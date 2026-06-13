/**
 * MASTER AGENT — Signal Fusion Brain
 * ====================================
 * Reads Feature Store. Never reads raw ticks.
 * Produces: { direction, confidence, reason } → Risk Agent
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { getFeatures, isFresh } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [MASTER] [${lvl}] ${msg}`);

// ── Dynamic weights (Learning Agent updates these) ────────
async function getWeights() {
  const stored = await redis.hgetall('master:weights');
  return {
    orderflow: parseFloat(stored?.orderflow || '0.25'),
    cvd:       parseFloat(stored?.cvd       || '0.20'),
    vwap:      parseFloat(stored?.vwap      || '0.18'),
    gex:       parseFloat(stored?.gex       || '0.15'),
    breadth:   parseFloat(stored?.breadth   || '0.10'),
    mtf:       parseFloat(stored?.mtf       || '0.08'),
    fii:       parseFloat(stored?.fii       || '0.04'),
  };
}

// ── Regime multipliers ────────────────────────────────────
const REGIME_MULT = {
  TRENDING_UP:   { orderflow:1.1, cvd:1.2, vwap:0.9, gex:0.8,  breadth:1.1, mtf:1.1, fii:1.0 },
  TRENDING_DOWN: { orderflow:1.1, cvd:1.2, vwap:0.9, gex:0.8,  breadth:1.0, mtf:1.1, fii:1.0 },
  SIDEWAYS:      { orderflow:0.9, cvd:0.8, vwap:1.3, gex:1.3,  breadth:0.7, mtf:0.7, fii:0.5 },
  BREAKOUT:      { orderflow:1.3, cvd:1.3, vwap:0.8, gex:0.7,  breadth:1.2, mtf:1.2, fii:0.8 },
  PANIC:         { orderflow:0.5, cvd:0.5, vwap:0.5, gex:0.5,  breadth:0.3, mtf:0.3, fii:2.0 },
};

// ── Classify current regime ───────────────────────────────
function classifyRegime(f) {
  const adx    = f.adx  || 0;
  const vix    = f.vix  || 15;
  const breadth = f.ad_ratio || 1;

  if (vix > 25) return 'PANIC';
  if (f.news_state === 'BLOCK') return 'NEWS_DRIVEN';
  if (adx > 25 && breadth > 1.5) return 'TRENDING_UP';
  if (adx > 25 && breadth < 0.7) return 'TRENDING_DOWN';
  if (adx < 20 && vix < 15)      return 'SIDEWAYS';
  return 'SIDEWAYS'; // Default — conservative
}

// ── Score each signal component ───────────────────────────
// Returns { score: -1..+1, confidence_contribution: 0..100 }
function scoreOBI(f) {
  const obi = f.obi || 0;
  if (obi > 0.4)  return  obi;
  if (obi < -0.4) return  obi; // negative = bearish
  return 0;
}
function scoreCVD(f) {
  if (f.cvd_slope === 'RISING'  && !f.cvd_divergence) return  0.7;
  if (f.cvd_slope === 'FALLING' && !f.cvd_divergence) return -0.7;
  if (f.cvd_divergence) return f.cvd_slope === 'RISING' ? -0.5 : 0.5; // divergence = opposite
  return 0;
}
function scoreVWAP(f, regime) {
  if (!f.vwap_signal) return 0;
  if (regime === 'SIDEWAYS') {
    if (f.vwap_signal === 'BELOW' && f.obi > 0.2) return  0.6; // mean revert up
    if (f.vwap_signal === 'ABOVE' && f.obi < -0.2) return -0.6;
  } else {
    if (f.vwap_signal === 'ABOVE') return  0.4;
    if (f.vwap_signal === 'BELOW') return -0.4;
  }
  return 0;
}
function scoreGEX(f) {
  if (f.gex_state === 'NEGATIVE') return f.cvd_slope === 'RISING' ?  0.5 : -0.5; // amplify trend
  if (f.gex_state === 'POSITIVE') return 0.2; // mean-reverting — slight signal
  return 0;
}
function scoreBreadth(f) {
  if (f.breadth_signal === 'BROAD_RALLY') return  0.6;
  if (f.breadth_signal === 'BROAD_SELL')  return -0.6;
  if (f.breadth_signal === 'NARROW')      return  0;
  return 0;
}
function scoreMTF(f) {
  if (!f.mtf_score) return 0;
  return parseFloat(((f.mtf_score - 0.5) * 2).toFixed(3)); // normalize to -1..+1
}
function scoreFII(f) {
  if (f.fii_bias === 'BULLISH') return  0.4;
  if (f.fii_bias === 'BEARISH') return -0.4;
  return 0;
}

// ── Main signal fusion ────────────────────────────────────
async function evaluate(symbol) {
  // 1. Kill switch check
  if (await redis.get('kill:active') === '1') return null;

  // 2. Check Feature Store freshness
  const fresh = await isFresh(symbol, 30000);
  if (!fresh) { log(`Features stale for ${symbol} — skip`, 'WARN'); return null; }

  // 3. Read features
  const f = await getFeatures(symbol);
  if (!f) return null;

  // 4. Hard blocks
  if (f.news_state === 'BLOCK') { log('Trading BLOCKED — news event'); return null; }
  if (f.vix > 25) { log('VIX > 25 — no new entries'); return null; }

  // 5. Check causal rules
  const rules = await redis.hgetall('causal:active');
  // Rules loaded to Redis at 9 AM from causal-rules.json
  // For now: simple check
  if (rules?.BUDGET_DAY === '1' || rules?.RBI_POLICY_DAY === '1') {
    log('Causal rule blocking trade'); return null;
  }

  // 6. Classify regime
  const regime = classifyRegime(f);
  if (regime === 'NEWS_DRIVEN') return null;

  const mult = REGIME_MULT[regime] || REGIME_MULT.SIDEWAYS;
  const weights = await getWeights();

  // 7. Compute weighted score
  const components = {
    orderflow: scoreOBI(f),
    cvd:       scoreCVD(f),
    vwap:      scoreVWAP(f, regime),
    gex:       scoreGEX(f),
    breadth:   scoreBreadth(f),
    mtf:       scoreMTF(f),
    fii:       scoreFII(f),
  };

  let totalScore  = 0;
  let totalWeight = 0;
  const breakdown = {};

  for (const [key, rawScore] of Object.entries(components)) {
    const w        = (weights[key] || 0) * (mult[key] || 1);
    const weighted = rawScore * w;
    totalScore    += weighted;
    totalWeight   += w;
    breakdown[key] = { raw: rawScore, weighted };
  }

  const normalizedScore = totalWeight > 0 ? totalScore / totalWeight : 0;
  const absScore        = Math.abs(normalizedScore);

  // 8. Convert to confidence (0-100)
  const confidence = Math.round(Math.min(95, absScore * 100));
  const direction  = normalizedScore > 0 ? 'BUY' : 'SELL';

  // 9. Minimum confidence threshold
  if (confidence < 65) {
    log(`Low confidence ${confidence} for ${symbol} — skip`);
    return null;
  }

  const signal = {
    symbol, direction, confidence, regime,
    score: parseFloat(normalizedScore.toFixed(4)),
    breakdown,
    features_snapshot: {
      obi: f.obi, cvd_slope: f.cvd_slope, sweep: f.liquidity_sweep,
      vwap_signal: f.vwap_signal, gex_state: f.gex_state,
      breadth: f.breadth_signal, vix: f.vix, mtf: f.mtf_score,
    },
    timestamp: Date.now(),
  };

  // Write to Redis for Risk Agent
  await redis.set('master:signal:latest', JSON.stringify(signal), 'EX', 300);
  await redis.lpush('master:signal:history', JSON.stringify(signal));
  await redis.ltrim('master:signal:history', 0, 99);

  log(`SIGNAL: ${direction} ${symbol} | Conf: ${confidence} | Regime: ${regime}`);
  return signal;
}

// ── Main loop ─────────────────────────────────────────────
(async function run() {
  log('Master Agent starting...');
  const symbol = TRADING_CONFIG.PRIMARY_FUTURE;
  while (true) {
    try {
      await evaluate(symbol);
      await redis.set('master:heartbeat', Date.now(), 'EX', 30);
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 10000)); // Evaluate every 10 seconds
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
