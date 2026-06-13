/**
 * INSTRUMENTS CONFIG — Single Source of Truth
 * ============================================
 * Yahan sirf ek jagah naam change karo.
 * Poora system automatically update ho jaata hai.
 *
 * Upstox instrument format: EXCHANGE|SYMBOL
 * NSE Index:    NSE_INDEX|Nifty 50
 * F&O Future:   NSE_FO|NIFTY25JUNFUT  (expiry ke saath)
 * F&O Option:   NSE_FO|NIFTY25JUN25000CE
 * Equity:       NSE_EQ|RELIANCE
 *
 * Jab bhi expiry change ho — sirf FUTURES section update karo.
 * Baaki code ko chhuna nahi padega.
 */

// ─────────────────────────────────────────────
// SECTION 1: INDICES (Cash market — no expiry)
// ─────────────────────────────────────────────
const INDICES = {
  NIFTY:     "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  MIDCAP:    "NSE_INDEX|Nifty Midcap 50",
  IT:        "NSE_INDEX|Nifty IT",
  AUTO:      "NSE_INDEX|Nifty Auto",
  FMCG:      "NSE_INDEX|Nifty FMCG",
  PHARMA:    "NSE_INDEX|Nifty Pharma",
  PSE:       "NSE_INDEX|Nifty PSE",
  REALTY:    "NSE_INDEX|Nifty Realty",
  VIX:       "NSE_INDEX|India VIX",
};

// ─────────────────────────────────────────────
// SECTION 2: FUTURES (Update expiry every month)
// ─────────────────────────────────────────────
// FORMAT: NIFTY + YY + MMM + FUT  (e.g. NIFTY25JUNFUT)
// Current expiry: June 2025 — CHANGE THIS EVERY MONTH
const CURRENT_EXPIRY = "25JUN"; // <── SIRF YEH CHANGE KARO

const FUTURES = {
  NIFTY_FUT:     `NSE_FO|NIFTY${CURRENT_EXPIRY}FUT`,
  BANKNIFTY_FUT: `NSE_FO|BANKNIFTY${CURRENT_EXPIRY}FUT`,
  FINNIFTY_FUT:  `NSE_FO|FINNIFTY${CURRENT_EXPIRY}FUT`,
};

// ─────────────────────────────────────────────
// SECTION 3: TOP F&O STOCKS (Equity)
// ─────────────────────────────────────────────
const FO_STOCKS = {
  // Banking
  HDFCBANK:   "NSE_EQ|HDFCBANK",
  ICICIBANK:  "NSE_EQ|ICICIBANK",
  AXISBANK:   "NSE_EQ|AXISBANK",
  KOTAKBANK:  "NSE_EQ|KOTAKBANK",
  SBIN:       "NSE_EQ|SBIN",

  // IT
  INFY:       "NSE_EQ|INFY",
  TCS:        "NSE_EQ|TCS",
  WIPRO:      "NSE_EQ|WIPRO",
  HCLTECH:    "NSE_EQ|HCLTECH",
  TECHM:      "NSE_EQ|TECHM",

  // Others
  RELIANCE:   "NSE_EQ|RELIANCE",
  LT:         "NSE_EQ|LT",
  BAJFINANCE: "NSE_EQ|BAJFINANCE",
  MARUTI:     "NSE_EQ|MARUTI",
  ONGC:       "NSE_EQ|ONGC",
  SUNPHARMA:  "NSE_EQ|SUNPHARMA",
  TATASTEEL:  "NSE_EQ|TATASTEEL",
  TITAN:      "NSE_EQ|TITAN",
  POWERGRID:  "NSE_EQ|POWERGRID",
  ULTRACEMCO: "NSE_EQ|ULTRACEMCO",
};

// ─────────────────────────────────────────────
// SECTION 4: CURRENCY & COMMODITY
// ─────────────────────────────────────────────
const CROSS_ASSET = {
  USDINR:     "NSE_EQ|USDINR",      // Currency
  CRUDE:      "MCX_FO|CRUDEOIL25JUNFUT", // MCX Crude
  GOLD:       "MCX_FO|GOLD25JUNFUT",     // MCX Gold
};

// ─────────────────────────────────────────────
// SECTION 5: OPTION CHAIN CONFIG
// ─────────────────────────────────────────────
// Strike step size — Nifty: 50, BankNifty: 100
const OPTION_CHAIN = {
  NIFTY: {
    exchange:    "NSE_FO",
    underlying:  "NIFTY",
    expiry:      CURRENT_EXPIRY,
    strike_step: 50,           // Nifty options at every 50 points
    strikes_otm: 10,           // Kitne OTM strikes track karne hain (both sides)
    // Example format: NSE_FO|NIFTY25JUN25000CE  or  NSE_FO|NIFTY25JUN25000PE
    format: (strike, type) => `NSE_FO|NIFTY${CURRENT_EXPIRY}${strike}${type}`,
  },
  BANKNIFTY: {
    exchange:    "NSE_FO",
    underlying:  "BANKNIFTY",
    expiry:      CURRENT_EXPIRY,
    strike_step: 100,          // BankNifty options at every 100 points
    strikes_otm: 10,
    format: (strike, type) => `NSE_FO|BANKNIFTY${CURRENT_EXPIRY}${strike}${type}`,
  },
};

// ─────────────────────────────────────────────
// SECTION 6: WHAT TO SUBSCRIBE (Gateway use karega)
// ─────────────────────────────────────────────
// Yeh list gateway.js ko deni hai — yahi subscribe hoga
const SUBSCRIBE_LIST = [
  // Indices — always
  ...Object.values(INDICES),

  // Futures — always
  ...Object.values(FUTURES),

  // Top 10 F&O stocks (bandwidth bachane ke liye — baad mein expand karo)
  FO_STOCKS.HDFCBANK,
  FO_STOCKS.ICICIBANK,
  FO_STOCKS.RELIANCE,
  FO_STOCKS.INFY,
  FO_STOCKS.TCS,
  FO_STOCKS.SBIN,
  FO_STOCKS.AXISBANK,
  FO_STOCKS.BAJFINANCE,
  FO_STOCKS.ONGC,
  FO_STOCKS.SUNPHARMA,
];

// ─────────────────────────────────────────────
// SECTION 7: TRADING CONFIG
// ─────────────────────────────────────────────
const TRADING_CONFIG = {
  // Primary instruments for signals
  PRIMARY_INDEX:    "NIFTY",
  PRIMARY_FUTURE:   FUTURES.NIFTY_FUT,
  SECONDARY_INDEX:  "BANKNIFTY",
  SECONDARY_FUTURE: FUTURES.BANKNIFTY_FUT,

  // Session timings (IST)
  SESSION_START:    "09:15",
  SESSION_END:      "15:15",
  NO_TRADE_WINDOW:  "09:15-09:30", // Observation only — no trades
  SQUARE_OFF_TIME:  "15:10",       // All positions closed by this time

  // Lot sizes (NSE standard — changes rarely)
  LOT_SIZES: {
    NIFTY:     75,   // 1 lot = 75 units
    BANKNIFTY: 30,   // 1 lot = 30 units
    FINNIFTY:  40,
  },

  // Tick sizes
  TICK_SIZE: {
    INDEX:   0.05,
    FUTURES: 0.05,
    OPTIONS: 0.05,
    EQUITY:  0.05,
  },
};

// ─────────────────────────────────────────────
// EXPORTS — Har file yahan se import karegi
// ─────────────────────────────────────────────
module.exports = {
  INDICES,
  FUTURES,
  FO_STOCKS,
  CROSS_ASSET,
  OPTION_CHAIN,
  SUBSCRIBE_LIST,
  TRADING_CONFIG,
  CURRENT_EXPIRY,  // Workers ko bhi chahiye hoga
};
