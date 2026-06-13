/**
 * NEWS WORKER — Event Calendar
 * Binary switch: CLEAR / CAUTION / BLOCK
 */
'use strict';
require('dotenv').config({ path: '../../config/.env' });
const Redis = require('ioredis');
const { writeWorkerOutput } = require('../feature-store/feature-builder');
const { TRADING_CONFIG } = require('../../config/instruments');

const redis = new Redis({ host: process.env.REDIS_HOST||'127.0.0.1', port: parseInt(process.env.REDIS_PORT)||6379, password: process.env.REDIS_PASSWORD||undefined });
const log = (msg, lvl='INFO') => console.log(`[${new Date().toISOString()}] [NEWS] [${lvl}] ${msg}`);

// Manually maintained event calendar — update weekly
// Format: { date: 'YYYY-MM-DD', time: 'HH:MM', event: 'name', severity: 'BLOCK'|'CAUTION' }
const EVENT_CALENDAR = [
  // Add events here as they are announced
  // { date: '2026-06-06', time: '10:00', event: 'RBI Policy', severity: 'BLOCK' },
  // { date: '2026-06-25', time: '15:30', event: 'F&O Expiry', severity: 'CAUTION' },
];

function checkEvents() {
  const now     = new Date();
  const today   = now.toISOString().split('T')[0];
  const nowMins = now.getHours() * 60 + now.getMinutes();

  for (const event of EVENT_CALENDAR) {
    if (event.date !== today) continue;
    const [h, m]    = event.time.split(':').map(Number);
    const eventMins = h * 60 + m;
    const diff      = eventMins - nowMins;

    if (diff >= 0 && diff <= 120) {
      // Within 2 hours of event
      return {
        news_state:      event.severity,
        next_event_mins: diff,
        event_name:      event.event,
      };
    }
  }

  // F&O Expiry — last Thursday of every month
  const dayOfWeek = now.getDay(); // 4 = Thursday
  const isExpiry  = dayOfWeek === 4 && now.getDate() > 24; // ~last Thursday
  if (isExpiry && nowMins > 13*60) { // After 1 PM on expiry
    return { news_state: 'CAUTION', next_event_mins: 0, event_name: 'FNO_EXPIRY' };
  }

  return { news_state: 'CLEAR', next_event_mins: 999, event_name: null };
}

(async function run() {
  log('News Worker starting...');
  while (true) {
    try {
      const killed = await redis.get('kill:active');
      if (killed !== '1') {
        const result = checkEvents();
        await writeWorkerOutput(TRADING_CONFIG.PRIMARY_FUTURE, 'news', {
          news_state:     result.news_state,
          next_event_mins: result.next_event_mins,
          timestamp:      Date.now(),
        });
        if (result.news_state !== 'CLEAR') {
          log(`State: ${result.news_state} — ${result.event_name} in ${result.next_event_mins}min`);
        }
        await redis.set('worker:news:heartbeat', Date.now(), 'EX', 60);
      }
    } catch (err) { log(`Error: ${err.message}`, 'ERROR'); }
    await new Promise(r => setTimeout(r, 60000)); // Check every minute
  }
})().catch(err => { log(`Fatal: ${err.message}`, 'ERROR'); process.exit(1); });
