/**
 * ALPHA SCOREBOARD — Monthly Contribution Tracker
 * =================================================
 * CEO Rule: 90 days without measurable contribution = removed
 * Runs weekly (Sunday) to update scores
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { Pool } = require('pg');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [ALPHA_SCOREBOARD] [${lvl}] ${msg}`);

// Components to track
const COMPONENTS = [
  { name: 'Liquidity Sweep',    feature: 'liquidity_sweep',  type: 'alpha' },
  { name: 'CVD Divergence',     feature: 'cvd_slope',        type: 'alpha' },
  { name: 'GEX Wall',           feature: 'gex_state',        type: 'alpha' },
  { name: 'VWAP Signal',        feature: 'vwap_signal',      type: 'alpha' },
  { name: 'Breadth Filter',     feature: 'breadth_signal',   type: 'risk'  },
  { name: 'MTF Alignment',      feature: 'mtf_score',        type: 'alpha' },
  { name: 'Causal Rules',       feature: null,               type: 'risk'  },
  { name: 'OBI Orderflow',      feature: 'obi',              type: 'alpha' },
  { name: 'FII Bias',           feature: 'fii_bias',         type: 'alpha' },
];

async function scoreComponent(comp, trades) {
  if (!comp.feature) return { contribution: 0, trades_influenced: 0 };

  let influenced = 0, influencedWins = 0;
  let totalPnlWithComp = 0, totalPnlWithout = 0;
  let countWith = 0, countWithout = 0;

  for (const trade of trades) {
    const features = trade.features_snapshot || {};
    const pnl      = parseFloat(trade.net_pnl || 0);
    const hasComp  = features[comp.feature] !== null && features[comp.feature] !== undefined;

    if (hasComp) {
      influenced++;
      totalPnlWithComp += pnl;
      countWith++;
      if (pnl > 0) influencedWins++;
    } else {
      totalPnlWithout += pnl;
      countWithout++;
    }
  }

  const avgWith    = countWith    > 0 ? totalPnlWithComp / countWith    : 0;
  const avgWithout = countWithout > 0 ? totalPnlWithout  / countWithout : 0;
  const contribution = influenced > 0
    ? parseFloat(((avgWith - avgWithout) / Math.max(Math.abs(avgWithout), 1) * 100).toFixed(2))
    : 0;

  return { contribution, trades_influenced: influenced };
}

async function runScoringCycle() {
  log('Running Alpha Scoreboard scoring cycle...');

  // Get last 30 days of trades
  const result = await pg.query(`
    SELECT trade_id, net_pnl, features_snapshot, regime, direction, entry_time
    FROM trades
    WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'
      AND net_pnl IS NOT NULL
    ORDER BY entry_time DESC
  `);
  const trades = result.rows;
  log(`Scoring with ${trades.length} trades from last 30 days`);

  if (trades.length < 10) {
    log('Insufficient trades for scoring — need at least 10', 'WARN');
    return;
  }

  const scores = [];
  for (const comp of COMPONENTS) {
    const score = await scoreComponent(comp, trades);
    scores.push({ ...comp, ...score });

    // Determine status
    const status = score.contribution > 5  ? 'GREEN'
      : score.contribution > 0  ? 'YELLOW'
      : score.trades_influenced === 0 ? 'YELLOW'  // Not enough data
      : 'RED';

    // Save to PostgreSQL
    await pg.query(`
      INSERT INTO alpha_scoreboard
        (component_name, period_start, period_end, alpha_contribution, trades_influenced, status)
      VALUES ($1, CURRENT_DATE - INTERVAL '30 days', CURRENT_DATE, $2, $3, $4)
    `, [comp.name, score.contribution, score.trades_influenced, status]);

    // Cache in Redis for dashboard
    await redis.hset('scoreboard:latest', comp.name, JSON.stringify({
      contribution: score.contribution,
      trades:       score.trades_influenced,
      status,
    }));

    log(`${comp.name}: contribution=${score.contribution}% | trades=${score.trades_influenced} | ${status}`);
  }

  // 90-day removal check
  await runRemovalCheck(trades);
}

async function runRemovalCheck(trades) {
  log('Running 90-day removal check...');

  // Get 90-day trades
  const result90 = await pg.query(`
    SELECT trade_id, net_pnl, features_snapshot FROM trades
    WHERE session_date >= CURRENT_DATE - INTERVAL '90 days'
    ORDER BY entry_time DESC
  `);
  const trades90 = result90.rows;

  for (const comp of COMPONENTS) {
    if (!comp.feature) continue;

    const score = await scoreComponent(comp, trades90);

    if (score.contribution <= 0 && score.trades_influenced > 5) {
      log(`REMOVAL WARNING: ${comp.name} — zero/negative alpha over 90 days`, 'WARN');
      await redis.hset('scoreboard:warnings', comp.name,
        JSON.stringify({ reason: 'Zero alpha 90 days', days: 90, ts: Date.now() }));
    }
  }
}

// Run scoring
runScoringCycle()
  .then(() => { redis.disconnect(); pg.end(); process.exit(0); })
  .catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
