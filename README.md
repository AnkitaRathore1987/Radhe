# Mini-Aladdin v5.1 — Setup Guide

## Step 1: Clone & Install

```bash
git clone <your-repo>
cd mini-aladdin
npm install
```

## Step 2: Config Setup

```bash
cp config/.env.example config/.env
# Fill in your Upstox API keys, Redis password, Postgres password
```

## Step 3: Upstox Auth (Daily)

```bash
# Get access token — run this BEFORE market open
node infra/scripts/auth-upstox.js
# This opens browser, you login, token gets saved to .env automatically
```

## Step 4: Start System

```bash
# Full system via Docker
cd infra/docker
docker-compose up -d

# Check all containers running
docker-compose ps

# Watch gateway logs
docker-compose logs -f gateway
```

## Step 5: Verify Ticks Flowing

```bash
# Check Redis for live ticks
redis-cli -a YOUR_REDIS_PASSWORD hgetall "tick:NSE_FO|NIFTY25JUNFUT:latest"
```

---

## Daily Operations

| Time     | Action                              |
|----------|-------------------------------------|
| 9:00 AM  | Run `startup.sh` — loads auth token |
| 9:15 AM  | Gateway connects, ticks start       |
| 9:15-9:30| Observation only — no trades        |
| 3:10 PM  | All positions auto-squared off      |
| 3:20 PM  | Run `shutdown.sh`                   |

---

## Instruments Config

To change expiry (every month):
1. Open `config/instruments.js`
2. Change `CURRENT_EXPIRY` line
3. Done — all futures & options update automatically

To add/remove symbols:
1. Open `config/instruments.js`
2. Add to `FO_STOCKS` section
3. Add to `SUBSCRIBE_LIST` if you want tick data
