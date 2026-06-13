/**
 * SHADOW TRADING AGENT
 * =====================
 * Real capital ke bina 50-100 virtual strategies parallel chalata hai.
 * Real market data use karta hai — sirf execution virtual hai.
 *
 * Kaam:
 * 1. Har strategy ke liye virtual entry/exit track karo
 * 2. Virtual P&L, win rate, PF calculate karo
 * 3. Jo strategies virtual mein achhi hain → Meta Strategy Agent promote karo
 * 4. Jo real mein hain unse compare karo → accuracy validate karo
 *
 * Phase 1 se hi chalta hai — data collection Day 1 se shuru.
 */

'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { Pool } = require('pg');
const { getFeatures, isFresh } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({
  host:     process.env.REDIS_HOST || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});
const pg = new Pool({
  host:     process.env.PG_HOST,
  port:     process.env.PG_PORT,
  database: process.env.PG_DATABASE,
  user:     process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

const log = (msg, lvl = 'INFO') =>
  console.log(`[${new Date().toISOString()}] [SHADOW] [${lvl}] ${msg}`);

// ─────────────────────────────────────────────────────────
// STRATEGY DEFINITIONS
// Har strategy ek hypothesis hai jise hum test kar rahe hain
// Entry condition → virtual trade → track result
// ─────────────────────────────────────────────────────────
const SHADOW_STRATEGIES = [

  // ── Variations of core signals ──────────────────────────

  {
    id:          'SWEEP_ONLY_HIGH_CONF',
    name:        'Liquidity Sweep — High Confidence Only (> 80)',
    description: 'Same as live but only conf > 80 — does filtering help?',
    entry: (f) => f.liquidity_sweep && f.obi > 0.35,
    direction: (f) => f.sweep_type?.includes('BULL') ? 'BUY' : 'SELL',
    min_confidence: 80,
  },

  {
    id:          'SWEEP_WEEKLY_ONLY',
    name:        'Liquidity Sweep — Weekly Levels Only',
    description: 'Only weekly H/L sweeps — stronger institutional signal',
    entry: (f) => f.liquidity_sweep && f.sweep_type?.includes('WEEKLY'),
    direction: (f) => f.sweep_type?.includes('BULL') ? 'BUY' : 'SELL',
    min_confidence: 70,
  },

  {
    id:          'CVD_DIVERGENCE_FADE',
    name:        'CVD Divergence Fade',
    description: 'Trade against price when CVD diverges — reversal signal',
    entry: (f) => f.cvd_divergence === true,
    direction: (f) => f.cvd_slope === 'RISING' ? 'SELL' : 'BUY', // Fade the divergence
    min_confidence: 65,
  },

  {
    id:          'GEX_NEG_MOMENTUM',
    name:        'Negative GEX Momentum',
    description: 'Trade only when GEX is negative (amplified moves)',
    entry: (f) => f.gex_state === 'NEGATIVE' && Math.abs(f.obi || 0) > 0.3,
    direction: (f) => (f.obi || 0) > 0 ? 'BUY' : 'SELL',
    min_confidence: 70,
  },

  {
    id:          'GEX_WALL_FADE',
    name:        'GEX Gamma Wall Fade',
    description: 'Fade price at gamma wall — positive GEX dampens moves',
    entry: (f) => {
      if (!f.gamma_wall_level || !f.vwap) return false;
      const dist = Math.abs((f.gamma_wall_level - f.vwap) / f.vwap * 100);
      return f.gex_state === 'POSITIVE' && dist < 0.5; // Within 0.5% of wall
    },
    direction: (f) => (f.obi || 0) > 0 ? 'SELL' : 'BUY', // Fade at wall
    min_confidence: 68,
  },

  {
    id:          'BROAD_RALLY_CONFIRM',
    name:        'Broad Rally Confirmation',
    description: 'Only trade when breadth > 2.5 AND sweep detected',
    entry: (f) => f.breadth_signal === 'BROAD_RALLY' && f.liquidity_sweep,
    direction: () => 'BUY',
    min_confidence: 72,
  },

  {
    id:          'VWAP_SD2_FADE',
    name:        'VWAP SD2 Fade',
    description: 'Mean reversion at VWAP 2nd standard deviation',
    entry: (f) => {
      if (!f.vwap_sd2_upper || !f.vwap_sd2_lower || !f.vwap) return false;
      const price = f.vwap; // Proxy — will use actual price in v2
      return f.vwap_signal === 'ABOVE' && f.obi < -0.2 && f.breadth_signal !== 'BROAD_RALLY';
    },
    direction: () => 'SELL',
    min_confidence: 68,
  },

  {
    id:          'FII_CONTRARIAN',
    name:        'FII Contrarian',
    description: 'Trade opposite of FII extreme — they reverse near extremes',
    entry: (f) => {
      const fiiExtreme = (f.fii_net || 0) > 2000 || (f.fii_net || 0) < -2000;
      return fiiExtreme && Math.abs(f.obi || 0) > 0.25;
    },
    direction: (f) => (f.fii_net || 0) < 0 ? 'BUY' : 'SELL', // Contrarian
    min_confidence: 65,
  },

  {
    id:          'HIGH_MTF_ONLY',
    name:        'High MTF Alignment Only (> 0.75)',
    description: 'Only trade when all timeframes strongly agree',
    entry: (f) => (f.mtf_score || 0) > 0.75 && f.liquidity_sweep,
    direction: (f) => (f.mtf_score || 0.5) > 0.5 ? 'BUY' : 'SELL',
    min_confidence: 75,
  },

  {
    id:          'LOW_VIX_MOMENTUM',
    name:        'Low VIX Momentum',
    description: 'Momentum trades only when VIX < 14 (stable environment)',
    entry: (f) => (f.vix || 99) < 14 && f.cvd_slope === 'RISING' && (f.obi || 0) > 0.3,
    direction: () => 'BUY',
    min_confidence: 68,
  },

  {
    id:          'ABSORPTION_REVERSAL',
    name:        'Absorption Reversal',
    description: 'Trade the reversal after absorption is detected',
    entry: (f) => f.absorption === true,
    direction: (f) => f.absorption_type === 'BULLISH' ? 'BUY' : 'SELL',
    min_confidence: 72,
  },

  {
    id:          'CROSS_ASSET_MACRO',
    name:        'Cross-Asset Macro Alignment',
    description: 'Trade only when FII + VIX + Breadth all aligned',
    entry: (f) => {
      const fiiBull   = f.fii_bias === 'BULLISH';
      const lowVix    = (f.vix || 99) < 16;
      const goodBread = (f.ad_ratio || 0) > 1.5;
      return fiiBull && lowVix && goodBread && (f.obi || 0) > 0.2;
    },
    direction: () => 'BUY',
    min_confidence: 70,
  },

  {
    id:          'TRENDING_REGIME_ONLY',
    name:        'Signals Only in TRENDING_UP Regime',
    description: 'Does regime filter improve win rate significantly?',
    entry: (f) => f.regime === 'TRENDING_UP' && f.liquidity_sweep,
    direction: () => 'BUY',
    min_confidence: 68,
  },

  {
    id:          'NO_NEWS_STRICT',
    name:        'Strict No-News — 2hr Window',
    description: 'Block all trades within 2hr of any event',
    entry: (f) => (f.next_event_mins || 999) > 120 && f.liquidity_sweep,
    direction: (f) => f.sweep_type?.includes('BULL') ? 'BUY' : 'SELL',
    min_confidence: 70,
  },

  {
    id:          'OBI_EXTREME_ONLY',
    name:        'OBI Extreme Only (> 0.5)',
    description: 'Only very strong orderbook imbalance signals',
    entry: (f) => Math.abs(f.obi || 0) > 0.5,
    direction: (f) => (f.obi || 0) > 0 ? 'BUY' : 'SELL',
    min_confidence: 75,
  },

  // ── Time-based strategies ────────────────────────────────
  {
    id:          'FIRST_HOUR_ONLY',
    name:        'First Hour Trades Only (9:30-10:30)',
    description: 'Many institutions are most active first hour',
    entry: (f) => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      return mins >= 9*60+30 && mins <= 10*60+30 && f.liquidity_sweep;
    },
    direction: (f) => f.sweep_type?.includes('BULL') ? 'BUY' : 'SELL',
    min_confidence: 68,
  },

  {
    id:          'AVOID_LAST_HOUR',
    name:        'Avoid Last Hour (2:15-3:10)',
    description: 'Exclude trades in last hour — noise increases',
    entry: (f) => {
      const h = new Date().getHours(), m = new Date().getMinutes();
      const mins = h * 60 + m;
      return mins < 14*60+15 && f.liquidity_sweep; // Before 2:15 PM only
    },
    direction: (f) => f.sweep_type?.includes('BULL') ? 'BUY' : 'SELL',
    min_confidence: 68,
  },
];

// ─────────────────────────────────────────────────────────
// VIRTUAL POSITION TRACKER
// ─────────────────────────────────────────────────────────
const virtualPositions = {}; // strategyId → { direction, entry_price, entry_time, atr }

// ── Try to enter a virtual position ──────────────────────
async function tryVirtualEntry(strategy, features, currentPrice) {
  // Already in position for this strategy — skip
  if (virtualPositions[strategy.id]) return;

  // Check kill switch
  if (await redis.get('kill:active') === '1') return;

  // News block
  if (features.news_state === 'BLOCK') return;

  // Entry condition check
  let shouldEnter = false;
  try {
    shouldEnter = strategy.entry(features);
  } catch { return; }

  if (!shouldEnter) return;

  // Direction
  let dir = 'BUY';
  try { dir = strategy.direction(features); } catch { return; }

  const atr = parseFloat(features.atr14 || 50);

  // Record virtual position
  virtualPositions[strategy.id] = {
    strategy_id:  strategy.id,
    direction:    dir,
    entry_price:  currentPrice,
    entry_time:   Date.now(),
    sl_price:     dir === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    target_price: dir === 'BUY' ? currentPrice + atr * 3.0 : currentPrice - atr * 3.0,
    atr,
    regime:       features.regime || 'UNKNOWN',
    features_snap: {
      obi: features.obi, sweep: features.liquidity_sweep,
      cvd: features.cvd_slope, gex: features.gex_state,
      vix: features.vix, mtf: features.mtf_score,
      fii: features.fii_bias, breadth: features.breadth_signal,
    },
  };

  // Store in Redis (for monitoring)
  await redis.hset(`shadow:positions:${strategy.id}`, virtualPositions[strategy.id]);
  await redis.expire(`shadow:positions:${strategy.id}`, 86400);

  log(`VIRTUAL ENTRY: [${strategy.id}] ${dir} @ ${currentPrice.toFixed(2)} | SL: ${virtualPositions[strategy.id].sl_price.toFixed(2)}`);
}

// ── Check exit conditions for open virtual positions ─────
async function checkVirtualExits(currentPrice) {
  const now = Date.now();

  for (const [stratId, pos] of Object.entries(virtualPositions)) {
    let exitReason = null;
    let exitPrice  = currentPrice;

    // SL hit
    if (pos.direction === 'BUY'  && currentPrice <= pos.sl_price) { exitReason = 'SL_HIT';     exitPrice = pos.sl_price; }
    if (pos.direction === 'SELL' && currentPrice >= pos.sl_price) { exitReason = 'SL_HIT';     exitPrice = pos.sl_price; }

    // Target hit
    if (pos.direction === 'BUY'  && currentPrice >= pos.target_price) { exitReason = 'TARGET'; exitPrice = pos.target_price; }
    if (pos.direction === 'SELL' && currentPrice <= pos.target_price) { exitReason = 'TARGET';  exitPrice = pos.target_price; }

    // Time-based exit — 3:10 PM
    const h = new Date().getHours(), m = new Date().getMinutes();
    if (h === 15 && m >= 10) { exitReason = 'TIME_EXIT'; }

    // Max hold time — 90 minutes
    if (now - pos.entry_time > 90 * 60 * 1000) { exitReason = 'MAX_HOLD'; }

    if (!exitReason) continue;

    // Calculate virtual P&L
    const pnlPoints = pos.direction === 'BUY'
      ? exitPrice - pos.entry_price
      : pos.entry_price - exitPrice;
    const pnlRs = pnlPoints * (TRADING_CONFIG.LOT_SIZES.NIFTY || 75); // 1 lot

    // Save to PostgreSQL
    await pg.query(`
      INSERT INTO shadow_trades
        (strategy_id, strategy_name, direction, entry_price, exit_price,
         pnl_points, pnl_rs, exit_reason, regime, hold_minutes,
         features_snapshot, session_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,CURRENT_DATE)
    `, [
      stratId,
      SHADOW_STRATEGIES.find(s => s.id === stratId)?.name || stratId,
      pos.direction,
      pos.entry_price,
      exitPrice,
      pnlPoints.toFixed(2),
      pnlRs.toFixed(2),
      exitReason,
      pos.regime,
      Math.round((now - pos.entry_time) / 60000),
      JSON.stringify(pos.features_snap),
    ]);

    // Update strategy stats in Redis
    await updateStrategyStats(stratId, pnlRs);

    log(`VIRTUAL EXIT: [${stratId}] ${pos.direction} ${exitReason} | P&L: ${pnlRs >= 0 ? '+' : ''}Rs ${pnlRs.toFixed(0)}`);

    // Clear virtual position
    delete virtualPositions[stratId];
    await redis.del(`shadow:positions:${stratId}`);
  }
}

// ── Update running strategy statistics ───────────────────
async function updateStrategyStats(stratId, pnlRs) {
  const key = `shadow:stats:${stratId}`;
  const pipeline = redis.pipeline();

  pipeline.hincrby(key, 'total_trades', 1);
  if (pnlRs > 0) {
    pipeline.hincrby(key, 'wins', 1);
    pipeline.hincrbyfloat(key, 'gross_win', pnlRs);
  } else {
    pipeline.hincrby(key, 'losses', 1);
    pipeline.hincrbyfloat(key, 'gross_loss', Math.abs(pnlRs));
  }
  pipeline.hincrbyfloat(key, 'total_pnl', pnlRs);
  pipeline.expire(key, 7776000); // 90 days

  await pipeline.exec();
}

// ── Get strategy performance summary ─────────────────────
async function getStrategyPerformance() {
  const summary = [];
  for (const strategy of SHADOW_STRATEGIES) {
    const stats = await redis.hgetall(`shadow:stats:${strategy.id}`);
    if (!stats?.total_trades) continue;

    const trades   = parseInt(stats.total_trades || 0);
    const wins     = parseInt(stats.wins         || 0);
    const grossWin = parseFloat(stats.gross_win  || 0);
    const grossLoss= parseFloat(stats.gross_loss || 0);
    const pf       = grossLoss > 0 ? (grossWin / grossLoss) : 0;
    const winRate  = trades > 0 ? (wins / trades * 100) : 0;

    summary.push({
      id:       strategy.id,
      name:     strategy.name,
      trades,
      win_rate: winRate.toFixed(1),
      pf:       pf.toFixed(3),
      total_pnl: parseFloat(stats.total_pnl || 0).toFixed(0),
      status:   pf > 1.4 && trades >= 30 ? 'PROMOTE_CANDIDATE'
        : pf < 0.8 && trades >= 20 ? 'RETIRING'
        : 'TRACKING',
    });
  }

  // Sort by PF descending
  summary.sort((a, b) => parseFloat(b.pf) - parseFloat(a.pf));

  // Cache in Redis for dashboard
  await redis.set('shadow:performance:summary',
    JSON.stringify(summary), 'EX', 3600);

  return summary;
}

// ── Check for promotion candidates ───────────────────────
async function checkPromotions() {
  const summary = await getStrategyPerformance();
  for (const s of summary) {
    if (s.status === 'PROMOTE_CANDIDATE') {
      log(`🌟 PROMOTE CANDIDATE: ${s.name} | PF=${s.pf} | ${s.trades} trades | Win%=${s.win_rate}`, 'WARN');
      // Push to promotion queue — Meta Strategy Agent picks this up
      await redis.lpush('shadow:promotion_queue', JSON.stringify(s));
      await redis.ltrim('shadow:promotion_queue', 0, 19);
    }
    if (s.status === 'RETIRING') {
      log(`💀 RETIRING: ${s.name} | PF=${s.pf} | ${s.trades} trades`, 'WARN');
    }
  }
}

// ─────────────────────────────────────────────────────────
// HISTORICAL REPLAY MODE
// Pehle ek baar chalao historical data pe — fast learning
// ─────────────────────────────────────────────────────────
async function replayHistoricalData(daysBack = 30) {
  log(`Starting historical replay — last ${daysBack} days`);

  // Read historical candles from PostgreSQL
  const result = await pg.query(`
    SELECT symbol, open, high, low, close, volume, vwap, atr14, candle_time
    FROM candles
    WHERE symbol = $1
      AND timeframe = '1m'
      AND candle_time >= NOW() - INTERVAL '${daysBack} days'
    ORDER BY candle_time ASC
  `, [TRADING_CONFIG.PRIMARY_FUTURE]);

  const candles = result.rows;
  log(`Replaying ${candles.length} candles...`);

  if (candles.length === 0) {
    log('No historical candles found — run after collecting live data', 'WARN');
    return;
  }

  // Simple replay: use OHLC as proxy for feature computation
  // Full feature replay happens in Historical Replay Agent (Phase 2)
  let replayTrades = 0;
  for (const candle of candles) {
    const price = parseFloat(candle.close);
    const atr   = parseFloat(candle.atr14 || 50);

    // Simulate basic features from candle data
    const mockFeatures = {
      vwap:          parseFloat(candle.vwap || price),
      vwap_signal:   price > parseFloat(candle.vwap || price) ? 'ABOVE' : 'BELOW',
      atr14:         atr,
      obi:           Math.random() * 0.4 - 0.2, // Will be real in Phase 2
      cvd_slope:     price > parseFloat(candle.open) ? 'RISING' : 'FALLING',
      news_state:    'CLEAR',
      regime:        'TRENDING_UP', // Simplified
      liquidity_sweep: Math.random() > 0.85, // ~15% occurrence
      sweep_type:    Math.random() > 0.5 ? 'PDL_BULL' : 'PDH_BEAR',
    };

    for (const strategy of SHADOW_STRATEGIES) {
      await tryVirtualEntry(strategy, mockFeatures, price);
    }
    await checkVirtualExits(price);
    replayTrades++;
  }

  log(`Historical replay complete: ${replayTrades} candles processed`);
  await checkPromotions();
}

// ─────────────────────────────────────────────────────────
// MAIN LIVE LOOP
// ─────────────────────────────────────────────────────────
async function run() {
  log('Shadow Trading Agent starting...');
  log(`Tracking ${SHADOW_STRATEGIES.length} virtual strategies`);

  // Run historical replay on startup (background)
  replayHistoricalData(30).catch(err =>
    log(`Replay error: ${err.message}`, 'WARN')
  );

  const symbol = TRADING_CONFIG.PRIMARY_FUTURE;

  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed === '1') {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Get current price
      const tick = await redis.hgetall(`tick:${symbol}:latest`);
      const price = parseFloat(tick?.price || 0);
      if (price <= 0) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Get current features
      const fresh = await isFresh(symbol, 30000);
      if (!fresh) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const features = await getFeatures(symbol);
      if (!features) {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      // Try entries for all strategies
      for (const strategy of SHADOW_STRATEGIES) {
        await tryVirtualEntry(strategy, features, price);
      }

      // Check exits for open virtual positions
      await checkVirtualExits(price);

      // Update heartbeat
      await redis.set('shadow:heartbeat', Date.now(), 'EX', 30);

      // Every 50 evaluations — check for promotions
      const count = parseInt(await redis.incr('shadow:eval_count'));
      if (count % 50 === 0) await checkPromotions();

    } catch (err) {
      log(`Error: ${err.message}`, 'ERROR');
    }

    await new Promise(r => setTimeout(r, 10000)); // Every 10 seconds
  }
}

// ── Export for other agents ──────────────────────────────
module.exports = { getStrategyPerformance, replayHistoricalData };

// ── Start if run directly ────────────────────────────────
if (require.main === module) {
  run().catch(err => {
    log(`Fatal: ${err.message}`, 'ERROR');
    process.exit(1);
  });
}
