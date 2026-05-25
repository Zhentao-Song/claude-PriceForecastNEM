"""
Evaluation metrics for NEM price forecasting.

Includes:
- Standard regression metrics (MAE, RMSE, MAPE)
- Probabilistic metrics (Pinball Loss, CRPS)
- Spike detection metrics (Precision, Recall, F1)
- Per-region and per-horizon breakdown
"""

import logging
from typing import Optional

import numpy as np
import pandas as pd
import torch
from torch.utils.data import DataLoader

from src.models.gnn_transformer import GNNTransformerModel
from src.features.engineer import FeatureEngineer

logger = logging.getLogger("nem_forecast.evaluation")

REGION_ORDER = ["NSW1", "QLD1", "VIC1", "SA1", "TAS1"]


def evaluate_forecasts(
    model: GNNTransformerModel,
    test_loader: DataLoader,
    feature_engineer: FeatureEngineer,
    device: torch.device,
    config: dict,
) -> dict:
    """Run full evaluation on test set.

    Returns:
        Dictionary of metrics organized by horizon and region.
    """
    model.eval()
    horizons = config["model"]["pred_horizons"]
    quantiles = config["model"]["quantiles"]
    spike_threshold_idx = _get_spike_threshold_idx(config)

    # Collect predictions and targets
    all_preds = {h: [] for h in horizons}
    all_targets = {h: [] for h in horizons}
    all_spike_preds = {h: [] for h in horizons}
    all_spike_targets = {h: [] for h in horizons}

    with torch.no_grad():
        for batch in test_loader:
            x = batch["x"].to(device)
            output = model(x)

            for h in horizons:
                pred = output["quantiles"][h].cpu().numpy()  # [B, N, Q]
                target = batch["targets"][h].numpy()  # [B, N]
                spike_target = batch["spike_targets"][h].numpy()

                all_preds[h].append(pred)
                all_targets[h].append(target)
                all_spike_targets[h].append(spike_target)

                # Spike prediction from spike_prob head
                h_idx = horizons.index(h)
                spike_pred = output["spike_prob"][:, :, h_idx].cpu().numpy()
                all_spike_preds[h].append(spike_pred)

    # Concatenate
    for h in horizons:
        all_preds[h] = np.concatenate(all_preds[h], axis=0)
        all_targets[h] = np.concatenate(all_targets[h], axis=0)
        all_spike_preds[h] = np.concatenate(all_spike_preds[h], axis=0)
        all_spike_targets[h] = np.concatenate(all_spike_targets[h], axis=0)

    # Compute metrics
    results = {}
    for h in horizons:
        preds = all_preds[h]  # [N_samples, 5_regions, Q_quantiles]
        targets = all_targets[h]  # [N_samples, 5_regions]
        spike_preds = all_spike_preds[h]
        spike_targets = all_spike_targets[h]

        # Inverse transform to original price scale
        median_idx = quantiles.index(0.5)
        point_preds_transformed = preds[:, :, median_idx]  # Use median as point forecast

        point_preds = feature_engineer._inverse_transform_price(point_preds_transformed)
        actual_prices = feature_engineer._inverse_transform_price(targets)

        h_results = {
            "overall": _compute_regression_metrics(point_preds.flatten(), actual_prices.flatten()),
            "per_region": {},
            "probabilistic": _compute_probabilistic_metrics(
                preds, targets, quantiles,
            ),
            "spike": _compute_spike_metrics(
                spike_preds.flatten(), spike_targets.flatten(),
            ),
        }

        # Per-region metrics
        for ri, region in enumerate(REGION_ORDER):
            region_preds = point_preds[:, ri]
            region_actual = actual_prices[:, ri]
            region_spike_pred = spike_preds[:, ri]
            region_spike_actual = spike_targets[:, ri]

            h_results["per_region"][region] = {
                **_compute_regression_metrics(region_preds, region_actual),
                **_compute_spike_metrics(region_spike_pred, region_spike_actual),
            }

        results[f"horizon_{h}"] = h_results

        # Log summary
        horizon_mins = h * 5
        r = h_results["overall"]
        logger.info(
            f"Horizon {horizon_mins}min | "
            f"MAE: ${r['mae']:.2f} | RMSE: ${r['rmse']:.2f} | "
            f"MAPE: {r['mape']:.1f}%"
        )

        # Per-region summary
        for region in REGION_ORDER:
            rr = h_results["per_region"][region]
            logger.info(
                f"  {region}: MAE=${rr['mae']:.2f}, RMSE=${rr['rmse']:.2f}, "
                f"Spike F1={rr.get('spike_f1', 0):.3f}"
            )

    return results


def _compute_regression_metrics(preds: np.ndarray, actuals: np.ndarray) -> dict:
    """Compute standard regression metrics."""
    residuals = preds - actuals
    mae = np.mean(np.abs(residuals))
    rmse = np.sqrt(np.mean(residuals ** 2))

    # MAPE (avoid division by zero, exclude near-zero prices)
    nonzero_mask = np.abs(actuals) > 1.0  # Ignore prices near $0
    if nonzero_mask.sum() > 0:
        mape = np.mean(np.abs(residuals[nonzero_mask] / actuals[nonzero_mask])) * 100
    else:
        mape = float("nan")

    # Normalized MAE
    nmae = mae / (np.std(actuals) + 1e-8)

    return {
        "mae": float(mae),
        "rmse": float(rmse),
        "mape": float(mape),
        "nmae": float(nmae),
        "mean_actual": float(np.mean(actuals)),
        "std_actual": float(np.std(actuals)),
    }


def _compute_probabilistic_metrics(
    preds: np.ndarray,
    targets: np.ndarray,
    quantiles: list[float],
) -> dict:
    """Compute probabilistic forecast metrics."""
    # Pinball loss per quantile
    pinball_losses = {}
    targets_expanded = targets[:, :, np.newaxis]

    for qi, q in enumerate(quantiles):
        residuals = targets_expanded[:, :, 0] - preds[:, :, qi]
        pinball = np.where(
            residuals >= 0,
            q * residuals,
            (q - 1) * residuals,
        )
        pinball_losses[f"q{q}"] = float(np.mean(pinball))

    # Average pinball loss
    avg_pinball = np.mean(list(pinball_losses.values()))

    # Prediction interval coverage (90% PI: q0.05 to q0.95 or closest)
    # Using q0.1 to q0.9 as our 80% PI
    q10_idx = quantiles.index(0.1) if 0.1 in quantiles else 0
    q90_idx = quantiles.index(0.9) if 0.9 in quantiles else -2

    lower = preds[:, :, q10_idx]
    upper = preds[:, :, q90_idx]
    coverage = np.mean((targets >= lower) & (targets <= upper))

    # Sharpness (average PI width)
    sharpness = np.mean(upper - lower)

    return {
        "pinball_losses": pinball_losses,
        "avg_pinball": float(avg_pinball),
        "pi_coverage_80": float(coverage),
        "pi_sharpness": float(sharpness),
    }


def _compute_spike_metrics(
    spike_preds: np.ndarray,
    spike_targets: np.ndarray,
    threshold: float = 0.5,
) -> dict:
    """Compute spike detection metrics."""
    binary_preds = (spike_preds >= threshold).astype(int)
    binary_targets = spike_targets.astype(int)

    tp = np.sum((binary_preds == 1) & (binary_targets == 1))
    fp = np.sum((binary_preds == 1) & (binary_targets == 0))
    fn = np.sum((binary_preds == 0) & (binary_targets == 1))
    tn = np.sum((binary_preds == 0) & (binary_targets == 0))

    precision = tp / (tp + fp + 1e-8)
    recall = tp / (tp + fn + 1e-8)
    f1 = 2 * precision * recall / (precision + recall + 1e-8)

    total_spikes = int(binary_targets.sum())
    total_samples = len(binary_targets)

    return {
        "spike_precision": float(precision),
        "spike_recall": float(recall),
        "spike_f1": float(f1),
        "spike_tp": int(tp),
        "spike_fp": int(fp),
        "spike_fn": int(fn),
        "total_spikes": total_spikes,
        "spike_rate": float(total_spikes / (total_samples + 1e-8)),
    }


def _get_spike_threshold_idx(config: dict) -> int:
    """Get the quantile index closest to the spike detection threshold."""
    return -1  # Use highest quantile


def generate_report(results: dict, output_path: str = "evaluation_report.txt"):
    """Generate a human-readable evaluation report."""
    lines = ["=" * 70, "NEM Price Forecast Evaluation Report", "=" * 70, ""]

    for horizon_key, h_results in sorted(results.items()):
        horizon_num = int(horizon_key.split("_")[1])
        horizon_mins = horizon_num * 5

        lines.append(f"--- Horizon: {horizon_mins} minutes ({horizon_num} intervals) ---")
        lines.append("")

        # Overall metrics
        overall = h_results["overall"]
        lines.append("Overall Metrics:")
        lines.append(f"  MAE:  ${overall['mae']:.2f}/MWh")
        lines.append(f"  RMSE: ${overall['rmse']:.2f}/MWh")
        lines.append(f"  MAPE: {overall['mape']:.1f}%")
        lines.append(f"  nMAE: {overall['nmae']:.4f}")
        lines.append("")

        # Probabilistic metrics
        prob = h_results["probabilistic"]
        lines.append("Probabilistic Metrics:")
        lines.append(f"  Avg Pinball Loss: {prob['avg_pinball']:.4f}")
        lines.append(f"  80% PI Coverage:  {prob['pi_coverage_80']:.1%}")
        lines.append(f"  80% PI Sharpness: {prob['pi_sharpness']:.4f}")
        lines.append("")

        # Spike metrics
        spike = h_results["spike"]
        lines.append("Spike Detection:")
        lines.append(f"  Precision: {spike['spike_precision']:.3f}")
        lines.append(f"  Recall:    {spike['spike_recall']:.3f}")
        lines.append(f"  F1:        {spike['spike_f1']:.3f}")
        lines.append(f"  Total spikes in test: {spike['total_spikes']}")
        lines.append("")

        # Per-region
        lines.append("Per-Region Breakdown:")
        for region in REGION_ORDER:
            rr = h_results["per_region"][region]
            lines.append(
                f"  {region}: MAE=${rr['mae']:.2f}, RMSE=${rr['rmse']:.2f}, "
                f"MAPE={rr['mape']:.1f}%, Spike F1={rr.get('spike_f1', 0):.3f}"
            )
        lines.append("")
        lines.append("")

    report = "\n".join(lines)

    with open(output_path, "w") as f:
        f.write(report)

    logger.info(f"Evaluation report saved to {output_path}")
    return report
