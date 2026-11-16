// Sources institutionnelles et alternatives, toutes publiques et sans clé.
import { getJson, pool, num, downsample } from "./util.mjs";

/* ---------- CFTC : positions des hedge funds sur les futures (rapport COT hebdomadaire) ---------- */
const TFF = { "13874A": ["S&P 500", "US_EQ"], "209742": ["Nasdaq 100", "NDX"], "239742": ["Russell 2000", null], "133741": ["Bitcoin (CME)", "BTC"], "146021": ["Ether (CME)", "ETH"], "043602": ["Trésor 10 ans", null], "042601": ["Trésor 2 ans", null], "099741": ["Euro", null], "097741": ["Yen", null], "098662": ["Indice dollar", "USD"], "1170E1": ["VIX", null] };
const DIS = { "088691": ["Or", "GOLD"], "067651": ["Pétrole WTI", "OIL"], "084691": ["Argent", "SILVER"], "085692": ["Cuivre", null], "023651": ["Gaz naturel", "NATGAS"] };
async function cotSet(dataset, codes, L, S, L2, S2) {
  const q = new URLSearchParams({ $select: `cftc_contract_market_code,report_date_as_yyyy_mm_dd,open_interest_all,${L},${S}${L2 ? `,${L2},${S2}` : ""}`, $where: `cftc_contract_market_code in (${Object.keys(codes).map((c) => `'${c}'`).join(",")})`, $order: "report_date_as_yyyy_mm_dd DESC", $limit: "2600" });
  const rows = await getJson(`https://publicreporting.cftc.gov/resource/${dataset}.json?${q}`, { timeout: 45000 });
  const by = {}; for (const r of rows) (by[r.cftc_contract_market_code] ??= []).push(r);
  return Object.entries(by).map(([code, rs]) => {
    rs = rs.slice(0, 156).reverse(); // 3 ans, du plus ancien au plus récent
    const oi = (r) => num(r.open_interest_all) || 1, net = rs.map((r) => (num(r[L]) - num(r[S])) / oi(r)), net2 = L2 ? rs.map((r) => (num(r[L2]) - num(r[S2])) / oi(r)) : null;
    const last = net.at(-1), pctl = net.filter((v) => v <= last).length / net.length, lr = rs.at(-1);
    return { code, name: codes[code][0], topic: codes[code][1], date: Date.parse(lr.report_date_as_yyyy_mm_dd), weeks: rs.length,
      net: last, netContracts: num(lr[L]) - num(lr[S]), long: num(lr[L]), short: num(lr[S]), w1: last - (net.at(-2) ?? last), w4: last - (net.at(-5) ?? net[0]), pctl,
      am: net2 ? { net: net2.at(-1), w4: net2.at(-1) - (net2.at(-5) ?? net2[0]), pctl: net2.filter((v) => v <= net2.at(-1)).length / net2.length } : null, spark: downsample(net.map((v) => +v.toFixed(4)), 60) };
  });
}
export async function fetchCot() {
  const [a, b] = await Promise.all([cotSet("gpe5-46if", TFF, "lev_money_positions_long", "lev_money_positions_short", "asset_mgr_positions_long", "asset_mgr_positions_short").catch(() => []), cotSet("72hh-3qpy", DIS, "m_money_positions_long_all", "m_money_positions_short_all").catch(() => [])]);
  const order = [...Object.keys(TFF), ...Object.keys(DIS)];
  return { at: Date.now(), markets: [...a, ...b].sort((x, y) => order.indexOf(x.code) - order.indexOf(y.code)) };
}

/* ---------- Deribit : options BTC et ETH ---------- */
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const expTs = (s) => { const m = s.match(/^(\d{1,2})([A-Z]{3})(\d{2})$/); return m ? Date.UTC(2000 + +m[3], MONTHS[m[2]], +m[1], 8) : 0; };
async function optionsFor(cur) {
  const D = "https://www.deribit.com/api/v2/public";
  const [book, dv] = await Promise.all([getJson(`${D}/get_book_summary_by_currency?currency=${cur}&kind=option`), getJson(`${D}/get_volatility_index_data?currency=${cur}&start_timestamp=${Date.now() - 14 * 86400e3}&end_timestamp=${Date.now()}&resolution=3600`).catch(() => null)]);
  const rows = book.result.map((r) => { const [, e, k, t] = r.instrument_name.split("-"); return { exp: e, t: expTs(e), k: +k, put: t === "P", oi: num(r.open_interest), iv: num(r.mark_iv), spot: num(r.underlying_price), vol: num(r.volume_usd) }; }).filter((r) => r.t > Date.now());
  const spot = rows.find((r) => r.spot)?.spot || 0, sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const callOi = sum(rows.filter((r) => !r.put), (r) => r.oi), putOi = sum(rows.filter((r) => r.put), (r) => r.oi);
  const exps = [...new Set(rows.map((r) => r.exp))].map((e) => {
    const rs = rows.filter((r) => r.exp === e), F = rs[0].spot || spot, strikes = [...new Set(rs.map((r) => r.k))].sort((a, b) => a - b);
    const near = (target, put) => rs.filter((r) => r.put === put && r.iv > 0).sort((a, b) => Math.abs(a.k - target) - Math.abs(b.k - target))[0];
    const atm = near(F, false), p90 = near(F * 0.9, true), c110 = near(F * 1.1, false);
    let best = null; for (const K of strikes) { const pain = sum(rs, (r) => r.oi * Math.max(0, r.put ? r.k - K : K - r.k)); if (!best || pain < best.pain) best = { K, pain }; }
    return { exp: e, t: rs[0].t, days: (rs[0].t - Date.now()) / 86400e3, oi: sum(rs, (r) => r.oi), pcr: sum(rs.filter((r) => r.put), (r) => r.oi) / (sum(rs.filter((r) => !r.put), (r) => r.oi) || 1), atmIv: atm?.iv ?? null, skew: p90 && c110 ? p90.iv - c110.iv : null, maxPain: best?.K ?? null };
  }).sort((a, b) => a.t - b.t);
  const main = [...exps].filter((e) => e.days >= 5).sort((a, b) => b.oi - a.oi)[0] || exps[0], m30 = [...exps].sort((a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30))[0];
  const strikes = {}; for (const r of rows.filter((x) => x.exp === main.exp && x.k > spot * 0.6 && x.k < spot * 1.5)) { const s = (strikes[r.k] ??= { k: r.k, call: 0, put: 0 }); r.put ? (s.put += r.oi) : (s.call += r.oi); }
  const dvol = dv?.result?.data?.map((d) => d[4]) || [];
  return { cur, spot, callOi, putOi, pcr: putOi / (callOi || 1), oiUsd: (callOi + putOi) * spot, dvol: dvol.at(-1) ?? null, dvolChg7: dvol.length > 168 ? dvol.at(-1) - dvol.at(-169) : null, dvolSpark: downsample(dvol, 60),
    skew30: m30?.skew ?? null, iv30: m30?.atmIv ?? null, exps: exps.slice(0, 10), main: { exp: main.exp, maxPain: main.maxPain, strikes: Object.values(strikes).sort((a, b) => a.k - b.k) } };
}
export async function fetchOptions() { const r = await pool(["BTC", "ETH"], 2, optionsFor); return { at: Date.now(), list: r.filter((x) => x && !x.error) }; }

/* ---------- Calendrier économique (semaine en cours) ---------- */
export async function fetchCalendar() {
  const ev = await getJson("https://nfs.faireconomy.media/ff_calendar_thisweek.json");
  return { at: Date.now(), events: ev.map((e) => ({ title: e.title, cur: e.country, t: Date.parse(e.date), impact: e.impact, forecast: e.forecast || "", previous: e.previous || "", actual: e.actual || "" })).filter((e) => e.t).sort((a, b) => a.t - b.t) };
}

/* ---------- Peur et avidité (crypto) ---------- */
export async function fetchFng() {
  const d = (await getJson("https://api.alternative.me/fng/?limit=60")).data.map((x) => ({ v: +x.value, t: +x.timestamp * 1000, label: x.value_classification })).reverse();
  return { at: Date.now(), value: d.at(-1).v, label: d.at(-1).label, w1: d.at(-1).v - (d.at(-8)?.v ?? d[0].v), spark: d.map((x) => x.v) };
}

/* ---------- Stablecoins : la « poudre sèche » du marché crypto ---------- */
export async function fetchStable() {
  const d = (await getJson("https://stablecoins.llama.fi/stablecoincharts/all", { timeout: 60000 })).slice(-200).map((x) => [+x.date * 1000, num(x.totalCirculatingUSD?.peggedUSD)]);
  const last = d.at(-1)[1], ago = (n) => d.at(-1 - n)?.[1] ?? d[0][1];
  return { at: Date.now(), total: last, d7: last - ago(7), d30: last - ago(30), p7: last / ago(7) - 1, p30: last / ago(30) - 1, spark: downsample(d.slice(-120).map((x) => x[1]), 60) };
}

/* ---------- Attention du public : pages vues Wikipedia ---------- */
const WIKI = [["Bitcoin", "Bitcoin", "BTC"], ["Ethereum", "Ethereum", "ETH"], ["Recession", "Récession", null], ["Inflation", "Inflation", null], ["Stock_market_crash", "Krach boursier", "US_EQ"], ["Bank_run", "Panique bancaire", null], ["Gold_as_an_investment", "Or (placement)", "GOLD"], ["Federal_Reserve", "Réserve fédérale", null],
  ["Tariff", "Droits de douane", null], ["World_War_III", "Troisième Guerre mondiale", null], ["Nuclear_warfare", "Guerre nucléaire", null], ["Short_squeeze", "Short squeeze", null], ["Margin_call", "Appel de marge", null], ["Strait_of_Hormuz", "Détroit d'Ormuz", "OIL"], ["Stagflation", "Stagflation", null],
  ["Quantitative_easing", "Assouplissement quantitatif", null], ["Polymarket", "Polymarket", null], ["Sovereign_default", "Défaut souverain", null], ["Price_of_oil", "Prix du pétrole", "OIL"], ["Bear_market", "Marché baissier", null]];
const ymd = (t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");
export async function fetchWiki() {
  const a = ymd(Date.now() - 62 * 86400e3), b = ymd(Date.now() - 86400e3);
  const res = await pool(WIKI, 4, async ([art, label, topic]) => {
    const it = (await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${art}/daily/${a}/${b}`)).items.map((x) => x.views);
    const last = it.at(-1), base = it.slice(-31, -1), mean = base.reduce((s, v) => s + v, 0) / base.length, sd = Math.sqrt(base.reduce((s, v) => s + (v - mean) ** 2, 0) / base.length) || 1;
    return { art, label, topic, last, mean, z: (last - mean) / sd, ratio: last / (mean || 1), spark: it.slice(-45) };
  });
  return { at: Date.now(), items: res.filter((x) => x && !x.error).sort((x, y) => y.z - x.z) };
}

/* ---------- Classement App Store (finance, États-Unis) : thermomètre du particulier ---------- */
const APPS = [["Coinbase", /^coinbase/i], ["Robinhood", /^robinhood/i], ["Kalshi", /^kalshi/i], ["Polymarket", /^polymarket/i], ["Binance", /^binance/i], ["Crypto.com", /^crypto\.com/i], ["Kraken", /^kraken/i], ["Webull", /^webull/i], ["Phantom", /^phantom/i], ["MetaMask", /^metamask/i], ["moomoo", /^moomoo/i], ["Fidelity", /^fidelity/i], ["Schwab", /^schwab/i]];
export async function fetchApps() {
  const e = (await getJson("https://itunes.apple.com/us/rss/topfreeapplications/limit=200/genre=6015/json")).feed.entry.map((x) => x["im:name"].label);
  return { at: Date.now(), size: e.length, ranks: APPS.map(([name, re]) => { const i = e.findIndex((n) => re.test(n)); return { name, rank: i < 0 ? null : i + 1 }; }) };
}

/* ---------- Séismes majeurs (USGS) ---------- */
export async function fetchQuakes() {
  const g = await getJson("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson");
  return { at: Date.now(), list: g.features.filter((f) => f.properties.mag >= 5.5).map((f) => ({ mag: f.properties.mag, place: f.properties.place, t: f.properties.time, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], url: f.properties.url })).sort((a, b) => b.mag - a.mag).slice(0, 40) };
}

/* ---------- Banque mondiale : fiche macro par pays ---------- */
const WB = { gdpGrowth: "NY.GDP.MKTP.KD.ZG", inflation: "FP.CPI.TOTL.ZG", unemployment: "SL.UEM.TOTL.ZS", gdp: "NY.GDP.MKTP.CD", debt: "GC.DOD.TOTL.GD.ZS" };
export async function fetchWorldBank() {
  const out = {};
  await pool(Object.entries(WB), 2, async ([key, ind]) => {
    const d = await getJson(`https://api.worldbank.org/v2/country/all/indicator/${ind}?format=json&mrnev=1&per_page=400`, { timeout: 45000 });
    for (const r of d[1] || []) if (r.value != null && r.country?.id?.length === 2) (out[r.country.id] ??= {})[key] = { v: r.value, y: r.date };
  });
  return { at: Date.now(), countries: out };
}
