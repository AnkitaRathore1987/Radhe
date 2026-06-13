FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package.json ./
RUN npm install --production

# Copy source code
COPY . .

# Non-root user for security
RUN addgroup -g 1001 -S aladdin && \
    adduser  -u 1001 -S aladdin -G aladdin
USER aladdin

CMD ["node", "backend/gateway/gateway.js"]
