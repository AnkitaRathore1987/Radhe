/**
 * BREADTH WORKER — Advance/Decline Ratio
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG, FO_STOCKS } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const WORKER_NAME = 'breadth';
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [BREADTH] [${lvl}] ${msg}`);

async function processBreadth() {
  let advancing = 0, declining = 0, unchanged = 0;

  for (const [name, symbol] of Object.entries(FO_STOCKS)) {
    const tick = await redis.hgetall(`tick:${symbol}:latest`);
    if (!tick?.price || !tick?.close) continue;
    const price = parseFloat(tick.price);
    const prev  = parseFloat(tick.close);
    if (price > prev * 1.001)       advancing++;
    else if (price < prev * 0.999)  declining++;
    else                            unchanged++;
  }

  const total    = advancing + declining + unchanged;
  if (total < 5) return;
  const ad_ratio = declining > 0 ? parseFloat((advancing / declining).toFixed(3)) : advancing;
  const signal   = ad_ratio > 2.5 ? 'BROAD_RALLY'
    : ad_ratio > 1.2 ? 'MODERATE'
    : ad_ratio < 0.5 ? 'BROAD_SELL'
    : 'NARROW';

  const symbol = TRADING_CONFIG.PRIMARY_FUTURE;
  await writeWorkerOutput(symbol, WORKER_NAME, {
    ad_ratio, breadth_signal: signal, timestamp: Date.now()
  });
}

async function run() {
  log('Breadth Worker starting...');
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        await processBreadth();
        await redis.set(`worker:${WORKER_NAME}:heartbeat`, Date.now(), 'EX', 60);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 30000)); // Every 30 seconds
  }
}
run().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
