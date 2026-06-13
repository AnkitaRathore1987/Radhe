/**
 * TRADE LEARNING AGENT — Post-Market Analyzer
 * =============================================
 * Runs at 3:30 PM daily (post-market)
 * Analyzes today's trades, updates causal flags,
 * updates worker accuracy stats in Redis
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { Pool } = require('pg');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [TRADE_LEARNING] [${lvl}] ${msg}`);

// ── Causal flag detection ─────────────────────────────────
function detectCausalFlags(trade, features) {
  const flags = {
    causal_news:        false,
    causal_vix_spike:   false,
    causal_gamma_wall:  false,
    causal_low_liquidity: false,
    causal_regime_miss: false,
    causal_fii_contrary: false,
  };
  if (!features) return flags;

  // News event near entry
  if (features.next_event_mins < 30) flags.causal_news = true;

  // VIX spike at entry
  if (features.vix_roc && Math.abs(features.vix_roc) > 15) flags.causal_vix_spike = true;

  // Gamma wall nearby
  if (features.gamma_wall_level && features.entry_price) {
    const dist = Math.abs(features.gamma_wall_level - parseFloat(trade.entry_price));
    if (dist < 50) flags.causal_gamma_wall = true; // within 50 points of gamma wall
  }

  // Low liquidity (volume Z-score negative)
  if (features.volume_z < -1.0) flags.causal_low_liquidity = true;

  // FII contrary to trade direction
  if (trade.direction === 'BUY'  && features.fii_bias === 'BEARISH') flags.causal_fii_contrary = true;
  if (trade.direction === 'SELL' && features.fii_bias === 'BULLISH') flags.causal_fii_contrary = true;

  return flags;
}

// ── Update accuracy stats for Alpha Scoreboard ────────────
async function updateAccuracyStats(trades) {
  const workerStats = {};
  const components  = ['liquidity_sweep','cvd_slope','obi','gex_state','breadth_signal','vwap_signal','mtf_score'];

  for (const trade of trades) {
    const features = trade.features_snapshot || {};
    const isWin    = parseFloat(trade.net_pnl || 0) > 0;

    for (const comp of components) {
      if (!workerStats[comp]) workerStats[comp] = { wins: 0, total: 0 };
      const hadSignal = features[comp] !== null && features[comp] !== undefined;
      if (hadSignal) {
        workerStats[comp].total++;
        if (isWin) workerStats[comp].wins++;
      }
    }
  }

  // Store accuracy in Redis
  const pipeline = redis.pipeline();
  for (const [comp, stats] of Object.entries(workerStats)) {
    if (stats.total > 0) {
      const accuracy = (stats.wins / stats.total * 100).toFixed(1);
      pipeline.hset('learning:accuracy', comp, accuracy);
    }
  }
  pipeline.hset('learning:stats', {
    total_trades:  trades.length,
    wins:          trades.filter(t => parseFloat(t.net_pnl||0) > 0).length,
    losses:        trades.filter(t => parseFloat(t.net_pnl||0) <= 0).length,
    updated_at:    Date.now(),
  });
  await pipeline.exec();

  // Win rate + avg win/loss for Kelly sizing
  const wins  = trades.filter(t => parseFloat(t.net_pnl||0) > 0);
  const losses= trades.filter(t => parseFloat(t.net_pnl||0) <= 0);
  if (wins.length > 0 && losses.length > 0) {
    const avgWin  = wins.reduce((a,t)=>a+parseFloat(t.net_pnl),0)  / wins.length;
    const avgLoss = Math.abs(losses.reduce((a,t)=>a+parseFloat(t.net_pnl),0) / losses.length);
    await redis.hset('learning:stats', {
      win_rate: (wins.length / trades.length * 100).toFixed(1),
      avg_win:  avgWin.toFixed(0),
      avg_loss: avgLoss.toFixed(0),
    });
  }
}

// ── Main daily analysis ───────────────────────────────────
async function runDailyAnalysis() {
  log('Starting daily analysis...');

  // Fetch today's trades
  const result = await pg.query(`
    SELECT * FROM trades
    WHERE session_date = CURRENT_DATE
    ORDER BY entry_time ASC
  `);
  const trades = result.rows;
  log(`Found ${trades.length} trades today`);

  if (trades.length === 0) {
    log('No trades today — skipping analysis');
    return;
  }

  // Analyze each trade
  let wins = 0, losses = 0, totalPnl = 0;
  for (const trade of trades) {
    const pnl  = parseFloat(trade.net_pnl || 0);
    const result = pnl > 0 ? 'WIN' : 'LOSS';
    if (pnl > 0) wins++; else losses++;
    totalPnl += pnl;

    // Detect causal flags
    const features = trade.features_snapshot || {};
    const flags    = detectCausalFlags(trade, features);

    // Save to learning_events
    await pg.query(`
      INSERT INTO learning_events
        (trade_id, prediction, actual_result, regime_at_entry,
         causal_news, causal_vix_spike, causal_gamma_wall,
         causal_low_liquidity, causal_regime_miss, causal_fii_contrary)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT DO NOTHING
    `, [
      trade.trade_id, 'WIN', result, trade.regime,
      flags.causal_news, flags.causal_vix_spike, flags.causal_gamma_wall,
      flags.causal_low_liquidity, flags.causal_regime_miss, flags.causal_fii_contrary,
    ]);
  }

  // Update accuracy stats
  await updateAccuracyStats(trades);

  // Update consecutive loss counter
  const lastTrade = trades[trades.length - 1];
  if (parseFloat(lastTrade?.net_pnl || 0) <= 0) {
    await redis.incr('risk:consecutive_losses');
  } else {
    await redis.set('risk:consecutive_losses', '0');
  }

  log(`Analysis complete: ${wins}W / ${losses}L | P&L: Rs ${totalPnl.toFixed(0)}`);
}

// Run once (called by shutdown.sh)
runDailyAnalysis()
  .then(() => { redis.disconnect(); pg.end(); process.exit(0); })
  .catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
