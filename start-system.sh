#!/bin/bash

# AI Accident Detection System - Docker Startup Script
# =====================================================

echo "🚀 Starting AI Accident Detection System..."
echo ""

# Check if Docker is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker is not running. Please start Docker first."
    exit 1
fi

# Check if docker-compose is available
if ! command -v docker-compose &> /dev/null; then
    echo "❌ docker-compose is not installed."
    exit 1
fi

echo "✅ Docker is running"
echo ""

# Stop any running containers
echo "🛑 Stopping any existing containers..."
docker-compose down

# Remove old volumes (optional - uncomment if needed)
# docker volume prune -f

echo ""
echo "🔧 Building and starting services..."
docker-compose up -d --build

echo ""
echo "⏳ Waiting for services to be ready..."
sleep 10

# Check service health
echo ""
echo "🏥 Checking service health..."
echo ""

services=(
    "postgres:5432"
    "redis:6379"
    "api-gateway:3000"
    "user-service:3001"
    "accident-service:3002"
    "video-service:3003"
    "ai-detection-service:3004"
    "notification-service:3005"
    "map-service:3006"
    "report-service:3007"
    "camera-service:3008"
    "admin-service:3009"
)

for service in "${services[@]}"; do
    name=${service%:*}
    port=${service#*:}
    
    if docker-compose ps | grep -q "$name.*Up"; then
        echo "✅ $name (port $port) - Running"
    else
        echo "❌ $name (port $port) - Not running"
    fi
done

echo ""
echo "📋 Service URLs:"
echo "   🌐 API Gateway:        http://localhost:3000"
echo "   👥 User Service:       http://localhost:3001"
echo "   🚨 Accident Service:   http://localhost:3002"
echo "   📹 Video Service:      http://localhost:3003"
echo "   🤖 AI Service:         http://localhost:3004"
echo "   🔔 Notification:       http://localhost:3005"
echo "   🗺️  Map Service:        http://localhost:3006"
echo "   📊 Report Service:     http://localhost:3007"
echo "   📷 Camera Service:     http://localhost:3008"
echo "   👨‍💼 Admin Dashboard:   http://localhost:3009"
echo ""
echo "📝 Default Admin Login:"
echo "   Username: admin"
echo "   Password: admin123"
echo "   URL: http://localhost:3009/login.html"
echo ""
echo "✅ System startup complete!"
echo ""
echo "📖 View logs with: docker-compose logs -f [service-name]"
echo "🛑 Stop system with: docker-compose down"