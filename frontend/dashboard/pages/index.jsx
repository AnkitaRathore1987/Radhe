import { useState, useEffect, useRef } from "react";

// ── Simulated live data (real app mein API se aayega) ──
function useLiveData() {
  const [data, setData] = useState({
    nifty:       { price: 24387.50, change: +0.34, changePct: +0.34 },
    banknifty:   { price: 52140.20, change: -0.12, changePct: -0.12 },
    vix:         { price: 13.82,    change: -0.41 },
    usdinr:      { price: 83.47,    change: +0.08 },
    regime:      "TRENDING_UP",
    regimeConf:  84,
    killActive:  false,
    positions: [
      { id: "T001", symbol: "NIFTY25JUNFUT", dir: "BUY",  qty: 2, entry: 24310.00, ltp: 24387.50, sl: 24185.00, tsl: 24310.00, pnl: +11550, status: "OPEN" },
      { id: "T002", symbol: "HDFCBANK",       dir: "BUY",  qty: 500, entry: 1642.30, ltp: 1651.80, sl: 1618.00, tsl: 1635.00, pnl: +4750, status: "OPEN" },
    ],
    signals: [
      { time: "10:42:18", worker: "ORDERFLOW", symbol: "NIFTY", dir: "BUY",  conf: 82, regime: "TRENDING_UP",  result: "TAKEN" },
      { time: "10:31:05", worker: "CVD",       symbol: "NIFTY", dir: "BUY",  conf: 71, regime: "TRENDING_UP",  result: "TAKEN" },
      { time: "10:15:44", worker: "VWAP",      symbol: "HDFC",  dir: "BUY",  conf: 68, regime: "TRENDING_UP",  result: "TAKEN" },
      { time: "09:52:30", worker: "GEX",       symbol: "NIFTY", dir: "SELL", conf: 74, regime: "SIDEWAYS",     result: "BLOCKED" },
      { time: "09:38:12", worker: "BREADTH",   symbol: "BANK",  dir: "BUY",  conf: 61, regime: "TRENDING_UP",  result: "BLOCKED" },
    ],
    risk: { dailyPnl: 16300, dailyLimit: 3000, weeklyPnl: 42800, exposure: 34, openPositions: 2, maxPositions: 2, consecLosses: 0 },
    latency: { avg: 18.4, last: 16.2, max: 29.1 },
    workers: [
      { name: "PRICE_ACTION", status: "OK",   lastBeat: 4  },
      { name: "VOLUME_CVD",   status: "OK",   lastBeat: 3  },
      { name: "ORDERFLOW",    status: "OK",   lastBeat: 2  },
      { name: "OPTIONS_GEX",  status: "OK",   lastBeat: 5  },
      { name: "BREADTH",      status: "OK",   lastBeat: 8  },
      { name: "VOLATILITY",   status: "OK",   lastBeat: 6  },
      { name: "NEWS",         status: "OK",   lastBeat: 12 },
      { name: "FII_FLOW",     status: "OK",   lastBeat: 180},
      { name: "MTF",          status: "WARN", lastBeat: 35 },
    ],
    alphaScores: [
      { name: "Liquidity Sweep", contribution: 38, trades: 12, status: "GREEN" },
      { name: "CVD Divergence",  contribution: 24, trades: 18, status: "GREEN" },
      { name: "GEX Wall",        contribution: 19, trades: 9,  status: "GREEN" },
      { name: "VWAP Bounce",     contribution: 11, trades: 15, status: "GREEN" },
      { name: "Breadth Filter",  contribution: 5,  trades: 0,  status: "YELLOW"},
      { name: "News Block",      contribution: 3,  trades: 0,  status: "YELLOW"},
    ],
  });

  // Simulate live price updates
  useEffect(() => {
    const interval = setInterval(() => {
      setData(prev => ({
        ...prev,
        nifty: {
          ...prev.nifty,
          price: +(prev.nifty.price + (Math.random() - 0.5) * 4).toFixed(2),
        },
        banknifty: {
          ...prev.banknifty,
          price: +(prev.banknifty.price + (Math.random() - 0.5) * 12).toFixed(2),
        },
        latency: {
          avg:  +(14 + Math.random() * 10).toFixed(1),
          last: +(10 + Math.random() * 15).toFixed(1),
          max:  prev.latency.max,
        },
      }));
    }, 1200);
    return () => clearInterval(interval);
  }, []);

  return data;
}

// ── Tick animation for prices ──
function useTickColor(value) {
  const prev   = useRef(value);
  const [color, setColor] = useState("");
  useEffect(() => {
    if (value > prev.current) setColor("tick-up");
    else if (value < prev.current) setColor("tick-dn");
    else setColor("");
    prev.current = value;
    const t = setTimeout(() => setColor(""), 600);
    return () => clearTimeout(t);
  }, [value]);
  return color;
}

// ── Helpers ──
const fmt  = (n, d=2) => n?.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d }) ?? "—";
const fmtP = (n) => (n >= 0 ? "+" : "") + fmt(n);
const pnlColor = (n) => n > 0 ? "#00d68f" : n < 0 ? "#ff4d4f" : "#8899aa";
const REGIME_COLORS = {
  TRENDING_UP:   { bg: "#0a2a1a", border: "#00d68f", text: "#00d68f" },
  TRENDING_DOWN: { bg: "#2a0a0a", border: "#ff4d4f", text: "#ff4d4f" },
  SIDEWAYS:      { bg: "#1a1a0a", border: "#f0c040", text: "#f0c040" },
  BREAKOUT:      { bg: "#0a1a2a", border: "#40aaff", text: "#40aaff" },
  PANIC:         { bg: "#2a0a0a", border: "#ff0000", text: "#ff0000" },
  NEWS_DRIVEN:   { bg: "#2a1a0a", border: "#ff8c00", text: "#ff8c00" },
};

// ═══════════════════════════════════════════════════
export default function Dashboard() {
  const d = useLiveData();
  const [tab, setTab] = useState("live");
  const now = new Date().toLocaleTimeString("en-IN", { hour12: false });
  const regimeStyle = REGIME_COLORS[d.regime] || REGIME_COLORS.SIDEWAYS;

  return (
    <div style={S.root}>
      {/* ── CSS ── */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #0c0e12; }
        ::-webkit-scrollbar-thumb { background: #2a2e38; border-radius: 2px; }
        .tick-up  { color: #00d68f !important; transition: color 0.1s; }
        .tick-dn  { color: #ff4d4f !important; transition: color 0.1s; }
        .row-hover:hover { background: rgba(255,255,255,0.03) !important; }
        .tab-btn { cursor: pointer; border: none; background: none; }
        .tab-btn:hover { background: rgba(255,255,255,0.05) !important; }
        .pulse { animation: pulse 2s infinite; }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.4; }
        }
        .blink { animation: blink 1s step-end infinite; }
        @keyframes blink { 50% { opacity: 0; } }
      `}</style>

      {/* ── TOP BAR ── */}
      <div style={S.topbar}>
        <div style={S.brand}>
          <span style={S.brandIcon}>◈</span>
          <span style={S.brandName}>MINI-ALADDIN</span>
          <span style={S.brandVer}>v5.1</span>
        </div>

        {/* Index chips */}
        <div style={S.indexRow}>
          <IndexChip label="NIFTY"     data={d.nifty}     />
          <IndexChip label="BANKNIFTY" data={d.banknifty} />
          <IndexChip label="VIX"       data={d.vix}       small />
          <IndexChip label="USDINR"    data={d.usdinr}    small />
        </div>

        {/* Regime badge */}
        <div style={{ ...S.regimeBadge, background: regimeStyle.bg, borderColor: regimeStyle.border }}>
          <span style={{ color: regimeStyle.text, fontWeight: 600, fontSize: 11, letterSpacing: 1 }}>
            {d.regime.replace("_", " ")}
          </span>
          <span style={{ color: regimeStyle.text, opacity: 0.7, fontSize: 10, marginLeft: 6 }}>
            {d.regimeConf}%
          </span>
        </div>

        {/* Kill switch status */}
        <div style={{ ...S.killBadge, background: d.killActive ? "#2a0000" : "#001a0a", borderColor: d.killActive ? "#ff4d4f" : "#00d68f" }}>
          <span style={{ ...S.dot, background: d.killActive ? "#ff4d4f" : "#00d68f" }} className={d.killActive ? "blink" : "pulse"} />
          <span style={{ color: d.killActive ? "#ff4d4f" : "#00d68f", fontSize: 10, fontWeight: 600 }}>
            {d.killActive ? "KILL ACTIVE" : "LIVE"}
          </span>
        </div>

        <div style={S.clock}>{now} IST</div>
      </div>

      {/* ── TABS ── */}
      <div style={S.tabBar}>
        {[
          { id: "live",    label: "LIVE TRADING" },
          { id: "risk",    label: "RISK MONITOR" },
          { id: "signals", label: "SIGNAL FEED" },
          { id: "workers", label: "SYSTEM HEALTH" },
          { id: "alpha",   label: "ALPHA SCOREBOARD" },
          { id: "shadow",  label: "SHADOW LAB" },
        ].map(t => (
          <button
            key={t.id}
            className="tab-btn"
            onClick={() => setTab(t.id)}
            style={{ ...S.tab, ...(tab === t.id ? S.tabActive : {}) }}
          >
            {t.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div style={S.latencyPill}>
          <span style={{ color: "#8899aa", fontSize: 10 }}>LATENCY</span>
          <span style={{ color: d.latency.last < 25 ? "#00d68f" : "#f0c040", fontSize: 11, fontWeight: 600, marginLeft: 6 }}>
            {d.latency.last}ms
          </span>
        </div>
      </div>

      {/* ── CONTENT ── */}
      <div style={S.content}>
        {tab === "live"    && <LiveTab    d={d} />}
        {tab === "risk"    && <RiskTab    d={d} />}
        {tab === "signals" && <SignalsTab d={d} />}
        {tab === "workers" && <WorkersTab d={d} />}
        {tab === "alpha"   && <AlphaTab  d={d} />}
        {tab === "shadow"  && (
          <div style={{ color:"#556070", textAlign:"center", padding:"40px 0" }}>
            <div style={{ fontSize:14, marginBottom:8 }}>Shadow Trading Lab</div>
            <a href="/shadow" style={{ color:"#40aaff", fontSize:12 }}>Open full Shadow Lab dashboard →</a>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── INDEX CHIP ─────────────────────────────────────────
function IndexChip({ label, data, small }) {
  const tc = useTickColor(data.price);
  const up = (data.change ?? 0) >= 0;
  return (
    <div style={S.chip}>
      <span style={{ color: "#556070", fontSize: 9, letterSpacing: 1 }}>{label}</span>
      <span className={tc} style={{ color: "#e0e8f0", fontSize: small ? 12 : 13, fontWeight: 600, fontFamily: "'IBM Plex Mono', monospace" }}>
        {fmt(data.price)}
      </span>
      <span style={{ color: up ? "#00d68f" : "#ff4d4f", fontSize: 9 }}>
        {up ? "▲" : "▼"} {Math.abs(data.changePct ?? data.change ?? 0).toFixed(2)}%
      </span>
    </div>
  );
}

// ─── LIVE TAB ────────────────────────────────────────────
function LiveTab({ d }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 12, height: "100%" }}>
      {/* Positions table */}
      <div style={S.panel}>
        <PanelHeader title="OPEN POSITIONS" count={d.positions.length} />
        <table style={S.table}>
          <thead>
            <tr>
              {["ID","SYMBOL","DIR","QTY","ENTRY","LTP","SL","TSL","P&L","STATUS"].map(h => (
                <th key={h} style={S.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.positions.map(p => (
              <tr key={p.id} className="row-hover" style={{ cursor: "default" }}>
                <td style={{ ...S.td, color: "#556070" }}>{p.id}</td>
                <td style={{ ...S.td, color: "#c0d0e0", fontWeight: 500 }}>{p.symbol}</td>
                <td style={{ ...S.td, color: p.dir === "BUY" ? "#00d68f" : "#ff4d4f", fontWeight: 600 }}>{p.dir}</td>
                <td style={{ ...S.td, color: "#a0b0c0" }}>{p.qty}</td>
                <td style={{ ...S.td, color: "#a0b0c0", fontFamily: "monospace" }}>{fmt(p.entry)}</td>
                <td style={{ ...S.td, color: "#e0e8f0", fontFamily: "monospace", fontWeight: 600 }}>{fmt(p.ltp)}</td>
                <td style={{ ...S.td, color: "#ff6b6b", fontFamily: "monospace" }}>{fmt(p.sl)}</td>
                <td style={{ ...S.td, color: "#f0c040", fontFamily: "monospace" }}>{fmt(p.tsl)}</td>
                <td style={{ ...S.td, color: pnlColor(p.pnl), fontFamily: "monospace", fontWeight: 600 }}>
                  {fmtP(p.pnl)}
                </td>
                <td style={S.td}>
                  <span style={{ ...S.statusBadge, background: "#0a2a1a", color: "#00d68f", border: "1px solid #00d68f30" }}>
                    {p.status}
                  </span>
                </td>
              </tr>
            ))}
            {d.positions.length === 0 && (
              <tr><td colSpan={10} style={{ ...S.td, textAlign: "center", color: "#334050", padding: "32px 0" }}>
                No open positions
              </td></tr>
            )}
          </tbody>
        </table>

        {/* PnL summary bar */}
        <div style={S.pnlBar}>
          <PnlStat label="SESSION P&L" value={d.risk.dailyPnl}   />
          <PnlStat label="WEEK P&L"    value={d.risk.weeklyPnl}  />
          <div style={{ width: 1, background: "#1a2030", alignSelf: "stretch" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ color: "#556070", fontSize: 9, letterSpacing: 1 }}>DAILY LIMIT USED</span>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 120, height: 4, background: "#1a2030", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ width: `${Math.min(100, (Math.abs(d.risk.dailyPnl < 0 ? d.risk.dailyPnl : 0) / d.risk.dailyLimit) * 100)}%`, height: "100%", background: "#ff4d4f", borderRadius: 2 }} />
              </div>
              <span style={{ color: "#a0b0c0", fontSize: 10, fontFamily: "monospace" }}>0%</span>
            </div>
          </div>
        </div>
      </div>

      {/* Right column */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Latest signals */}
        <div style={{ ...S.panel, flex: 1 }}>
          <PanelHeader title="LATEST SIGNALS" />
          <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
            {d.signals.slice(0, 5).map((sig, i) => (
              <div key={i} className="row-hover" style={S.sigRow}>
                <span style={{ color: "#334050", fontSize: 9, fontFamily: "monospace", width: 52 }}>{sig.time}</span>
                <span style={{ color: "#556070", fontSize: 9, width: 70 }}>{sig.worker}</span>
                <span style={{ color: "#a0b0c0", fontSize: 10, width: 44 }}>{sig.symbol}</span>
                <span style={{ color: sig.dir === "BUY" ? "#00d68f" : "#ff4d4f", fontSize: 10, fontWeight: 600, width: 28 }}>{sig.dir}</span>
                <ConfBar conf={sig.conf} />
                <span style={{ color: sig.result === "TAKEN" ? "#00d68f" : "#556070", fontSize: 9, marginLeft: 4, minWidth: 44 }}>
                  {sig.result}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Causal rules active */}
        <div style={{ ...S.panel }}>
          <PanelHeader title="CAUSAL RULES ACTIVE" />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <RuleRow label="VIX NORMAL"    status="CLEAR"  note="< 15 — full size" />
            <RuleRow label="FII FLOW"      status="BULL"   note="+820 Cr today" />
            <RuleRow label="CRUDE"         status="CLEAR"  note="< 1% move" />
            <RuleRow label="RBI / EVENT"   status="CLEAR"  note="No events today" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── RISK TAB ────────────────────────────────────────────
function RiskTab({ d }) {
  const usedPct = Math.abs(Math.min(0, d.risk.dailyPnl)) / d.risk.dailyLimit * 100;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
      <RiskCard title="DAILY P&L" value={fmtP(d.risk.dailyPnl)} sub={`Limit: Rs ${fmt(d.risk.dailyLimit, 0)}`}
        accent={d.risk.dailyPnl >= 0 ? "#00d68f" : "#ff4d4f"} />
      <RiskCard title="WEEKLY P&L" value={fmtP(d.risk.weeklyPnl)} sub="Resets Monday"
        accent={d.risk.weeklyPnl >= 0 ? "#00d68f" : "#ff4d4f"} />
      <RiskCard title="EXPOSURE" value={`${d.risk.exposure}%`} sub="Max 80% of capital"
        accent={d.risk.exposure > 60 ? "#f0c040" : "#00d68f"} />
      <RiskCard title="OPEN POSITIONS" value={`${d.risk.openPositions} / ${d.risk.maxPositions}`}
        sub="Max 2 simultaneous" accent="#40aaff" />
      <RiskCard title="CONSEC LOSSES" value={d.risk.consecLosses} sub="Kill at 4"
        accent={d.risk.consecLosses >= 3 ? "#ff4d4f" : "#00d68f"} />
      <RiskCard title="DAILY LIMIT USED" value={`${usedPct.toFixed(1)}%`}
        sub={`${usedPct.toFixed(0)}% of Rs ${fmt(d.risk.dailyLimit, 0)}`}
        accent={usedPct > 70 ? "#ff4d4f" : usedPct > 40 ? "#f0c040" : "#00d68f"} />
    </div>
  );
}

// ─── SIGNALS TAB ─────────────────────────────────────────
function SignalsTab({ d }) {
  return (
    <div style={S.panel}>
      <PanelHeader title="SIGNAL FEED — TODAY" count={d.signals.length} />
      <table style={S.table}>
        <thead>
          <tr>{["TIME","WORKER","SYMBOL","DIRECTION","CONFIDENCE","REGIME","RESULT"].map(h =>
            <th key={h} style={S.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.signals.map((sig, i) => (
            <tr key={i} className="row-hover">
              <td style={{ ...S.td, color: "#556070", fontFamily: "monospace" }}>{sig.time}</td>
              <td style={{ ...S.td, color: "#a0b0c0" }}>{sig.worker}</td>
              <td style={{ ...S.td, color: "#c0d0e0", fontWeight: 500 }}>{sig.symbol}</td>
              <td style={{ ...S.td, color: sig.dir === "BUY" ? "#00d68f" : "#ff4d4f", fontWeight: 700 }}>{sig.dir}</td>
              <td style={S.td}><ConfBar conf={sig.conf} showNum /></td>
              <td style={S.td}>
                <span style={{ color: "#8899aa", fontSize: 10 }}>{sig.regime.replace("_"," ")}</span>
              </td>
              <td style={S.td}>
                <span style={{ color: sig.result === "TAKEN" ? "#00d68f" : "#556070",
                  background: sig.result === "TAKEN" ? "#001a0a" : "#111820",
                  padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600 }}>
                  {sig.result}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── WORKERS TAB ─────────────────────────────────────────
function WorkersTab({ d }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div style={S.panel}>
        <PanelHeader title="WORKER AGENTS" count={`${d.workers.filter(w=>w.status==="OK").length}/${d.workers.length} OK`} />
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {d.workers.map(w => (
            <div key={w.name} className="row-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", borderRadius: 4 }}>
              <span style={{ ...S.dot, background: w.status === "OK" ? "#00d68f" : "#f0c040", flexShrink: 0 }}
                className={w.status !== "OK" ? "pulse" : ""} />
              <span style={{ flex: 1, color: "#a0b0c0", fontSize: 11, fontFamily: "monospace" }}>{w.name}</span>
              <span style={{ color: w.lastBeat > 30 ? "#f0c040" : "#334050", fontSize: 10, fontFamily: "monospace" }}>
                {w.lastBeat}s ago
              </span>
              <span style={{ color: w.status === "OK" ? "#00d68f" : "#f0c040", fontSize: 10, fontWeight: 600, minWidth: 36, textAlign: "right" }}>
                {w.status}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={S.panel}>
        <PanelHeader title="SYSTEM METRICS" />
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" }}>
          <MetricRow label="TICK-TO-FILL AVG"  value={`${d.latency.avg}ms`}   good={d.latency.avg < 25} target="< 30ms" />
          <MetricRow label="LAST ORDER LATENCY" value={`${d.latency.last}ms`} good={d.latency.last < 25} target="< 30ms" />
          <MetricRow label="MAX LATENCY TODAY"  value={`${d.latency.max}ms`}  good={d.latency.max < 40} target="< 40ms" />
          <MetricRow label="KILL SWITCH"        value="ARMED"   good={true}  target="Always on" />
          <MetricRow label="BROKER PRIMARY"     value="UPSTOX"  good={true}  target="Connected" />
          <MetricRow label="BROKER BACKUP"      value="STANDBY" good={true}  target="Ready" />
          <MetricRow label="REDIS"              value="OK"      good={true}  target="< 1ms" />
          <MetricRow label="POSTGRES"           value="OK"      good={true}  target="Connected" />
          <MetricRow label="CHAOS TEST"         value="10/10"   good={true}  target="Last Saturday" />
        </div>
      </div>
    </div>
  );
}

// ─── ALPHA SCOREBOARD TAB ────────────────────────────────
function AlphaTab({ d }) {
  return (
    <div style={S.panel}>
      <PanelHeader title="ALPHA SCOREBOARD — CURRENT MONTH" />
      <div style={{ padding: "4px 0 12px", color: "#556070", fontSize: 11 }}>
        Rule: Component must show measurable contribution within 90 days or it is removed.
      </div>
      <table style={S.table}>
        <thead>
          <tr>{["COMPONENT","ALPHA CONTRIBUTION","TRADES INFLUENCED","90-DAY STATUS","ACTION"].map(h =>
            <th key={h} style={S.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {d.alphaScores.map((a, i) => (
            <tr key={i} className="row-hover">
              <td style={{ ...S.td, color: "#c0d0e0", fontWeight: 500 }}>{a.name}</td>
              <td style={S.td}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 80, height: 6, background: "#1a2030", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${a.contribution}%`, height: "100%",
                      background: a.contribution > 20 ? "#00d68f" : a.contribution > 8 ? "#40aaff" : "#556070",
                      borderRadius: 3 }} />
                  </div>
                  <span style={{ color: "#a0b0c0", fontSize: 11, fontFamily: "monospace", minWidth: 32 }}>
                    {a.contribution}%
                  </span>
                </div>
              </td>
              <td style={{ ...S.td, color: "#a0b0c0", fontFamily: "monospace" }}>{a.trades}</td>
              <td style={S.td}>
                <span style={{
                  color: a.status === "GREEN" ? "#00d68f" : "#f0c040",
                  background: a.status === "GREEN" ? "#001a0a" : "#1a1400",
                  border: `1px solid ${a.status === "GREEN" ? "#00d68f30" : "#f0c04030"}`,
                  padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600
                }}>{a.status}</span>
              </td>
              <td style={{ ...S.td, color: "#334050", fontSize: 10 }}>
                {a.status === "GREEN" ? "Keep" : "Monitor — Day 14 of 90"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Small components ───────────────────────────────────
const PanelHeader = ({ title, count }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, paddingBottom: 10, borderBottom: "1px solid #1a2030" }}>
    <span style={{ color: "#c0d0e0", fontSize: 11, fontWeight: 600, letterSpacing: 1.5 }}>{title}</span>
    {count !== undefined && <span style={{ color: "#40aaff", fontSize: 10, background: "#0a1a2a", padding: "1px 7px", borderRadius: 10, fontFamily: "monospace" }}>{count}</span>}
  </div>
);

const PnlStat = ({ label, value }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
    <span style={{ color: "#556070", fontSize: 9, letterSpacing: 1 }}>{label}</span>
    <span style={{ color: pnlColor(value), fontSize: 16, fontWeight: 700, fontFamily: "monospace" }}>
      ₹{fmt(Math.abs(value), 0)}
      <span style={{ fontSize: 10, fontWeight: 400, marginLeft: 2 }}>{value >= 0 ? " PROFIT" : " LOSS"}</span>
    </span>
  </div>
);

const ConfBar = ({ conf, showNum }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
    <div style={{ width: 40, height: 4, background: "#1a2030", borderRadius: 2, overflow: "hidden" }}>
      <div style={{ width: `${conf}%`, height: "100%", background: conf >= 75 ? "#00d68f" : conf >= 60 ? "#f0c040" : "#ff6b6b", borderRadius: 2 }} />
    </div>
    {showNum && <span style={{ color: "#8899aa", fontSize: 10, fontFamily: "monospace" }}>{conf}</span>}
  </div>
);

const RuleRow = ({ label, status, note }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 8px" }}>
    <span style={{ ...S.dot, background: status === "CLEAR" || status === "BULL" ? "#00d68f" : status === "CAUTION" ? "#f0c040" : "#ff4d4f" }} />
    <span style={{ color: "#8899aa", fontSize: 10, width: 90 }}>{label}</span>
    <span style={{ color: status === "CLEAR" ? "#334050" : status === "BULL" ? "#00d68f" : "#f0c040", fontSize: 10, flex: 1 }}>{note}</span>
  </div>
);

const RiskCard = ({ title, value, sub, accent }) => (
  <div style={{ ...S.panel, padding: 16 }}>
    <div style={{ color: "#556070", fontSize: 10, letterSpacing: 1.5, marginBottom: 8 }}>{title}</div>
    <div style={{ color: accent, fontSize: 28, fontWeight: 700, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 4 }}>{value}</div>
    <div style={{ color: "#334050", fontSize: 10 }}>{sub}</div>
  </div>
);

const MetricRow = ({ label, value, good, target }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px" }}>
    <span style={{ ...S.dot, background: good ? "#00d68f" : "#ff4d4f" }} />
    <span style={{ color: "#8899aa", fontSize: 10, flex: 1, letterSpacing: 0.5 }}>{label}</span>
    <span style={{ color: good ? "#00d68f" : "#ff4d4f", fontSize: 11, fontFamily: "monospace", fontWeight: 600 }}>{value}</span>
    <span style={{ color: "#334050", fontSize: 9, minWidth: 70, textAlign: "right" }}>{target}</span>
  </div>
);

// ─── Styles ─────────────────────────────────────────────
const S = {
  root: {
    fontFamily: "'IBM Plex Sans', sans-serif",
    background: "#080a0e",
    color: "#e0e8f0",
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 16px",
    background: "#0c0e12",
    borderBottom: "1px solid #1a2030",
    flexWrap: "wrap",
    minHeight: 48,
  },
  brand: { display: "flex", alignItems: "center", gap: 6, marginRight: 8 },
  brandIcon: { color: "#40aaff", fontSize: 18 },
  brandName: { color: "#e0e8f0", fontSize: 13, fontWeight: 700, letterSpacing: 2 },
  brandVer:  { color: "#334050", fontSize: 10 },
  indexRow:  { display: "flex", gap: 4 },
  chip: {
    display: "flex", flexDirection: "column", alignItems: "flex-start",
    gap: 1, padding: "4px 10px",
    background: "#111620", border: "1px solid #1a2030",
    borderRadius: 4,
  },
  regimeBadge: {
    padding: "4px 12px", borderRadius: 4,
    border: "1px solid", display: "flex", alignItems: "center",
    marginLeft: "auto",
  },
  killBadge: {
    padding: "4px 10px", borderRadius: 4,
    border: "1px solid", display: "flex", alignItems: "center", gap: 6,
  },
  clock: { color: "#334050", fontSize: 11, fontFamily: "'IBM Plex Mono', monospace" },
  dot: { width: 6, height: 6, borderRadius: "50%", display: "inline-block", flexShrink: 0 },
  tabBar: {
    display: "flex", alignItems: "center", gap: 2,
    padding: "0 16px",
    background: "#0a0c10",
    borderBottom: "1px solid #1a2030",
  },
  tab: {
    padding: "10px 14px", fontSize: 10, letterSpacing: 1.5,
    color: "#556070", borderRadius: "4px 4px 0 0",
    borderBottom: "2px solid transparent",
    transition: "all 0.15s",
  },
  tabActive: {
    color: "#40aaff", borderBottom: "2px solid #40aaff",
    background: "rgba(64,170,255,0.05)",
  },
  latencyPill: {
    display: "flex", alignItems: "center",
    background: "#0c0e12", border: "1px solid #1a2030",
    borderRadius: 4, padding: "4px 10px",
  },
  content: { flex: 1, padding: 12, overflow: "auto" },
  panel: {
    background: "#0e1118",
    border: "1px solid #1a2030",
    borderRadius: 6,
    padding: 14,
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: {
    color: "#334050", fontSize: 9, letterSpacing: 1.5,
    padding: "4px 10px", textAlign: "left",
    borderBottom: "1px solid #1a2030", whiteSpace: "nowrap",
  },
  td: {
    color: "#8899aa", fontSize: 11, padding: "8px 10px",
    borderBottom: "1px solid #0e1118",
    fontFamily: "'IBM Plex Mono', monospace",
  },
  statusBadge: { padding: "2px 8px", borderRadius: 3, fontSize: 10, fontWeight: 600 },
  pnlBar: {
    display: "flex", alignItems: "center", gap: 24,
    marginTop: 12, paddingTop: 12,
    borderTop: "1px solid #1a2030",
  },
  sigRow: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 8px", borderRadius: 4,
    borderBottom: "1px solid #0e1118",
  },
};
