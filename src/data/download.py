"""
NEM data download pipeline using NEMOSIS and NEMSEER.

Downloads:
- DISPATCHPRICE: 5-minute regional prices
- DISPATCHREGIONSUM: 5-minute demand, generation, interconnector flows
- P5MIN forecasts: AEMO's own 5-minute pre-dispatch forecasts
"""

import logging
from datetime import datetime
from pathlib import Path

import pandas as pd

logger = logging.getLogger("nem_forecast.data")


class NEMDataDownloader:
    """Download and cache NEM market data from AEMO."""

    # NEM interconnectors and their region pairs (from, to)
    INTERCONNECTORS = {
        "NSW1-QLD1": ("NSW1", "QLD1"),
        "VIC1-NSW1": ("VIC1", "NSW1"),
        "VIC1-SA1": ("VIC1", "SA1"),
        "VIC1-TAS1": ("VIC1", "TAS1"),  # Basslink
    }

    def __init__(self, config: dict):
        self.config = config
        self.raw_dir = Path(config["data"]["raw_dir"])
        self.cache_dir = Path(config["data"]["cache_dir"])
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        self.start_date = config["data"]["start_date"]
        self.end_date = config["data"]["end_date"]
        self.regions = config["data"]["regions"]

    def download_dispatch_prices(self) -> pd.DataFrame:
        """Download 5-minute dispatch prices for all regions."""
        cache_file = self.cache_dir / "dispatch_prices.parquet"
        if cache_file.exists():
            logger.info("Loading cached dispatch prices")
            return pd.read_parquet(cache_file)

        logger.info(f"Downloading DISPATCHPRICE: {self.start_date} to {self.end_date}")
        try:
            from nemosis import dynamic_data_compiler

            price_df = dynamic_data_compiler(
                start_time=self.start_date,
                end_time=self.end_date,
                table_name="DISPATCHPRICE",
                raw_data_location=str(self.raw_dir),
                filter_cols=["REGIONID"],
                filter_values=[self.regions],
            )
        except ImportError:
            logger.warning("nemosis not installed, trying nemdata fallback")
            price_df = self._download_with_nemdata("dispatch-price")

        if price_df is not None and not price_df.empty:
            price_df.to_parquet(cache_file, index=False)
            logger.info(f"Saved dispatch prices: {len(price_df)} rows")

        return price_df

    def download_dispatch_region_summary(self) -> pd.DataFrame:
        """Download 5-minute regional demand, generation, interconnector data."""
        cache_file = self.cache_dir / "dispatch_region_summary.parquet"
        if cache_file.exists():
            logger.info("Loading cached dispatch region summary")
            return pd.read_parquet(cache_file)

        logger.info(f"Downloading DISPATCHREGIONSUM: {self.start_date} to {self.end_date}")
        try:
            from nemosis import dynamic_data_compiler

            region_df = dynamic_data_compiler(
                start_time=self.start_date,
                end_time=self.end_date,
                table_name="DISPATCHREGIONSUM",
                raw_data_location=str(self.raw_dir),
                filter_cols=["REGIONID"],
                filter_values=[self.regions],
            )
        except ImportError:
            logger.warning("nemosis not installed, trying nemdata fallback")
            region_df = self._download_with_nemdata("dispatch-summary")

        if region_df is not None and not region_df.empty:
            region_df.to_parquet(cache_file, index=False)
            logger.info(f"Saved region summary: {len(region_df)} rows")

        return region_df

    def download_p5min_forecasts(self) -> pd.DataFrame:
        """Download AEMO's P5MIN pre-dispatch forecasts via NEMSEER."""
        cache_file = self.cache_dir / "p5min_forecasts.parquet"
        if cache_file.exists():
            logger.info("Loading cached P5MIN forecasts")
            return pd.read_parquet(cache_file)

        logger.info(f"Downloading P5MIN forecasts: {self.start_date} to {self.end_date}")
        try:
            from nemseer import compile_data, download_raw_data

            download_raw_data(
                forecast_start=self.start_date,
                forecast_end=self.end_date,
                forecast_type="P5MIN",
                tables=["REGIONSOLUTION"],
                raw_cache=str(self.raw_dir / "nemseer"),
            )
            p5_df = compile_data(
                forecast_start=self.start_date,
                forecast_end=self.end_date,
                forecast_type="P5MIN",
                tables=["REGIONSOLUTION"],
                raw_cache=str(self.raw_dir / "nemseer"),
            )
            if isinstance(p5_df, dict):
                p5_df = p5_df.get("REGIONSOLUTION", pd.DataFrame())
        except (ImportError, Exception) as e:
            logger.warning(f"NEMSEER download failed: {e}. P5MIN data will be skipped.")
            return pd.DataFrame()

        if p5_df is not None and not p5_df.empty:
            p5_df.to_parquet(cache_file, index=False)
            logger.info(f"Saved P5MIN forecasts: {len(p5_df)} rows")

        return p5_df

    def _download_with_nemdata(self, table_type: str) -> pd.DataFrame:
        """Fallback download using nemdata package."""
        try:
            import nemdata

            data = nemdata.download(
                start=self.start_date,
                end=self.end_date,
                table=table_type,
            )
            return data
        except (ImportError, Exception) as e:
            logger.error(f"nemdata download failed: {e}")
            return pd.DataFrame()

    def download_all(self) -> dict[str, pd.DataFrame]:
        """Download all required datasets."""
        logger.info("Starting full NEM data download")
        data = {
            "prices": self.download_dispatch_prices(),
            "region_summary": self.download_dispatch_region_summary(),
            "p5min": self.download_p5min_forecasts(),
        }
        logger.info("Data download complete")
        return data

    def build_merged_dataset(self) -> pd.DataFrame:
        """Download all data and merge into a single time-series DataFrame.

        Returns a DataFrame indexed by (SETTLEMENTDATE, REGIONID) with columns:
        - RRP: Regional reference price ($/MWh)
        - TOTALDEMAND: Regional demand (MW)
        - AVAILABLEGENERATION: Available generation (MW)
        - And other features from DISPATCHREGIONSUM
        """
        data = self.download_all()

        prices = data["prices"]
        region = data["region_summary"]

        if prices is None or prices.empty:
            raise ValueError("No price data available. Check NEMOSIS installation and date range.")

        # Standardize datetime column names
        for df in [prices, region]:
            if df is not None and not df.empty:
                for col in ["SETTLEMENTDATE", "DATETIME", "INTERVAL_DATETIME"]:
                    if col in df.columns:
                        df[col] = pd.to_datetime(df[col])

        # Determine datetime column
        time_col = "SETTLEMENTDATE"
        if time_col not in prices.columns:
            for candidate in ["DATETIME", "INTERVAL_DATETIME"]:
                if candidate in prices.columns:
                    prices = prices.rename(columns={candidate: time_col})
                    break

        # Select key columns from prices
        price_cols = [time_col, "REGIONID", "RRP"]
        price_cols = [c for c in price_cols if c in prices.columns]
        prices_clean = prices[price_cols].drop_duplicates()

        # Merge with region summary
        if region is not None and not region.empty:
            if time_col not in region.columns:
                for candidate in ["DATETIME", "INTERVAL_DATETIME"]:
                    if candidate in region.columns:
                        region = region.rename(columns={candidate: time_col})
                        break

            region_cols = [
                time_col, "REGIONID",
                "TOTALDEMAND", "AVAILABLEGENERATION", "CLEAREDSUPPLY",
                "INITIALSUPPLY", "DISPATCHABLEGENERATION", "DISPATCHABLELOAD",
                "NETINTERCHANGE",
            ]
            region_cols = [c for c in region_cols if c in region.columns]
            region_clean = region[region_cols].drop_duplicates()

            merged = prices_clean.merge(
                region_clean,
                on=[time_col, "REGIONID"],
                how="left",
            )
        else:
            merged = prices_clean

        # Add P5MIN AEMO forecasts as features
        p5min = data.get("p5min")
        if p5min is not None and not p5min.empty:
            p5_time_col = None
            for candidate in ["INTERVAL_DATETIME", "DATETIME", "SETTLEMENTDATE"]:
                if candidate in p5min.columns:
                    p5_time_col = candidate
                    break
            if p5_time_col:
                p5min[p5_time_col] = pd.to_datetime(p5min[p5_time_col])
                p5_cols = [p5_time_col, "REGIONID"]
                for col in ["RRP", "TOTALDEMAND", "AVAILABLEGENERATION"]:
                    if col in p5min.columns:
                        p5_cols.append(col)
                p5_latest = (
                    p5min[p5_cols]
                    .sort_values(p5_time_col)
                    .drop_duplicates(subset=[p5_time_col, "REGIONID"], keep="last")
                )
                p5_latest = p5_latest.rename(
                    columns={
                        c: f"P5MIN_{c}" for c in p5_latest.columns
                        if c not in [p5_time_col, "REGIONID"]
                    }
                )
                if p5_time_col != time_col:
                    p5_latest = p5_latest.rename(columns={p5_time_col: time_col})
                merged = merged.merge(
                    p5_latest,
                    on=[time_col, "REGIONID"],
                    how="left",
                )

        merged = merged.sort_values([time_col, "REGIONID"]).reset_index(drop=True)
        logger.info(f"Built merged dataset: {merged.shape}")

        # Save processed
        out_dir = Path(self.config["data"]["processed_dir"])
        out_dir.mkdir(parents=True, exist_ok=True)
        merged.to_parquet(out_dir / "nem_merged.parquet", index=False)

        return merged
