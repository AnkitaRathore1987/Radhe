#!/bin/bash
# ═══════════════════════════════════════════════════
# STARTUP SCRIPT — Run at 9:00 AM every trading day
# ═══════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/../.."

echo "================================================"
echo "  MINI-ALADDIN STARTUP — $(date)"
echo "================================================"

# 1. Load env
export $(grep -v '^#' config/.env | xargs)

# 2. Check Oracle VPS connectivity
echo "[1/6] Checking Redis..."
redis-cli -a "$REDIS_PASSWORD" ping || { echo "ERROR: Redis not responding"; exit 1; }
echo "Redis OK"

# 3. Check PostgreSQL
echo "[2/6] Checking PostgreSQL..."
pg_isready -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" -d "$PG_DATABASE" \
  || { echo "ERROR: PostgreSQL not ready"; exit 1; }
echo "PostgreSQL OK"

# 4. Reset daily risk counters in Redis
echo "[3/6] Resetting daily risk counters..."
redis-cli -a "$REDIS_PASSWORD" hset risk:daily pnl 0 trades 0 date "$(date +%Y-%m-%d)"
redis-cli -a "$REDIS_PASSWORD" set risk:consecutive_losses 0
echo "Risk counters reset"

# 5. Load causal rules to Redis
echo "[4/6] Loading causal rules..."
node -e "
  const Redis = require('ioredis');
  const rules = require('./backend/knowledge/causal-rules.json');
  const redis = new Redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD });
  redis.set('causal:rules', JSON.stringify(rules), 'EX', 86400)
    .then(() => { console.log('Rules loaded'); redis.disconnect(); process.exit(0); })
    .catch(e => { console.error(e.message); process.exit(1); });
"
echo "Causal rules loaded"

# 6. Refresh Upstox token (interactive — opens browser)
echo "[5/6] Refreshing Upstox token..."
echo "  → Open browser and complete OAuth login"
echo "  → Or set UPSTOX_ACCESS_TOKEN manually in config/.env"
# node infra/scripts/auth-upstox.js  # Uncomment when auth script is ready

# 7. Start all services
echo "[6/6] Starting services via Docker..."
cd infra/docker
docker-compose up -d
docker-compose ps

echo ""
echo "================================================"
echo "  ALL SYSTEMS UP — Ready for 9:15 AM"
echo "================================================"
echo "  Watch logs: docker-compose logs -f gateway"
echo "  Kill switch: /KILLSWITCH via Telegram"
echo "  Status: /STATUS via Telegram"
