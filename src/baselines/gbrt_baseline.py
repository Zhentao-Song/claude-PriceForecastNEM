"""
GBRT Baseline for NEM 5-Minute Price Forecasting
=================================================
Implements a LightGBM gradient-boosted regression tree baseline that uses
exactly the same features and train/val/test split as the GNN-Transformer,
allowing direct apples-to-apples comparison.

Reference:
  [2604.23908] ML & DL Models for Short-Term EPF in Australia's NEM (2026)
  → GBRT achieved R²=0.88, best among all tested models

Design decisions:
  - One model per (region × horizon) — "direct" multi-step forecasting
    (same strategy as [2602.01157])
  - Features: identical to FeatureEngineer output, plus region one-hot
  - Target: asinh-transformed price (same as GNN-Transformer)
  - Evaluation: MAE / RMSE / MAPE / PinballLoss (P10,P50,P90) / Spike F1
    on *original* $/MWh scale

Usage:
  # Download data first (or point to existing cache):
  python -m src.baselines.gbrt_baseline --config config.yaml

  # Skip download if data already cached:
  python -m src.baselines.gbrt_baseline --config config.yaml --no-download

  # Quick smoke-test with tiny dataset:
  python -m src.baselines.gbrt_baseline --config config.yaml --fast
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import yaml

warnings.filterwarnings("ignore", category=UserWarning)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("baseline.gbrt")

# ── project root on sys.path ──────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from src.features.engineer import FeatureEngineer  # noqa: E402
from src.data.download import NEMDataDownloader      # noqa: E402

REGIONS = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]


# ── Metrics ───────────────────────────────────────────────────────────────────

def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(y_true - y_pred)))


def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def mape(y_true: np.ndarray, y_pred: np.ndarray, eps: float = 1.0) -> float:
    """MAPE with floor on |y_true| to avoid division by near-zero."""
    denom = np.maximum(np.abs(y_true), eps)
    return float(np.mean(np.abs(y_true - y_pred) / denom) * 100)


def pinball(y_true: np.ndarray, y_pred: np.ndarray, q: float) -> float:
    err = y_true - y_pred
    return float(np.mean(np.where(err >= 0, q * err, (q - 1) * err)))


def spike_f1(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    threshold: float = 300.0,
) -> dict[str, float]:
    """Precision / Recall / F1 for price spikes (>= threshold $/MWh)."""
    true_spike = y_true >= threshold
    pred_spike = y_pred >= threshold
    tp = float(np.sum(true_spike & pred_spike))
    fp = float(np.sum(~true_spike & pred_spike))
    fn = float(np.sum(true_spike & ~pred_spike))
    prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    rec  = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1   = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
    return {"precision": prec, "recall": rec, "f1": f1, "n_true_spikes": int(true_spike.sum())}


def evaluate(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    spike_threshold: float = 300.0,
) -> dict:
    return {
        "MAE":    mae(y_true, y_pred),
        "RMSE":   rmse(y_true, y_pred),
        "MAPE":   mape(y_true, y_pred),
        "P10":    pinball(y_true, y_pred, 0.10),
        "P50":    pinball(y_true, y_pred, 0.50),
        "P90":    pinball(y_true, y_pred, 0.90),
        "spike":  spike_f1(y_true, y_pred, spike_threshold),
    }


# ── Inverse transform ─────────────────────────────────────────────────────────

def inv_asinh(x: np.ndarray) -> np.ndarray:
    """Inverse of asinh(price / 100)."""
    return np.sinh(x) * 100.0


# ── Train / test split (mirrors dataset.py) ───────────────────────────────────

def temporal_split(
    df: pd.DataFrame,
    val_ratio: float = 0.1,
    test_ratio: float = 0.1,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    timestamps = sorted(df["SETTLEMENTDATE"].unique())
    n = len(timestamps)
    train_end = int(n * (1 - val_ratio - test_ratio))
    val_end   = int(n * (1 - test_ratio))
    train_ts = set(timestamps[:train_end])
    val_ts   = set(timestamps[train_end:val_end])
    test_ts  = set(timestamps[val_end:])
    return (
        df[df["SETTLEMENTDATE"].isin(train_ts)].copy(),
        df[df["SETTLEMENTDATE"].isin(val_ts)].copy(),
        df[df["SETTLEMENTDATE"].isin(test_ts)].copy(),
    )


# ── Feature matrix builder ────────────────────────────────────────────────────

def build_xy(
    df: pd.DataFrame,
    feature_cols: list[str],
    horizon: int,
    region: str,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Build (X, y) for a single region and horizon.

    X: feature matrix at time t  [n_samples, n_features + 5 region dummies]
    y: transformed price at time t + horizon  [n_samples]
    """
    rdf = df[df["REGIONID"] == region].copy()
    rdf = rdf.sort_values("SETTLEMENTDATE").reset_index(drop=True)

    # Target: price at horizon h steps ahead
    rdf["target"] = rdf["price_transformed"].shift(-horizon)
    rdf = rdf.dropna(subset=["target"] + feature_cols)

    X = rdf[feature_cols].values.astype(np.float32)
    y = rdf["target"].values.astype(np.float32)
    return X, y


# ── LightGBM training ─────────────────────────────────────────────────────────

def train_lgbm(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    params: dict | None = None,
    num_boost_round: int = 1000,
    early_stopping_rounds: int = 50,
):
    try:
        import lightgbm as lgb
    except ImportError:
        raise ImportError(
            "LightGBM not installed. Run: pip install lightgbm --break-system-packages"
        )

    default_params = {
        "objective":        "regression",
        "metric":           "rmse",
        "learning_rate":    0.05,
        "num_leaves":       127,
        "min_child_samples": 20,
        "subsample":        0.8,
        "colsample_bytree": 0.8,
        "reg_alpha":        0.1,
        "reg_lambda":       1.0,
        "n_jobs":           -1,
        "verbose":          -1,
        "seed":             42,
    }
    if params:
        default_params.update(params)

    dtrain = lgb.Dataset(X_train, label=y_train)
    dval   = lgb.Dataset(X_val,   label=y_val,   reference=dtrain)

    callbacks = [
        lgb.early_stopping(early_stopping_rounds, verbose=False),
        lgb.log_evaluation(period=-1),
    ]

    model = lgb.train(
        default_params,
        dtrain,
        num_boost_round=num_boost_round,
        valid_sets=[dval],
        callbacks=callbacks,
    )
    return model


def train_sklearn_gbr(
    X_train: np.ndarray,
    y_train: np.ndarray,
    X_val: np.ndarray,
    y_val: np.ndarray,
    n_estimators: int = 300,
):
    """Fallback: scikit-learn HistGradientBoostingRegressor (no external deps)."""
    from sklearn.ensemble import HistGradientBoostingRegressor

    model = HistGradientBoostingRegressor(
        max_iter=n_estimators,
        learning_rate=0.05,
        max_leaf_nodes=127,
        min_samples_leaf=20,
        l2_regularization=1.0,
        early_stopping=True,
        validation_fraction=0.0,
        n_iter_no_change=50,
        random_state=42,
        verbose=0,
    )
    # sklearn's early stopping uses internal val split; we ignore X_val here
    model.fit(X_train, y_train)
    return model


# ── Main pipeline ─────────────────────────────────────────────────────────────

def run(config: dict, no_download: bool = False, fast: bool = False) -> dict:
    spike_threshold = config["features"]["spike_threshold"]
    horizons        = config["model"]["pred_horizons"]   # e.g. [1, 6, 12]
    val_ratio       = config["training"]["val_ratio"]
    test_ratio      = config["training"]["test_ratio"]

    # ── 1. Load data ──────────────────────────────────────────────────────────
    if no_download:
        proc_dir = Path(config["data"]["processed_dir"])
        parquet  = proc_dir / "nem_merged.parquet"
        if not parquet.exists():
            raise FileNotFoundError(
                f"No cached data at {parquet}. Run without --no-download first."
            )
        log.info(f"Loading cached data from {parquet}")
        merged = pd.read_parquet(parquet)
    else:
        log.info("Downloading NEM data …")
        dl     = NEMDataDownloader(config)
        merged = dl.build_merged_dataset()

    if fast:
        # Keep only first 10 000 rows per region for a quick smoke-test
        merged = (
            merged.sort_values("SETTLEMENTDATE")
            .groupby("REGIONID")
            .head(10_000)
            .reset_index(drop=True)
        )
        log.info("FAST mode: trimmed to 10 000 rows per region")

    # ── 2. Feature engineering ────────────────────────────────────────────────
    log.info("Engineering features …")
    fe      = FeatureEngineer(config)
    feat_df = fe.transform(merged)
    feat_cols = fe.get_feature_columns(feat_df)
    log.info(f"{len(feat_cols)} feature columns: {feat_cols[:5]} … {feat_cols[-3:]}")

    # ── 3. Temporal split ─────────────────────────────────────────────────────
    train_df, val_df, test_df = temporal_split(feat_df, val_ratio, test_ratio)
    log.info(
        f"Split sizes — train: {len(train_df):,}  val: {len(val_df):,}  "
        f"test: {len(test_df):,} rows"
    )

    # ── 4. Train one model per (region × horizon) ─────────────────────────────
    results   = {}   # {region: {horizon: metrics}}
    models    = {}   # {(region, horizon): model}

    use_lgbm = True
    try:
        import lightgbm  # noqa: F401
    except ImportError:
        log.warning("LightGBM not found; falling back to sklearn HistGBR (slower)")
        use_lgbm = False

    total_models = len(REGIONS) * len(horizons)
    done = 0

    for region in REGIONS:
        results[region] = {}
        for horizon in horizons:
            t0 = time.time()
            horizon_label = f"{horizon * 5}min"  # 5-min intervals → minutes

            X_tr, y_tr = build_xy(train_df, feat_cols, horizon, region)
            X_va, y_va = build_xy(val_df,   feat_cols, horizon, region)
            X_te, y_te = build_xy(test_df,  feat_cols, horizon, region)

            if len(X_tr) == 0:
                log.warning(f"No training data for {region} h={horizon}, skipping")
                continue

            log.info(
                f"[{done+1}/{total_models}] Training {region} h={horizon_label} "
                f"({len(X_tr):,} train samples) …"
            )

            if use_lgbm:
                model = train_lgbm(X_tr, y_tr, X_va, y_va)
            else:
                model = train_sklearn_gbr(X_tr, y_tr, X_va, y_va)

            # Predict on test set (transformed space)
            y_pred_t = model.predict(X_te)

            # Inverse-transform both to $/MWh for evaluation
            y_true_rrp = inv_asinh(y_te)
            y_pred_rrp = inv_asinh(y_pred_t)

            metrics = evaluate(y_true_rrp, y_pred_rrp, spike_threshold)
            metrics["train_seconds"] = round(time.time() - t0, 1)
            metrics["n_test"]        = len(y_te)

            results[region][horizon_label] = metrics
            models[(region, horizon)] = model
            done += 1

            log.info(
                f"  MAE={metrics['MAE']:.2f} RMSE={metrics['RMSE']:.2f} "
                f"MAPE={metrics['MAPE']:.2f}% SpikeF1={metrics['spike']['f1']:.3f}"
            )

    return results, models, feat_cols


# ── Pretty-print results table ────────────────────────────────────────────────

def print_results_table(results: dict) -> None:
    horizons = []
    for region_data in results.values():
        horizons = list(region_data.keys())
        break

    print("\n" + "=" * 90)
    print("GBRT BASELINE — NEM 5-MINUTE PRICE FORECASTING")
    print("=" * 90)

    for h in horizons:
        print(f"\n── Horizon: {h} ────────────────────────────────────────────────")
        header = f"{'Region':<8} {'MAE':>8} {'RMSE':>8} {'MAPE%':>8} "
        header += f"{'P50':>8} {'SpikeF1':>9} {'SpikeRec':>10} {'N_spikes':>10}"
        print(header)
        print("-" * 80)

        mae_vals = []
        for region in REGIONS:
            if h not in results.get(region, {}):
                continue
            m = results[region][h]
            sp = m["spike"]
            mae_vals.append(m["MAE"])
            print(
                f"{region:<8} {m['MAE']:>8.2f} {m['RMSE']:>8.2f} {m['MAPE']:>8.2f} "
                f"{m['P50']:>8.3f} {sp['f1']:>9.3f} {sp['recall']:>10.3f} "
                f"{sp['n_true_spikes']:>10}"
            )

        if mae_vals:
            print(f"{'MEAN':<8} {np.mean(mae_vals):>8.2f}")

    print("\n" + "=" * 90)
    print("HOW TO READ: compare these numbers against your GNN-Transformer test metrics.")
    print("If GNN-Transformer MAE ≥ GBRT MAE → the model doesn't beat the baseline.")
    print("Target: GNN-Transformer MAE < GBRT MAE, especially at SpikeF1.")
    print("=" * 90 + "\n")


# ── Save results ──────────────────────────────────────────────────────────────

def save_results(results: dict, out_path: Path) -> None:
    """Save results dict to JSON (spike sub-dicts included)."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(results, f, indent=2, default=float)
    log.info(f"Results saved to {out_path}")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GBRT baseline for NEM EPF")
    parser.add_argument("--config",      default="config.yaml", help="Path to config.yaml")
    parser.add_argument("--no-download", action="store_true",   help="Skip data download, use cache")
    parser.add_argument("--fast",        action="store_true",   help="Quick smoke-test (10k rows/region)")
    parser.add_argument("--out",         default="logs/gbrt_baseline_results.json",
                        help="Output path for JSON results")
    args = parser.parse_args()

    with open(args.config) as f:
        config = yaml.safe_load(f)

    results, models, feat_cols = run(
        config,
        no_download=args.no_download,
        fast=args.fast,
    )

    print_results_table(results)
    save_results(results, Path(args.out))

    return results


if __name__ == "__main__":
    main()
