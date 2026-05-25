"""
GNN-Transformer Hybrid Model for NEM Price Forecasting.

Architecture:
1. GNN layers capture spatial dependencies across 5 NEM regions
   (interconnector-based graph structure)
2. Transformer decoder layers capture temporal patterns
3. Quantile regression head outputs probabilistic forecasts

The model processes multi-region time series data where:
- Each node = a NEM region
- Each edge = an interconnector between regions
- Temporal features are processed per-node, then aggregated via GNN
"""

import math
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F


class RegionGNNLayer(nn.Module):
    """Graph attention layer for inter-regional message passing.

    Uses attention mechanism to weight messages from connected regions,
    mimicking how interconnector flows affect regional prices.
    """

    def __init__(self, in_dim: int, out_dim: int, num_heads: int = 4):
        super().__init__()
        self.num_heads = num_heads
        self.head_dim = out_dim // num_heads
        assert out_dim % num_heads == 0

        self.W_q = nn.Linear(in_dim, out_dim, bias=False)
        self.W_k = nn.Linear(in_dim, out_dim, bias=False)
        self.W_v = nn.Linear(in_dim, out_dim, bias=False)
        self.W_o = nn.Linear(out_dim, out_dim)
        self.norm = nn.LayerNorm(out_dim)
        self.ffn = nn.Sequential(
            nn.Linear(out_dim, out_dim * 2),
            nn.GELU(),
            nn.Linear(out_dim * 2, out_dim),
        )
        self.norm2 = nn.LayerNorm(out_dim)

    def forward(self, x: torch.Tensor, edge_index: torch.Tensor) -> torch.Tensor:
        """
        Args:
            x: Node features [batch, num_nodes, dim]
            edge_index: Edge indices [2, num_edges]

        Returns:
            Updated node features [batch, num_nodes, dim]
        """
        B, N, D = x.shape
        src, dst = edge_index  # source and destination nodes

        Q = self.W_q(x).view(B, N, self.num_heads, self.head_dim)
        K = self.W_k(x).view(B, N, self.num_heads, self.head_dim)
        V = self.W_v(x).view(B, N, self.num_heads, self.head_dim)

        # Compute attention only for connected node pairs
        # For small graph (5 nodes), we can do full attention masked by adjacency
        # Build adjacency mask [N, N]
        adj_mask = torch.zeros(N, N, device=x.device, dtype=torch.bool)
        adj_mask[dst, src] = True
        # Self-loops
        adj_mask.fill_diagonal_(True)

        # Compute attention scores [B, heads, N, N]
        Q = Q.permute(0, 2, 1, 3)  # [B, heads, N, head_dim]
        K = K.permute(0, 2, 1, 3)
        V = V.permute(0, 2, 1, 3)

        scores = torch.matmul(Q, K.transpose(-2, -1)) / math.sqrt(self.head_dim)

        # Mask non-adjacent nodes
        scores = scores.masked_fill(~adj_mask.unsqueeze(0).unsqueeze(0), float("-inf"))
        attn = F.softmax(scores, dim=-1)

        out = torch.matmul(attn, V)  # [B, heads, N, head_dim]
        out = out.permute(0, 2, 1, 3).reshape(B, N, -1)  # [B, N, dim]
        out = self.W_o(out)

        # Residual + norm
        x = self.norm(x + out)
        x = self.norm2(x + self.ffn(x))

        return x


class TemporalTransformerBlock(nn.Module):
    """Decoder-only Transformer block for temporal sequence modeling."""

    def __init__(self, d_model: int, nhead: int, dim_feedforward: int, dropout: float = 0.1):
        super().__init__()
        self.self_attn = nn.MultiheadAttention(
            d_model, nhead, dropout=dropout, batch_first=True,
        )
        self.norm1 = nn.LayerNorm(d_model)
        self.ffn = nn.Sequential(
            nn.Linear(d_model, dim_feedforward),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(dim_feedforward, d_model),
            nn.Dropout(dropout),
        )
        self.norm2 = nn.LayerNorm(d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, x: torch.Tensor, mask: Optional[torch.Tensor] = None) -> torch.Tensor:
        """
        Args:
            x: [batch, seq_len, d_model]
            mask: Causal attention mask [seq_len, seq_len]
        """
        attn_out, _ = self.self_attn(x, x, x, attn_mask=mask, is_causal=(mask is None))
        x = self.norm1(x + self.dropout(attn_out))
        x = self.norm2(x + self.ffn(x))
        return x


class PositionalEncoding(nn.Module):
    """Sinusoidal positional encoding."""

    def __init__(self, d_model: int, max_len: int = 2048):
        super().__init__()
        pe = torch.zeros(max_len, d_model)
        position = torch.arange(0, max_len, dtype=torch.float).unsqueeze(1)
        div_term = torch.exp(
            torch.arange(0, d_model, 2).float() * (-math.log(10000.0) / d_model)
        )
        pe[:, 0::2] = torch.sin(position * div_term)
        pe[:, 1::2] = torch.cos(position * div_term)
        self.register_buffer("pe", pe.unsqueeze(0))  # [1, max_len, d_model]

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.pe[:, :x.size(1)]


class GNNTransformerModel(nn.Module):
    """
    Hybrid GNN-Transformer for NEM 5-minute price forecasting.

    Pipeline:
    1. Input projection: raw features -> d_model dimension
    2. Positional encoding for temporal ordering
    3. GNN layers: capture inter-regional spatial dependencies at each timestep
    4. Transformer layers: capture temporal patterns (causal, decoder-only)
    5. Quantile regression head: output price quantiles per region per horizon

    Input shape: [batch, seq_len, num_regions, num_features]
    Output shape: [batch, num_horizons, num_regions, num_quantiles]
    """

    def __init__(
        self,
        num_features: int,
        num_regions: int = 5,
        seq_len: int = 288,
        pred_horizons: list[int] = None,
        quantiles: list[float] = None,
        # GNN params
        gnn_hidden_dim: int = 64,
        gnn_num_layers: int = 2,
        # Transformer params
        d_model: int = 128,
        nhead: int = 8,
        num_transformer_layers: int = 4,
        dim_feedforward: int = 512,
        dropout: float = 0.1,
        # Graph structure
        edge_index: Optional[torch.Tensor] = None,
    ):
        super().__init__()

        self.num_regions = num_regions
        self.seq_len = seq_len
        self.pred_horizons = pred_horizons or [1, 6, 12, 48]
        self.quantiles = quantiles or [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]
        self.d_model = d_model

        # Default NEM graph edges
        if edge_index is not None:
            self.register_buffer("edge_index", edge_index)
        else:
            edges = [
                [0, 1, 2, 0, 2, 3, 2, 4],  # source
                [1, 0, 0, 2, 3, 2, 4, 2],  # target
            ]
            self.register_buffer("edge_index", torch.tensor(edges, dtype=torch.long))

        # Input projection: per-region features -> d_model
        self.input_proj = nn.Sequential(
            nn.Linear(num_features, d_model),
            nn.GELU(),
            nn.LayerNorm(d_model),
        )

        # Region embedding (learnable per-region bias)
        self.region_embedding = nn.Embedding(num_regions, d_model)

        # Positional encoding
        self.pos_enc = PositionalEncoding(d_model, max_len=seq_len + max(self.pred_horizons))

        # GNN layers for spatial modeling
        self.gnn_layers = nn.ModuleList([
            RegionGNNLayer(d_model, d_model, num_heads=4)
            for _ in range(gnn_num_layers)
        ])

        # Transformer layers for temporal modeling
        self.transformer_layers = nn.ModuleList([
            TemporalTransformerBlock(d_model, nhead, dim_feedforward, dropout)
            for _ in range(num_transformer_layers)
        ])

        # Output heads: one per prediction horizon
        num_outputs = len(self.quantiles)
        self.output_heads = nn.ModuleDict({
            f"horizon_{h}": nn.Sequential(
                nn.Linear(d_model, d_model),
                nn.GELU(),
                nn.Dropout(dropout),
                nn.Linear(d_model, num_outputs),
            )
            for h in self.pred_horizons
        })

        # Spike probability head (binary classification per region)
        self.spike_head = nn.Sequential(
            nn.Linear(d_model, d_model // 2),
            nn.GELU(),
            nn.Linear(d_model // 2, len(self.pred_horizons)),
            nn.Sigmoid(),
        )

        self._init_weights()

    def _init_weights(self):
        for p in self.parameters():
            if p.dim() > 1:
                nn.init.xavier_uniform_(p)

    def forward(
        self,
        x: torch.Tensor,
        region_ids: Optional[torch.Tensor] = None,
    ) -> dict[str, torch.Tensor]:
        """
        Args:
            x: Input features [batch, seq_len, num_regions, num_features]
            region_ids: Region indices [num_regions] (default: 0..4)

        Returns:
            Dictionary with:
            - "quantiles": {horizon: [batch, num_regions, num_quantiles]}
            - "spike_prob": [batch, num_regions, num_horizons]
        """
        B, T, N, F = x.shape

        if region_ids is None:
            region_ids = torch.arange(N, device=x.device)

        # Project input features
        x = self.input_proj(x)  # [B, T, N, d_model]

        # Add region embeddings
        region_emb = self.region_embedding(region_ids)  # [N, d_model]
        x = x + region_emb.unsqueeze(0).unsqueeze(1)  # broadcast over B, T

        # Apply GNN at each timestep for spatial modeling
        # Reshape to process all timesteps at once: [B*T, N, d_model]
        x_spatial = x.reshape(B * T, N, self.d_model)
        for gnn_layer in self.gnn_layers:
            x_spatial = gnn_layer(x_spatial, self.edge_index)
        x = x_spatial.reshape(B, T, N, self.d_model)

        # Now process temporal dimension per region
        # Reshape: [B*N, T, d_model]
        x_temporal = x.permute(0, 2, 1, 3).reshape(B * N, T, self.d_model)
        x_temporal = self.pos_enc(x_temporal)

        # Causal mask for decoder-only transformer
        causal_mask = nn.Transformer.generate_square_subsequent_mask(T, device=x.device)

        for transformer_layer in self.transformer_layers:
            x_temporal = transformer_layer(x_temporal, mask=causal_mask)

        # Take the last timestep representation for prediction
        x_last = x_temporal[:, -1, :]  # [B*N, d_model]
        x_last = x_last.reshape(B, N, self.d_model)

        # Generate quantile forecasts per horizon
        quantile_outputs = {}
        for h in self.pred_horizons:
            head = self.output_heads[f"horizon_{h}"]
            quantile_outputs[h] = head(x_last)  # [B, N, num_quantiles]

        # Spike probability
        spike_prob = self.spike_head(x_last)  # [B, N, num_horizons]

        return {
            "quantiles": quantile_outputs,
            "spike_prob": spike_prob,
        }

    def predict(self, x: torch.Tensor) -> dict:
        """Convenience method for inference."""
        self.eval()
        with torch.no_grad():
            return self.forward(x)
