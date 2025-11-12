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

# Download YOLOv8 model (optional, will download on first run if not present)
RUN mkdir -p /app/models

ENV PORT=3004 \
    MODEL_PATH=/app/models/yolov8n.pt \
    PYTHONUNBUFFERED=1

EXPOSE 3004

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3004"]