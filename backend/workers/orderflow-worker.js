/**
 * ORDERFLOW WORKER — OBI + Absorption + Liquidity Sweep
 * =======================================================
 * Primary alpha source — institutional footprint detector
 * Reads: Redis tick stream (bid/ask depth)
 * Writes: Feature Store
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG, FUTURES } = require('../../config/instruments');

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

const WORKER_NAME = 'orderflow';
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [${WORKER_NAME.toUpperCase()}] [${lvl}] ${msg}`);

const state = {};
function getState(symbol) {
  if (!state[symbol]) {
    state[symbol] = {
      prev_day_high: null,
      prev_day_low:  null,
      session_high:  -Infinity,
      session_low:   Infinity,
      obi_history:   [],       // Last 5 OBI values
      price_history: [],       // For absorption detection
      vol_history:   [],
    };
  }
  return state[symbol];
}

// ── OBI: Order Book Imbalance ────────────────────────────
// OBI = (BidVol - AskVol) / (BidVol + AskVol)  range: -1 to +1
function calcOBI(bidQty, askQty) {
  const total = bidQty + askQty;
  if (total === 0) return 0;
  return parseFloat(((bidQty - askQty) / total).toFixed(4));
}

// ── Absorption Detection ─────────────────────────────────
// Large volume + tiny price move = someone absorbing
function detectAbsorption(s, price, volume, atr14) {
  s.price_history.push(price);
  s.vol_history.push(volume);
  if (s.price_history.length > 5) s.price_history.shift();
  if (s.vol_history.length > 5)   s.vol_history.shift();
  if (s.price_history.length < 3) return { absorption: false, type: null };

  const avgVol    = s.vol_history.reduce((a,b)=>a+b,0) / s.vol_history.length;
  const priceMove = Math.abs(price - s.price_history[0]);
  const volSpike  = volume > avgVol * 2;
  const tinyMove  = atr14 ? priceMove < atr14 * 0.15 : priceMove < 5;

  if (volSpike && tinyMove) {
    // Check if it's bullish (selling absorbed) or bearish (buying absorbed)
    const priceDir = price >= s.price_history[0] ? 'UP' : 'DOWN';
    return {
      absorption: true,
      type: priceDir === 'DOWN' ? 'BULLISH' : 'BEARISH', // selling into falling price absorbed = bullish
    };
  }
  return { absorption: false, type: null };
}

// ── Liquidity Sweep Detection ────────────────────────────
// Price breaks key level + huge volume + immediate reversal
function detectLiquiditySweep(s, price, volume, atr14) {
  // Update session high/low
  s.session_high = Math.max(s.session_high, price);
  s.session_low  = Math.min(s.session_low,  price);

  if (!s.prev_day_high || !s.prev_day_low) return { sweep: false, type: null };

  const avgVol     = 1000; // placeholder — will use proper baseline in Phase 2
  const volSpike   = volume > avgVol * 2.5;
  const atr        = atr14 || 50;

  // Bullish sweep: price dips below PDL then closes above it
  const belowPDL   = price < s.prev_day_low;
  const nearPDL    = Math.abs(price - s.prev_day_low) < atr * 0.3;

  // Bearish sweep: price spikes above PDH then closes below it
  const abovePDH   = price > s.prev_day_high;
  const nearPDH    = Math.abs(price - s.prev_day_high) < atr * 0.3;

  if (nearPDL && volSpike) return { sweep: true, type: 'PDL_BULL' };
  if (nearPDH && volSpike) return { sweep: true, type: 'PDH_BEAR' };

  return { sweep: false, type: null };
}

// ── Main candle processor ────────────────────────────────
async function processCandle(symbol) {
  const streamKey = `tick:${symbol}:stream`;
  const now       = Date.now();
  const oneMinAgo = now - 60000;
  const ticks     = await redis.xrange(streamKey, oneMinAgo, '+');
  if (!ticks || ticks.length === 0) return;

  const s       = getState(symbol);
  const atr14   = parseFloat(await redis.hget(`features:${symbol}:latest`, 'atr14') || '0') || null;

  let totalBidQty = 0, totalAskQty = 0;
  let totalVol    = 0, lastPrice   = null;
  const obiVals   = [];

  for (const [, fields] of ticks) {
    const tick = {};
    for (let i = 0; i < fields.length; i += 2) tick[fields[i]] = fields[i + 1];
    const price   = parseFloat(tick.price    || 0);
    const bidQty  = parseFloat(tick.bid_qty  || 0);
    const askQty  = parseFloat(tick.ask_qty  || 0);
    const volume  = parseFloat(tick.volume   || 0);
    if (price <= 0) continue;
    lastPrice = price;
    totalVol += volume;
    if (bidQty + askQty > 0) obiVals.push(calcOBI(bidQty, askQty));
    totalBidQty += bidQty;
    totalAskQty += askQty;
  }

  if (!lastPrice) return;

  // Average OBI over the candle
  const obi = obiVals.length > 0
    ? parseFloat((obiVals.reduce((a,b)=>a+b,0) / obiVals.length).toFixed(4))
    : calcOBI(totalBidQty, totalAskQty);

  // OFI: net aggression (simplified)
  const ofi = parseFloat((totalBidQty - totalAskQty).toFixed(0));

  // Absorption
  const absResult = detectAbsorption(s, lastPrice, totalVol, atr14);

  // Liquidity sweep
  const sweepResult = detectLiquiditySweep(s, lastPrice, totalVol, atr14);

  await writeWorkerOutput(symbol, WORKER_NAME, {
    obi:             obi,
    ofi:             ofi,
    absorption:      absResult.absorption,
    absorption_type: absResult.type,
    liquidity_sweep: sweepResult.sweep,
    sweep_type:      sweepResult.type,
    timestamp:       now,
  });
}

// ── Load previous day high/low from Redis on startup ─────
async function loadPrevDayLevels() {
  for (const sym of [TRADING_CONFIG.PRIMARY_FUTURE, TRADING_CONFIG.SECONDARY_FUTURE]) {
    const pdh = await redis.get(`levels:${sym}:pdh`);
    const pdl = await redis.get(`levels:${sym}:pdl`);
    if (pdh) getState(sym).prev_day_high = parseFloat(pdh);
    if (pdl) getState(sym).prev_day_low  = parseFloat(pdl);
    log(`Loaded PDH/PDL for ${sym}: ${pdh} / ${pdl}`);
  }
}

async function run() {
  log('Orderflow Worker starting...');
  await loadPrevDayLevels();
  const instruments = [TRADING_CONFIG.PRIMARY_FUTURE, TRADING_CONFIG.SECONDARY_FUTURE];
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed === '1') { await new Promise(r => setTimeout(r, 5000)); continue; }
      for (const sym of instruments) await processCandle(sym);
      await redis.set(`worker:${WORKER_NAME}:heartbeat`, Date.now(), 'EX', 30);
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 10000));
  }
}

run().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
