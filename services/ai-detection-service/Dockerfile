# services/ai-detection-service/Dockerfile
FROM python:3.11-slim

# шаардлагатай системийн package-ууд
RUN apt-get update && apt-get install -y \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .

ENV PORT=3004 MODEL_PATH=/app/models/yolov8n.pt
EXPOSE 3004
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3004"]
