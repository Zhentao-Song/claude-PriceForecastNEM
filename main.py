#!/usr/bin/env python3
"""
NEM 5-Minute Price Forecasting Pipeline

End-to-end pipeline:
1. Download NEM data from AEMO (via NEMOSIS/NEMSEER)
2. Feature engineering (lags, rolling stats, calendar, spreads)
3. Train GNN-Transformer hybrid model with quantile regression
4. Evaluate with regression, probabilistic, and spike metrics

Usage:
    python main.py                          # Full pipeline
    python main.py --mode download          # Download data only
    python main.py --mode train             # Train model only (requires data)
    python main.py --mode evaluate          # Evaluate only (requires trained model)
    python main.py --config custom.yaml     # Use custom config
"""

import argparse
import logging
import sys
from pathlib import Path

import torch

from src.utils.config import load_config, get_device
from src.utils.logger import setup_logger
from src.data.download import NEMDataDownloader
from src.data.dataset import create_dataloaders
from src.features.engineer import FeatureEngineer
from src.models.gnn_transformer import GNNTransformerModel
from src.training.trainer import Trainer
from src.evaluation.metrics import evaluate_forecasts, generate_report


def parse_args():
    parser = argparse.ArgumentParser(description="NEM Price Forecasting")
    parser.add_argument(
        "--config", type=str, default="config.yaml",
        help="Path to configuration YAML file",
    )
    parser.add_argument(
        "--mode", type=str, default="full",
        choices=["full", "download", "features", "train", "evaluate"],
        help="Pipeline mode",
    )
    parser.add_argument(
        "--checkpoint", type=str, default=None,
        help="Path to model checkpoint for evaluation",
    )
    return parser.parse_args()


def run_download(config: dict, logger: logging.Logger):
    """Step 1: Download NEM data."""
    logger.info("=" * 60)
    logger.info("STEP 1: Data Download")
    logger.info("=" * 60)

    downloader = NEMDataDownloader(config)
    merged_df = downloader.build_merged_dataset()
    logger.info(f"Downloaded data shape: {merged_df.shape}")
    logger.info(f"Date range: {merged_df['SETTLEMENTDATE'].min()} to {merged_df['SETTLEMENTDATE'].max()}")
    logger.info(f"Regions: {merged_df['REGIONID'].unique().tolist()}")

    return merged_df


def run_features(config: dict, logger: logging.Logger, df=None):
    """Step 2: Feature engineering."""
    logger.info("=" * 60)
    logger.info("STEP 2: Feature Engineering")
    logger.info("=" * 60)

    import pandas as pd

    if df is None:
        processed_path = Path(config["data"]["processed_dir"]) / "nem_merged.parquet"
        if not processed_path.exists():
            raise FileNotFoundError(
                f"No processed data found at {processed_path}. "
                "Run with --mode download first."
            )
        df = pd.read_parquet(processed_path)

    engineer = FeatureEngineer(config)
    featured_df = engineer.transform(df)

    # Save featured data
    out_path = Path(config["data"]["processed_dir"]) / "nem_featured.parquet"
    featured_df.to_parquet(out_path, index=False)
    logger.info(f"Saved featured data to {out_path}: {featured_df.shape}")

    feature_cols = engineer.get_feature_columns(featured_df)
    logger.info(f"Feature columns ({len(feature_cols)}): {feature_cols[:10]}...")

    return featured_df, engineer, feature_cols


def run_train(config: dict, logger: logging.Logger, featured_df=None, feature_cols=None):
    """Step 3: Model training."""
    logger.info("=" * 60)
    logger.info("STEP 3: Model Training")
    logger.info("=" * 60)

    import pandas as pd

    if featured_df is None:
        featured_path = Path(config["data"]["processed_dir"]) / "nem_featured.parquet"
        if not featured_path.exists():
            raise FileNotFoundError(
                f"No featured data at {featured_path}. "
                "Run with --mode features first."
            )
        featured_df = pd.read_parquet(featured_path)

    if feature_cols is None:
        engineer = FeatureEngineer(config)
        feature_cols = engineer.get_feature_columns(featured_df)

    # Create data loaders
    device = get_device(config["training"]["device"])
    logger.info(f"Using device: {device}")

    train_loader, val_loader, test_loader = create_dataloaders(
        featured_df, feature_cols, config,
    )

    # Build model
    num_features = len(feature_cols)
    model_cfg = config["model"]

    model = GNNTransformerModel(
        num_features=num_features,
        num_regions=5,
        seq_len=model_cfg["seq_len"],
        pred_horizons=model_cfg["pred_horizons"],
        quantiles=model_cfg["quantiles"],
        gnn_hidden_dim=model_cfg["gnn"]["hidden_dim"],
        gnn_num_layers=model_cfg["gnn"]["num_layers"],
        d_model=model_cfg["transformer"]["d_model"],
        nhead=model_cfg["transformer"]["nhead"],
        num_transformer_layers=model_cfg["transformer"]["num_layers"],
        dim_feedforward=model_cfg["transformer"]["dim_feedforward"],
        dropout=model_cfg["transformer"]["dropout"],
    )

    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info(f"Model parameters: {total_params:,} total, {trainable_params:,} trainable")

    # Train
    trainer = Trainer(model, config, device)
    history = trainer.train(train_loader, val_loader)

    return model, test_loader, history


def run_evaluate(
    config: dict,
    logger: logging.Logger,
    model=None,
    test_loader=None,
    checkpoint_path=None,
):
    """Step 4: Evaluation."""
    logger.info("=" * 60)
    logger.info("STEP 4: Evaluation")
    logger.info("=" * 60)

    import pandas as pd

    device = get_device(config["training"]["device"])
    engineer = FeatureEngineer(config)

    if model is None:
        if checkpoint_path is None:
            checkpoint_path = Path(config["training"]["checkpoint_dir"]) / "best_model.pt"
        if not Path(checkpoint_path).exists():
            raise FileNotFoundError(f"No checkpoint at {checkpoint_path}")

        state = torch.load(checkpoint_path, map_location=device, weights_only=False)

        featured_df = pd.read_parquet(
            Path(config["data"]["processed_dir"]) / "nem_featured.parquet"
        )
        feature_cols = engineer.get_feature_columns(featured_df)

        model = GNNTransformerModel(
            num_features=len(feature_cols),
            **{k: v for k, v in config["model"].items() if k not in ["type", "quantiles", "pred_horizons", "gnn", "transformer"]},
            pred_horizons=config["model"]["pred_horizons"],
            quantiles=config["model"]["quantiles"],
            gnn_hidden_dim=config["model"]["gnn"]["hidden_dim"],
            gnn_num_layers=config["model"]["gnn"]["num_layers"],
            d_model=config["model"]["transformer"]["d_model"],
            nhead=config["model"]["transformer"]["nhead"],
            num_transformer_layers=config["model"]["transformer"]["num_layers"],
            dim_feedforward=config["model"]["transformer"]["dim_feedforward"],
            dropout=config["model"]["transformer"]["dropout"],
        )
        model.load_state_dict(state["model_state_dict"])
        model = model.to(device)

    if test_loader is None:
        featured_df = pd.read_parquet(
            Path(config["data"]["processed_dir"]) / "nem_featured.parquet"
        )
        feature_cols = engineer.get_feature_columns(featured_df)
        _, _, test_loader = create_dataloaders(featured_df, feature_cols, config)

    # Run evaluation
    results = evaluate_forecasts(model, test_loader, engineer, device, config)

    # Generate report
    report = generate_report(results, "evaluation_report.txt")
    print("\n" + report)

    return results


def main():
    args = parse_args()
    config = load_config(args.config)
    logger = setup_logger()

    logger.info("NEM 5-Minute Price Forecasting Pipeline")
    logger.info(f"Mode: {args.mode}")
    logger.info(f"Config: {args.config}")

    try:
        if args.mode == "download":
            run_download(config, logger)

        elif args.mode == "features":
            run_features(config, logger)

        elif args.mode == "train":
            run_train(config, logger)

        elif args.mode == "evaluate":
            run_evaluate(config, logger, checkpoint_path=args.checkpoint)

        elif args.mode == "full":
            # Full pipeline
            df = run_download(config, logger)
            featured_df, engineer, feature_cols = run_features(config, logger, df)
            model, test_loader, history = run_train(
                config, logger, featured_df, feature_cols,
            )
            results = run_evaluate(config, logger, model, test_loader)

            logger.info("=" * 60)
            logger.info("Pipeline complete!")
            logger.info("=" * 60)

    except Exception as e:
        logger.error(f"Pipeline failed: {e}", exc_info=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
