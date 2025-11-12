#!/bin/bash
# Focused Camera Service Diagnostics

echo "=== 1. Check if container is running ==="
docker ps | grep camera-service
echo ""

echo "=== 2. Service startup message ==="
docker logs camera-service 2>&1 | grep -i "running on port\|listening\|started"
echo ""

echo "=== 3. Database connection status ==="
docker logs camera-service 2>&1 | grep -i "database\|postgres" | tail -5
echo ""

echo "=== 4. Any ERROR messages ==="
docker logs camera-service 2>&1 | grep -i "error" | tail -10
echo ""

echo "=== 5. Test health endpoint directly ==="
curl -s http://localhost:3008/health 2>&1 | head -20
echo ""

echo "=== 6. Test from admin service container ==="
docker exec admin-service curl -s http://camera-service:3008/health 2>&1 | head -20
echo ""

echo "=== 7. Check what port camera-service is listening on ==="
docker exec camera-service netstat -tuln 2>/dev/null | grep -E "3008|LISTEN" || echo "netstat not available, trying alternative..."
docker exec camera-service ss -tuln 2>/dev/null | grep -E "3008|LISTEN" || echo "ss not available either"
echo ""

echo "=== 8. Environment check ==="
docker exec camera-service printenv | grep -E "^PORT=|^DB_HOST=|^DB_PORT=|^NODE_ENV="
echo ""
