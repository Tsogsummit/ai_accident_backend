#!/bin/bash

# ==========================================
# Quick Fix Script for Admin Service Build
# ==========================================

set -e

echo "🔧 Applying Admin Service Build Fix..."
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Check if we're in the right directory
if [ ! -f "docker-compose.yml" ]; then
    echo -e "${RED}❌ Error: docker-compose.yml not found${NC}"
    echo "Please run this script from your project root directory"
    exit 1
fi

# Check if admin service directory exists
if [ ! -d "services/admin-service" ]; then
    echo -e "${RED}❌ Error: services/admin-service directory not found${NC}"
    exit 1
fi

# Backup existing files
echo "📦 Creating backup..."
mkdir -p .backup/admin-service
cp services/admin-service/Dockerfile .backup/admin-service/ 2>/dev/null || true
cp services/admin-service/package.json .backup/admin-service/ 2>/dev/null || true
echo -e "${GREEN}✅ Backup created in .backup/admin-service/${NC}"
echo ""

# Update Dockerfile
echo "📝 Updating Dockerfile..."
cat > services/admin-service/Dockerfile << 'EOF'
# ==========================================
# Admin Service - Dockerfile
# ==========================================

FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./

RUN npm install --omit=dev && \
    npm cache clean --force

# Copy application files
COPY . .

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3009/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

EXPOSE 3009

CMD ["node", "server.js"]
EOF

# Update .dockerignore if it doesn't exist
if [ ! -f "services/admin-service/.dockerignore" ]; then
    echo "📝 Creating .dockerignore..."
    cat > services/admin-service/.dockerignore << 'EOF'
node_modules/
npm-debug.log*
yarn-debug.log*
.env
.env.local
.vscode/
.idea/
.DS_Store
Thumbs.db
.git/
.gitignore
coverage/
logs/
*.log
tmp/
temp/
README.md
docs/
Dockerfile
.dockerignore
docker-compose*.yml
EOF
fi

echo -e "${GREEN}✅ Files updated${NC}"
echo ""

# Stop and remove old containers
echo "🛑 Stopping admin service..."
docker-compose stop admin-service 2>/dev/null || true
docker-compose rm -f admin-service 2>/dev/null || true

# Clean build
echo ""
echo "🏗️  Building admin service (this may take 1-2 minutes)..."
echo ""

if docker-compose build --no-cache admin-service; then
    echo ""
    echo -e "${GREEN}✅ Build successful!${NC}"
    echo ""
    
    # Start the service
    echo "🚀 Starting admin service..."
    docker-compose up -d admin-service
    
    echo ""
    echo "⏳ Waiting for service to initialize (30 seconds)..."
    sleep 30
    
    echo ""
    echo "🔍 Checking service health..."
    
    if curl -s http://localhost:3009/health > /dev/null 2>&1; then
        echo -e "${GREEN}✅ Admin service is healthy!${NC}"
        echo ""
        echo "📊 Service Status:"
        curl -s http://localhost:3009/health | jq . 2>/dev/null || curl -s http://localhost:3009/health
        echo ""
        echo ""
        echo -e "${GREEN}🎉 SUCCESS! Admin service is running!${NC}"
        echo ""
        echo "🌐 Access your admin dashboard:"
        echo "   URL: ${GREEN}http://localhost:3009${NC}"
        echo "   Login: admin"
        echo "   Password: admin123"
        echo ""
    else
        echo -e "${YELLOW}⚠️  Service is starting but not responding yet${NC}"
        echo ""
        echo "Please wait a few more seconds and check:"
        echo "  docker-compose logs -f admin-service"
        echo ""
        echo "Or verify manually:"
        echo "  curl http://localhost:3009/health"
    fi
else
    echo ""
    echo -e "${RED}❌ Build failed${NC}"
    echo ""
    echo "Troubleshooting steps:"
    echo "1. Check the error messages above"
    echo "2. Verify internet connection"
    echo "3. Try: docker system prune -a"
    echo "4. Check logs: docker-compose logs admin-service"
    echo ""
    echo "Your original files are backed up in: .backup/admin-service/"
    exit 1
fi

echo ""
echo "📖 For more information, see BUILD_FIX.md"