/**
 * EXECUTION AGENT — Order State Machine
 * =======================================
 * PENDING → PLACED → FILLED → CLOSED
 * Upstox primary, Zerodha backup
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis  = require('ioredis');
const https  = require('https');
const { Pool } = require('pg');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [EXECUTION] [${lvl}] ${msg}`);

// ── Upstox order placement ────────────────────────────────
async function placeOrder(order) {
  const token = process.env.UPSTOX_ACCESS_TOKEN;
  if (!token) throw new Error('No access token');

  const body = JSON.stringify({
    quantity:        order.qty,
    product:         'D',          // Intraday
    validity:        'DAY',
    price:           0,            // Market order
    tag:             order.trade_id,
    instrument_token: order.symbol,
    order_type:      'MARKET',
    transaction_type: order.direction, // 'BUY' or 'SELL'
    disclosed_quantity: 0,
    trigger_price:   0,
    is_amo:          false,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.upstox.com',
      path:     '/v2/order/place',
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${token}`,
        'Content-Type':   'application/json',
        'Api-Version':    '2.0',
        'x-algo-id':      process.env.SEBI_ALGO_ID || '',
        'Content-Length': Buffer.byteLength(body),
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Log to audit trail (SEBI compliance) ─────────────────
async function logAudit(action, order, response) {
  await pg.query(`
    INSERT INTO audit_log (algo_id, order_id, action, symbol, price, quantity, direction, status, raw_response, ip_address, broker)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
  `, [
    process.env.SEBI_ALGO_ID || 'UNREGISTERED',
    order.order_id || response?.data?.order_id || '',
    action,
    order.symbol,
    order.price || 0,
    order.qty,
    order.direction,
    response?.status || 'UNKNOWN',
    JSON.stringify(response),
    process.env.STATIC_IP || '0.0.0.0',
    'UPSTOX',
  ]);
}

// ── Log latency ───────────────────────────────────────────
async function logLatency(tradeId, timestamps) {
  const total = timestamps.order_filled_at
    ? timestamps.order_filled_at - timestamps.tick_arrived_at
    : null;
  await pg.query(`
    INSERT INTO latency_log (trade_id, tick_arrived_at, feature_built_at, master_decided_at, risk_approved_at, order_sent_at, order_filled_at, total_ms, session_date)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_DATE)
  `, [tradeId, ...Object.values(timestamps), total]);
}

// ── Process approved signal ───────────────────────────────
async function processApproved(approved) {
  const tradeId = `T${Date.now()}`;
  const tStart  = Date.now();

  log(`Placing ${approved.direction} ${approved.symbol} x${approved.approved_qty} lots`);

  try {
    const orderSentAt = Date.now();

    // Place order
    const response = await placeOrder({
      trade_id:  tradeId,
      symbol:    approved.symbol,
      direction: approved.direction,
      qty:       approved.approved_qty,
    });

    const filled_at = Date.now();

    if (response?.status !== 'success') {
      log(`Order failed: ${JSON.stringify(response)}`, 'ERROR');
      await logAudit('PLACE_FAILED', approved, response);
      return;
    }

    const orderId   = response.data?.order_id;
    const fillPrice = approved.features_snapshot?.vwap || 0; // Will be updated from fill data

    // Store position in Redis
    const position = {
      trade_id:  tradeId,
      order_id:  orderId,
      symbol:    approved.symbol,
      direction: approved.direction,
      qty:       approved.approved_qty,
      entry_price: fillPrice,
      sl_price:  approved.sl_price,
      tsl_price: approved.sl_price, // TSL starts at initial SL
      regime:    approved.regime,
      confidence: approved.confidence,
      entered_at: Date.now(),
    };

    await redis.hset(`position:${tradeId}`, position);
    await redis.expire(`position:${tradeId}`, 86400);
    await redis.incr('positions:open_count');
    await redis.set(`positions:open:${tradeId}`, '1', 'EX', 86400);

    // Log to audit trail
    await logAudit('PLACE', { ...approved, order_id: orderId }, response);

    // Log latency
    await logLatency(tradeId, {
      tick_arrived_at:  approved.timestamp || tStart,
      feature_built_at: approved.timestamp || tStart,
      master_decided_at: approved.timestamp || tStart,
      risk_approved_at:  approved.approved_at || tStart,
      order_sent_at:    orderSentAt,
      order_filled_at:  filled_at,
    });

    // Save trade to PostgreSQL
    await pg.query(`
      INSERT INTO trades (trade_id, algo_id, symbol, direction, quantity, entry_price, sl_price, entry_time, master_confidence, regime, session_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),$8,$9,CURRENT_DATE)
    `, [tradeId, process.env.SEBI_ALGO_ID||'', approved.symbol, approved.direction,
        approved.approved_qty, fillPrice, approved.sl_price, approved.confidence, approved.regime]);

    log(`ORDER PLACED: ${tradeId} | OrderID: ${orderId} | Latency: ${filled_at - tStart}ms`);

    // Telegram notification
    await sendTelegram(`✅ ${approved.direction} ${approved.symbol}\nLots: ${approved.approved_qty} | Conf: ${approved.confidence}%\nSL: ${approved.sl_price}`);

  } catch (err) {
    log(`Order error: ${err.message}`, 'ERROR');
    await logAudit('ERROR', approved, { error: err.message });
  }
}

// ── Telegram ──────────────────────────────────────────────
async function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const body = JSON.stringify({ chat_id: chatId, text: msg });
    const req  = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    req.write(body); req.end();
  } catch {}
}

// ── Square off all positions at 3:10 PM ──────────────────
async function squareOffAll() {
  const keys = await redis.keys('positions:open:*');
  for (const key of keys) {
    const tradeId = key.replace('positions:open:', '');
    const pos = await redis.hgetall(`position:${tradeId}`);
    if (!pos?.symbol) continue;
    const exitDir = pos.direction === 'BUY' ? 'SELL' : 'BUY';
    log(`Squaring off ${tradeId}: ${exitDir} ${pos.symbol}`);
    try {
      await placeOrder({ trade_id: `EXIT_${tradeId}`, symbol: pos.symbol, direction: exitDir, qty: parseInt(pos.qty) });
      await redis.del(`position:${tradeId}`);
      await redis.del(`positions:open:${tradeId}`);
      await redis.decr('positions:open_count');
    } catch (err) { log(`Square off error ${tradeId}: ${err.message}`, 'ERROR'); }
  }
}

// ── Main loop ─────────────────────────────────────────────
(async function run() {
  log('Execution Agent starting...');
  while (true) {
    try {
      // Time-based square off
      const now = new Date();
      if (now.getHours() === 15 && now.getMinutes() >= 10 && now.getMinutes() < 15) {
        log('3:10 PM — squaring off all positions');
        await squareOffAll();
      }

      // Process approved signal
      const raw = await redis.get('risk:approved:latest');
      if (raw) {
        const approved = JSON.parse(raw);
        if (Date.now() - approved.approved_at < 10000) { // Only if < 10 seconds old
          await processApproved(approved);
          await redis.del('risk:approved:latest');
        }
      }

      await redis.set('execution:heartbeat', Date.now(), 'EX', 30);
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 1000)); // Check every second
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
