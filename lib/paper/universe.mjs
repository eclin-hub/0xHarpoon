// Univers des stratégies (Blueprints) : tout Hyperliquid et tout Polymarket, plus les 8 tickers historiques.
//   Éléments acceptés dans `universe` (1 à 20) :
//     - un ticker historique : BTC, ETH, SOL, HYPE, ZEC, NVDA, SOXL, BRENTOIL (séries existantes des ligues) ;
//     - un actif Hyperliquid tel qu'il est coté : DOGE, kPEPE, xyz:CL, xyz:TSLA… (dex principal et dex xyz) ;
//     - un marché Polymarket : PM:<conditionId ou ses 10 premiers caractères hex au moins>|<issue> (ex. PM:0x2745c38ff0|No) ;
//     - un groupe, résolu à chaque cycle sur les actifs les plus liquides du moment :
//         ALL_HL (25 actifs Hyperliquid), HL_CRYPTO (20 cryptos du dex principal), HL_TRADFI (15 actifs du dex xyz :
//         actions, indices, matières premières), ALL_PM (15 marchés Polymarket suivis, cote entre 3 % et 97 %).
//   Résolution (D2/D3) : catalogue du cycle (marchés Hyperliquid + séries de cotes Polymarket de market_history.json),
//   30 actifs au plus par stratégie ; un actif absent du catalogue est ignoré.
//   Labo D1 : chaque élément est remplacé par un actif synthétique de la même classe (proxies : crypto, actions,
//   pétrole, et PMPROXY, une cote de probabilité bornée entre 0 et 1).
export const LEGACY_COIN = Object.freeze({ BTC: "BTC", ETH: "ETH", SOL: "SOL", HYPE: "HYPE", ZEC: "ZEC", NVDA: "xyz:NVDA", SOXL: "xyz:SOXL", BRENTOIL: "xyz:BRENTOIL" });
// tickers historiques (mêmes que blueprint.TICKERS ; pas d'import pour éviter une dépendance circulaire)
const TICKERS = Object.keys(LEGACY_COIN);
const TICKER_OF_COIN = Object.fromEntries(Object.entries(LEGACY_COIN).map(([t, c]) => [c.toLowerCase(), t]));
export const GROUPS = Object.freeze(["ALL_HL", "HL_CRYPTO", "HL_TRADFI", "ALL_PM"]);
export const UNIVERSE_CFG = Object.freeze({ allHl: 25, crypto: 20, tradfi: 15, pm: 15, maxAssets: 30, maxItems: 20, pmMin: 0.03, pmMax: 0.97, pmFreshH: 3, pmMinPts: 6 });

const H = 3600e3;
export const isPmKey = (k) => /^PM:/i.test(String(k));
export const isGroup = (k) => GROUPS.includes(String(k).toUpperCase());
const HL_RE = /^(?:[a-z]{1,8}:)?[A-Za-z0-9]{1,20}$/, PM_RE = /^PM:0x[0-9a-fA-F]{8,64}\|[^|]{1,60}$/;
// élément d'univers syntaxiquement valide (la présence dans le catalogue se vérifie au cycle)
export const validAsset = (k) => typeof k === "string" && (TICKERS.includes(k) || GROUPS.includes(k) || HL_RE.test(k) || PM_RE.test(k));
// clé de série d'un actif Hyperliquid : ticker historique si l'actif en est un (xyz:NVDA → NVDA), sinon le nom coté
export const hlKey = (coin) => TICKER_OF_COIN[String(coin).toLowerCase()] ?? coin;
export const pmKey = (cid, outcome) => `PM:${cid}|${outcome}`;
export const isCommodity = (coin) => /(^|:)(CL|BRENT\w*|WTI|OIL|GOLD|SILVER|NATGAS|NG|COPPER|PLAT\w*|PALLAD\w*|URANIUM)$/i.test(coin);

// Normalisation d'un élément brut rendu par un LLM (alias, casse) ; null si inutilisable
const ALIASES = { BITCOIN: "BTC", XBT: "BTC", ETHEREUM: "ETH", SOLANA: "SOL", HYPERLIQUID: "HYPE", ZCASH: "ZEC", NVIDIA: "NVDA", BRENT: "BRENTOIL", SOX: "SOXL", CRUDE: "xyz:CL", OIL: "xyz:CL", WTI: "xyz:CL", GOLD: "xyz:GOLD" };
export function normalizeAsset(raw) {
  const s = String(raw ?? "").trim().replace(/\s+/g, "");
  if (!s) return null;
  if (/^PM:/i.test(s)) { const m = s.match(/^PM:(0x[0-9a-fA-F]{8,64})\|(.+)$/i); return m ? `PM:${m[1].toLowerCase()}|${m[2]}` : null; }
  if (GROUPS.includes(s.toUpperCase().replace(/-/g, "_"))) return s.toUpperCase().replace(/-/g, "_");
  const dex = s.match(/^([A-Za-z]{1,8}):([A-Za-z0-9]{1,20})$/);
  if (dex) { const k = `${dex[1].toLowerCase()}:${dex[2].toUpperCase()}`; return hlKey(k); }
  const up = s.toUpperCase();
  if (ALIASES[up]) return ALIASES[up];
  if (TICKERS.includes(up)) return up;
  if (/^k[A-Z0-9]{2,}$/.test(s)) return s;                    // kPEPE, kBONK : préfixe k minuscule chez Hyperliquid
  return /^[A-Z0-9]{1,20}$/.test(up) ? up : null;
}

/* ---------------- catalogue du cycle ---------------- */

// markets : marchés Hyperliquid (lib/hl.mjs fetchMarkets) ; history : market_history.json (cotes Polymarket horodatées)
// → { hl: [{ key, coin, cls, vol, oi, mark }], pm: [{ key, cid, outcome, title, last, n }] }, triés par liquidité
export function buildCatalog({ markets = {}, history = null, now = Date.now(), cfg = UNIVERSE_CFG } = {}) {
  const hl = Object.values(markets || {}).filter((m) => m?.coin && m.mark > 0)
    .map((m) => ({ key: hlKey(m.coin), coin: m.coin, cls: m.coin.includes(":") ? "tradfi" : "crypto", vol: m.vol ?? 0, oi: m.oi ?? 0, mark: m.mark }))
    .sort((a, b) => b.vol - a.vol || b.oi - a.oi);
  const pm = Object.values(history?.pm || {}).filter((e) => e?.cid && e.outcome && e.pts?.length >= cfg.pmMinPts)
    .map((e) => ({ key: pmKey(e.cid, e.outcome), cid: e.cid, outcome: e.outcome, title: e.title || e.cid, last: e.pts.at(-1)[1], lastT: e.pts.at(-1)[0], n: e.pts.length }))
    .filter((e) => e.last >= cfg.pmMin && e.last <= cfg.pmMax && now - e.lastT <= cfg.pmFreshH * H)
    .sort((a, b) => b.n - a.n || Math.abs(0.5 - a.last) - Math.abs(0.5 - b.last));
  return { at: new Date(now).toISOString(), hl, pm };
}

// Éléments d'univers → clés de séries (dédoublonnées, 30 au plus). catalog null : seuls les tickers historiques restent.
export function resolveUniverse(universe = [], catalog = null, cfg = UNIVERSE_CFG) {
  const out = [], add = (k) => { if (k && !out.includes(k) && out.length < cfg.maxAssets) out.push(k); };
  const hl = catalog?.hl || [], pm = catalog?.pm || [];
  for (const raw of universe) {
    const x = String(raw);
    if (TICKERS.includes(x)) { add(x); continue; }
    if (x === "ALL_HL") { hl.slice(0, cfg.allHl).forEach((m) => add(m.key)); continue; }
    if (x === "HL_CRYPTO") { hl.filter((m) => m.cls === "crypto").slice(0, cfg.crypto).forEach((m) => add(m.key)); continue; }
    if (x === "HL_TRADFI") { hl.filter((m) => m.cls === "tradfi").slice(0, cfg.tradfi).forEach((m) => add(m.key)); continue; }
    if (x === "ALL_PM") { pm.slice(0, cfg.pm).forEach((m) => add(m.key)); continue; }
    if (isPmKey(x)) {
      const [, cid = "", outcome = ""] = x.match(/^PM:(0x[0-9a-fA-F]+)\|(.+)$/i) || [];
      const hit = pm.find((m) => m.cid.toLowerCase().startsWith(cid.toLowerCase()) && m.outcome.toLowerCase() === outcome.toLowerCase());
      if (hit) add(hit.key);
      continue;
    }
    const lx = x.toLowerCase(), hit = hl.find((m) => m.coin.toLowerCase() === lx || m.key.toLowerCase() === lx) ?? hl.find((m) => m.coin.toLowerCase().endsWith(":" + lx));
    if (hit) add(hit.key);
  }
  return out;
}

// Libellé lisible d'une clé de série
export function assetLabel(key, catalog = null, history = null) {
  if (!isPmKey(key)) return LEGACY_COIN[key] && LEGACY_COIN[key] !== key ? `${key}` : key;
  const e = catalog?.pm?.find((m) => m.key === key) ?? Object.values(history?.pm || {}).find((m) => pmKey(m.cid, m.outcome) === key);
  return e ? `${e.title} · ${e.outcome}` : key.slice(0, 18) + "…";
}

// Liste compacte pour le compilateur de Blueprints (LLM) : les actifs réellement disponibles ce cycle
export function catalogPrompt(catalog, { hlMax = 70, pmMax = 25 } = {}) {
  if (!catalog || (!catalog.hl?.length && !catalog.pm?.length)) return null;
  const hl = (catalog.hl || []).slice(0, hlMax), cr = hl.filter((m) => m.cls === "crypto").map((m) => m.key), tf = hl.filter((m) => m.cls === "tradfi").map((m) => m.coin);
  const pm = (catalog.pm || []).slice(0, pmMax).map((m) => `PM:${m.cid.slice(0, 12)}|${m.outcome} = "${String(m.title).slice(0, 70)}" (odds ${m.last.toFixed(2)})`);
  return [`Hyperliquid crypto perps (most liquid first): ${cr.join(", ")}`, `Hyperliquid TradFi perps (equities, indices, commodities): ${tf.join(", ")}`,
    pm.length ? `Polymarket markets (trade the odds of one outcome):\n${pm.join("\n")}` : null].filter(Boolean).join("\n");
}

/* ---------------- proxies synthétiques du labo D1 ---------------- */

const ALT = ["SOL", "HYPE", "ZEC"];
const hashIdx = (s, n) => { let h = 7; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % n; };
// Éléments d'univers → actifs du marché synthétique (8 au plus) : même classe d'actifs que l'original
export function syntheticAssets(universe = []) {
  const out = [], add = (k) => { if (!out.includes(k) && out.length < 8) out.push(k); };
  for (const raw of universe) {
    const x = String(raw);
    if (TICKERS.includes(x)) add(x);
    else if (x === "ALL_HL") ["BTC", "ETH", "SOL", "NVDA", "BRENTOIL"].forEach(add);
    else if (x === "HL_CRYPTO") ["BTC", "ETH", "SOL", "HYPE"].forEach(add);
    else if (x === "HL_TRADFI") ["NVDA", "SOXL", "BRENTOIL"].forEach(add);
    else if (x === "ALL_PM" || isPmKey(x)) add("PMPROXY");
    else if (x.includes(":")) add(isCommodity(x) ? "BRENTOIL" : "NVDA");
    else add(ALT[hashIdx(x, ALT.length)]);
  }
  return out.length ? out : ["BTC"];
}

/* ---------------- migration des Blueprints existants ---------------- */

// Univers historique (les 8 tickers) → on garde les actifs d'origine et on ajoute le groupe de leur classe, pour que la
// stratégie balaie toutes les paires liquides de cette classe. Idempotent (version 2).
export const UNIVERSE_V = 2;
export function widenUniverse(universe = []) {
  const u = [...universe];
  if (u.some((x) => GROUPS.includes(x) || isPmKey(x))) return u;
  const crypto = u.some((x) => ["BTC", "ETH", "SOL", "HYPE", "ZEC"].includes(x) || (!x.includes(":") && !TICKERS.includes(x)));
  const tradfi = u.some((x) => ["NVDA", "SOXL", "BRENTOIL"].includes(x) || x.includes(":"));
  if (crypto) u.push("HL_CRYPTO");
  if (tradfi) u.push("HL_TRADFI");
  return u.slice(0, UNIVERSE_CFG.maxItems);
}
