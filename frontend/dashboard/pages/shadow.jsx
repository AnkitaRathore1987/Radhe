import { useState, useEffect } from "react";

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

async function fetchShadow() {
  try {
    const [perfRes, tradesRes] = await Promise.all([
      fetch(`${API}/api/shadow/performance`),
      fetch(`${API}/api/shadow/trades`),
    ]);
    const perf   = perfRes.ok   ? await perfRes.json()   : { data: { scores: [] } };
    const trades = tradesRes.ok ? await tradesRes.json() : { data: { trades: [] } };
    return {
      strategies: perf.data?.scores   || [],
      trades:     trades.data?.trades || [],
    };
  } catch {
    return { strategies: MOCK_DATA.strategies, trades: MOCK_DATA.trades };
  }
}

// ── Mock data for when API not connected ──────────────────
const MOCK_DATA = {
  strategies: [
    { id:"SWEEP_ONLY_HIGH_CONF",  name:"Sweep — High Conf Only",      trades:47, win_rate:"61.7", pf:"1.82", total_pnl:"12400", status:"PROMOTE_CANDIDATE" },
    { id:"BROAD_RALLY_CONFIRM",   name:"Broad Rally Confirmation",     trades:31, win_rate:"58.1", pf:"1.61", total_pnl:"7800",  status:"PROMOTE_CANDIDATE" },
    { id:"HIGH_MTF_ONLY",         name:"High MTF Alignment (>0.75)",   trades:29, win_rate:"55.2", pf:"1.48", total_pnl:"5200",  status:"TRACKING" },
    { id:"GEX_NEG_MOMENTUM",      name:"Negative GEX Momentum",        trades:38, win_rate:"52.6", pf:"1.32", total_pnl:"3100",  status:"TRACKING" },
    { id:"ABSORPTION_REVERSAL",   name:"Absorption Reversal",          trades:22, win_rate:"54.5", pf:"1.41", total_pnl:"4600",  status:"TRACKING" },
    { id:"CROSS_ASSET_MACRO",     name:"Cross-Asset Macro Align",      trades:18, win_rate:"50.0", pf:"1.21", total_pnl:"1800",  status:"TRACKING" },
    { id:"CVD_DIVERGENCE_FADE",   name:"CVD Divergence Fade",          trades:33, win_rate:"45.5", pf:"0.98", total_pnl:"-800",  status:"TRACKING" },
    { id:"FII_CONTRARIAN",        name:"FII Contrarian",               trades:25, win_rate:"44.0", pf:"0.91", total_pnl:"-1200", status:"TRACKING" },
    { id:"GEX_WALL_FADE",         name:"GEX Gamma Wall Fade",          trades:19, win_rate:"42.1", pf:"0.82", total_pnl:"-2100", status:"RETIRING" },
    { id:"VWAP_SD2_FADE",         name:"VWAP SD2 Fade",                trades:28, win_rate:"39.3", pf:"0.74", total_pnl:"-3400", status:"RETIRING" },
  ],
  trades: [
    { strategy_id:"SWEEP_ONLY_HIGH_CONF", direction:"BUY",  entry_price:"24310", exit_price:"24430", pnl_rs:"8850",  exit_reason:"TARGET",    hold_minutes:22, regime:"TRENDING_UP" },
    { strategy_id:"BROAD_RALLY_CONFIRM",  direction:"BUY",  entry_price:"24280", exit_price:"24390", pnl_rs:"8250",  exit_reason:"TARGET",    hold_minutes:18, regime:"TRENDING_UP" },
    { strategy_id:"GEX_WALL_FADE",        direction:"SELL", entry_price:"24450", exit_price:"24520", pnl_rs:"-5250", exit_reason:"SL_HIT",    hold_minutes:8,  regime:"SIDEWAYS" },
    { strategy_id:"HIGH_MTF_ONLY",        direction:"BUY",  entry_price:"24190", exit_price:"24310", pnl_rs:"9000",  exit_reason:"TARGET",    hold_minutes:31, regime:"TRENDING_UP" },
    { strategy_id:"CVD_DIVERGENCE_FADE",  direction:"SELL", entry_price:"24380", exit_price:"24460", pnl_rs:"-6000", exit_reason:"SL_HIT",    hold_minutes:12, regime:"SIDEWAYS" },
  ],
};

// ── Helpers ───────────────────────────────────────────────
const fmt    = (n, d=0) => parseFloat(n||0).toLocaleString("en-IN", { minimumFractionDigits:d, maximumFractionDigits:d });
const pnlClr = (n)      => parseFloat(n||0) >= 0 ? "#00d68f" : "#ff4d4f";

const STATUS_STYLE = {
  PROMOTE_CANDIDATE: { bg:"#001a0a", border:"#00d68f", text:"#00d68f", label:"🌟 PROMOTE" },
  RETIRING:          { bg:"#1a0000", border:"#ff4d4f", text:"#ff4d4f", label:"💀 RETIRING" },
  TRACKING:          { bg:"#0a0c10", border:"#334050", text:"#8899aa", label:"TRACKING"   },
};

// ═══════════════════════════════════════════════════════════
export default function ShadowDashboard() {
  const [data,    setData]    = useState(MOCK_DATA);
  const [tab,     setTab]     = useState("leaderboard");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchShadow().then(d => { setData(d); setLoading(false); });
    const t = setInterval(() => fetchShadow().then(setData), 30000);
    return () => clearInterval(t);
  }, []);

  const totalTrades   = data.strategies.reduce((a,s) => a + (s.trades||0), 0);
  const promoteCount  = data.strategies.filter(s => s.status === "PROMOTE_CANDIDATE").length;
  const retiringCount = data.strategies.filter(s => s.status === "RETIRING").length;

  return (
    <div style={S.root}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; }
        ::-webkit-scrollbar-thumb { background:#2a2e38; border-radius:2px; }
        .row:hover { background:rgba(255,255,255,0.03) !important; cursor:default; }
      `}</style>

      {/* ── Header ── */}
      <div style={S.header}>
        <div>
          <div style={S.title}>SHADOW TRADING LAB</div>
          <div style={S.sub}>Virtual strategies running parallel to real trading — no capital at risk</div>
        </div>
        <div style={S.statRow}>
          <StatPill label="Virtual Trades"   value={totalTrades}   color="#40aaff" />
          <StatPill label="Promote Ready"    value={promoteCount}  color="#00d68f" />
          <StatPill label="Retiring"         value={retiringCount} color="#ff4d4f" />
          <StatPill label="Strategies Live"  value={data.strategies.length} color="#8899aa" />
        </div>
      </div>

      {/* ── Tabs ── */}
      <div style={S.tabBar}>
        {[
          { id:"leaderboard", label:"STRATEGY LEADERBOARD" },
          { id:"trades",      label:"RECENT VIRTUAL TRADES" },
          { id:"promote",     label:"PROMOTION QUEUE" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ ...S.tab, ...(tab===t.id ? S.tabActive : {}) }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div style={S.content}>
        {tab === "leaderboard" && <Leaderboard strategies={data.strategies} />}
        {tab === "trades"      && <RecentTrades trades={data.trades} />}
        {tab === "promote"     && <PromoteQueue strategies={data.strategies.filter(s => s.status === "PROMOTE_CANDIDATE")} />}
      </div>
    </div>
  );
}

// ── Leaderboard ───────────────────────────────────────────
function Leaderboard({ strategies }) {
  return (
    <div style={S.panel}>
      <PanelHeader
        title="ALL SHADOW STRATEGIES — Ranked by Profit Factor"
        note="PF > 1.4 with 30+ trades = Promote Candidate  |  PF < 0.8 with 20+ trades = Retiring"
      />
      <table style={S.table}>
        <thead>
          <tr>
            {["RANK","STRATEGY","TRADES","WIN RATE","PROFIT FACTOR","VIRTUAL P&L","STATUS"].map(h =>
              <th key={h} style={S.th}>{h}</th>
            )}
          </tr>
        </thead>
        <tbody>
          {strategies.map((s, i) => {
            const ss = STATUS_STYLE[s.status] || STATUS_STYLE.TRACKING;
            return (
              <tr key={s.id} className="row">
                <td style={{ ...S.td, color: i < 3 ? "#f0c040" : "#334050", fontWeight:i<3?"700":"400" }}>
                  {i < 3 ? ["🥇","🥈","🥉"][i] : `#${i+1}`}
                </td>
                <td style={{ ...S.td }}>
                  <div style={{ color:"#c0d0e0", fontSize:12, fontWeight:500 }}>{s.name}</div>
                  <div style={{ color:"#334050", fontSize:10, marginTop:2, fontFamily:"monospace" }}>{s.id}</div>
                </td>
                <td style={{ ...S.td, color:"#a0b0c0", fontFamily:"monospace" }}>{s.trades}</td>
                <td style={S.td}>
                  <WinRateBar rate={parseFloat(s.win_rate)} />
                </td>
                <td style={S.td}>
                  <PFBar pf={parseFloat(s.pf)} />
                </td>
                <td style={{ ...S.td, color: pnlClr(s.total_pnl), fontFamily:"monospace", fontWeight:600 }}>
                  {parseFloat(s.total_pnl||0) >= 0 ? "+" : ""}₹{fmt(s.total_pnl)}
                </td>
                <td style={S.td}>
                  <span style={{ background:ss.bg, color:ss.text, border:`1px solid ${ss.border}`,
                    padding:"3px 8px", borderRadius:3, fontSize:10, fontWeight:600, whiteSpace:"nowrap" }}>
                    {ss.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Recent virtual trades ─────────────────────────────────
function RecentTrades({ trades }) {
  return (
    <div style={S.panel}>
      <PanelHeader title="RECENT VIRTUAL TRADES" note="These are paper trades — no real money" />
      <table style={S.table}>
        <thead>
          <tr>{["STRATEGY","DIR","ENTRY","EXIT","P&L","EXIT REASON","HOLD","REGIME"].map(h =>
            <th key={h} style={S.th}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {trades.map((t, i) => (
            <tr key={i} className="row">
              <td style={{ ...S.td, color:"#8899aa", fontSize:10 }}>{t.strategy_id}</td>
              <td style={{ ...S.td, color: t.direction==="BUY"?"#00d68f":"#ff4d4f", fontWeight:700 }}>{t.direction}</td>
              <td style={{ ...S.td, color:"#a0b0c0", fontFamily:"monospace" }}>{fmt(t.entry_price,2)}</td>
              <td style={{ ...S.td, color:"#a0b0c0", fontFamily:"monospace" }}>{fmt(t.exit_price,2)}</td>
              <td style={{ ...S.td, color:pnlClr(t.pnl_rs), fontFamily:"monospace", fontWeight:600 }}>
                {parseFloat(t.pnl_rs||0)>=0?"+":""}₹{fmt(t.pnl_rs)}
              </td>
              <td style={S.td}>
                <span style={{ color: t.exit_reason==="TARGET"?"#00d68f":t.exit_reason==="SL_HIT"?"#ff4d4f":"#8899aa", fontSize:10 }}>
                  {t.exit_reason}
                </span>
              </td>
              <td style={{ ...S.td, color:"#556070", fontFamily:"monospace" }}>{t.hold_minutes}m</td>
              <td style={{ ...S.td, color:"#556070", fontSize:10 }}>{t.regime?.replace("_"," ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Promotion queue ───────────────────────────────────────
function PromoteQueue({ strategies }) {
  return (
    <div style={S.panel}>
      <PanelHeader
        title="PROMOTION CANDIDATES"
        note="These strategies have proven themselves virtually — review before promoting to live"
      />
      {strategies.length === 0 ? (
        <div style={{ color:"#334050", textAlign:"center", padding:"40px 0", fontSize:13 }}>
          No promotion candidates yet — need PF &gt; 1.4 with 30+ virtual trades
        </div>
      ) : (
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
          {strategies.map(s => (
            <div key={s.id} style={{ background:"#001a0a", border:"1px solid #00d68f30", borderRadius:6, padding:16 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:12 }}>
                <div>
                  <div style={{ color:"#00d68f", fontSize:14, fontWeight:600 }}>{s.name}</div>
                  <div style={{ color:"#334050", fontSize:10, fontFamily:"monospace", marginTop:2 }}>{s.id}</div>
                </div>
                <span style={{ color:"#00d68f", background:"#002a10", border:"1px solid #00d68f50",
                  padding:"4px 12px", borderRadius:4, fontSize:11, fontWeight:700 }}>
                  🌟 PROMOTE CANDIDATE
                </span>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:12 }}>
                {[
                  ["Virtual Trades", s.trades],
                  ["Win Rate",       `${s.win_rate}%`],
                  ["Profit Factor",  s.pf],
                  ["Virtual P&L",    `+₹${fmt(s.total_pnl)}`],
                ].map(([label, value]) => (
                  <div key={label}>
                    <div style={{ color:"#334050", fontSize:9, letterSpacing:1, marginBottom:4 }}>{label}</div>
                    <div style={{ color:"#00d68f", fontSize:18, fontWeight:700, fontFamily:"monospace" }}>{value}</div>
                  </div>
                ))}
              </div>
              <div style={{ marginTop:12, padding:"8px 12px", background:"#002a10", borderRadius:4, fontSize:11, color:"#8899aa" }}>
                ⚠️ Review with Risk Officer before enabling live. Confirm strategy logic still valid with current market regime.
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Small components ──────────────────────────────────────
const StatPill = ({ label, value, color }) => (
  <div style={{ background:"#0e1118", border:"1px solid #1a2030", borderRadius:6, padding:"8px 16px", textAlign:"center" }}>
    <div style={{ color, fontSize:22, fontWeight:700, fontFamily:"monospace" }}>{value}</div>
    <div style={{ color:"#556070", fontSize:9, letterSpacing:1, marginTop:2 }}>{label}</div>
  </div>
);

const PanelHeader = ({ title, note }) => (
  <div style={{ marginBottom:14, paddingBottom:12, borderBottom:"1px solid #1a2030" }}>
    <div style={{ color:"#c0d0e0", fontSize:11, fontWeight:600, letterSpacing:1.5 }}>{title}</div>
    {note && <div style={{ color:"#334050", fontSize:10, marginTop:4 }}>{note}</div>}
  </div>
);

const WinRateBar = ({ rate }) => (
  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
    <div style={{ width:60, height:5, background:"#1a2030", borderRadius:3, overflow:"hidden" }}>
      <div style={{ width:`${rate}%`, height:"100%", background: rate>=55?"#00d68f":rate>=45?"#f0c040":"#ff4d4f", borderRadius:3 }} />
    </div>
    <span style={{ color:"#a0b0c0", fontSize:11, fontFamily:"monospace" }}>{rate}%</span>
  </div>
);

const PFBar = ({ pf }) => (
  <div style={{ display:"flex", alignItems:"center", gap:8 }}>
    <div style={{ width:60, height:5, background:"#1a2030", borderRadius:3, overflow:"hidden" }}>
      <div style={{ width:`${Math.min(100, pf/2*100)}%`, height:"100%",
        background: pf>=1.4?"#00d68f":pf>=1.0?"#f0c040":"#ff4d4f", borderRadius:3 }} />
    </div>
    <span style={{ color: pf>=1.4?"#00d68f":pf>=1.0?"#f0c040":"#ff4d4f",
      fontSize:11, fontFamily:"monospace", fontWeight:600 }}>{pf.toFixed(2)}</span>
  </div>
);

// ── Styles ────────────────────────────────────────────────
const S = {
  root:    { fontFamily:"'IBM Plex Sans',sans-serif", background:"#080a0e", color:"#e0e8f0", minHeight:"100vh", display:"flex", flexDirection:"column" },
  header:  { display:"flex", justifyContent:"space-between", alignItems:"center", padding:"16px 20px", background:"#0c0e12", borderBottom:"1px solid #1a2030", flexWrap:"wrap", gap:12 },
  title:   { color:"#e0e8f0", fontSize:16, fontWeight:700, letterSpacing:2 },
  sub:     { color:"#556070", fontSize:11, marginTop:4 },
  statRow: { display:"flex", gap:8 },
  tabBar:  { display:"flex", gap:2, padding:"0 20px", background:"#0a0c10", borderBottom:"1px solid #1a2030" },
  tab:     { padding:"10px 16px", fontSize:10, letterSpacing:1.5, color:"#556070", background:"none", border:"none", borderBottom:"2px solid transparent", cursor:"pointer" },
  tabActive: { color:"#40aaff", borderBottom:"2px solid #40aaff", background:"rgba(64,170,255,0.05)" },
  content: { flex:1, padding:16, overflow:"auto" },
  panel:   { background:"#0e1118", border:"1px solid #1a2030", borderRadius:6, padding:16 },
  table:   { width:"100%", borderCollapse:"collapse" },
  th:      { color:"#334050", fontSize:9, letterSpacing:1.5, padding:"6px 12px", textAlign:"left", borderBottom:"1px solid #1a2030" },
  td:      { color:"#8899aa", fontSize:11, padding:"9px 12px", borderBottom:"1px solid #0e1118", fontFamily:"'IBM Plex Mono',monospace" },
};
