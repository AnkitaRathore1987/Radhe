/**
 * KILL SWITCH — Emergency Agent
 * ==============================
 * Sabse pehle start hota hai. Sabse baad band hota hai.
 * Ek kaam: Market ko band karna jab zaroorat ho.
 *
 * Triggers:
 *   Auto: Daily loss limit, consecutive losses, VIX spike, API errors
 *   Manual: Telegram /KILLSWITCH command
 */

'use strict';

require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');

const redis = new Redis({
  host:     process.env.REDIS_HOST || '127.0.0.1',
  port:     parseInt(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

// ─── Risk thresholds ────────────────────────────────────
const CAPITAL          = parseFloat(process.env.ACCOUNT_CAPITAL) || 200000;
const DAILY_LOSS_LIMIT = CAPITAL * (parseFloat(process.env.DAILY_LOSS_LIMIT_PCT) || 1.5) / 100;
const WEEKLY_LOSS_LIMIT= CAPITAL * (parseFloat(process.env.WEEKLY_LOSS_LIMIT_PCT) || 4.0) / 100;
const MAX_CONSEC_LOSSES= 4;
const VIX_SPIKE_THRESH = 30; // If VIX > 30, kill switch on standby

function log(msg, level = 'INFO') {
  console.log(`[${new Date().toISOString()}] [KILLSWITCH] [${level}] ${msg}`);
}

// ─── Activate kill switch ────────────────────────────────
async function activate(reason) {
  log(`ACTIVATING KILL SWITCH — Reason: ${reason}`, 'CRITICAL');

  // Set kill flag — ALL agents check this before any action
  await redis.set('kill:active', '1');
  await redis.set('kill:reason', reason);
  await redis.set('kill:activated_at', Date.now());

  // Log to kill history
  await redis.lpush('kill:history', JSON.stringify({
    reason,
    timestamp: new Date().toISOString(),
    capital:   CAPITAL,
  }));
  await redis.ltrim('kill:history', 0, 49); // Keep last 50 events

  // Notify Telegram
  await sendTelegramAlert(`🚨 KILL SWITCH ACTIVATED\nReason: ${reason}\nAll trading stopped.\nSend /RESUME to restart.`);

  log('Kill switch active. Waiting for /RESUME command.', 'CRITICAL');
}

// ─── Deactivate kill switch ──────────────────────────────
async function deactivate(who = 'manual') {
  log(`Deactivating kill switch — by: ${who}`);
  await redis.del('kill:active');
  await redis.del('kill:reason');
  await redis.set('kill:deactivated_at', Date.now());

  await sendTelegramAlert(`✅ KILL SWITCH DEACTIVATED by ${who}\nSystem resuming...`);
  log('Kill switch deactivated. System can resume.');
}

// ─── Check if kill switch should fire ───────────────────
async function checkTriggers() {
  // Already active — don't check again
  const isActive = await redis.get('kill:active');
  if (isActive === '1') return;

  // 1. Daily loss check
  const dailyPnl = parseFloat(await redis.hget('risk:daily', 'pnl') || '0');
  if (dailyPnl <= -DAILY_LOSS_LIMIT) {
    await activate(`Daily loss limit hit: Rs ${Math.abs(dailyPnl).toFixed(0)} (limit: Rs ${DAILY_LOSS_LIMIT.toFixed(0)})`);
    return;
  }

  // 2. Consecutive losses
  const consecLosses = parseInt(await redis.get('risk:consecutive_losses') || '0');
  if (consecLosses >= MAX_CONSEC_LOSSES) {
    await activate(`${MAX_CONSEC_LOSSES} consecutive losses — cooling off`);
    return;
  }

  // 3. VIX spike
  const vix = parseFloat(await redis.hget('tick:NSE_INDEX|India VIX:latest', 'price') || '0');
  if (vix > VIX_SPIKE_THRESH) {
    await activate(`VIX spike: ${vix.toFixed(1)} > ${VIX_SPIKE_THRESH}`);
    return;
  }

  // 4. Redis/Gateway health check
  const lastTick = parseInt(await redis.get('gateway:last_tick') || '0');
  const tickAge  = Date.now() - lastTick;
  if (lastTick > 0 && tickAge > 60000) { // No ticks for 60 seconds during market hours
    const now  = new Date();
    const hour = now.getHours();
    const min  = now.getMinutes();
    const inMarketHours = (hour > 9 || (hour === 9 && min >= 15)) && hour < 15;

    if (inMarketHours) {
      await activate(`Gateway dead — no ticks for ${(tickAge/1000).toFixed(0)}s during market hours`);
      return;
    }
  }
}

// ─── Telegram alert (simple HTTP — no library needed) ────
async function sendTelegramAlert(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    log('Telegram not configured — skipping alert', 'WARN');
    return;
  }

  try {
    const https  = require('https');
    const body   = JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' });
    const url    = `https://api.telegram.org/bot${token}/sendMessage`;

    await new Promise((resolve, reject) => {
      const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        res.on('data', () => {});
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    log(`Telegram alert failed: ${err.message}`, 'WARN');
  }
}

// ─── Monitor loop ────────────────────────────────────────
async function monitorLoop() {
  while (true) {
    try {
      await checkTriggers();
    } catch (err) {
      log(`Monitor error: ${err.message}`, 'ERROR');
    }
    await new Promise(r => setTimeout(r, 5000)); // Check every 5 seconds
  }
}

// ─── Status check (other agents call this) ───────────────
async function isKillActive() {
  const val = await redis.get('kill:active');
  return val === '1';
}

// ─── Export for other agents ─────────────────────────────
module.exports = { isKillActive, activate, deactivate };

// ─── Start if run directly ───────────────────────────────
if (require.main === module) {
  log('Kill Switch Agent starting...');
  log(`Daily loss limit: Rs ${DAILY_LOSS_LIMIT.toFixed(0)}`);
  log(`Consecutive loss limit: ${MAX_CONSEC_LOSSES} trades`);
  log(`VIX spike threshold: ${VIX_SPIKE_THRESH}`);
  monitorLoop().catch(err => {
    log(`Fatal: ${err.message}`, 'ERROR');
    process.exit(1);
  });
}
