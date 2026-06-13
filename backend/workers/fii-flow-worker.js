/**
 * FII FLOW WORKER — Daily FII/DII Net Flow
 * Published by NSE at 6 PM — used as next-day bias
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const https = require('https');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [FII_FLOW] [${lvl}] ${msg}`);

// NSE FII/DII data — publicly available
async function fetchFIIData() {
  return new Promise((resolve) => {
    const url = 'https://www.nseindia.com/api/fiidiiTradeReact';
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function processFIIFlow() {
  const data = await fetchFIIData();
  if (!data) {
    log('FII data fetch failed — using cached', 'WARN');
    return;
  }

  // NSE data format: array with FII and DII rows
  const fiiRow = Array.isArray(data) ? data.find(r => r.category === 'FII/FPI') : null;
  const diiRow = Array.isArray(data) ? data.find(r => r.category === 'DII') : null;

  const fii_net = fiiRow ? parseFloat(fiiRow.netVal || 0) : 0;
  const dii_net = diiRow ? parseFloat(diiRow.netVal || 0) : 0;

  const fii_bias = fii_net > 500  ? 'BULLISH'
    : fii_net < -500 ? 'BEARISH'
    : 'NEUTRAL';

  await writeWorkerOutput(TRADING_CONFIG.PRIMARY_FUTURE, 'fii_flow', {
    fii_net, fii_bias, timestamp: Date.now()
  });

  // Cache for intraday use
  await redis.set('fii:daily:net',  fii_net,  'EX', 86400);
  await redis.set('fii:daily:bias', fii_bias, 'EX', 86400);

  log(`FII Net: ${fii_net} Cr [${fii_bias}] | DII Net: ${dii_net} Cr`);
}

(async function run() {
  log('FII Flow Worker starting...');
  // Load cached value immediately on startup
  const cached = await redis.get('fii:daily:net');
  if (cached) {
    log(`Using cached FII net: ${cached} Cr`);
  }
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        await processFIIFlow();
        await redis.set('worker:fii_flow:heartbeat', Date.now(), 'EX', 3600);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 3600000)); // Every hour
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
