import http from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import * as hl from "./lib/hl.mjs";
import * as pm from "./lib/pm.mjs";
import { hlByTopic, pmByTopic, crossSentiment, coinBoard } from "./lib/sentiment.mjs";
import { TOPIC_COIN } from "./lib/topics.mjs";
import { fetchMacro } from "./lib/macro.mjs";
import * as alt from "./lib/alt.mjs";
import * as news from "./lib/news.mjs";
import { fetchOdds } from "./lib/odds.mjs";
import { CONFLICTS, WATCH, COUNTRIES } from "./lib/world.mjs";
import { directions, edgeSignals } from "./lib/synth.mjs";
import { pool } from "./lib/util.mjs";
import { PUBLIC_PAPER_FILES } from "./lib/paper/store.mjs";

const PORT = Number(process.env.PORT || 8787);
const COHORT_SIZE = Number(process.env.HL_COHORT || 100);
const SCALE = Number(process.env.REFRESH_SCALE || 1);   // 0.5 = deux fois plus vite
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");

const state = {
  updatedAt: null, startedAt: Date.now(),
  hl: { lbAt: null, posAt: null, mkAt: null, eligible: 0, total: 0, top: {}, cohort: [], accounts: [], markets: {} },
  pm: { boardsAt: null, posAt: null, boards: {}, whales: [], crowded: [] },
  sentiment: [], events: [], history: [], errors: {}, x: {}, appsHist: [], dirs: [], edge: [],
};
const clients = new Set();
let lastBroadcast = 0, bTimer = null;

/* ---------- persistance légère (historique et flux survivent à un redémarrage) ---------- */
async function loadDisk() {
  try {
    const last = JSON.parse(await readFile(path.join(DATA, "last.json"), "utf8"));
    if (Date.now() - last.at < 6 * 3600e3) { state.hl.accounts = last.hl || []; state.pm.whales = last.pm || []; }
  } catch {}
  for (const k of ["history", "events", "appsHist"]) {
    try { state[k] = JSON.parse(await readFile(path.join(DATA, k + ".json"), "utf8")); } catch {}
  }
}
let saving = false;
async function saveDisk() {
  if (saving) return; saving = true;
  try { await mkdir(DATA, { recursive: true }); for (const k of ["history", "events", "appsHist"]) await writeFile(path.join(DATA, k + ".json"), JSON.stringify(state[k]));
    const slimPm = state.pm.whales.map((w) => ({ addr: w.addr, name: w.name, nAll: w.positions.length, at: w.at || null, positions: w.positions.filter((p) => p.value >= 1).slice(0, 60) }));
    await writeFile(path.join(DATA, "last.json"), JSON.stringify({ at: Date.now(), hl: state.hl.accounts.filter((a) => !a.error), pm: slimPm.filter((w) => w.positions.length) })); }
  catch (e) { console.error("sauvegarde", e.message); } finally { saving = false; }
}

/* ---------- calculs dérivés ---------- */
function globalIndex(sent) {
  let num_ = 0, den = 0;
  for (const s of sent) { const n = (s.hl ? s.hl.nLong + s.hl.nShort : 0) + (s.pm ? s.pm.nBull + s.pm.nBear : 0), w = Math.min(1, n / 10); num_ += s.score * w; den += w; }
  return den ? num_ / den : 0;
}
function recompute() {
  const accounts = state.hl.accounts;
  const roiOf = new Map(state.hl.cohort.map((c) => [c.addr, c.month.roi]));
  const ranked = [...accounts].filter((a) => !a.error).sort((a, b) => (roiOf.get(b.addr) ?? 0) - (roiOf.get(a.addr) ?? 0));
  const elite = hlByTopic(ranked.slice(0, 20)), crowd = hlByTopic(ranked.slice(20));
  state.sentiment = crossSentiment(hlByTopic(accounts), pmByTopic(state.pm.whales)).map((s) => ({
    ...s, coin: TOPIC_COIN[s.topic] || null,
    elite: elite[s.topic] ? { nLong: elite[s.topic].nLong, nShort: elite[s.topic].nShort, score: elite[s.topic].score } : null,
    crowd: crowd[s.topic] ? { nLong: crowd[s.topic].nLong, nShort: crowd[s.topic].nShort, score: crowd[s.topic].score } : null,
  }));
  state.pm.crowded = pm.crowdedMarkets(state.pm.whales);
  state.liq = hl.liquidationMap(accounts.filter((a) => !a.error), state.hl.markets);
  state.gIndex = globalIndex(state.sentiment);
  const X = state.x, appsPrev = state.appsHist.find((a) => Date.now() - a.at >= 5 * 86400e3 - 3600e3) && [...state.appsHist].reverse().find((a) => Date.now() - a.at >= 5 * 86400e3 - 3600e3);
  state.dirs = directions({ candles: X.candles, sentiment: state.sentiment, cot: X.cot, macro: X.macro, options: X.options, markets: state.hl.markets });
  state.edge = edgeSignals({ sentiment: state.sentiment, cot: X.cot, macro: X.macro, options: X.options, fng: X.fng, stable: X.stable, wiki: X.wiki, apps: X.apps, appsPrev, odds: X.odds, liq: state.liq, markets: state.hl.markets, coins: coinBoard(accounts), dirs: state.dirs });
  const last = state.history.at(-1);
  if (state.sentiment.length && (!last || Date.now() - last.t >= 60_000)) {
    state.history.push({ t: Date.now(), g: state.gIndex, s: Object.fromEntries(state.sentiment.map((s) => [s.topic, +s.score.toFixed(3)])) });
    if (state.history.length > 2880) state.history.shift();
  }
}

function publicState() {
  const held = new Set(state.hl.accounts.flatMap((a) => a.positions.map((p) => p.coin)));
  const topicCoins = new Set(Object.values(TOPIC_COIN));
  const markets = Object.values(state.hl.markets).filter((m) => held.has(m.coin) || topicCoins.has(m.coin) || m.oi >= 3e6);
  return {
    updatedAt: state.updatedAt, startedAt: state.startedAt, errors: state.errors, sentiment: state.sentiment, gIndex: state.gIndex ?? 0,
    events: state.events.slice(0, 500), history: state.history, liq: state.liq || [], dirs: state.dirs, edge: state.edge,
    x: { ...state.x, appsHist: state.appsHist.slice(-60), conflicts: CONFLICTS.map((c) => ({ ...c, news: state.x.conflictNews?.[c.id] || [] })), conflictNews: undefined, xAccounts: news.X_ACCOUNTS, watch: WATCH },
    hl: { lbAt: state.hl.lbAt, posAt: state.hl.posAt, mkAt: state.hl.mkAt, eligible: state.hl.eligible, total: state.hl.total, top: state.hl.top,
      markets, coins: coinBoard(state.hl.accounts),
      accounts: state.hl.accounts.map((a) => {
        const c = state.hl.cohort.find((x) => x.addr === a.addr) || {};
        return { addr: a.addr, name: c.name, equity: a.equity || c.equity, month: c.month, week: c.week, day: c.day, allTime: c.allTime,
          longN: a.longN, shortN: a.shortN, positions: a.positions.slice(0, 15), nPositions: a.positions.length, error: a.error || false };
      }) },
    pm: { boardsAt: state.pm.boardsAt, posAt: state.pm.posAt, boards: state.pm.boards, crowded: state.pm.crowded,
      whales: state.pm.whales.map((w) => ({ addr: w.addr, name: w.name, x: w.x, cats: w.cats, pnlMonth: w.pnlMonth,
        total: w.positions.reduce((s, p) => s + p.value, 0), nPositions: w.positions.length, nActive: w.positions.filter((p) => p.value >= 1).length, positions: w.positions.slice(0, 40), error: w.error, stale: w.stale || false })) },
  };
}

function push() {
  state.updatedAt = Date.now();
  try { recompute(); } catch (e) { console.error("recompute", e); }
  const wait = Math.max(0, 4000 - (Date.now() - lastBroadcast));
  clearTimeout(bTimer);
  bTimer = setTimeout(() => {
    lastBroadcast = Date.now();
    if (!clients.size) return;
    const data = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
    for (const c of clients) c.write(data);
  }, wait);
}

async function guarded(key, fn) {
  try { await fn(); delete state.errors[key]; } catch (e) { state.errors[key] = String(e.message || e); console.error(key, e.message || e); }
  push();
}

const nameOf = (list, addr) => list.find((x) => x.addr === addr)?.name || null;
function addEvents(src, evs, list) {
  const t = Date.now();
  for (const e of evs) state.events.unshift({ ...e, t, src, name: nameOf(list, e.addr) });
  if (state.events.length > 800) state.events.length = 800;
}

const loops = {
  async hlLeaderboard() {
    const rows = await hl.fetchLeaderboard();
    const { cohort, eligible } = hl.selectCohort(rows, COHORT_SIZE);
    Object.assign(state.hl, { lbAt: Date.now(), total: rows.length, eligible, top: hl.topByPnl(rows, 50), cohort });
  },
  async hlPositions() {
    if (!state.hl.cohort.length) return;
    const prev = state.hl.accounts, next = await hl.refreshPositions(state.hl.cohort);
    if (prev.length) addEvents("hl", hl.diffAccounts(prev, next), state.hl.cohort);
    state.hl.accounts = next; state.hl.posAt = Date.now();
  },
  async hlMarkets() { state.hl.markets = await hl.fetchMarkets(); state.hl.mkAt = Date.now(); },
  async pmBoards() {
    state.pm.boards = await pm.fetchBoards(); state.pm.boardsAt = Date.now();
    const cohort = pm.buildCohort(state.pm.boards), have = new Map(state.pm.whales.map((w) => [w.addr, w]));
    state.pm.cohortList = cohort;
    state.pm.whales = cohort.map((c) => (have.get(c.addr) ? { ...have.get(c.addr), ...c } : { ...c, positions: [] }));
  },
  async pmPositions() {
    if (!state.pm.cohortList?.length) return;
    const prev = state.pm.whales, next = await pm.refreshPositions(state.pm.cohortList, prev);
    if (prev.some((w) => w.positions.length)) addEvents("pm", pm.diffWhales(prev, next), next);
    state.pm.whales = next; state.pm.posAt = Date.now();
  },
};

async function boot() {
  await loadDisk();
  console.log("Chargement initial…");
  await Promise.all([guarded("hlLeaderboard", loops.hlLeaderboard), guarded("pmBoards", loops.pmBoards), guarded("hlMarkets", loops.hlMarkets)]);
  await Promise.all([guarded("hlPositions", loops.hlPositions), guarded("pmPositions", loops.pmPositions)]);
  console.log("Prêt.", state.hl.accounts.length, "comptes HL,", state.pm.whales.length, "baleines Polymarket");
  const every = (name, s) => setInterval(() => guarded(name, loops[name]), s * 1000 * SCALE);
  every("hlLeaderboard", 120); every("pmBoards", 90); every("hlPositions", 45); every("pmPositions", 150); every("hlMarkets", 15);
  loadExtras(false).then(() => console.log("Sources complémentaires chargées :", Object.keys(state.x).length, "sur", Object.keys(EXTRA).length));
  for (const [k, [, sec]] of Object.entries(EXTRA)) setInterval(() => extra(k), sec * 1000 * SCALE);
  setInterval(saveDisk, 300_000);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await saveDisk(); process.exit(0); });
}

/* ---------- sources complémentaires : macro, institutionnel, actualité, données alternatives ---------- */
const MIN = 60;
const EXTRA = {
  odds: [fetchOdds, 2 * MIN, true], wire: [news.fetchWire, 3 * MIN, true], social: [news.fetchSocial, 2 * MIN, true], options: [alt.fetchOptions, 5 * MIN, true], quakes: [alt.fetchQuakes, 15 * MIN, true],
  calendar: [alt.fetchCalendar, 60 * MIN], fng: [alt.fetchFng, 60 * MIN], candles: [hl.fetchCandles, 60 * MIN], macro: [fetchMacro, 360 * MIN], cot: [alt.fetchCot, 720 * MIN], stable: [alt.fetchStable, 360 * MIN],
  wiki: [alt.fetchWiki, 360 * MIN], wb: [alt.fetchWorldBank, 1440 * MIN], countryNews: [() => news.fetchCountries(WATCH), 30 * MIN],
  conflictNews: [async () => { const r = await pool(CONFLICTS, 3, (c) => news.fetchQuery(c.q)); return Object.fromEntries(CONFLICTS.map((c, i) => [c.id, Array.isArray(r[i]) ? r[i] : []])); }, 30 * MIN],
  apps: [async () => { const a = await alt.fetchApps(); const last = state.appsHist.at(-1); if (!last || Date.now() - last.at >= 20 * 3600e3) { state.appsHist.push(a); if (state.appsHist.length > 120) state.appsHist.shift(); } return a; }, 360 * MIN],
};
const extra = (k) => guarded("x." + k, async () => { state.x[k] = await EXTRA[k][0](); });
const loadExtras = (fastOnly) => Promise.all(Object.keys(EXTRA).filter((k) => !fastOnly || EXTRA[k][2]).map(extra));

/* ---------- actualisation manuelle (bouton « Actualiser ») ---------- */
let refreshing = null, lastRefresh = 0;
async function refreshAll(full = false) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const ex = loadExtras(!full && Object.keys(state.x).length > 8);
    await Promise.all([guarded("hlMarkets", loops.hlMarkets), guarded("hlLeaderboard", loops.hlLeaderboard), guarded("pmBoards", loops.pmBoards)]);
    await Promise.all([guarded("hlPositions", loops.hlPositions), guarded("pmPositions", loops.pmPositions)]);
    await ex; lastRefresh = Date.now();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json" };
const cache = new Map();
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/state") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(publicState())); }
  if (url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res); req.on("close", () => clients.delete(res)); return;
  }
  if (url.pathname === "/api/refresh" && req.method === "POST") {
    if (!refreshing && Date.now() - lastRefresh < 5000) { res.writeHead(429, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "trop tôt", retryIn: 5000 - (Date.now() - lastRefresh) })); }
    await refreshAll();
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(publicState()));
  }
  if (url.pathname === "/api/country") {
    const iso = (url.searchParams.get("iso") || "").toUpperCase();
    if (!COUNTRIES[iso]) { res.writeHead(400); return res.end("bad iso"); }
    const hit = cache.get("c:" + iso);
    const data = hit && Date.now() - hit.t < 600_000 ? hit.d : await news.fetchCountry(iso).catch(() => null);
    if (data) cache.set("c:" + iso, { t: Date.now(), d: data });
    res.writeHead(data ? 200 : 502, { "content-type": "application/json" }); return res.end(JSON.stringify(data));
  }
  if (url.pathname === "/api/hl/account") {
    const addr = url.searchParams.get("addr") || "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) { res.writeHead(400); return res.end("bad addr"); }
    const hit = cache.get(addr);
    const data = hit && Date.now() - hit.t < 30_000 ? hit.d : await hl.fetchPositions(addr).catch(() => null);
    if (data) cache.set(addr, { t: Date.now(), d: data });
    res.writeHead(data ? 200 : 502, { "content-type": "application/json" }); return res.end(JSON.stringify(data));
  }
  // agent de paper trading : fichiers de data/paper (liste fermée), lus par la page « Paper trading »
  if (url.pathname.startsWith("/api/paper/")) {
    const name = url.pathname.slice(11);
    if (!PUBLIC_PAPER_FILES.includes(name)) { res.writeHead(404); return res.end("not found"); }
    try { const b = await readFile(path.join(DATA, "paper", name)); res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "application/x-ndjson", "cache-control": "no-cache" }); return res.end(b); }
    catch { res.writeHead(404); return res.end("not found"); }
  }
  const file = url.pathname === "/" ? "/index.html" : url.pathname;
  const full = path.join(ROOT, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(path.join(ROOT, "public"))) { res.writeHead(403); return res.end(); }
  try { const b = await readFile(full); res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream", "cache-control": "no-cache" }); res.end(b); }
  catch { res.writeHead(404); res.end("not found"); }
});
if (import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(PORT, () => { console.log(`Boussole des baleines : http://localhost:${PORT}`); boot(); });

export { state, publicState, loops, guarded, push, loadDisk, refreshAll, saveDisk };
