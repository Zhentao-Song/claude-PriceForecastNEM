"""Logging setup."""

import logging
import sys
from pathlib import Path


def setup_logger(name: str = "nem_forecast", log_dir: str = "logs") -> logging.Logger:
    """Set up a logger with console and file handlers."""
    logger = logging.getLogger(name)
    if logger.handlers:
        return logger

    logger.setLevel(logging.INFO)
    formatter = logging.Formatter(
        "%(asctime)s | %(levelname)-8s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(formatter)
    logger.addHandler(console)

    # File handler
    log_path = Path(log_dir)
    log_path.mkdir(parents=True, exist_ok=True)
    file_handler = logging.FileHandler(log_path / "training.log")
    file_handler.setFormatter(formatter)
    logger.addHandler(file_handler)

    return logger
