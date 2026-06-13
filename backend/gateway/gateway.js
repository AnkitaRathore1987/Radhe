/**
 * MARKET GATEWAY
 * ==============
 * Ek kaam: Upstox se ticks lena aur Redis mein daalna.
 * Koi calculation nahi. Koi signal nahi. Sirf data ingestion.
 *
 * Flow: Upstox WebSocket → Decode Protobuf → Validate → Redis
 */

'use strict';

require('dotenv').config({ path: '../config/.env' });
const WebSocket  = require('ws');
const protobuf   = require('protobufjs');
const Redis      = require('ioredis');
const path       = require('path');

// Central config — instrument names yahan se aate hain
const { SUBSCRIBE_LIST, INDICES, FUTURES } = require('../config/instruments');

// ─── Redis connection ───────────────────────────────────
const redis = new Redis({
  host:     process.env.REDIS_HOST || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryStrategy: (times) => Math.min(times * 100, 3000), // Auto-reconnect
});

redis.on('connect',       () => log('Redis connected'));
redis.on('error',    (err) => log(`Redis error: ${err.message}`, 'ERROR'));
redis.on('reconnecting',  () => log('Redis reconnecting...', 'WARN'));

// ─── Logging ────────────────────────────────────────────
function log(msg, level = 'INFO') {
  const ts  = new Date().toISOString();
  const out = `[${ts}] [GATEWAY] [${level}] ${msg}`;
  console.log(out);

  // Critical errors → Redis (monitoring agent reads this)
  if (level === 'ERROR') {
    redis.lpush('gateway:errors', JSON.stringify({ ts, msg }))
         .catch(() => {});
    redis.ltrim('gateway:errors', 0, 99); // Keep last 100 errors
  }
}

// ─── Protobuf setup ─────────────────────────────────────
// Upstox uses protobuf for binary tick encoding — much faster than JSON
let MarketDataFeed;

async function loadProtobuf() {
  try {
    // Upstox ka proto file — download from their GitHub
    // https://github.com/upstox/upstox-python/blob/master/upstox_client/feeder/market_data_feeder.proto
    const protoPath = path.join(__dirname, 'market_data.proto');
    const root = await protobuf.load(protoPath);
    MarketDataFeed = root.lookupType('com.upstox.marketdatafeeder.rpc.proto.MarketDataFeed');
    log('Protobuf schema loaded');
  } catch (err) {
    log(`Protobuf load failed: ${err.message}`, 'ERROR');
    // Fallback: JSON mode (slower but works without proto file)
    MarketDataFeed = null;
    log('Falling back to JSON mode', 'WARN');
  }
}

// ─── Tick validation ────────────────────────────────────
function validateTick(tick) {
  // Reject obviously bad data before storing
  if (!tick.symbol)           return false;
  if (tick.price <= 0)        return false;
  if (tick.price > 100000)    return false; // Nifty never crosses 1 lakh
  if (tick.volume < 0)        return false;

  // Spike detection — reject if price moves > 5% in single tick
  // (Circuit breaker events are handled separately)
  // We'll add this after we have baseline prices in Redis

  return true;
}

// ─── Decode incoming WebSocket message ──────────────────
function decodeTick(data) {
  try {
    if (MarketDataFeed) {
      // Protobuf decode — production mode
      const buffer  = Buffer.from(data);
      const decoded = MarketDataFeed.decode(buffer);
      return MarketDataFeed.toObject(decoded);
    } else {
      // JSON fallback mode
      return JSON.parse(data.toString());
    }
  } catch (err) {
    log(`Decode error: ${err.message}`, 'ERROR');
    return null;
  }
}

// ─── Store tick in Redis ─────────────────────────────────
async function storeTick(tick) {
  const key    = `tick:${tick.symbol}`;
  const tsNow  = Date.now();
  const payload = {
    symbol:      tick.symbol,
    price:       tick.ltp  || tick.last_price || 0,   // ltp = last traded price
    open:        tick.open_price  || 0,
    high:        tick.high_price  || 0,
    low:         tick.low_price   || 0,
    close:       tick.close_price || 0,
    volume:      tick.volume      || 0,
    bid:         tick.best_bid_price || 0,
    ask:         tick.best_ask_price || 0,
    bid_qty:     tick.best_bid_quantity  || 0,
    ask_qty:     tick.best_ask_quantity  || 0,
    oi:          tick.oi || 0,           // Open Interest (futures/options)
    receivedAt:  tsNow,
  };

  const pipeline = redis.pipeline();

  // 1. Latest tick (hash) — workers read this
  pipeline.hset(`${key}:latest`, payload);
  pipeline.expire(`${key}:latest`, 1800); // 30 min TTL

  // 2. Tick stream — for candle building & replay
  pipeline.xadd(
    `${key}:stream`,
    '*',
    ...Object.entries(payload).flat().map(String)
  );
  pipeline.xtrim(`${key}:stream`, 'MAXLEN', '~', 3600); // Keep ~1hr of ticks

  // 3. Gateway heartbeat — monitoring checks this
  pipeline.set('gateway:last_tick', tsNow, 'EX', 60);
  pipeline.incr('gateway:tick_count');

  await pipeline.exec();
}

// ─── Get Upstox access token ─────────────────────────────
// Token changes daily — startup script sets it in env
function getAccessToken() {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) {
    log('ACCESS TOKEN NOT SET — run auth script first', 'ERROR');
    process.exit(1);
  }
  return token;
}

// ─── Build subscription message ─────────────────────────
function buildSubscribeMessage(instruments) {
  return JSON.stringify({
    guid:  `sub_${Date.now()}`,
    method: 'sub',
    data: {
      mode: 'full',          // full = all tick data including OI, bid/ask
      instrumentKeys: instruments,
    }
  });
}

// ─── Main WebSocket connection ───────────────────────────
let ws;
let reconnectTimer;
let isShuttingDown = false;

async function connectWebSocket() {
  const token = getAccessToken();
  const wsUrl = `wss://api.upstox.com/v2/feed/market-data-feed`;

  log(`Connecting to Upstox WebSocket...`);
  log(`Subscribing to ${SUBSCRIBE_LIST.length} instruments`);

  ws = new WebSocket(wsUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Api-Version':   '2.0',
    }
  });

  ws.on('open', () => {
    log('WebSocket connected');

    // Subscribe to all instruments from instruments.js
    const subMsg = buildSubscribeMessage(SUBSCRIBE_LIST);
    ws.send(subMsg);
    log(`Subscription sent for ${SUBSCRIBE_LIST.length} instruments`);

    // Update Redis — gateway is live
    redis.set('gateway:status', 'CONNECTED', 'EX', 30);
  });

  ws.on('message', async (data) => {
    // Latency tracking — tick arrival time
    const arrivalTime = performance.now();

    const raw = decodeTick(data);
    if (!raw) return;

    // Upstox sends feeds as array of ticks
    const ticks = Array.isArray(raw.feeds) ? raw.feeds : [raw];

    for (const tickData of ticks) {
      // Flatten Upstox response structure
      const tick = {
        symbol:           tickData.instrument_key || tickData.symbol,
        ltp:              tickData.ff?.marketFF?.ltpc?.ltp || tickData.ltp,
        volume:           tickData.ff?.marketFF?.marketOHLC?.ohlc?.[0]?.volume || 0,
        open_price:       tickData.ff?.marketFF?.marketOHLC?.ohlc?.[0]?.open || 0,
        high_price:       tickData.ff?.marketFF?.marketOHLC?.ohlc?.[0]?.high || 0,
        low_price:        tickData.ff?.marketFF?.marketOHLC?.ohlc?.[0]?.low  || 0,
        close_price:      tickData.ff?.marketFF?.ltpc?.cp || 0,
        best_bid_price:   tickData.ff?.marketFF?.depth?.bid?.[0]?.price || 0,
        best_ask_price:   tickData.ff?.marketFF?.depth?.ask?.[0]?.price || 0,
        best_bid_quantity: tickData.ff?.marketFF?.depth?.bid?.[0]?.quantity || 0,
        best_ask_quantity: tickData.ff?.marketFF?.depth?.ask?.[0]?.quantity || 0,
        oi:               tickData.ff?.marketFF?.oi || 0,
      };

      if (!validateTick(tick)) continue;

      await storeTick(tick);

      // Log latency — we want gateway processing < 3ms
      const processingTime = performance.now() - arrivalTime;
      if (processingTime > 5) {
        log(`High latency: ${processingTime.toFixed(2)}ms for ${tick.symbol}`, 'WARN');
      }
    }
  });

  ws.on('error', (err) => {
    log(`WebSocket error: ${err.message}`, 'ERROR');
    redis.set('gateway:status', 'ERROR', 'EX', 30);
  });

  ws.on('close', (code, reason) => {
    log(`WebSocket closed: ${code} — ${reason}`, 'WARN');
    redis.set('gateway:status', 'DISCONNECTED', 'EX', 30);

    if (!isShuttingDown) {
      // Auto-reconnect after 5 seconds
      log('Reconnecting in 5 seconds...');
      reconnectTimer = setTimeout(connectWebSocket, 5000);
    }
  });

  // Heartbeat — keep connection alive
  ws.on('ping', () => ws.pong());
}

// ─── Graceful shutdown ───────────────────────────────────
async function shutdown(signal) {
  log(`Shutdown signal received: ${signal}`);
  isShuttingDown = true;

  clearTimeout(reconnectTimer);

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'Graceful shutdown');
  }

  await redis.set('gateway:status', 'SHUTDOWN');
  await redis.quit();

  log('Gateway shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── Start ──────────────────────────────────────────────
async function start() {
  log('=== MINI-ALADDIN GATEWAY STARTING ===');

  // Check kill switch before starting
  const killActive = await redis.get('kill:active');
  if (killActive === '1') {
    log('KILL SWITCH IS ACTIVE — Gateway will not start', 'ERROR');
    log('Send /RESUME via Telegram to restart', 'ERROR');
    process.exit(1);
  }

  await loadProtobuf();
  await connectWebSocket();
}

start().catch(err => {
  log(`Fatal error: ${err.message}`, 'ERROR');
  process.exit(1);
});
