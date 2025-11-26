FROM node:20-alpine
WORKDIR /app

# Copy shared module from project root
COPY shared/ ./shared/

# Copy service package files
COPY services/user-service/package*.json ./
RUN npm install --production

# Copy service code
COPY services/user-service/ ./

EXPOSE 3001
CMD ["node", "server.js"]
