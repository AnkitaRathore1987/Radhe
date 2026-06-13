-- ═══════════════════════════════════════════════════
-- MINI-ALADDIN — PostgreSQL Schema (Phase 1)
-- ═══════════════════════════════════════════════════
-- Run: psql -U aladdin_user -d minialaddin -f schema.sql
-- ═══════════════════════════════════════════════════

-- ─── 1. TICKS (partitioned by date) ─────────────────────
CREATE TABLE IF NOT EXISTS ticks (
  id          BIGSERIAL,
  symbol      VARCHAR(50)    NOT NULL,
  price       DECIMAL(12,2)  NOT NULL,
  volume      BIGINT         DEFAULT 0,
  bid         DECIMAL(12,2)  DEFAULT 0,
  ask         DECIMAL(12,2)  DEFAULT 0,
  bid_qty     BIGINT         DEFAULT 0,
  ask_qty     BIGINT         DEFAULT 0,
  oi          BIGINT         DEFAULT 0,
  received_at TIMESTAMPTZ    NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (received_at);

-- Create monthly partitions (run this script monthly)
CREATE TABLE IF NOT EXISTS ticks_2026_06 PARTITION OF ticks
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS ticks_2026_07 PARTITION OF ticks
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE INDEX IF NOT EXISTS idx_ticks_symbol_time
  ON ticks (symbol, received_at DESC);

-- ─── 2. CANDLES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candles (
  id          BIGSERIAL PRIMARY KEY,
  symbol      VARCHAR(50)   NOT NULL,
  timeframe   VARCHAR(5)    NOT NULL,   -- '1m', '5m', '15m', '1h'
  open        DECIMAL(12,2) NOT NULL,
  high        DECIMAL(12,2) NOT NULL,
  low         DECIMAL(12,2) NOT NULL,
  close       DECIMAL(12,2) NOT NULL,
  volume      BIGINT        DEFAULT 0,
  vwap        DECIMAL(12,2),
  atr14       DECIMAL(10,4),
  candle_time TIMESTAMPTZ   NOT NULL,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candles_symbol_tf_time
  ON candles (symbol, timeframe, candle_time DESC);

-- ─── 3. TRADES — Most important table ───────────────────
CREATE TABLE IF NOT EXISTS trades (
  trade_id        UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  algo_id         VARCHAR(50),               -- SEBI Algo-ID (mandatory for compliance)
  symbol          VARCHAR(50)   NOT NULL,
  direction       VARCHAR(5)    NOT NULL,    -- 'BUY' or 'SELL'
  quantity        INTEGER       NOT NULL,
  entry_price     DECIMAL(12,2) NOT NULL,
  exit_price      DECIMAL(12,2),
  entry_time      TIMESTAMPTZ   NOT NULL,
  exit_time       TIMESTAMPTZ,
  sl_price        DECIMAL(12,2),             -- Initial stop loss
  tsl_price       DECIMAL(12,2),             -- Trailing stop loss at exit
  target_price    DECIMAL(12,2),
  gross_pnl       DECIMAL(12,2),             -- Before charges
  charges         DECIMAL(10,2) DEFAULT 0,   -- Brokerage + STT + exchange
  net_pnl         DECIMAL(12,2),             -- After all charges
  slippage        DECIMAL(8,2)  DEFAULT 0,   -- entry_price - signal_price
  master_confidence INTEGER,                 -- 0-100
  regime          VARCHAR(30),               -- Market regime at entry
  exit_reason     VARCHAR(50),               -- 'SL_HIT'|'TSL_HIT'|'TARGET'|'KILL'|'TIME'
  features_snapshot JSONB,                   -- Full feature vector at entry
  session_date    DATE          NOT NULL,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_date      ON trades (session_date DESC);
CREATE INDEX IF NOT EXISTS idx_trades_symbol    ON trades (symbol, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades (direction, exit_reason);

-- ─── 4. SIGNALS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  signal_id    BIGSERIAL     PRIMARY KEY,
  worker_name  VARCHAR(50)   NOT NULL,
  symbol       VARCHAR(50)   NOT NULL,
  direction    VARCHAR(10),   -- 'BUY'|'SELL'|'NEUTRAL'
  confidence   INTEGER,       -- 0-100
  regime       VARCHAR(30),
  features     JSONB,         -- What the worker saw
  trade_id     UUID           REFERENCES trades(trade_id),  -- If signal led to trade
  timestamp    TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_time   ON signals (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_signals_worker ON signals (worker_name, timestamp DESC);

-- ─── 5. AUDIT LOG — SEBI Compliance (NEVER DELETE) ──────
CREATE TABLE IF NOT EXISTS audit_log (
  log_id      BIGSERIAL     PRIMARY KEY,
  algo_id     VARCHAR(50),
  order_id    VARCHAR(100),
  action      VARCHAR(50)   NOT NULL,  -- 'PLACE'|'CANCEL'|'MODIFY'|'FILL'
  symbol      VARCHAR(50),
  price       DECIMAL(12,2),
  quantity    INTEGER,
  direction   VARCHAR(5),
  status      VARCHAR(30),
  ip_address  INET,
  broker      VARCHAR(20),
  raw_response JSONB,
  timestamp   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
-- NOTE: No DELETE permission on this table for compliance

-- ─── 6. RISK LOG ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS risk_log (
  log_id          BIGSERIAL     PRIMARY KEY,
  session_date    DATE          NOT NULL,
  daily_pnl       DECIMAL(12,2) DEFAULT 0,
  trades_count    INTEGER       DEFAULT 0,
  winning_trades  INTEGER       DEFAULT 0,
  max_drawdown    DECIMAL(12,2) DEFAULT 0,
  kill_triggered  BOOLEAN       DEFAULT FALSE,
  kill_reason     TEXT,
  capital_start   DECIMAL(14,2),
  capital_end     DECIMAL(14,2),
  notes           TEXT,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ─── 7. LEARNING EVENTS ──────────────────────────────────
CREATE TABLE IF NOT EXISTS learning_events (
  event_id            BIGSERIAL   PRIMARY KEY,
  trade_id            UUID        REFERENCES trades(trade_id),
  prediction          VARCHAR(10),   -- 'WIN' prediction
  actual_result       VARCHAR(10),   -- 'WIN' or 'LOSS'
  regime_at_entry     VARCHAR(30),
  causal_news         BOOLEAN DEFAULT FALSE,
  causal_vix_spike    BOOLEAN DEFAULT FALSE,
  causal_gamma_wall   BOOLEAN DEFAULT FALSE,
  causal_low_liquidity BOOLEAN DEFAULT FALSE,
  causal_regime_miss  BOOLEAN DEFAULT FALSE,
  causal_fii_contrary BOOLEAN DEFAULT FALSE,
  notes               TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ─── 8. ALPHA SCOREBOARD ─────────────────────────────────
CREATE TABLE IF NOT EXISTS alpha_scoreboard (
  id              BIGSERIAL     PRIMARY KEY,
  component_name  VARCHAR(50)   NOT NULL,
  period_start    DATE          NOT NULL,
  period_end      DATE          NOT NULL,
  alpha_contribution DECIMAL(8,4),  -- % contribution to total PnL
  risk_contribution  DECIMAL(8,4),  -- % drawdown reduction
  trades_influenced  INTEGER,
  status          VARCHAR(20)   DEFAULT 'ACTIVE',  -- 'ACTIVE'|'WARNING'|'REMOVED'
  notes           TEXT,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

-- ─── 9. SHADOW TRADES ───────────────────────────────────
CREATE TABLE IF NOT EXISTS shadow_trades (
  id              BIGSERIAL     PRIMARY KEY,
  strategy_id     VARCHAR(50)   NOT NULL,
  strategy_name   VARCHAR(100),
  direction       VARCHAR(5)    NOT NULL,
  entry_price     DECIMAL(12,2) NOT NULL,
  exit_price      DECIMAL(12,2),
  pnl_points      DECIMAL(10,2),
  pnl_rs          DECIMAL(12,2),
  exit_reason     VARCHAR(30),   -- 'SL_HIT'|'TARGET'|'TIME_EXIT'|'MAX_HOLD'
  regime          VARCHAR(30),
  hold_minutes    INTEGER,
  features_snapshot JSONB,
  session_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_strategy   ON shadow_trades (strategy_id, session_date DESC);
CREATE INDEX IF NOT EXISTS idx_shadow_date        ON shadow_trades (session_date DESC);

-- ─── 10. LATENCY LOG ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS latency_log (
  id              BIGSERIAL     PRIMARY KEY,
  trade_id        UUID          REFERENCES trades(trade_id),
  tick_arrived_at BIGINT,       -- Unix ms
  feature_built_at BIGINT,
  master_decided_at BIGINT,
  risk_approved_at  BIGINT,
  order_sent_at     BIGINT,
  order_filled_at   BIGINT,
  total_ms        INTEGER,      -- tick to fill
  session_date    DATE,
  created_at      TIMESTAMPTZ   DEFAULT NOW()
);
