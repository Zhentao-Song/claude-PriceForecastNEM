"""
Feature engineering for NEM price forecasting.

Creates:
- Lagged price features
- Rolling statistics
- Calendar/temporal features
- Price transformations (asinh for handling negatives + spikes)
- Inter-regional price spreads
- Spike indicators
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd

logger = logging.getLogger("nem_forecast.features")


class FeatureEngineer:
    """Build features for NEM 5-minute price forecasting."""

    # Region ordering for consistent indexing
    REGION_ORDER = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]

    # Region index mapping (for GNN)
    REGION_IDX = {r: i for i, r in enumerate(REGION_ORDER)}

    # Interconnector adjacency (bidirectional)
    EDGES = [
        (0, 1),  # NSW1 - QLD1
        (1, 0),
        (2, 0),  # VIC1 - NSW1
        (0, 2),
        (2, 3),  # VIC1 - SA1
        (3, 2),
        (2, 4),  # VIC1 - TAS1
        (4, 2),
    ]

    def __init__(self, config: dict):
        self.config = config
        feat_cfg = config["features"]

        self.price_lags = feat_cfg["price_lags"]
        self.rolling_windows = feat_cfg["rolling_windows"]
        self.use_calendar = feat_cfg["use_calendar"]
        self.use_holidays = feat_cfg["use_holidays"]
        self.price_transform = feat_cfg["price_transform"]
        self.spike_threshold = feat_cfg["spike_threshold"]
        self.negative_spike_threshold = feat_cfg["negative_spike_threshold"]

    def transform(self, df: pd.DataFrame) -> pd.DataFrame:
        """Apply all feature engineering steps.

        Args:
            df: Merged NEM data with columns [SETTLEMENTDATE, REGIONID, RRP, ...]

        Returns:
            Feature-enriched DataFrame.
        """
        logger.info("Starting feature engineering")
        df = df.copy()

        # Ensure datetime
        df["SETTLEMENTDATE"] = pd.to_datetime(df["SETTLEMENTDATE"])
        df = df.sort_values(["REGIONID", "SETTLEMENTDATE"]).reset_index(drop=True)

        # Price transformation
        df["price_transformed"] = self._transform_price(df["RRP"])

        # Per-region feature engineering
        dfs = []
        for region in self.REGION_ORDER:
            rdf = df[df["REGIONID"] == region].copy()
            if rdf.empty:
                continue

            rdf = rdf.set_index("SETTLEMENTDATE").sort_index()

            # Lagged prices
            rdf = self._add_price_lags(rdf)

            # Rolling statistics
            rdf = self._add_rolling_stats(rdf)

            # Calendar features
            if self.use_calendar:
                rdf = self._add_calendar_features(rdf)

            # Holiday features
            if self.use_holidays:
                rdf = self._add_holiday_features(rdf)

            # Spike indicators (as labels, not features to avoid leakage)
            rdf["is_spike"] = (rdf["RRP"] >= self.spike_threshold).astype(int)
            rdf["is_negative_spike"] = (rdf["RRP"] <= self.negative_spike_threshold).astype(int)

            rdf = rdf.reset_index()
            dfs.append(rdf)

        result = pd.concat(dfs, ignore_index=True)

        # Add inter-regional price spreads
        result = self._add_price_spreads(result)

        # Drop rows with NaN from lagging (first seq_len rows per region)
        max_lag = max(self.price_lags)
        result = pd.concat([
            g.iloc[max_lag:]
            for _, g in result.groupby("REGIONID")
        ], ignore_index=True)

        logger.info(f"Feature engineering complete: {result.shape}, "
                     f"{len([c for c in result.columns if c.startswith('lag_')])} lag features, "
                     f"{len([c for c in result.columns if c.startswith('roll_')])} rolling features")

        return result

    def _transform_price(self, prices: pd.Series) -> pd.Series:
        """Apply price transformation to handle extreme values."""
        if self.price_transform == "asinh":
            # asinh(x/100) maps well for electricity prices:
            # preserves sign, compresses extremes, ~linear near zero
            return np.arcsinh(prices / 100.0)
        elif self.price_transform == "log":
            # log1p only for positive prices
            return np.sign(prices) * np.log1p(np.abs(prices))
        return prices

    def _inverse_transform_price(self, transformed: np.ndarray) -> np.ndarray:
        """Inverse price transformation for predictions."""
        if self.price_transform == "asinh":
            return np.sinh(transformed) * 100.0
        elif self.price_transform == "log":
            return np.sign(transformed) * (np.expm1(np.abs(transformed)))
        return transformed

    def _add_price_lags(self, rdf: pd.DataFrame) -> pd.DataFrame:
        """Add lagged price features."""
        for lag in self.price_lags:
            rdf[f"lag_price_{lag}"] = rdf["price_transformed"].shift(lag)
            # Also lag raw RRP for spread calculations
            rdf[f"lag_rrp_{lag}"] = rdf["RRP"].shift(lag)
        return rdf

    def _add_rolling_stats(self, rdf: pd.DataFrame) -> pd.DataFrame:
        """Add rolling window statistics on transformed prices."""
        price = rdf["price_transformed"]
        for w in self.rolling_windows:
            rdf[f"roll_mean_{w}"] = price.rolling(w, min_periods=1).mean()
            rdf[f"roll_std_{w}"] = price.rolling(w, min_periods=1).std().fillna(0)
            rdf[f"roll_max_{w}"] = price.rolling(w, min_periods=1).max()
            rdf[f"roll_min_{w}"] = price.rolling(w, min_periods=1).min()
            # Spike count in window
            rdf[f"roll_spike_count_{w}"] = (
                (rdf["RRP"] >= self.spike_threshold)
                .astype(int)
                .rolling(w, min_periods=1)
                .sum()
            )
        return rdf

    def _add_calendar_features(self, rdf: pd.DataFrame) -> pd.DataFrame:
        """Add cyclical temporal features."""
        idx = rdf.index  # DatetimeIndex

        # Time of day (cyclical encoding)
        minutes_of_day = idx.hour * 60 + idx.minute
        rdf["tod_sin"] = np.sin(2 * np.pi * minutes_of_day / 1440)
        rdf["tod_cos"] = np.cos(2 * np.pi * minutes_of_day / 1440)

        # Day of week (cyclical)
        dow = idx.dayofweek
        rdf["dow_sin"] = np.sin(2 * np.pi * dow / 7)
        rdf["dow_cos"] = np.cos(2 * np.pi * dow / 7)

        # Month of year (cyclical - captures seasonality)
        month = idx.month
        rdf["month_sin"] = np.sin(2 * np.pi * month / 12)
        rdf["month_cos"] = np.cos(2 * np.pi * month / 12)

        # Weekend flag
        rdf["is_weekend"] = (dow >= 5).astype(int)

        return rdf

    def _add_holiday_features(self, rdf: pd.DataFrame) -> pd.DataFrame:
        """Add Australian public holiday features."""
        try:
            import holidays as hdays

            au_holidays = hdays.Australia(years=range(2021, 2027))
            rdf["is_holiday"] = rdf.index.date
            rdf["is_holiday"] = rdf["is_holiday"].apply(lambda d: int(d in au_holidays))
        except ImportError:
            logger.warning("holidays package not installed, skipping holiday features")
            rdf["is_holiday"] = 0
        return rdf

    def _add_price_spreads(self, df: pd.DataFrame) -> pd.DataFrame:
        """Add inter-regional price spreads (indicators of interconnector congestion)."""
        # Pivot to get price per region per timestamp
        pivot = df.pivot_table(
            index="SETTLEMENTDATE",
            columns="REGIONID",
            values="price_transformed",
            aggfunc="first",
        )

        # Key interconnector spreads
        spreads = {}
        spread_pairs = [
            ("NSW1", "QLD1"),
            ("VIC1", "NSW1"),
            ("VIC1", "SA1"),
            ("VIC1", "TAS1"),
        ]
        for r1, r2 in spread_pairs:
            if r1 in pivot.columns and r2 in pivot.columns:
                col_name = f"spread_{r1}_{r2}"
                spreads[col_name] = pivot[r1] - pivot[r2]

        if spreads:
            spread_df = pd.DataFrame(spreads)
            spread_df = spread_df.reset_index()
            df = df.merge(spread_df, on="SETTLEMENTDATE", how="left")

        return df

    def get_feature_columns(self, df: pd.DataFrame) -> list[str]:
        """Get list of feature column names (excluding targets and identifiers)."""
        exclude = {
            "SETTLEMENTDATE", "REGIONID", "RRP", "price_transformed",
            "is_spike", "is_negative_spike",
            # Exclude raw lagged RRP (we use transformed lags)
        }
        exclude.update({f"lag_rrp_{lag}" for lag in self.price_lags})

        feature_cols = [c for c in df.columns if c not in exclude and not c.startswith("lag_rrp_")]
        return sorted(feature_cols)

    def get_graph_edges(self) -> list[tuple[int, int]]:
        """Return edge list for the NEM region graph."""
        return self.EDGES
