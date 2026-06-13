/**
 * FEATURE STORE
 * =============
 * Workers apne signals yahan likhte hain.
 * Master Agent yahan se padhta hai.
 * Har candle close pe ek versioned snapshot.
 *
 * Key format: features:{symbol}:latest
 */

'use strict';

require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');

const redis = new Redis({
  host:     process.env.REDIS_HOST || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

// ─── Feature schema — what each worker provides ──────────
// Every field = one signal or measurement from a worker
const FEATURE_SCHEMA = {
  // ── Price Action Worker ─────────────────────────────
  vwap:             null,   // Volume Weighted Average Price
  vwap_distance:    null,   // (price - vwap) / vwap * 100
  vwap_signal:      null,   // 'ABOVE' | 'BELOW' | 'AT'
  ema9:             null,
  ema21:            null,
  ema50:            null,
  ema_stack:        null,   // 'BULL' (9>21>50) | 'BEAR' | 'MIXED'
  atr14:            null,
  atr_ratio:        null,   // ATR(5) / ATR(20)

  // ── Volume Worker ──────────────────────────────────
  cvd:              null,   // Cumulative Volume Delta
  cvd_slope:        null,   // 'RISING' | 'FALLING' | 'FLAT'
  cvd_divergence:   null,   // true/false — price vs CVD diverging
  volume_z:         null,   // Volume Z-Score vs 20-day avg
  volume_signal:    null,   // 'SPIKE' | 'LOW' | 'NORMAL'

  // ── Orderflow Worker ───────────────────────────────
  obi:              null,   // Order Book Imbalance (-1 to +1)
  ofi:              null,   // Order Flow Imbalance
  absorption:       null,   // true/false — absorption detected
  absorption_type:  null,   // 'BULLISH' | 'BEARISH' | null
  liquidity_sweep:  null,   // true/false
  sweep_type:       null,   // 'PDH_BEAR' | 'PDL_BULL' | 'WEEKLY_BULL' | null

  // ── Options Worker ─────────────────────────────────
  pcr_oi:           null,   // Put/Call Ratio by OI
  pcr_vol:          null,   // Put/Call Ratio by Volume
  gex:              null,   // Gamma Exposure (Cr)
  gex_state:        null,   // 'POSITIVE' | 'NEGATIVE' | 'NEAR_ZERO'
  gamma_wall_level: null,   // Strike with max GEX
  dealer_delta:     null,   // Net dealer delta

  // ── Breadth Worker ────────────────────────────────
  ad_ratio:         null,   // Advance/Decline ratio
  breadth_signal:   null,   // 'BROAD_RALLY' | 'NARROW' | 'BROAD_SELL'

  // ── Volatility Worker ─────────────────────────────
  vix:              null,   // India VIX level
  vix_regime:       null,   // 'LOW' | 'NORMAL' | 'ELEVATED' | 'HIGH'
  vix_roc:          null,   // VIX rate of change (30 min)

  // ── News Worker ───────────────────────────────────
  news_state:       null,   // 'CLEAR' | 'CAUTION' | 'BLOCK'
  next_event_mins:  null,   // Minutes to next scheduled event

  // ── FII Worker ────────────────────────────────────
  fii_net:          null,   // FII net (Cr)
  fii_bias:         null,   // 'BULLISH' | 'BEARISH' | 'NEUTRAL'

  // ── MTF Worker ────────────────────────────────────
  mtf_score:        null,   // 0 to 1 — multi-timeframe alignment
  mtf_direction:    null,   // 'BULL' | 'BEAR' | 'NEUTRAL'

  // ── Regime (Level 1 Alpha) ────────────────────────
  regime:           null,   // 'TRENDING_UP' | 'TRENDING_DOWN' | 'SIDEWAYS' | 'BREAKOUT' | 'PANIC'
  regime_confidence:null,   // 0-100

  // ── Causal Rules (Knowledge layer) ───────────────
  causal_avoid:     null,   // [] — instruments to avoid
  causal_prefer:    null,   // [] — instruments to prefer

  // ── Meta ──────────────────────────────────────────
  symbol:           null,
  timestamp:        null,
  candle_time:      null,   // Which 1-min candle this snapshot is for
  workers_complete: 0,      // How many workers have written (9 = full)
};

// ─── Write a worker's output to Feature Store ────────────
async function writeWorkerOutput(symbol, workerName, updates) {
  const key = `features:${symbol}:latest`;

  const pipeline = redis.pipeline();

  // Write all fields this worker provides
  const fields = [];
  for (const [field, value] of Object.entries(updates)) {
    if (value !== undefined && value !== null) {
      fields.push(field, String(value));
    }
  }

  if (fields.length > 0) {
    pipeline.hset(key, ...fields);
    pipeline.expire(key, 300); // 5 min TTL — stale features invalid

    // Track which workers have completed
    pipeline.hincrby(key, 'workers_complete', 1);

    // Worker heartbeat
    pipeline.set(`worker:${workerName}:last_update`, Date.now(), 'EX', 60);
  }

  await pipeline.exec();
}

// ─── Read full feature vector (Master Agent uses this) ───
async function getFeatures(symbol) {
  const key      = `features:${symbol}:latest`;
  const raw      = await redis.hgetall(key);

  if (!raw || Object.keys(raw).length === 0) {
    return null; // No features yet
  }

  // Convert string values back to appropriate types
  const features = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === 'true')  { features[k] = true;  continue; }
    if (v === 'false') { features[k] = false; continue; }
    if (v === 'null')  { features[k] = null;  continue; }

    const num = parseFloat(v);
    features[k] = isNaN(num) ? v : num;
  }

  return features;
}

// ─── Check if feature store is fresh enough to trade ─────
async function isFresh(symbol, maxAgeMs = 30000) {
  const ts = await redis.hget(`features:${symbol}:latest`, 'timestamp');
  if (!ts) return false;

  const age = Date.now() - parseInt(ts);
  return age < maxAgeMs;
}

// ─── Check how many workers have completed ───────────────
async function getWorkerCount(symbol) {
  const count = await redis.hget(`features:${symbol}:latest`, 'workers_complete');
  return parseInt(count || '0');
}

// ─── Initialize a fresh snapshot at candle open ──────────
async function initSnapshot(symbol, candleTime) {
  const key = `features:${symbol}:latest`;

  // Reset workers_complete counter for new candle
  await redis.hset(key,
    'symbol',         symbol,
    'candle_time',    candleTime,
    'timestamp',      Date.now(),
    'workers_complete', '0',
  );
  await redis.expire(key, 300);
}

module.exports = {
  writeWorkerOutput,
  getFeatures,
  isFresh,
  getWorkerCount,
  initSnapshot,
  FEATURE_SCHEMA,
};
