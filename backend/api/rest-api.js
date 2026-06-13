/**
 * REST API — Dashboard Data Provider
 * ====================================
 * READ-ONLY. Dashboard kabhi execute nahi karta.
 * Sirf data serve karta hai.
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const http     = require('http');
const Redis    = require('ioredis');
const { Pool } = require('pg');
const url      = require('url');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const pg    = new Pool({ host: process.env.PG_HOST, port: process.env.PG_PORT, database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD });
const log   = (msg) => console.log(`[${new Date().toISOString()}] [API] ${msg}`);

// ── CORS headers ─────────────────────────────────────────
const CORS = {
  'Access-Control-Allow-Origin':  'https://your-dashboard.vercel.app', // Change to your Vercel URL
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type':                 'application/json',
};

function json(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
}

// ── API Routes ────────────────────────────────────────────
const routes = {

  // GET /api/market — Live market data
  '/api/market': async () => {
    const [niftyTick, bankTick, vixTick] = await Promise.all([
      redis.hgetall('tick:NSE_INDEX|Nifty 50:latest'),
      redis.hgetall('tick:NSE_INDEX|Nifty Bank:latest'),
      redis.hgetall('tick:NSE_INDEX|India VIX:latest'),
    ]);
    return {
      nifty:     { price: parseFloat(niftyTick?.price||0), volume: parseInt(niftyTick?.volume||0) },
      banknifty: { price: parseFloat(bankTick?.price||0)  },
      vix:       { price: parseFloat(vixTick?.price||0)   },
      timestamp: Date.now(),
    };
  },

  // GET /api/regime — Current regime
  '/api/regime': async () => {
    const features = await redis.hgetall(`features:${process.env.PRIMARY_FUTURE||'NSE_FO|NIFTY25JUNFUT'}:latest`);
    return {
      regime:     features?.regime      || 'UNKNOWN',
      confidence: features?.regime_confidence || 0,
      vix:        features?.vix         || 0,
      vix_regime: features?.vix_regime  || 'UNKNOWN',
      ad_ratio:   features?.ad_ratio    || 1,
    };
  },

  // GET /api/positions — Open positions
  '/api/positions': async () => {
    const keys = await redis.keys('position:*');
    const positions = [];
    for (const key of keys) {
      const pos = await redis.hgetall(key);
      if (pos?.symbol) positions.push(pos);
    }
    return { positions, count: positions.length };
  },

  // GET /api/risk — Risk metrics
  '/api/risk': async () => {
    const daily   = await redis.hgetall('risk:daily') || {};
    const capital = parseFloat(process.env.ACCOUNT_CAPITAL||200000);
    const limit   = capital * parseFloat(process.env.DAILY_LOSS_LIMIT_PCT||1.5) / 100;
    return {
      daily_pnl:         parseFloat(daily.pnl||0),
      daily_limit:       limit,
      trades_today:      parseInt(daily.trades||0),
      consecutive_losses: parseInt(await redis.get('risk:consecutive_losses')||0),
      open_positions:    parseInt(await redis.get('positions:open_count')||0),
      kill_active:       (await redis.get('kill:active')) === '1',
      kill_reason:       await redis.get('kill:reason') || null,
    };
  },

  // GET /api/signals — Recent signals from Master Agent
  '/api/signals': async () => {
    const raw = await redis.lrange('master:signal:history', 0, 19);
    return {
      signals: raw.map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean),
    };
  },

  // GET /api/workers — Worker heartbeats
  '/api/workers': async () => {
    const WORKERS = ['price_action','volume_cvd','orderflow','options_gex','breadth','volatility','news','fii_flow','mtf'];
    const workers = [];
    for (const w of WORKERS) {
      const beat = parseInt(await redis.get(`worker:${w}:heartbeat`)||0);
      const age  = beat > 0 ? Math.round((Date.now()-beat)/1000) : null;
      workers.push({ name: w, last_beat_seconds: age, status: (!age||age>120) ? 'WARN' : 'OK' });
    }
    return { workers };
  },

  // GET /api/trades — Recent trades from DB
  '/api/trades': async () => {
    const result = await pg.query(`
      SELECT trade_id, symbol, direction, quantity, entry_price, exit_price,
             net_pnl, regime, exit_reason, entry_time, exit_time, master_confidence
      FROM trades WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY entry_time DESC LIMIT 50
    `);
    return { trades: result.rows };
  },

  // GET /api/scoreboard — Alpha Scoreboard
  '/api/scoreboard': async () => {
    const raw = await redis.hgetall('scoreboard:latest') || {};
    const scores = Object.entries(raw).map(([name, val]) => {
      try { return { name, ...JSON.parse(val) }; }
      catch { return { name, contribution: 0, trades: 0, status: 'UNKNOWN' }; }
    });
    return { scores };
  },

  // GET /api/latency — Latency stats
  '/api/latency': async () => {
    const result = await pg.query(`
      SELECT total_ms, order_sent_at, order_filled_at
      FROM latency_log
      WHERE session_date = CURRENT_DATE AND total_ms IS NOT NULL
      ORDER BY created_at DESC LIMIT 20
    `);
    const ms   = result.rows.map(r => r.total_ms).filter(Boolean);
    const avg  = ms.length > 0 ? ms.reduce((a,b)=>a+b,0)/ms.length : 0;
    const max  = ms.length > 0 ? Math.max(...ms) : 0;
    const last = ms[0] || 0;
    return { avg: parseFloat(avg.toFixed(1)), max, last, count: ms.length };
  },

  // GET /api/health — System health summary
  '/api/health': async () => {
    const monitor = await redis.get('monitor:health');
    return monitor ? JSON.parse(monitor) : { issues: 0, issue_list: [] };
  },
};

// ── HTTP Server ───────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
  if (req.method !== 'GET')     { json(res, { error: 'Method not allowed' }, 405); return; }

  const pathname = url.parse(req.url).pathname;
  const handler  = routes[pathname];

  if (!handler) { json(res, { error: 'Not found' }, 404); return; }

  try {
    const data = await handler();
    json(res, { ok: true, data, ts: Date.now() });
    log(`GET ${pathname} — 200`);
  } catch (err) {
    log(`GET ${pathname} — 500: ${err.message}`);
    json(res, { ok: false, error: err.message }, 500);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '127.0.0.1', () => log(`API server running on port ${PORT}`));

// ── Shadow API routes (added post-initial) ────────────────
routes['/api/shadow/performance'] = async () => {
  const raw = await redis.get('shadow:performance:summary');
  if (raw) return { scores: JSON.parse(raw) };
  const keys   = await redis.keys('shadow:stats:*');
  const scores = [];
  for (const key of keys) {
    const stats  = await redis.hgetall(key);
    const id     = key.replace('shadow:stats:', '');
    const trades = parseInt(stats.total_trades || 0);
    const wins   = parseInt(stats.wins         || 0);
    const grossW = parseFloat(stats.gross_win  || 0);
    const grossL = parseFloat(stats.gross_loss || 0);
    const pf     = grossL > 0 ? grossW / grossL : 0;
    scores.push({
      id, trades, pf: pf.toFixed(3),
      win_rate:  trades > 0 ? (wins / trades * 100).toFixed(1) : '0.0',
      total_pnl: parseFloat(stats.total_pnl || 0).toFixed(0),
      status:    pf > 1.4 && trades >= 30 ? 'PROMOTE_CANDIDATE'
               : pf < 0.8 && trades >= 20 ? 'RETIRING' : 'TRACKING',
    });
  }
  return { scores: scores.sort((a, b) => parseFloat(b.pf) - parseFloat(a.pf)) };
};

routes['/api/shadow/trades'] = async () => {
  const result = await pg.query(`
    SELECT strategy_id, direction, entry_price, exit_price,
           pnl_rs, exit_reason, hold_minutes, regime, session_date
    FROM shadow_trades
    ORDER BY created_at DESC LIMIT 50
  `);
  return { trades: result.rows };
};
