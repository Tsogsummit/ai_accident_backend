FROM python:3.11-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Copy models
RUN mkdir -p /app/models
COPY models/yolov8m.pt /app/models/yolov8m.pt
COPY models/accident_classifier.pt /app/models/accident_classifier.pt

ENV PORT=3004 \
    MODEL_PATH=/app/models/yolov8m.pt \
    AI_CONFIDENCE_THRESHOLD=0.30 \
    AI_IOU_THRESHOLD=0.45 \
    AI_MAX_DETECTIONS=300 \
    PYTHONUNBUFFERED=1

EXPOSE 3004

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3004"]