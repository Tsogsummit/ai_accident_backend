FROM python:3.11-slim

LABEL maintainer="Tsog - Tselmeg Digital School"
LABEL description="AI Accident Detection Service - Improved v2.0"

# System dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgl1-mesa-glx \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY utils/ ./utils/

# Create directories
RUN mkdir -p /app/models /app/logs /tmp

# Download YOLOv8m model on build (optional - will auto-download if needed)
RUN python -c "from ultralytics import YOLO; YOLO('yolov8m.pt')" || echo "Model will download on first run"

# Environment variables
ENV PORT=3004 \
    MODEL_PATH=/root/.ultralytics/models/yolov8m.pt \
    AI_CONFIDENCE_THRESHOLD=0.4 \
    AI_FRAME_INTERVAL=1.0 \
    AI_MAX_FRAMES=300 \
    TRACKING_MAX_AGE=3 \
    TRACKING_MIN_HITS=3 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app

# Expose port
EXPOSE 3004

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD python -c "import requests; requests.get('http://localhost:3004/health')" || exit 1

# Run application
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3004", "--workers", "1"]