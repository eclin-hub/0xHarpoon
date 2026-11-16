// Thèmes communs entre Hyperliquid (coins) et Polymarket (titres de marchés).
export const TOPICS = {
  BTC: { label: "Bitcoin", group: "Crypto" },
  ETH: { label: "Ethereum", group: "Crypto" },
  SOL: { label: "Solana", group: "Crypto" },
  XRP: { label: "XRP", group: "Crypto" },
  DOGE: { label: "Dogecoin", group: "Crypto" },
  HYPE: { label: "Hyperliquid (HYPE)", group: "Crypto" },
  OIL: { label: "Pétrole (WTI / Brent)", group: "Matières premières" },
  GOLD: { label: "Or", group: "Matières premières" },
  SILVER: { label: "Argent", group: "Matières premières" },
  NATGAS: { label: "Gaz naturel", group: "Matières premières" },
  US_EQ: { label: "Actions US (S&P / Nasdaq)", group: "Indices" },
  TSLA: { label: "Tesla", group: "Actions" },
  NVDA: { label: "Nvidia", group: "Actions" },
  USD: { label: "Dollar (DXY)", group: "Macro" },
};

const HL_MAP = {
  BTC: "BTC", kPEPE: null, ETH: "ETH", SOL: "SOL", XRP: "XRP", DOGE: "DOGE", HYPE: "HYPE",
  "xyz:CL": "OIL", "xyz:BRENTOIL": "OIL", "xyz:GOLD": "GOLD", "xyz:SILVER": "SILVER", "xyz:NATGAS": "NATGAS",
  "xyz:SP500": "US_EQ", "xyz:XYZ100": "US_EQ", "xyz:TSLA": "TSLA", "xyz:NVDA": "NVDA", "xyz:DXY": "USD",
  PAXG: "GOLD",
};
export const hlTopic = (coin) => HL_MAP[coin] ?? null;

const PM_RULES = [
  ["BTC", /\b(bitcoin|btc)\b/i],
  ["ETH", /\b(ethereum|ether|eth)\b/i],
  ["SOL", /\b(solana|sol)\b/i],
  ["XRP", /\bxrp\b/i],
  ["DOGE", /\b(dogecoin|doge)\b/i],
  ["HYPE", /\b(hyperliquid|hype)\b/i],
  ["OIL", /\b(crude|oil|wti|brent)\b/i],
  ["GOLD", /\bgold\b/i],
  ["SILVER", /\bsilver\b/i],
  ["NATGAS", /\b(natural gas|nat gas|natgas)\b/i],
  ["US_EQ", /\b(s&p|sp500|spx|nasdaq|ndx|dow jones)\b/i],
  ["TSLA", /\b(tesla|tsla)\b/i],
  ["NVDA", /\b(nvidia|nvda)\b/i],
  ["USD", /\b(dxy|dollar index)\b/i],
];
export function pmTopic(title) {
  for (const [t, re] of PM_RULES) if (re.test(title)) return t;
  return null;
}

// Sens du marché : "up" si OUI = hausse du sous-jacent, "down" si OUI = baisse, null si pas directionnel.
export function marketDirection(title) {
  const t = title.toLowerCase();
  if (/\b(between|range|exactly)\b/.test(t)) return null;
  if (/\b(dip|fall|drop|below|under|lower|less than|crash|decline|drops?)\b/.test(t)) return "down";
  if (/\b(above|over|reach|hit|rise|higher|exceed|greater|surpass|up|ath|all[- ]time high|at least|more than)\b/.test(t)) return "up";
  return null;
}

// Catégorie grossière d'un marché Polymarket d'après son titre
const CAT_RULES = [
  ["crypto", /\b(bitcoin|btc|ethereum|eth|solana|xrp|dogecoin|crypto|token|coin|memecoin|airdrop|megaeth|hyperliquid)\b/i],
  ["finance", /\b(s&p|nasdaq|fed|rate cut|interest rate|inflation|cpi|gdp|oil|crude|gold|silver|stock|earnings|ipo|dow|treasury|recession|tariff|fdv|market cap)\b/i],
  ["sports", /\b(vs\.?|nba|nfl|mlb|nhl|ufc|fifa|world cup|premier league|champions league|la liga|serie a|bundesliga|tennis|grand prix|f1|masters|super bowl|olympic|win on)\b/i],
  ["politics", /\b(president|election|trump|biden|harris|congress|senate|house|governor|prime minister|parliament|democrat|republican|iran|israel|ukraine|russia|china|gaza|ceasefire|nato|putin|zelensky|war|sanction|vote|minister|mayor|primary|nominee)\b/i],
];
export function pmCategory(title) {
  for (const [c, re] of CAT_RULES) if (re.test(title)) return c;
  return "other";
}

// Actif Hyperliquid de référence pour chaque thème (prix, funding, open interest)
export const TOPIC_COIN = {
  BTC: "BTC", ETH: "ETH", SOL: "SOL", XRP: "XRP", DOGE: "DOGE", HYPE: "HYPE",
  OIL: "xyz:CL", GOLD: "xyz:GOLD", SILVER: "xyz:SILVER", NATGAS: "xyz:NATGAS",
  US_EQ: "xyz:SP500", TSLA: "xyz:TSLA", NVDA: "xyz:NVDA", USD: "xyz:DXY",
};
