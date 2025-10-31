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