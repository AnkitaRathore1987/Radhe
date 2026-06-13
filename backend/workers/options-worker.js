/**
 * OPTIONS WORKER — GEX + PCR + Dealer Delta
 * ===========================================
 * Options market mein institutional positioning track karta hai.
 * Reads: Upstox option chain API (every 5 minutes)
 * Writes: Feature Store
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis  = require('ioredis');
const https  = require('https');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { OPTION_CHAIN, TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

const WORKER_NAME = 'options_gex';
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [${WORKER_NAME.toUpperCase()}] [${lvl}] ${msg}`);

// ── Fetch option chain from Upstox ───────────────────────
async function fetchOptionChain(underlying) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) return null;

  const cfg    = OPTION_CHAIN[underlying];
  if (!cfg) return null;

  return new Promise((resolve, reject) => {
    const url = `https://api.upstox.com/v2/option/chain?instrument_key=${cfg.exchange}|${cfg.underlying}&expiry_date=2025-06-26`;
    const options = {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ── PCR Calculation ──────────────────────────────────────
// PCR_OI = Total Put OI / Total Call OI
function calcPCR(chain) {
  let totalPutOI = 0, totalCallOI = 0;
  let totalPutVol = 0, totalCallVol = 0;

  for (const strike of chain) {
    totalPutOI   += strike.put_options?.market_data?.oi  || 0;
    totalCallOI  += strike.call_options?.market_data?.oi || 0;
    totalPutVol  += strike.put_options?.market_data?.volume  || 0;
    totalCallVol += strike.call_options?.market_data?.volume || 0;
  }

  const pcr_oi  = totalCallOI  > 0 ? parseFloat((totalPutOI  / totalCallOI).toFixed(3))  : 1;
  const pcr_vol = totalCallVol > 0 ? parseFloat((totalPutVol / totalCallVol).toFixed(3)) : 1;
  return { pcr_oi, pcr_vol };
}

// ── GEX: Gamma Exposure ──────────────────────────────────
// GEX = Σ [Gamma × OI × 100 × Spot²]
// Positive GEX = dealers long gamma = market-dampening (mean revert)
// Negative GEX = dealers short gamma = market-amplifying (trending)
function calcGEX(chain, spotPrice) {
  let totalGEX    = 0;
  let maxGEX      = 0;
  let gammaWall   = 0;
  const strikeGEX = [];

  for (const strike of chain) {
    const callGamma = strike.call_options?.option_greeks?.gamma || 0;
    const putGamma  = strike.put_options?.option_greeks?.gamma  || 0;
    const callOI    = strike.call_options?.market_data?.oi      || 0;
    const putOI     = strike.put_options?.market_data?.oi       || 0;
    const strikePx  = strike.strike_price || 0;

    // Dealers are SHORT calls and LONG puts (opposite of retail)
    // Call GEX: dealers short calls = negative gamma from calls
    const callGEX   = -callGamma * callOI * 100 * Math.pow(spotPrice, 2) / 1e7;
    // Put GEX: dealers long puts = positive gamma from puts
    const putGEX    =  putGamma  * putOI  * 100 * Math.pow(spotPrice, 2) / 1e7;
    const netGEX    = callGEX + putGEX;

    totalGEX += netGEX;
    strikeGEX.push({ strike: strikePx, gex: netGEX });

    if (Math.abs(netGEX) > Math.abs(maxGEX)) {
      maxGEX    = netGEX;
      gammaWall = strikePx;
    }
  }

  const gexState = totalGEX > 500  ? 'POSITIVE'   // dampening
    : totalGEX  < -500 ? 'NEGATIVE'   // amplifying
    : 'NEAR_ZERO';

  return {
    gex:              parseFloat(totalGEX.toFixed(2)),
    gex_state:        gexState,
    gamma_wall_level: gammaWall,
  };
}

// ── Dealer Delta ─────────────────────────────────────────
// Net delta exposure dealers need to hedge
function calcDealerDelta(chain, spotPrice) {
  let netDelta = 0;
  for (const strike of chain) {
    const callDelta = strike.call_options?.option_greeks?.delta || 0;
    const putDelta  = strike.put_options?.option_greeks?.delta  || 0;
    const callOI    = strike.call_options?.market_data?.oi      || 0;
    const putOI     = strike.put_options?.market_data?.oi       || 0;
    // Dealers are opposite side — short calls (negative delta), long puts (negative delta)
    netDelta += (-callDelta * callOI) + (-putDelta * putOI);
  }
  return parseFloat((netDelta / 1000).toFixed(2)); // in thousands
}

// ── Process option chain ─────────────────────────────────
async function processChain(underlying) {
  try {
    const spotKey  = underlying === 'NIFTY' ? 'NSE_INDEX|Nifty 50' : 'NSE_INDEX|Nifty Bank';
    const spotData = await redis.hgetall(`tick:${spotKey}:latest`);
    const spot     = parseFloat(spotData?.price || 0);
    if (spot <= 0) return;

    const response = await fetchOptionChain(underlying);
    if (!response?.data) return;

    const chain = response.data;
    const pcr   = calcPCR(chain);
    const gex   = calcGEX(chain, spot);
    const delta = calcDealerDelta(chain, spot);

    // Write to feature store for primary future
    const symbol = underlying === 'NIFTY'
      ? TRADING_CONFIG.PRIMARY_FUTURE
      : TRADING_CONFIG.SECONDARY_FUTURE;

    await writeWorkerOutput(symbol, WORKER_NAME, {
      pcr_oi:           pcr.pcr_oi,
      pcr_vol:          pcr.pcr_vol,
      gex:              gex.gex,
      gex_state:        gex.gex_state,
      gamma_wall_level: gex.gamma_wall_level,
      dealer_delta:     delta,
      timestamp:        Date.now(),
    });

    log(`${underlying}: GEX=${gex.gex.toFixed(0)} [${gex.gex_state}] PCR_OI=${pcr.pcr_oi} Wall=${gex.gamma_wall_level}`);
  } catch (err) {
    log(`Chain fetch error for ${underlying}: ${err.message}`, 'WARN');
  }
}

async function run() {
  log('Options Worker starting...');
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        await processChain('NIFTY');
        await processChain('BANKNIFTY');
        await redis.set(`worker:${WORKER_NAME}:heartbeat`, Date.now(), 'EX', 60);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    // Options chain — every 5 minutes (no need for tick-level refresh)
    await new Promise(r => setTimeout(r, 300000));
  }
}

run().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
