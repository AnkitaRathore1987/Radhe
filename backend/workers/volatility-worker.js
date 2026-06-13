/**
 * VOLATILITY WORKER — VIX + ATR Ratio
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG, INDICES } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [VOL_WORKER] [${lvl}] ${msg}`);

const vixHistory = [];

async function processVolatility() {
  const vixTick  = await redis.hgetall(`tick:${INDICES.VIX}:latest`);
  const vix      = parseFloat(vixTick?.price || 0);
  if (vix <= 0) return;

  vixHistory.push({ vix, time: Date.now() });
  if (vixHistory.length > 50) vixHistory.shift();

  // VIX Rate of Change (30 min)
  const ago30 = vixHistory.find(v => v.time < Date.now() - 1800000);
  const vix_roc = ago30 ? parseFloat(((vix - ago30.vix) / ago30.vix * 100).toFixed(3)) : 0;

  const vix_regime = vix > 25 ? 'HIGH'
    : vix > 20 ? 'ELEVATED'
    : vix > 15 ? 'NORMAL'
    : 'LOW';

  // Read ATR from Feature Store (computed by price-action worker)
  const features = await redis.hgetall(`features:${TRADING_CONFIG.PRIMARY_FUTURE}:latest`);
  const atr5     = parseFloat(features?.atr5  || 0);
  const atr14    = parseFloat(features?.atr14 || 0);
  const atr_ratio = atr14 > 0 ? parseFloat((atr5 / atr14).toFixed(3)) : 1;

  await writeWorkerOutput(TRADING_CONFIG.PRIMARY_FUTURE, 'volatility', {
    vix, vix_regime, vix_roc, atr_ratio, timestamp: Date.now()
  });
}

(async function run() {
  log('Volatility Worker starting...');
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        await processVolatility();
        await redis.set('worker:volatility:heartbeat', Date.now(), 'EX', 30);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 15000));
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
