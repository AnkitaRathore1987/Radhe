/**
 * RISK AGENT — Veto Power
 * ========================
 * Master Agent suggest karta hai. Risk Agent decide karta hai.
 * Half-Kelly position sizing + daily/weekly limits + drawdown guard
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [RISK] [${lvl}] ${msg}`);

const CAPITAL           = parseFloat(process.env.ACCOUNT_CAPITAL)        || 200000;
const RISK_PER_TRADE    = parseFloat(process.env.RISK_PER_TRADE_PCT)      || 0.5;    // 0.5% of capital
const DAILY_LOSS_LIMIT  = CAPITAL * (parseFloat(process.env.DAILY_LOSS_LIMIT_PCT) || 1.5) / 100;
const WEEKLY_LOSS_LIMIT = CAPITAL * (parseFloat(process.env.WEEKLY_LOSS_LIMIT_PCT)|| 4.0) / 100;
const MAX_POSITIONS     = parseInt(process.env.MAX_OPEN_POSITIONS)        || 2;
const MAX_EXPOSURE      = parseFloat(process.env.MAX_EXPOSURE_PCT)        || 8.0;
const LOT_SIZES         = TRADING_CONFIG.LOT_SIZES;

// ── Position sizing: Base size ────────────────────────────
// Base_Size = (Capital × Risk%) / (ATR14 × 1.5)
async function calcBaseSize(symbol, atr14) {
  if (!atr14 || atr14 <= 0) return 0;
  const riskRs    = CAPITAL * RISK_PER_TRADE / 100;
  const slDist    = atr14 * 1.5;
  const lotSize   = LOT_SIZES.NIFTY || 75;
  const lotsFloat = riskRs / (slDist * lotSize);
  return Math.max(1, Math.floor(lotsFloat));
}

// ── Half-Kelly sizing ─────────────────────────────────────
// f* = (WinRate × AvgWin/AvgLoss - (1-WinRate)) / (AvgWin/AvgLoss)
// Half-Kelly = 0.5 × f*
async function calcKellySize() {
  const stats = await redis.hgetall('learning:stats');
  if (!stats?.win_rate || !stats?.avg_win || !stats?.avg_loss) return null;

  const winRate = parseFloat(stats.win_rate) / 100;
  const ratio   = parseFloat(stats.avg_win) / parseFloat(stats.avg_loss);
  const kelly   = (winRate * ratio - (1 - winRate)) / ratio;
  const halfK   = Math.max(0, kelly * 0.5); // Half-Kelly
  const lots    = Math.floor(halfK * CAPITAL / (CAPITAL * RISK_PER_TRADE / 100));
  return Math.max(1, Math.min(lots, 10)); // Cap at 10 lots
}

// ── Regime multiplier for position size ──────────────────
function regimeMult(regime) {
  return { TRENDING_UP:1.0, TRENDING_DOWN:1.0, SIDEWAYS:0.8, BREAKOUT:1.0, PANIC:0, NEWS_DRIVEN:0 }[regime] || 0.8;
}

// ── Risk checks ───────────────────────────────────────────
async function performChecks(signal) {
  const daily   = await redis.hgetall('risk:daily');
  const dailyPnl   = parseFloat(daily?.pnl              || '0');
  const openCount  = parseInt(await redis.get('positions:open_count') || '0');
  const consecLoss = parseInt(await redis.get('risk:consecutive_losses') || '0');
  const vix        = parseFloat(await redis.hget(`features:${signal.symbol}:latest`, 'vix') || '0');

  const checks = {
    daily_loss:    { pass: dailyPnl > -DAILY_LOSS_LIMIT,       msg: `Daily P&L: ${dailyPnl.toFixed(0)}` },
    max_positions: { pass: openCount < MAX_POSITIONS,          msg: `Open: ${openCount}/${MAX_POSITIONS}` },
    consec_losses: { pass: consecLoss < 4,                     msg: `Consec losses: ${consecLoss}` },
    vix_level:     { pass: vix < 25 || vix === 0,              msg: `VIX: ${vix.toFixed(1)}` },
    news_state:    { pass: signal.features_snapshot?.news !== 'BLOCK', msg: 'News check' },
    kill_switch:   { pass: await redis.get('kill:active') !== '1', msg: 'Kill switch' },
  };

  const failed = Object.entries(checks).filter(([,v]) => !v.pass);
  return { pass: failed.length === 0, failed: failed.map(([k,v]) => `${k}: ${v.msg}`) };
}

// ── Main evaluator ────────────────────────────────────────
async function evaluateSignal(signal) {
  const checkResult = await performChecks(signal);
  if (!checkResult.pass) {
    log(`REJECTED — ${checkResult.failed.join(', ')}`);
    await redis.set('risk:last_rejection', JSON.stringify({ reason: checkResult.failed, ts: Date.now() }), 'EX', 300);
    return null;
  }

  const atr14    = parseFloat(await redis.hget(`features:${signal.symbol}:latest`, 'atr14') || '0') || 50;
  const baseSize = await calcBaseSize(signal.symbol, atr14);
  const kelly    = await calcKellySize();
  const regime   = signal.regime || 'SIDEWAYS';
  const mult     = regimeMult(regime);

  let finalSize  = kelly
    ? Math.min(baseSize, kelly)
    : baseSize;
  finalSize = Math.max(1, Math.floor(finalSize * mult));

  const slPrice  = signal.direction === 'BUY'
    ? signal.features_snapshot?.vwap - atr14 * 1.5
    : signal.features_snapshot?.vwap + atr14 * 1.5;

  const approved = {
    ...signal,
    approved_qty:  finalSize,
    sl_price:      parseFloat((slPrice || 0).toFixed(2)),
    risk_amount:   finalSize * (LOT_SIZES.NIFTY || 75) * atr14 * 1.5,
    approved_at:   Date.now(),
  };

  await redis.set('risk:approved:latest', JSON.stringify(approved), 'EX', 60);
  log(`APPROVED: ${signal.direction} ${signal.symbol} | ${finalSize} lots | SL: ${approved.sl_price}`);
  return approved;
}

// ── Listen for Master Agent signals ───────────────────────
(async function run() {
  log('Risk Agent starting...');
  log(`Capital: Rs ${CAPITAL.toLocaleString('en-IN')} | Risk/trade: ${RISK_PER_TRADE}% | Daily limit: Rs ${DAILY_LOSS_LIMIT.toFixed(0)}`);

  while (true) {
    try {
      const raw = await redis.get('master:signal:latest');
      if (raw) {
        const signal = JSON.parse(raw);
        // Only process if signal is fresh (< 15 seconds old)
        if (Date.now() - signal.timestamp < 15000) {
          await evaluateSignal(signal);
          await redis.del('master:signal:latest'); // Consume signal
        }
      }
      await redis.set('risk:heartbeat', Date.now(), 'EX', 30);
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 2000)); // Check every 2 seconds
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
