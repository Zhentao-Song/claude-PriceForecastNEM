"""
Training pipeline for the GNN-Transformer model.

Features:
- Quantile loss (pinball loss) for probabilistic forecasting
- Spike-aware loss weighting to improve extreme price prediction
- Early stopping on validation loss
- TensorBoard logging
- Checkpoint saving/loading
"""

import logging
import time
from pathlib import Path
from typing import Optional

import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torch.utils.tensorboard import SummaryWriter

from src.models.gnn_transformer import GNNTransformerModel

logger = logging.getLogger("nem_forecast.training")


class QuantileLoss(nn.Module):
    """Pinball loss for quantile regression.

    For each quantile q:
        L(y, y_hat) = q * max(y - y_hat, 0) + (1-q) * max(y_hat - y, 0)

    With optional spike weighting to emphasize extreme price events.
    """

    def __init__(self, quantiles: list[float], spike_weight: float = 5.0):
        super().__init__()
        self.quantiles = quantiles
        self.spike_weight = spike_weight
        self.register_buffer(
            "q_tensor", torch.tensor(quantiles, dtype=torch.float32)
        )

    def forward(
        self,
        predictions: torch.Tensor,
        targets: torch.Tensor,
        spike_mask: Optional[torch.Tensor] = None,
    ) -> torch.Tensor:
        """
        Args:
            predictions: [batch, num_regions, num_quantiles]
            targets: [batch, num_regions]
            spike_mask: [batch, num_regions] binary mask for spike events

        Returns:
            Scalar loss
        """
        # Expand targets for broadcasting: [batch, num_regions, 1]
        targets = targets.unsqueeze(-1)

        # Residuals: [batch, num_regions, num_quantiles]
        residuals = targets - predictions

        # Pinball loss per quantile
        loss = torch.max(self.q_tensor * residuals, (self.q_tensor - 1) * residuals)

        # Apply spike weighting
        if spike_mask is not None:
            weights = torch.ones_like(loss[:, :, 0])
            weights[spike_mask > 0] = self.spike_weight
            loss = loss * weights.unsqueeze(-1)

        return loss.mean()


class Trainer:
    """Training loop for NEM price forecasting model."""

    def __init__(
        self,
        model: GNNTransformerModel,
        config: dict,
        device: torch.device,
    ):
        self.model = model.to(device)
        self.device = device
        self.config = config

        train_cfg = config["training"]
        self.max_epochs = train_cfg["max_epochs"]
        self.patience = train_cfg["early_stopping_patience"]
        self.checkpoint_dir = Path(train_cfg["checkpoint_dir"])
        self.checkpoint_dir.mkdir(parents=True, exist_ok=True)
        self.log_dir = Path(train_cfg["log_dir"])

        # Optimizer
        self.optimizer = torch.optim.AdamW(
            model.parameters(),
            lr=train_cfg["learning_rate"],
            weight_decay=train_cfg["weight_decay"],
        )

        # Learning rate scheduler
        self.scheduler = torch.optim.lr_scheduler.CosineAnnealingWarmRestarts(
            self.optimizer, T_0=10, T_mult=2,
        )

        # Loss functions
        quantiles = config["model"]["quantiles"]
        self.quantile_loss = QuantileLoss(
            quantiles, spike_weight=train_cfg["spike_loss_weight"],
        ).to(device)

        self.spike_loss = nn.BCELoss()

        # TensorBoard
        self.writer = SummaryWriter(log_dir=str(self.log_dir))

        # Tracking
        self.best_val_loss = float("inf")
        self.patience_counter = 0
        self.global_step = 0

    def train(
        self,
        train_loader: DataLoader,
        val_loader: DataLoader,
    ) -> dict:
        """Run the full training loop."""
        logger.info(
            f"Starting training: {self.max_epochs} epochs, "
            f"{len(train_loader)} train batches, "
            f"{len(val_loader)} val batches, "
            f"device={self.device}"
        )

        history = {"train_loss": [], "val_loss": []}

        for epoch in range(1, self.max_epochs + 1):
            t0 = time.time()

            train_loss = self._train_epoch(train_loader, epoch)
            val_loss = self._validate(val_loader)

            self.scheduler.step()

            elapsed = time.time() - t0
            history["train_loss"].append(train_loss)
            history["val_loss"].append(val_loss)

            logger.info(
                f"Epoch {epoch}/{self.max_epochs} | "
                f"Train Loss: {train_loss:.6f} | "
                f"Val Loss: {val_loss:.6f} | "
                f"LR: {self.optimizer.param_groups[0]['lr']:.2e} | "
                f"Time: {elapsed:.1f}s"
            )

            # TensorBoard
            self.writer.add_scalar("loss/train", train_loss, epoch)
            self.writer.add_scalar("loss/val", val_loss, epoch)
            self.writer.add_scalar("lr", self.optimizer.param_groups[0]["lr"], epoch)

            # Early stopping check
            if val_loss < self.best_val_loss:
                self.best_val_loss = val_loss
                self.patience_counter = 0
                self._save_checkpoint(epoch, is_best=True)
                logger.info(f"  -> New best val loss: {val_loss:.6f}")
            else:
                self.patience_counter += 1
                if self.patience_counter >= self.patience:
                    logger.info(f"Early stopping at epoch {epoch}")
                    break

            # Periodic checkpoint
            if epoch % 10 == 0:
                self._save_checkpoint(epoch)

        self.writer.close()

        # Load best model
        self._load_best_checkpoint()

        return history

    def _train_epoch(self, loader: DataLoader, epoch: int) -> float:
        """Train for one epoch."""
        self.model.train()
        total_loss = 0.0
        num_batches = 0

        for batch in loader:
            x = batch["x"].to(self.device)  # [B, T, N, F]
            targets = batch["targets"]
            spike_targets = batch["spike_targets"]

            self.optimizer.zero_grad()

            # Forward pass
            output = self.model(x)

            # Compute loss across all horizons
            loss = torch.tensor(0.0, device=self.device)
            for h in self.model.pred_horizons:
                target_h = targets[h].to(self.device)
                spike_mask_h = spike_targets[h].to(self.device)
                pred_h = output["quantiles"][h]

                loss = loss + self.quantile_loss(pred_h, target_h, spike_mask_h)

            # Spike classification loss (smaller weight)
            spike_prob = output["spike_prob"]  # [B, N, num_horizons]
            for i, h in enumerate(self.model.pred_horizons):
                spike_target_h = spike_targets[h].to(self.device)
                loss = loss + 0.1 * self.spike_loss(
                    spike_prob[:, :, i], spike_target_h,
                )

            loss.backward()
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), max_norm=1.0)
            self.optimizer.step()

            total_loss += loss.item()
            num_batches += 1
            self.global_step += 1

        return total_loss / max(num_batches, 1)

    @torch.no_grad()
    def _validate(self, loader: DataLoader) -> float:
        """Validate on the validation set."""
        self.model.eval()
        total_loss = 0.0
        num_batches = 0

        for batch in loader:
            x = batch["x"].to(self.device)
            targets = batch["targets"]
            spike_targets = batch["spike_targets"]

            output = self.model(x)

            loss = torch.tensor(0.0, device=self.device)
            for h in self.model.pred_horizons:
                target_h = targets[h].to(self.device)
                spike_mask_h = spike_targets[h].to(self.device)
                pred_h = output["quantiles"][h]
                loss = loss + self.quantile_loss(pred_h, target_h, spike_mask_h)

            total_loss += loss.item()
            num_batches += 1

        return total_loss / max(num_batches, 1)

    def _save_checkpoint(self, epoch: int, is_best: bool = False):
        """Save model checkpoint."""
        state = {
            "epoch": epoch,
            "model_state_dict": self.model.state_dict(),
            "optimizer_state_dict": self.optimizer.state_dict(),
            "scheduler_state_dict": self.scheduler.state_dict(),
            "best_val_loss": self.best_val_loss,
            "config": self.config,
        }

        if is_best:
            path = self.checkpoint_dir / "best_model.pt"
        else:
            path = self.checkpoint_dir / f"checkpoint_epoch_{epoch}.pt"

        torch.save(state, path)
        logger.info(f"Saved checkpoint: {path}")

    def _load_best_checkpoint(self):
        """Load the best model checkpoint."""
        path = self.checkpoint_dir / "best_model.pt"
        if path.exists():
            state = torch.load(path, map_location=self.device, weights_only=False)
            self.model.load_state_dict(state["model_state_dict"])
            logger.info(f"Loaded best model from epoch {state['epoch']}")
