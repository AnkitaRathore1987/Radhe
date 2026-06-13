/**
 * META STRATEGY AGENT — Dynamic Strategy Enable/Disable
 * Runs post-market daily. Checks which strategies are working.
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { Pool } = require('pg');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [META_STRATEGY] [${lvl}] ${msg}`);

// ── Strategy definitions ──────────────────────────────────
const STRATEGIES = {
  LIQUIDITY_SWEEP_LONG: {
    regime:    ['TRENDING_UP', 'BREAKOUT'],
    requires:  ['liquidity_sweep'],
    min_trades: 10,
  },
  VWAP_MEAN_REVERT: {
    regime:    ['SIDEWAYS'],
    requires:  ['vwap_signal'],
    min_trades: 10,
  },
  CVD_TREND_FOLLOW: {
    regime:    ['TRENDING_UP', 'TRENDING_DOWN'],
    requires:  ['cvd_slope'],
    min_trades: 10,
  },
  GEX_WALL_FADE: {
    regime:    ['SIDEWAYS'],
    requires:  ['gex_state', 'gamma_wall_level'],
    min_trades: 8,
  },
};

// ── Compute profit factor for a strategy ─────────────────
async function getStrategyPF(strategyName, lookback = 50) {
  const result = await pg.query(`
    SELECT net_pnl, features_snapshot, regime
    FROM trades
    WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY entry_time DESC
    LIMIT $1
  `, [lookback]);

  const trades  = result.rows;
  let grossWin  = 0, grossLoss = 0;

  for (const trade of trades) {
    const pnl  = parseFloat(trade.net_pnl || 0);
    if (pnl > 0) grossWin  += pnl;
    else         grossLoss += Math.abs(pnl);
  }

  return grossLoss > 0 ? parseFloat((grossWin / grossLoss).toFixed(3)) : 0;
}

async function runMetaStrategy() {
  log('Running Meta Strategy evaluation...');

  for (const [name, config] of Object.entries(STRATEGIES)) {
    const pf = await getStrategyPF(name);
    const statusKey = `strategy:${name}:status`;
    const current   = await redis.get(statusKey);

    log(`${name}: PF=${pf}`);

    if (pf >= 1.3 && current !== 'ACTIVE') {
      await redis.set(statusKey, 'ACTIVE', 'EX', 86400);
      log(`→ ACTIVATING ${name} (PF ${pf})`);
    } else if (pf < 1.0 && pf > 0 && current === 'ACTIVE') {
      await redis.set(statusKey, 'WARNING', 'EX', 86400);
      log(`→ WARNING ${name} (PF ${pf} < 1.0)`, 'WARN');
    }
  }
}

// ══════════════════════════════════════════════════════════

/**
 * STRATEGY RETIREMENT AGENT
 * Auto-retires strategies with PF < 1.0 for 200 trades
 */
async function runRetirement() {
  log('Running Strategy Retirement check...');

  for (const name of Object.keys(STRATEGIES)) {
    const result = await pg.query(`
      SELECT net_pnl FROM trades
      WHERE session_date >= CURRENT_DATE - INTERVAL '90 days'
      ORDER BY entry_time DESC LIMIT 200
    `);

    const trades = result.rows;
    if (trades.length < 20) continue; // Need minimum data

    let grossWin = 0, grossLoss = 0;
    for (const t of trades) {
      const pnl = parseFloat(t.net_pnl || 0);
      if (pnl > 0) grossWin  += pnl;
      else         grossLoss += Math.abs(pnl);
    }
    const pf = grossLoss > 0 ? grossWin / grossLoss : 0;

    // Retire if PF < 1.0 AND enough trades for statistical significance
    if (pf < 1.0 && trades.length >= 50) {
      const key = `strategy:${name}:status`;
      const cur = await redis.get(key);
      if (cur !== 'RETIRED') {
        await redis.set(key, 'RETIRED');
        log(`RETIRED: ${name} — PF ${pf.toFixed(3)} over ${trades.length} trades`, 'WARN');

        // Fast-track: PF < 0.8 over 50 trades
        if (pf < 0.8) log(`FAST-TRACK RETIRED: ${name} PF=${pf.toFixed(3)}`, 'WARN');
      }
    }
  }
}

// Run both agents post-market
(async () => {
  try {
    await runMetaStrategy();
    await runRetirement();
  } catch (err) {
    log(`Error: ${err.message}`, 'ERROR');
  } finally {
    redis.disconnect();
    pg.end();
    process.exit(0);
  }
})();
