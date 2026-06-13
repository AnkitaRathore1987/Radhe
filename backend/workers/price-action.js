/**
 * PRICE ACTION WORKER
 * ====================
 * Calculates: VWAP, EMA stack, ATR
 * Reads from: Redis tick stream
 * Writes to:  Feature Store
 *
 * Ek kaam: Price-based features compute karna.
 * Koi signal nahi deta. Sirf features.
 */

'use strict';

require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { SUBSCRIBE_LIST, TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({
  host:     process.env.REDIS_HOST || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

const WORKER_NAME = 'price_action';

function log(msg, level = 'INFO') {
  console.log(`[${new Date().toISOString()}] [${WORKER_NAME.toUpperCase()}] [${level}] ${msg}`);
}

// ─── In-memory state (reset daily at 9:14 AM) ────────────
const state = {};

function getState(symbol) {
  if (!state[symbol]) {
    state[symbol] = {
      // VWAP components (reset each session)
      vwap_cum_pv:  0,   // Cumulative Price × Volume
      vwap_cum_vol: 0,   // Cumulative Volume
      vwap_prices:  [],  // For standard deviation calculation

      // EMA values
      ema9:  null,
      ema21: null,
      ema50: null,

      // ATR components
      prev_close: null,
      tr_values:  [],    // True Range history

      // Candle tracking
      current_candle: null,
      candle_high:    -Infinity,
      candle_low:     Infinity,
      candle_vol:     0,
      candle_open:    null,
    };
  }
  return state[symbol];
}

// ─── VWAP calculation ────────────────────────────────────
function updateVWAP(s, price, volume) {
  s.vwap_cum_pv  += price * volume;
  s.vwap_cum_vol += volume;

  const vwap = s.vwap_cum_vol > 0
    ? s.vwap_cum_pv / s.vwap_cum_vol
    : price;

  // Track price deviations for SD bands
  s.vwap_prices.push(price);
  if (s.vwap_prices.length > 200) s.vwap_prices.shift(); // Keep last 200

  // Standard deviation of prices from VWAP
  const mean = vwap;
  const variance = s.vwap_prices.reduce((acc, p) => acc + Math.pow(p - mean, 2), 0) / s.vwap_prices.length;
  const sd = Math.sqrt(variance);

  return {
    vwap,
    vwap_sd1_upper: vwap + sd,
    vwap_sd1_lower: vwap - sd,
    vwap_sd2_upper: vwap + 2 * sd,
    vwap_sd2_lower: vwap - 2 * sd,
  };
}

// ─── EMA calculation ─────────────────────────────────────
// EMA(n) = Price × k + EMA_prev × (1 - k)  where k = 2/(n+1)
function updateEMA(prevEMA, price, period) {
  const k = 2 / (period + 1);
  if (prevEMA === null) return price; // First value = price
  return price * k + prevEMA * (1 - k);
}

// ─── ATR calculation ─────────────────────────────────────
// True Range = MAX(High-Low, |High-PrevClose|, |Low-PrevClose|)
function updateATR(s, high, low, close) {
  if (s.prev_close === null) {
    s.prev_close = close;
    return { atr14: null, atr5: null, atr_ratio: null };
  }

  const tr = Math.max(
    high - low,
    Math.abs(high - s.prev_close),
    Math.abs(low  - s.prev_close)
  );

  s.tr_values.push(tr);
  if (s.tr_values.length > 20) s.tr_values.shift();

  s.prev_close = close;

  if (s.tr_values.length < 5) return { atr14: null, atr5: null, atr_ratio: null };

  // ATR(14) — simple average for now (EMA version later)
  const last14 = s.tr_values.slice(-14);
  const last5  = s.tr_values.slice(-5);
  const atr14  = last14.reduce((a, b) => a + b, 0) / last14.length;
  const atr5   = last5.reduce((a, b) => a + b, 0)  / last5.length;
  const atr_ratio = atr14 > 0 ? atr5 / atr14 : 1;

  return { atr14, atr5, atr_ratio };
}

// ─── Process one candle close ─────────────────────────────
async function processCandleClose(symbol, candle) {
  const s      = getState(symbol);
  const { open, high, low, close, volume } = candle;
  const typical_price = (high + low + close) / 3;

  // VWAP
  const vwapData = updateVWAP(s, typical_price, volume);

  // EMA
  s.ema9  = updateEMA(s.ema9,  close, 9);
  s.ema21 = updateEMA(s.ema21, close, 21);
  s.ema50 = updateEMA(s.ema50, close, 50);

  // EMA Stack
  let ema_stack = 'MIXED';
  if (s.ema9 && s.ema21 && s.ema50) {
    if (s.ema9 > s.ema21 && s.ema21 > s.ema50) ema_stack = 'BULL';
    else if (s.ema9 < s.ema21 && s.ema21 < s.ema50) ema_stack = 'BEAR';
  }

  // ATR
  const atrData = updateATR(s, high, low, close);

  // VWAP signal
  const vwap_distance = vwapData.vwap > 0
    ? ((close - vwapData.vwap) / vwapData.vwap) * 100
    : 0;
  const vwap_signal = vwap_distance > 0.1 ? 'ABOVE'
    : vwap_distance < -0.1 ? 'BELOW'
    : 'AT';

  // Write to Feature Store
  await writeWorkerOutput(symbol, WORKER_NAME, {
    vwap:             parseFloat(vwapData.vwap.toFixed(2)),
    vwap_sd1_upper:   parseFloat(vwapData.vwap_sd1_upper.toFixed(2)),
    vwap_sd1_lower:   parseFloat(vwapData.vwap_sd1_lower.toFixed(2)),
    vwap_sd2_upper:   parseFloat(vwapData.vwap_sd2_upper.toFixed(2)),
    vwap_sd2_lower:   parseFloat(vwapData.vwap_sd2_lower.toFixed(2)),
    vwap_distance:    parseFloat(vwap_distance.toFixed(3)),
    vwap_signal,
    ema9:             s.ema9  ? parseFloat(s.ema9.toFixed(2))  : null,
    ema21:            s.ema21 ? parseFloat(s.ema21.toFixed(2)) : null,
    ema50:            s.ema50 ? parseFloat(s.ema50.toFixed(2)) : null,
    ema_stack,
    atr14:            atrData.atr14  ? parseFloat(atrData.atr14.toFixed(2))  : null,
    atr5:             atrData.atr5   ? parseFloat(atrData.atr5.toFixed(2))   : null,
    atr_ratio:        atrData.atr_ratio ? parseFloat(atrData.atr_ratio.toFixed(3)) : null,
    timestamp:        Date.now(),
  });
}

// ─── Build 1-minute candles from tick stream ─────────────
async function buildCandle(symbol) {
  const streamKey = `tick:${symbol}:stream`;
  const now       = Date.now();
  const oneMinAgo = now - 60000;

  // Read last 1 minute of ticks
  const ticks = await redis.xrange(streamKey, oneMinAgo, '+');
  if (!ticks || ticks.length === 0) return null;

  let open = null, high = -Infinity, low = Infinity;
  let close = null, volume = 0;

  for (const [, fields] of ticks) {
    // Redis stream fields come as flat array: [key, val, key, val...]
    const tick = {};
    for (let i = 0; i < fields.length; i += 2) {
      tick[fields[i]] = fields[i + 1];
    }

    const price = parseFloat(tick.price || tick.ltp || 0);
    const vol   = parseFloat(tick.volume || 0);

    if (price <= 0) continue;

    if (open === null) open = price;
    high   = Math.max(high, price);
    low    = Math.min(low, price);
    close  = price;
    volume += vol;
  }

  if (open === null) return null;

  return { open, high, low, close, volume, timestamp: now };
}

// ─── Daily reset at session start ────────────────────────
function resetDailyState(symbol) {
  const s = getState(symbol);
  s.vwap_cum_pv  = 0;
  s.vwap_cum_vol = 0;
  s.vwap_prices  = [];
  log(`Daily VWAP reset for ${symbol}`);
}

// ─── Main worker loop ────────────────────────────────────
const PRIMARY = TRADING_CONFIG.PRIMARY_FUTURE; // NIFTY futures — primary instrument

async function run() {
  log('Price Action Worker starting...');

  // Process primary instrument + indices
  const instruments = [
    TRADING_CONFIG.PRIMARY_FUTURE,
    TRADING_CONFIG.SECONDARY_FUTURE,
  ];

  while (true) {
    try {
      // Check kill switch
      const killed = await redis.get('kill:active');
      if (killed === '1') {
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      for (const symbol of instruments) {
        const candle = await buildCandle(symbol);
        if (candle) {
          await processCandleClose(symbol, candle);
        }
      }

      // Update worker heartbeat
      await redis.set(`worker:${WORKER_NAME}:heartbeat`, Date.now(), 'EX', 30);

    } catch (err) {
      log(`Error: ${err.message}`, 'ERROR');
    }

    // Run every 10 seconds
    await new Promise(r => setTimeout(r, 10000));
  }
}

run().catch(err => {
  log(`Fatal: ${err.message}`, 'ERROR');
  process.exit(1);
});
