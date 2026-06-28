"""NSW price-forecast subsystem.

A small, pluggable forecasting layer that sits on top of the actuals
(`nem_dispatch_price`) and AEMO forecast (`nem_predispatch_price`) we already
ingest. It powers the dedicated **Forecast** page:

- `models.py`  — the model registry (AEMO / Naive / Residual / Amber / ML stub).
  This *is* the "our own forecast structure": a `ForecastModel` interface plus
  concrete implementations, so new models drop in without touching routes/UI.
- `data.py`    — shared time + half-hour aggregation helpers (NEM time, 30-min
  trading grid) reused by every model.
- `eval.py`    — forward forecast logging (locked day-ahead vintage), startup
  seeding/backtest, accuracy metrics, and the live series builder.

v1 scope: NSW1 only, day-ahead (~next 24h) at 30-min resolution. Region is a
parameter throughout so other states are a config change, not a rewrite.
"""
