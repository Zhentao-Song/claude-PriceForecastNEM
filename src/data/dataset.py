"""
PyTorch Dataset and DataLoader for NEM price forecasting.

Converts the feature-engineered DataFrame into tensors suitable for
the GNN-Transformer model:
- Input: [seq_len, num_regions, num_features]
- Target: prices at various horizons for each region
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd
import torch
from torch.utils.data import Dataset, DataLoader

logger = logging.getLogger("nem_forecast.data")

REGION_ORDER = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]


class NEMDataset(Dataset):
    """Dataset for NEM 5-minute price forecasting.

    Each sample is a window of `seq_len` timesteps across all 5 regions,
    with targets at multiple prediction horizons.
    """

    def __init__(
        self,
        df: pd.DataFrame,
        feature_cols: list[str],
        seq_len: int = 288,
        pred_horizons: list[int] = None,
        target_col: str = "price_transformed",
        spike_col: str = "is_spike",
    ):
        self.seq_len = seq_len
        self.pred_horizons = pred_horizons or [1, 6, 12, 48]
        self.max_horizon = max(self.pred_horizons)
        self.feature_cols = feature_cols
        self.target_col = target_col
        self.spike_col = spike_col

        # Pivot data to 3D: [timestamps, regions, features]
        self.timestamps = sorted(df["SETTLEMENTDATE"].unique())
        self.num_timestamps = len(self.timestamps)

        # Build 3D arrays
        num_regions = len(REGION_ORDER)
        num_features = len(feature_cols)

        self.features = np.full(
            (self.num_timestamps, num_regions, num_features), np.nan, dtype=np.float32
        )
        self.targets = np.full(
            (self.num_timestamps, num_regions), np.nan, dtype=np.float32
        )
        self.spike_labels = np.zeros(
            (self.num_timestamps, num_regions), dtype=np.float32
        )

        # Fill arrays using vectorized indexing (much faster than iterrows)
        time_idx = {t: i for i, t in enumerate(self.timestamps)}
        region_idx = {r: i for i, r in enumerate(REGION_ORDER)}

        ti_arr = df["SETTLEMENTDATE"].map(time_idx).values
        ri_arr = df["REGIONID"].map(region_idx).values

        # Filter valid rows
        valid = ~(np.isnan(ti_arr) | np.isnan(ri_arr))
        ti_arr = ti_arr[valid].astype(int)
        ri_arr = ri_arr[valid].astype(int)

        self.features[ti_arr, ri_arr] = df.loc[valid, feature_cols].values.astype(np.float32)
        self.targets[ti_arr, ri_arr] = df.loc[valid, target_col].values.astype(np.float32)
        if spike_col in df.columns:
            self.spike_labels[ti_arr, ri_arr] = df.loc[valid, spike_col].values.astype(np.float32)

        # Handle NaN - forward fill then backward fill per region
        for ri in range(num_regions):
            for fi in range(num_features):
                col = self.features[:, ri, fi]
                # Forward fill
                mask = np.isnan(col)
                if mask.all():
                    col[:] = 0.0
                else:
                    idx = np.where(~mask, np.arange(len(col)), 0)
                    np.maximum.accumulate(idx, out=idx)
                    col[:] = col[idx]
                    # Backward fill remaining
                    mask = np.isnan(col)
                    if mask.any():
                        col[mask] = col[~mask][0] if (~mask).any() else 0.0

        # Replace any remaining NaN
        self.features = np.nan_to_num(self.features, nan=0.0)
        self.targets = np.nan_to_num(self.targets, nan=0.0)

        # Compute normalization stats (per feature)
        self.feature_mean = np.nanmean(self.features, axis=(0, 1))
        self.feature_std = np.nanstd(self.features, axis=(0, 1)) + 1e-8

        # Normalize features
        self.features = (self.features - self.feature_mean) / self.feature_std

        # Valid sample indices (need seq_len history + max_horizon future)
        self.valid_indices = list(range(
            self.seq_len,
            self.num_timestamps - self.max_horizon,
        ))

        logger.info(
            f"NEMDataset: {len(self.valid_indices)} samples, "
            f"{num_features} features, seq_len={seq_len}"
        )

    def __len__(self) -> int:
        return len(self.valid_indices)

    def __getitem__(self, idx: int) -> dict:
        t = self.valid_indices[idx]

        # Input sequence: [seq_len, num_regions, num_features]
        x = torch.from_numpy(self.features[t - self.seq_len : t])

        # Targets at each horizon: {horizon: [num_regions]}
        targets = {}
        spike_targets = {}
        for h in self.pred_horizons:
            targets[h] = torch.from_numpy(self.targets[t + h - 1])
            spike_targets[h] = torch.from_numpy(self.spike_labels[t + h - 1])

        return {
            "x": x,
            "targets": targets,
            "spike_targets": spike_targets,
            "timestamp_idx": t,
        }


def collate_fn(batch: list[dict]) -> dict:
    """Custom collation for variable horizon targets."""
    x = torch.stack([b["x"] for b in batch])
    timestamp_idx = [b["timestamp_idx"] for b in batch]

    horizons = list(batch[0]["targets"].keys())
    targets = {h: torch.stack([b["targets"][h] for b in batch]) for h in horizons}
    spike_targets = {h: torch.stack([b["spike_targets"][h] for b in batch]) for h in horizons}

    return {
        "x": x,
        "targets": targets,
        "spike_targets": spike_targets,
        "timestamp_idx": timestamp_idx,
    }


def create_dataloaders(
    df: pd.DataFrame,
    feature_cols: list[str],
    config: dict,
) -> tuple[DataLoader, DataLoader, DataLoader]:
    """Create train/val/test DataLoaders with temporal split.

    Uses temporal split (not random) to prevent data leakage.
    """
    seq_len = config["model"]["seq_len"]
    pred_horizons = config["model"]["pred_horizons"]
    batch_size = config["training"]["batch_size"]
    val_ratio = config["training"]["val_ratio"]
    test_ratio = config["training"]["test_ratio"]

    # Sort by time
    df = df.sort_values("SETTLEMENTDATE").reset_index(drop=True)

    # Temporal split
    timestamps = sorted(df["SETTLEMENTDATE"].unique())
    n = len(timestamps)
    train_end = int(n * (1 - val_ratio - test_ratio))
    val_end = int(n * (1 - test_ratio))

    train_times = set(timestamps[:train_end])
    val_times = set(timestamps[train_end:val_end])
    test_times = set(timestamps[val_end:])

    train_df = df[df["SETTLEMENTDATE"].isin(train_times)]
    val_df = df[df["SETTLEMENTDATE"].isin(val_times)]
    test_df = df[df["SETTLEMENTDATE"].isin(test_times)]

    logger.info(f"Split: train={len(train_times)} val={len(val_times)} test={len(test_times)} timestamps")

    train_ds = NEMDataset(train_df, feature_cols, seq_len, pred_horizons)
    val_ds = NEMDataset(val_df, feature_cols, seq_len, pred_horizons)
    test_ds = NEMDataset(test_df, feature_cols, seq_len, pred_horizons)

    train_loader = DataLoader(
        train_ds, batch_size=batch_size, shuffle=True,
        collate_fn=collate_fn, num_workers=0, pin_memory=True,
    )
    val_loader = DataLoader(
        val_ds, batch_size=batch_size, shuffle=False,
        collate_fn=collate_fn, num_workers=0, pin_memory=True,
    )
    test_loader = DataLoader(
        test_ds, batch_size=batch_size, shuffle=False,
        collate_fn=collate_fn, num_workers=0, pin_memory=True,
    )

    return train_loader, val_loader, test_loader
