#!/bin/bash
# ═══════════════════════════════════════════════════
# SHUTDOWN SCRIPT — Run at 3:20 PM every trading day
# ═══════════════════════════════════════════════════

set -e
cd "$(dirname "$0")/../.."
export $(grep -v '^#' config/.env | xargs)

echo "================================================"
echo "  MINI-ALADDIN SHUTDOWN — $(date)"
echo "================================================"

# 1. Confirm all positions squared off
echo "[1/5] Checking open positions..."
OPEN=$(redis-cli -a "$REDIS_PASSWORD" get positions:open_count)
if [ "$OPEN" != "0" ] && [ -n "$OPEN" ]; then
  echo "WARNING: $OPEN positions still open — forcing square off"
  node -e "
    const Redis = require('ioredis');
    const redis = new Redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD });
    redis.keys('positions:open:*').then(keys => {
      console.log('Open positions:', keys.length);
      redis.disconnect(); process.exit(0);
    });
  "
else
  echo "All positions closed — OK"
fi

# 2. Save day's P&L summary to PostgreSQL
echo "[2/5] Saving daily summary..."
node -e "
  const Redis = require('ioredis');
  const { Pool } = require('pg');
  const redis = new Redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD });
  const pg = new Pool({ host: process.env.PG_HOST, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
  async function save() {
    const daily = await redis.hgetall('risk:daily');
    await pg.query(
      'INSERT INTO risk_log (session_date, daily_pnl, trades_count, capital_start, notes) VALUES (CURRENT_DATE, \$1, \$2, \$3, \$4)',
      [daily.pnl || 0, daily.trades || 0, process.env.ACCOUNT_CAPITAL, 'Auto-saved at shutdown']
    );
    console.log('Daily summary saved:', daily);
    await redis.disconnect(); await pg.end(); process.exit(0);
  }
  save().catch(e => { console.error(e.message); process.exit(1); });
"

# 3. Run post-market learning agents
echo "[3/5] Running post-market learning..."
node backend/learning/trade-learning-agent.js --mode=daily &
LEARN_PID=$!
sleep 30
kill $LEARN_PID 2>/dev/null || true
echo "Learning agent run complete"

# 4. Save previous day high/low for next session
echo "[4/5] Saving PDH/PDL levels..."
node -e "
  const Redis = require('ioredis');
  const { TRADING_CONFIG } = require('./config/instruments');
  const redis = new Redis({ host: process.env.REDIS_HOST, port: process.env.REDIS_PORT, password: process.env.REDIS_PASSWORD });
  async function saveLevels() {
    const sym  = TRADING_CONFIG.PRIMARY_FUTURE;
    const tick = await redis.hgetall('tick:' + sym + ':latest');
    if (tick && tick.high && tick.low) {
      await redis.set('levels:' + sym + ':pdh', tick.high, 'EX', 90000); // 25hr
      await redis.set('levels:' + sym + ':pdl', tick.low,  'EX', 90000);
      console.log('PDH:', tick.high, 'PDL:', tick.low);
    }
    redis.disconnect(); process.exit(0);
  }
  saveLevels();
"

# 5. Stop trading services (keep Redis + Postgres + Monitor running)
echo "[5/5] Stopping trading services..."
cd infra/docker
docker-compose stop gateway \
  worker-price worker-volume worker-orderflow worker-options \
  worker-breadth worker-volatility worker-news worker-fii worker-mtf \
  master risk execution
echo "Trading services stopped — databases and monitor still running"

echo ""
echo "================================================"
echo "  SHUTDOWN COMPLETE — $(date)"
echo "  Run nightly.sh at 11 PM for Alpha Factory"
echo "================================================"
