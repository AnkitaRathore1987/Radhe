/**
 * MONITORING AGENT — System Health Watchdog
 * Checks all services, fires Telegram alerts
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const https = require('https');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [MONITOR] [${lvl}] ${msg}`);

const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;

async function telegram(msg, silent = false) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const body = JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg, disable_notification: silent });
    const req  = https.request(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.write(body); req.end();
  } catch {}
}

const WORKERS = ['price_action','volume_cvd','orderflow','options_gex','breadth','volatility','news','fii_flow','mtf'];
const alertState = {}; // Track which alerts already sent (don't spam)

async function checkHealth() {
  const issues = [];
  const now    = Date.now();

  // 1. Kill switch status
  const killActive = await redis.get('kill:active');
  if (killActive === '1') issues.push('🚨 KILL SWITCH ACTIVE');

  // 2. Gateway heartbeat
  const lastTick = parseInt(await redis.get('gateway:last_tick') || '0');
  const tickAge  = lastTick > 0 ? now - lastTick : Infinity;
  const inHours  = (() => { const h = new Date().getHours(), m = new Date().getMinutes(); return (h > 9 || (h===9&&m>=15)) && h < 15; })();
  if (inHours && tickAge > 60000) issues.push(`⚠️ Gateway dead — ${Math.round(tickAge/1000)}s since last tick`);

  // 3. Worker heartbeats
  for (const w of WORKERS) {
    const beat = parseInt(await redis.get(`worker:${w}:heartbeat`) || '0');
    const age  = beat > 0 ? now - beat : Infinity;
    if (age > 120000) issues.push(`⚠️ Worker ${w} — no heartbeat ${Math.round(age/1000)}s`);
  }

  // 4. Daily P&L vs limit
  const dailyPnl   = parseFloat(await redis.hget('risk:daily', 'pnl') || '0');
  const dailyLimit = parseFloat(process.env.ACCOUNT_CAPITAL||200000) * parseFloat(process.env.DAILY_LOSS_LIMIT_PCT||1.5) / 100;
  if (dailyPnl < -dailyLimit * 0.8) issues.push(`⚠️ Daily loss at ${(Math.abs(dailyPnl)/dailyLimit*100).toFixed(0)}% of limit`);

  // 5. Latency
  const latencyKeys = await redis.lrange('latency:recent', 0, 9);
  if (latencyKeys.length > 0) {
    const latencies = latencyKeys.map(Number).filter(Boolean);
    const avg = latencies.reduce((a,b)=>a+b,0) / latencies.length;
    if (avg > 35) issues.push(`⚠️ High latency: ${avg.toFixed(1)}ms avg`);
  }

  return issues;
}

async function runMonitor() {
  const issues = await checkHealth();

  for (const issue of issues) {
    const key = issue.substring(0, 30);
    if (!alertState[key] || Date.now() - alertState[key] > 300000) { // Alert every 5 min max
      await telegram(issue);
      alertState[key] = Date.now();
      log(issue, 'WARN');
    }
  }

  // Write health summary to Redis (dashboard reads this)
  await redis.set('monitor:health', JSON.stringify({
    issues: issues.length,
    issue_list: issues,
    checked_at: Date.now(),
  }), 'EX', 60);
}

// ── Telegram command listener (for /KILLSWITCH, /RESUME) ──
async function pollTelegramCommands() {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  try {
    const offset = parseInt(await redis.get('telegram:update_offset') || '0');
    const url    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates?offset=${offset}&timeout=5`;
    const data   = await new Promise((resolve) => {
      https.get(url, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
      }).on('error', () => resolve(null));
    });

    if (!data?.result) return;
    for (const update of data.result) {
      const text = update.message?.text?.trim().toUpperCase();
      if (text === '/KILLSWITCH') {
        await redis.set('kill:active', '1');
        await redis.set('kill:reason', 'Manual — Telegram command');
        await telegram('🚨 Kill switch activated via Telegram');
        log('Kill switch activated via Telegram', 'CRITICAL');
      } else if (text === '/RESUME') {
        await redis.del('kill:active');
        await telegram('✅ Kill switch deactivated — system resuming');
        log('Kill switch deactivated via Telegram');
      } else if (text === '/STATUS') {
        const issues = await checkHealth();
        const msg = issues.length > 0
          ? `⚠️ Issues:\n${issues.join('\n')}`
          : '✅ All systems normal';
        await telegram(msg);
      }
      await redis.set('telegram:update_offset', update.update_id + 1);
    }
  } catch {}
}

(async function run() {
  log('Monitoring Agent starting...');
  await telegram('🟢 Mini-Aladdin monitoring started', true);
  while (true) {
    try {
      await runMonitor();
      await pollTelegramCommands();
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 15000)); // Every 15 seconds
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
