import { num, pool, sleep } from "./util.mjs";

/* ---------- accès limité à l'API Polymarket ----------
   Toutes les requêtes passent par une file : au plus 2 en parallèle, espacées de 200 ms. Après un refus pour débit excessif (429),
   toute la file marque une pause (Retry-After s'il est fourni, sinon délai exponentiel) avant de reprendre. */
const LIM = { max: 2, gap: 200, active: 0, last: 0, cool: 0, q: [] };
const UA = process.env.HTTP_USER_AGENT || "WhaleCompass/0.5 (tableau de bord personnel ; données publiques)";
async function one(url, tries) {
  let last;
  for (let a = 0; a < tries; a++) {
    const wait = Math.max(LIM.cool - Date.now(), LIM.last + LIM.gap - Date.now()); if (wait > 0) await sleep(wait); LIM.last = Date.now();
    try {
      const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      if (r.status === 429 || r.status >= 500) { const ra = Number(r.headers.get("retry-after")), d = (ra > 0 ? Math.min(ra, 60) * 1000 : Math.min(30000, 1500 * 2 ** a)) + Math.random() * 400; if (r.status === 429) LIM.cool = Date.now() + d; last = new Error(`HTTP ${r.status}`); last.status = r.status; if (a < tries - 1) await sleep(d); continue; }
      if (!r.ok) { const e = new Error(`HTTP ${r.status} ${url}`); e.status = r.status; throw e; }
      return await r.json();
    } catch (e) { last = e; if (e.status && e.status < 500 && e.status !== 429) break; if (a < tries - 1) await sleep(700 * 2 ** a); }
  }
  throw last;
}
function pump() { while (LIM.active < LIM.max && LIM.q.length) { const j = LIM.q.shift(); LIM.active++; one(j.url, j.tries).then(j.resolve, j.reject).finally(() => { LIM.active--; pump(); }); } }
const fetchJson = (url, _opts, tries = 3) => new Promise((resolve, reject) => { LIM.q.push({ url, tries, resolve, reject }); pump(); });
import { pmTopic, marketDirection, pmCategory } from "./topics.mjs";

const B = "https://data-api.polymarket.com/v2";
export const PERIODS = ["DAY", "WEEK", "MONTH", "ALL"];
export const CATEGORIES = ["OVERALL", "SPORTS", "POLITICS", "CRYPTO", "FINANCE"];

export async function leaderboard(period, category, limit = 50) {
  const q = new URLSearchParams({ timePeriod: period, orderBy: "PNL", limit: String(limit) });
  if (category !== "OVERALL") q.set("category", category);
  const d = await fetchJson(`${B}/leaderboard?${q}`, {}, 3);
  return (d.data || []).map((r) => ({
    addr: r.user_id, name: r.user_name, pnl: num(r.pnl), vol: num(r.volume),
    x: r.x_username || null, verified: !!r.verified,
  }));
}

export async function fetchBoards() {
  const jobs = [];
  for (const c of CATEGORIES) for (const p of PERIODS) jobs.push([c, p]);
  const res = await pool(jobs, 5, ([c, p]) => leaderboard(p, c, 50));
  const boards = {};
  jobs.forEach(([c, p], i) => { (boards[c] ??= {})[p] = Array.isArray(res[i]) ? res[i] : []; });
  return boards;
}

// Cohorte de baleines : top PnL du mois par catégorie (dédoublonné)
export function buildCohort(boards, perCat = 35) {
  const map = new Map();
  for (const c of ["SPORTS", "POLITICS", "CRYPTO", "FINANCE"]) {
    (boards[c]?.MONTH || []).slice(0, perCat).forEach((w, i) => {
      const e = map.get(w.addr) || { addr: w.addr, name: w.name, x: w.x, cats: new Set(), pnlMonth: 0 };
      e.cats.add(c.toLowerCase()); e.pnlMonth = Math.max(e.pnlMonth, w.pnl); map.set(w.addr, e);
    });
  }
  return [...map.values()].map((e) => ({ ...e, cats: [...e.cats] }));
}

// Positions OUVERTES d'un portefeuille (proxy wallet), triées par valeur, avec pagination.
// Sans status=OPEN, l'API renvoie d'abord les positions déjà résolues : les comptes très actifs paraissaient vides.
export async function fetchPositions(addr, maxPages = 3) {
  const a = String(addr).toLowerCase(), rows = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page++) {   // pagination par curseur (l'API refuse « offset »)
    const d = await fetchJson(`${B}/positions?user=${a}&limit=100&status=OPEN&sortBy=CURRENT_VALUE&sortDirection=DESC${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`, {}, 2);
    rows.push(...(d.data || []));
    cursor = d.pagination?.has_more ? d.pagination.next_cursor : ""; if (!cursor) break;
  }
  const seen = new Set();
  return rows.filter((p) => { const k = p.token_id; if (seen.has(k)) return false; seen.add(k); return true; }).map((p) => {
    const topic = pmTopic(p.title), dir = marketDirection(p.title), out = (p.outcome || "").toLowerCase();
    let view = null; // +1 = vision haussière du sous-jacent, -1 = baissière
    if (topic) {
      if (out === "up") view = 1; else if (out === "down") view = -1;
      else if (dir && (out === "yes" || out === "no")) view = (dir === "up") === (out === "yes") ? 1 : -1;
    }
    return {
      title: p.title, slug: p.event_slug, outcome: p.outcome, oi: p.outcome_index, price: num(p.current_price), avg: num(p.avg_price), size: num(p.current_size),
      value: num(p.current_value), cost: num(p.total_cost_usdc), pnl: num(p.total_pnl), upnl: num(p.unrealized_pnl), rpnl: num(p.realized_pnl), end: p.end_date || null,
      cid: p.condition_id, token: p.token_id ? String(p.token_id) : null, category: pmCategory(p.title), topic, view,   // token : nécessaire pour lire le carnet CLOB
    };
  });
}

// Relevé de toute la cohorte. En cas d'échec (limite de débit, coupure), on GARDE les dernières positions connues
// au lieu d'afficher un portefeuille vide : c'était une des causes des comptes « à 0 position ».
export async function refreshPositions(cohort, prev = [], conc = 3) {
  const old = new Map(prev.map((w) => [w.addr, w]));
  let streak = 0;   // coupe-circuit : après 6 échecs d'affilée (limite de débit), on arrête et on réessaiera au prochain cycle
  const res = await pool(cohort, conc, async (w) => { if (streak >= 6) throw new Error("relevé interrompu (limite de débit)"); try { const r = await fetchPositions(w.addr, 1); streak = 0; return r; /* 1 page = les 100 plus grosses positions, triées par valeur : une requête par compte */ } catch (e) { streak++; throw e; } });
  return res.map((r, i) => { const ok = Array.isArray(r), o = old.get(cohort[i].addr);
    return { ...cohort[i], positions: ok ? r : o?.positions || [], error: !ok && !o?.positions?.length, stale: !ok && !!o?.positions?.length, at: ok ? Date.now() : o?.at || null }; });
}

// Marchés où plusieurs baleines sont positionnées : consensus par marché
export function crowdedMarkets(whales, minWhales = 3) {
  const m = new Map();
  for (const w of whales) for (const p of w.positions) {
    if (p.value < 1000 || p.price <= 0.03 || p.price >= 0.97) continue;
    const e = m.get(p.cid) || { title: p.title, slug: p.slug, category: p.category, topic: p.topic, outcomes: {}, whales: new Set(), total: 0 };
    const o = (e.outcomes[p.outcome] ??= { n: 0, value: 0, price: p.price });
    o.n++; o.value += p.value; e.total += p.value; e.whales.add(w.addr);
    m.set(p.cid, e);
  }
  return [...m.values()].filter((e) => e.whales.size >= minWhales).map((e) => {
    const list = Object.entries(e.outcomes).map(([name, v]) => ({ name, ...v })).sort((a, b) => b.value - a.value);
    const n = list.reduce((s, o) => s + o.n, 0);
    return { title: e.title, slug: e.slug, category: e.category, topic: e.topic, whales: e.whales.size, total: e.total,
             top: list[0].name, topShare: list[0].n / n, outcomes: list };
  }).sort((a, b) => b.total - a.total).slice(0, 60);
}

export function diffWhales(prev, next, minValue = 5000) {
  const ev = [], pm = new Map(prev.map((w) => [w.addr, w]));
  for (const w of next) {
    const b = pm.get(w.addr); if (!b || w.error || b.error || !b.positions.length) continue;
    const key = (p) => p.cid + "|" + p.outcome, before = new Map(b.positions.map((p) => [key(p), p])), after = new Map(w.positions.map((p) => [key(p), p]));
    for (const [k, p] of after) {
      const o = before.get(k);
      if (!o && p.value >= minValue) ev.push({ kind: "open", addr: w.addr, notional: p.value, delta: p.value, title: p.title, slug: p.slug, outcome: p.outcome, price: p.price, topic: p.topic, view: p.view, category: p.category, cid: p.cid, token: p.token, avg: p.avg });
      else if (o && Math.abs(p.value - o.value) >= minValue * 2 && Math.abs(p.cost / (o.cost || 1) - 1) >= 0.2) ev.push({ kind: p.cost > o.cost ? "add" : "reduce", addr: w.addr, notional: p.value, delta: p.cost - o.cost, title: p.title, slug: p.slug, outcome: p.outcome, price: p.price, topic: p.topic, view: p.view, category: p.category, cid: p.cid, token: p.token, avg: p.avg });
    }
    if ((b.nAll ?? b.positions.length) < 100) for (const [k, o] of before) if (!after.has(k) && o.value >= minValue * 2) ev.push({ kind: "close", addr: w.addr, notional: o.value, delta: -o.value, title: o.title, slug: o.slug, outcome: o.outcome, price: o.price, topic: o.topic, view: o.view, category: o.category, cid: o.cid, token: o.token, avg: o.avg });
  }
  return ev;
}

// ---- agent de paper trading : carnet d'ordres et résolutions (clob.polymarket.com, lecture seule) ----
const CLOB = "https://clob.polymarket.com";

// Carnet : { bids: [[px, sz]…] du meilleur au pire, asks: idem }. Le CLOB ne garantit pas l'ordre des niveaux : on trie.
export function normalizePmBook(raw) {
  const side = (lv) => (lv || []).map((x) => [num(x.price), num(x.size)]).filter(([p, s]) => p > 0 && p < 1 && s > 0);
  return { t: num(raw?.timestamp) || Date.now(), bids: side(raw?.bids).sort((a, b) => b[0] - a[0]), asks: side(raw?.asks).sort((a, b) => a[0] - b[0]),
           tick: num(raw?.tick_size) || null, minSize: num(raw?.min_order_size) || null };
}
export async function fetchBook(token) { return { token: String(token), ...normalizePmBook(await fetchJson(`${CLOB}/book?token_id=${encodeURIComponent(token)}`, {}, 3)) }; }

// État d'un marché : fermé ou non, et jeton gagnant une fois résolu (paiement 1 $ par part gagnante, 0 $ sinon).
export function normalizeResolution(raw) {
  const tokens = (raw?.tokens || []).map((t) => ({ token: String(t.token_id), outcome: t.outcome, price: num(t.price), winner: !!t.winner }));
  const win = tokens.find((t) => t.winner) || null;
  return { cid: raw?.condition_id || null, closed: !!raw?.closed, resolved: !!win, winner: win ? { token: win.token, outcome: win.outcome } : null,
           end: raw?.end_date_iso || null, tokens };
}
export async function fetchResolution(cid) { return normalizeResolution(await fetchJson(`${CLOB}/markets/${encodeURIComponent(cid)}`, {}, 3)); }

// Paiement à la résolution d'une part du jeton `token` : 1, 0, ou null si pas encore résolu.
export const payoutOf = (res, token) => (res?.resolved ? (res.winner.token === String(token) ? 1 : 0) : null);

// ---- intitulé lisible d'un marché (gamma-api.polymarket.com, lecture seule) ----
// Le relevé des baleines donne déjà titre, échéance et slug d'événement ; Gamma sert de rattrapage pour un conditionId inconnu.
const GAMMA = "https://gamma-api.polymarket.com";
export const pmEventUrl = (slug) => (slug ? `https://polymarket.com/event/${encodeURIComponent(slug)}` : null);
export function normalizeGammaMarket(raw) {
  const m = Array.isArray(raw) ? raw[0] : raw;
  if (!m?.conditionId && !m?.question) return null;
  const slug = m.events?.[0]?.slug || m.slug || null;   // l'URL publique est celle de l'événement
  return { cid: m.conditionId || null, title: m.question || m.events?.[0]?.title || null, endDate: m.endDate || m.endDateIso || null, slug, url: pmEventUrl(slug) };
}
export async function fetchGammaMarket(cid) {
  const q = `${GAMMA}/markets?condition_ids=${encodeURIComponent(cid)}`;
  // Gamma peut écarter les marchés fermés de la réponse par défaut : second essai avec closed=true
  return normalizeGammaMarket(await fetchJson(q, {}, 2)) ?? normalizeGammaMarket(await fetchJson(q + "&closed=true", {}, 2));
}
