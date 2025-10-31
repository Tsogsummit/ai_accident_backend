#!/bin/bash

# ==========================================
# Admin Service Verification Script
# ==========================================

echo "🔍 Verifying Admin Service Setup..."
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if Docker is running
echo -n "Checking Docker... "
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}❌ Docker is not running${NC}"
    exit 1
fi
echo -e "${GREEN}✅${NC}"

# Check if admin service container exists
echo -n "Checking admin service container... "
if docker-compose ps admin-service | grep -q "Up"; then
    echo -e "${GREEN}✅ Running${NC}"
else
    echo -e "${RED}❌ Not running${NC}"
    echo ""
    echo "Starting admin service..."
    docker-compose up -d admin-service
    sleep 5
fi

# Check if required files exist
echo ""
echo "Checking required files:"
files=(
    "services/admin-service/Dockerfile"
    "services/admin-service/package.json"
    "services/admin-service/.dockerignore"
    "services/admin-service/server.js"
)

for file in "${files[@]}"; do
    echo -n "  $file... "
    if [ -f "$file" ]; then
        echo -e "${GREEN}✅${NC}"
    else
        echo -e "${RED}❌ Missing${NC}"
    fi
done

# Check health endpoint
echo ""
echo -n "Checking health endpoint... "
if curl -s http://localhost:3009/health > /dev/null 2>&1; then
    echo -e "${GREEN}✅${NC}"
    echo ""
    echo "Health Status:"
    curl -s http://localhost:3009/health | jq . 2>/dev/null || curl -s http://localhost:3009/health
else
    echo -e "${RED}❌ Cannot connect${NC}"
fi

# Check login page
echo ""
echo -n "Checking login page... "
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3009/login.html | grep -q "200"; then
    echo -e "${GREEN}✅ Accessible${NC}"
else
    echo -e "${RED}❌ Not accessible${NC}"
fi

# Check database connection
echo ""
echo -n "Checking database connection... "
if docker-compose exec -T postgres pg_isready > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Connected${NC}"
else
    echo -e "${RED}❌ Disconnected${NC}"
fi

# Check Redis connection
echo ""
echo -n "Checking Redis connection... "
if docker-compose exec -T redis redis-cli ping > /dev/null 2>&1; then
    echo -e "${GREEN}✅ Connected${NC}"
else
    echo -e "${RED}❌ Disconnected${NC}"
fi

# Show admin service logs (last 20 lines)
echo ""
echo "Recent admin service logs:"
echo "─────────────────────────────────────────────"
docker-compose logs --tail=20 admin-service
echo "─────────────────────────────────────────────"

# Summary
echo ""
echo "📊 Summary:"
echo "  Admin Dashboard: ${GREEN}http://localhost:3009${NC}"
echo "  Login Page: ${GREEN}http://localhost:3009/login.html${NC}"
echo "  Default User: admin"
echo "  Default Pass: admin123"
echo ""

# Test login (optional)
echo "Testing admin login API..."
response=$(curl -s -X POST http://localhost:3009/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin123"}')

if echo "$response" | grep -q "success.*true"; then
    echo -e "${GREEN}✅ Admin login working!${NC}"
    echo ""
    echo -e "${GREEN}🎉 All checks passed! Admin service is ready.${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Open http://localhost:3009 in your browser"
    echo "  2. Login with: admin / admin123"
    echo "  3. Change the default password"
else
    echo -e "${YELLOW}⚠️  Login test failed or admin user not created yet${NC}"
    echo "Response: $response"
    echo ""
    echo "You may need to:"
    echo "  1. Wait for database initialization"
    echo "  2. Check database logs: docker-compose logs postgres"
    echo "  3. Restart services: docker-compose restart"
fi

echo ""
echo "🔧 Useful commands:"
echo "  View logs: docker-compose logs -f admin-service"
echo "  Restart: docker-compose restart admin-service"
echo "  Rebuild: docker-compose build admin-service && docker-compose up -d admin-service"
echo "  Shell: docker-compose exec admin-service sh"    