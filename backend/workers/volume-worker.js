/**
 * VOLUME WORKER — CVD + Volume Z-Score
 * =====================================
 * Reads: Redis tick stream
 * Writes: Feature Store (cvd, cvd_slope, volume_z, volume_signal)
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

const WORKER_NAME = 'volume_cvd';
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [${WORKER_NAME.toUpperCase()}] [${lvl}] ${msg}`);

// ── In-memory state ──────────────────────────────────────
const state = {};
function getState(symbol) {
  if (!state[symbol]) {
    state[symbol] = {
      cvd:           0,        // Cumulative Volume Delta — resets each session
      cvd_history:   [],       // Last 10 CVD values for slope
      vol_history:   [],       // Last 20 session volumes for Z-score baseline
      prev_price:    null,
    };
  }
  return state[symbol];
}

// ── CVD: Cumulative Volume Delta ─────────────────────────
// Aggressive buy = trade at ask (uptick), Aggressive sell = trade at bid (downtick)
// Tick rule: if price > prev_price → buy aggressor, else → sell aggressor
function updateCVD(s, price, volume) {
  if (s.prev_price === null) {
    s.prev_price = price;
    return { cvd: 0, delta: 0 };
  }
  const delta = price >= s.prev_price ? volume : -volume;
  s.cvd += delta;
  s.prev_price = price;

  // Track last 10 CVD values for slope
  s.cvd_history.push(s.cvd);
  if (s.cvd_history.length > 10) s.cvd_history.shift();

  return { cvd: s.cvd, delta };
}

// ── CVD Slope: Rising / Falling / Flat ──────────────────
function getCVDSlope(history) {
  if (history.length < 3) return 'FLAT';
  const recent = history.slice(-3);
  const first  = recent[0];
  const last   = recent[recent.length - 1];
  const diff   = last - first;
  const pct    = first !== 0 ? Math.abs(diff / first) : 0;
  if (pct < 0.005) return 'FLAT';
  return diff > 0 ? 'RISING' : 'FALLING';
}

// ── CVD Divergence detector ──────────────────────────────
// Price making higher high BUT CVD making lower high = bearish divergence
function checkCVDDivergence(s, price) {
  if (s.cvd_history.length < 6) return false;
  const priceNow  = price;
  const cvdNow    = s.cvd;
  // Simple version: if price up 0.3% but cvd down = divergence
  // Full version needs candle highs — simplified for Phase 1
  return false; // Will enhance in Phase 2 with candle data
}

// ── Volume Z-Score ────────────────────────────────────────
// Z = (current_vol - mean_vol) / std_vol
function getVolumeZScore(s, currentVol) {
  if (s.vol_history.length < 5) {
    s.vol_history.push(currentVol);
    return { z: 0, signal: 'NORMAL' };
  }
  const mean = s.vol_history.reduce((a, b) => a + b, 0) / s.vol_history.length;
  const variance = s.vol_history.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / s.vol_history.length;
  const std  = Math.sqrt(variance);
  const z    = std > 0 ? (currentVol - mean) / std : 0;

  s.vol_history.push(currentVol);
  if (s.vol_history.length > 20) s.vol_history.shift();

  const signal = z > 3.0 ? 'EXTREME_SPIKE'
    : z > 2.0 ? 'SPIKE'
    : z < -1.0 ? 'LOW'
    : 'NORMAL';

  return { z: parseFloat(z.toFixed(3)), signal };
}

// ── Process one candle ───────────────────────────────────
async function processCandle(symbol) {
  const streamKey = `tick:${symbol}:stream`;
  const now       = Date.now();
  const oneMinAgo = now - 60000;

  const ticks = await redis.xrange(streamKey, oneMinAgo, '+');
  if (!ticks || ticks.length === 0) return;

  const s = getState(symbol);
  let totalVolume = 0;
  let lastPrice   = null;

  for (const [, fields] of ticks) {
    const tick = {};
    for (let i = 0; i < fields.length; i += 2) tick[fields[i]] = fields[i + 1];
    const price  = parseFloat(tick.price || 0);
    const volume = parseFloat(tick.volume || 0);
    if (price <= 0) continue;
    totalVolume += volume;
    lastPrice = price;
    updateCVD(s, price, volume);
  }

  if (!lastPrice) return;

  const cvdSlope = getCVDSlope(s.cvd_history);
  const volZ     = getVolumeZScore(s, totalVolume);
  const diverge  = checkCVDDivergence(s, lastPrice);

  await writeWorkerOutput(symbol, WORKER_NAME, {
    cvd:            parseFloat(s.cvd.toFixed(0)),
    cvd_slope:      cvdSlope,
    cvd_divergence: diverge,
    volume_z:       volZ.z,
    volume_signal:  volZ.signal,
    timestamp:      now,
  });
}

// ── Daily reset ──────────────────────────────────────────
function resetDaily(symbol) {
  const s = getState(symbol);
  s.cvd         = 0;
  s.cvd_history = [];
  s.prev_price  = null;
  log(`Daily CVD reset: ${symbol}`);
}

// ── Main loop ────────────────────────────────────────────
async function run() {
  log('Volume Worker starting...');
  const instruments = [TRADING_CONFIG.PRIMARY_FUTURE, TRADING_CONFIG.SECONDARY_FUTURE];
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed === '1') { await new Promise(r => setTimeout(r, 5000)); continue; }
      for (const sym of instruments) await processCandle(sym);
      await redis.set(`worker:${WORKER_NAME}:heartbeat`, Date.now(), 'EX', 30);
    } catch (err) {
      log(`Error: ${err.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

run().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
