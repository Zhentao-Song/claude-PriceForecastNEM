# Reuse the locally-cached Python image from the parent forecasting project
# (already has Python 3.12 + fastapi + uvicorn). Avoids Docker Hub pulls,
# which are unreliable on this network.
FROM nem-price-forecast-nem-forecast:latest

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple

WORKDIR /app

# Install only what's missing on top of the cached base. SQLite is in stdlib.
RUN pip install --break-system-packages \
        httpx \
        apscheduler \
        sse-starlette \
        python-dateutil

COPY app ./app

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
