/**
 * MTF WORKER — Multi-Timeframe Alignment Score
 * Combines 1m + 5m + 15m + 1h signals into single score (0 to 1)
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [MTF] [${lvl}] ${msg}`);

// Store candle closes per timeframe
const candles = { '1m': [], '5m': [], '15m': [], '1h': [] };
const WEIGHTS  = { '1m': 0.15, '5m': 0.25, '15m': 0.35, '1h': 0.25 };

function emaSignal(closes, period) {
  if (closes.length < period) return 0; // neutral
  const k    = 2 / (period + 1);
  let ema    = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  const last = closes[closes.length - 1];
  return last > ema ? 1 : last < ema ? -1 : 0;
}

async function processMTF(symbol) {
  const tick = await redis.hgetall(`tick:${symbol}:latest`);
  const price = parseFloat(tick?.price || 0);
  if (price <= 0) return;

  candles['1m'].push(price);
  if (candles['1m'].length % 5  === 0) candles['5m'].push(price);
  if (candles['1m'].length % 15 === 0) candles['15m'].push(price);
  if (candles['1m'].length % 60 === 0) candles['1h'].push(price);

  for (const tf of Object.keys(candles)) {
    if (candles[tf].length > 100) candles[tf].shift();
  }

  // Direction per timeframe (-1, 0, +1)
  const dirs = {
    '1m':  emaSignal(candles['1m'],  9),
    '5m':  emaSignal(candles['5m'],  9),
    '15m': emaSignal(candles['15m'], 9),
    '1h':  emaSignal(candles['1h'],  9),
  };

  // Weighted score: +1 = fully bullish, -1 = fully bearish
  let score = 0;
  for (const [tf, weight] of Object.entries(WEIGHTS)) score += dirs[tf] * weight;

  // Normalize to 0-1 range: 0=fully bear, 0.5=neutral, 1=fully bull
  const mtf_score     = parseFloat(((score + 1) / 2).toFixed(3));
  const mtf_direction = score > 0.2 ? 'BULL' : score < -0.2 ? 'BEAR' : 'NEUTRAL';

  await writeWorkerOutput(symbol, 'mtf', { mtf_score, mtf_direction, timestamp: Date.now() });
}

(async function run() {
  log('MTF Worker starting...');
  const sym = TRADING_CONFIG.PRIMARY_FUTURE;
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        await processMTF(sym);
        await redis.set('worker:mtf:heartbeat', Date.now(), 'EX', 30);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 10000));
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
