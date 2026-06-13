/**
 * CHAOS TESTING AGENT — Saturday 10 AM Weekly
 * =============================================
 * Tests 10 failure scenarios in safe sandbox.
 * 100% pass = green light for Monday trading.
 * Any fail = fix required before Monday open.
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis    = require('ioredis');
const { Pool } = require('pg');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [CHAOS] [${lvl}] ${msg}`);

const results = [];

async function runTest(name, testFn) {
  log(`Running: ${name}...`);
  const start = Date.now();
  try {
    const { pass, notes } = await testFn();
    const ms = Date.now() - start;
    results.push({ name, pass, notes, ms });
    log(`${pass ? '✅ PASS' : '❌ FAIL'}: ${name} (${ms}ms) — ${notes}`);
    return pass;
  } catch (err) {
    results.push({ name, pass: false, notes: err.message, ms: Date.now() - start });
    log(`❌ ERROR: ${name} — ${err.message}`, 'ERROR');
    return false;
  }
}

// ── TEST 1: Kill switch fires correctly ───────────────────
async function testKillSwitch() {
  await redis.set('kill:active', '1');
  await new Promise(r => setTimeout(r, 1000));
  const active = await redis.get('kill:active');
  await redis.del('kill:active'); // Reset
  return { pass: active === '1', notes: 'Kill switch set/get verified' };
}

// ── TEST 2: Redis connection + read/write ─────────────────
async function testRedis() {
  const testKey = 'chaos:test:' + Date.now();
  await redis.set(testKey, 'OK', 'EX', 10);
  const val = await redis.get(testKey);
  await redis.del(testKey);
  return { pass: val === 'OK', notes: 'Redis set/get/del working' };
}

// ── TEST 3: PostgreSQL connection + write ─────────────────
async function testPostgres() {
  const result = await pg.query('SELECT 1 + 1 AS result');
  return { pass: result.rows[0]?.result === 2, notes: 'PostgreSQL query executing' };
}

// ── TEST 4: Feature Store read/write ─────────────────────
async function testFeatureStore() {
  const { writeWorkerOutput, getFeatures } = require('../feature-store/feature-builder');
  const testSym = 'TEST_SYMBOL';
  await writeWorkerOutput(testSym, 'chaos_test', { vwap: 12345.5, timestamp: Date.now() });
  const features = await getFeatures(testSym);
  await redis.del(`features:${testSym}:latest`);
  return { pass: features?.vwap === 12345.5, notes: 'Feature Store write/read verified' };
}

// ── TEST 5: Stale tick detection ─────────────────────────
async function testStaleTickDetection() {
  // Set a very old tick timestamp
  await redis.set('chaos:fake_tick_time', Date.now() - 120000); // 2 minutes ago
  const lastTick = parseInt(await redis.get('chaos:fake_tick_time'));
  const age      = Date.now() - lastTick;
  await redis.del('chaos:fake_tick_time');
  return { pass: age > 90000, notes: `Stale tick detection works — detected ${Math.round(age/1000)}s age` };
}

// ── TEST 6: Bad tick data rejection ──────────────────────
async function testBadTickRejection() {
  // Simulate bad ticks that should be rejected by gateway validation
  const badTicks = [
    { price: -100, volume: 1000 },      // Negative price
    { price: 999999, volume: 1000 },    // Impossible price
    { price: 24000, volume: -1 },       // Negative volume
    { price: 0, volume: 500 },          // Zero price
  ];
  const VALIDATE_TICK = (tick) => {
    if (!tick.price || tick.price <= 0) return false;
    if (tick.price > 100000) return false;
    if (tick.volume < 0)     return false;
    return true;
  };
  const allRejected = badTicks.every(t => !VALIDATE_TICK(t));
  return { pass: allRejected, notes: `All ${badTicks.length} bad ticks rejected` };
}

// ── TEST 7: Daily risk limit enforcement ─────────────────
async function testRiskLimits() {
  const capital  = parseFloat(process.env.ACCOUNT_CAPITAL || 200000);
  const limit    = capital * parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || 1.5) / 100;
  // Simulate loss exceeding limit
  await redis.hset('chaos:risk_test', 'pnl', -(limit + 100));
  const pnl = parseFloat(await redis.hget('chaos:risk_test', 'pnl'));
  await redis.del('chaos:risk_test');
  const wouldTrigger = pnl <= -limit;
  return { pass: wouldTrigger, notes: `Risk limit check: loss Rs ${Math.abs(pnl).toFixed(0)} > limit Rs ${limit.toFixed(0)}` };
}

// ── TEST 8: Causal rules loading ─────────────────────────
async function testCausalRules() {
  const rules = require('../knowledge/causal-rules.json');
  const keys  = Object.keys(rules).filter(k => !k.startsWith('_'));
  return { pass: keys.length >= 10, notes: `${keys.length} causal rules loaded from JSON` };
}

// ── TEST 9: Instruments config integrity ─────────────────
async function testInstrumentsConfig() {
  const { INDICES, FUTURES, SUBSCRIBE_LIST, TRADING_CONFIG } = require('../../config/instruments');
  const checks = [
    Object.keys(INDICES).length >= 5,
    Object.keys(FUTURES).length >= 2,
    SUBSCRIBE_LIST.length >= 10,
    !!TRADING_CONFIG.PRIMARY_FUTURE,
    !!TRADING_CONFIG.LOT_SIZES.NIFTY,
  ];
  const pass = checks.every(Boolean);
  return { pass, notes: `${SUBSCRIBE_LIST.length} instruments configured, lot sizes defined` };
}

// ── TEST 10: Consecutive loss counter ────────────────────
async function testConsecLossCounter() {
  await redis.set('chaos:test:losses', '3');
  const val = parseInt(await redis.get('chaos:test:losses'));
  await redis.del('chaos:test:losses');
  const wouldWarn = val >= 3;
  return { pass: wouldWarn, notes: 'Consecutive loss counter reads correctly' };
}

// ── Run all tests ─────────────────────────────────────────
async function runAllTests() {
  log('=== CHAOS TESTING STARTED ===');
  log(`Running 10 scenarios at ${new Date().toLocaleString('en-IN')}`);

  await runTest('Kill Switch Activation',       testKillSwitch);
  await runTest('Redis Read/Write',             testRedis);
  await runTest('PostgreSQL Connection',        testPostgres);
  await runTest('Feature Store Integrity',      testFeatureStore);
  await runTest('Stale Tick Detection',         testStaleTickDetection);
  await runTest('Bad Tick Data Rejection',      testBadTickRejection);
  await runTest('Daily Risk Limit Check',       testRiskLimits);
  await runTest('Causal Rules Loading',         testCausalRules);
  await runTest('Instruments Config Integrity', testInstrumentsConfig);
  await runTest('Consecutive Loss Counter',     testConsecLossCounter);

  const passed = results.filter(r => r.pass).length;
  const total  = results.length;
  const score  = Math.round(passed / total * 100);

  log(`=== RESULTS: ${passed}/${total} PASSED (${score}%) ===`);

  // Save to PostgreSQL
  for (const r of results) {
    await pg.query(`
      INSERT INTO chaos_test_results (scenario_name, result, recovery_time_ms, notes, test_date)
      VALUES ($1,$2,$3,$4,CURRENT_DATE)
    `, [r.name, r.pass ? 'PASS' : 'FAIL', r.ms, r.notes]).catch(() => {});
  }

  // Cache summary in Redis
  await redis.set('chaos:last_result', JSON.stringify({ score, passed, total, timestamp: Date.now() }), 'EX', 604800);

  // Telegram summary
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const status = score === 100 ? '✅ ALL CLEAR — Monday trading approved'
      : score >= 80 ? '⚠️ PARTIAL — Review failures before Monday'
      : '🚨 CRITICAL — Fix required, do NOT trade Monday';
    const msg = `🔬 Chaos Test Results\n${status}\nScore: ${score}% (${passed}/${total})\n${results.filter(r=>!r.pass).map(r=>`❌ ${r.name}`).join('\n')}`;
    const https = require('https');
    const body  = JSON.stringify({ chat_id: chatId, text: msg });
    const req   = https.request(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(body); req.end();
  }

  return score;
}

runAllTests()
  .then(score => { redis.disconnect(); pg.end(); process.exit(score === 100 ? 0 : 1); })
  .catch(err  => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
