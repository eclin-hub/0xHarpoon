"use strict";
/* PMApi — accès fiabilisé à l'API publique Polymarket (data-api v2 ; la v1 sans préfixe a été retirée par Polymarket).
   - file d'attente : au plus 2 requêtes simultanées, espacées, avec priorité (un clic de l'utilisateur passe devant le reste) ;
   - reprise automatique avec délai exponentiel et aléa ; l'en-tête Retry-After est respecté ; après une limite de débit, toute la file marque une pause ;
   - cache mémoire « stale-while-revalidate » : une réponse de moins de 45 s est servie telle quelle, une réponse plus ancienne est servie
     tout de suite puis rafraîchie en arrière-plan ;
   - mémoire locale des 15 plus grosses positions de chaque profil consulté, pour ne jamais afficher un compte vide après une coupure. */
const PMApi = (() => {
  const API = "https://data-api.polymarket.com/v2", GAMMA = "https://gamma-api.polymarket.com", MAXC = 2, GAP = 180, TTL = 45000, STALE = 30 * 60e3;
  const q = [], cache = new Map(), st = { ok: 0, retried: 0, limited: 0, failed: 0, lastOk: 0, lastErr: null }; let active = 0, coolUntil = 0, lastStart = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  async function exec(job) {
    let last;
    for (let a = 0; a < 4; a++) {
      const wait = Math.max(coolUntil - Date.now(), lastStart + GAP - Date.now()); if (wait > 0) await sleep(wait); lastStart = Date.now();
      try {
        const r = await fetch(job.url);
        if (r.status === 429 || r.status >= 500) { const ra = Number(r.headers.get("retry-after")), d = (ra > 0 ? Math.min(ra, 60) * 1000 : Math.min(30000, 1500 * 2 ** a)) + Math.random() * 400; if (r.status === 429) { st.limited++; coolUntil = Date.now() + d; } st.retried++; last = new Error("HTTP " + r.status); last.status = r.status; if (a < 3) await sleep(d); continue; }
        if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
        const d = await r.json(); st.ok++; st.lastOk = Date.now(); return d;
      } catch (e) { last = e; if (e.status && e.status < 500 && e.status !== 429) break; st.retried++; if (a < 3) await sleep(700 * 2 ** a + Math.random() * 300); }
    }
    st.failed++; st.lastErr = { at: Date.now(), msg: last?.message || "échec réseau", limited: last?.status === 429 }; throw last;
  }
  function pump() { while (active < MAXC && q.length) { const job = q.shift(); active++; exec(job).then(job.resolve, job.reject).finally(() => { active--; pump(); }); } }
  // prio : true = action de l'utilisateur (tête de file)
  function raw(url, prio) { return new Promise((resolve, reject) => { const job = { url, resolve, reject }; prio ? q.unshift(job) : q.push(job); pump(); }); }
  // stale-while-revalidate ; onFresh(data) est appelé quand une version plus récente arrive après coup
  function swr(key, url, { ttl = TTL, prio = false, onFresh, map = (d) => d } = {}) {
    const c = cache.get(key), now = Date.now();
    const refresh = () => { if (c?.pending) return c.pending; const pnd = raw(url, prio).then((d) => { const v = map(d); cache.set(key, { at: Date.now(), data: v }); return v; }).catch((e) => { const cur = cache.get(key); if (cur) delete cur.pending; throw e; }); cache.set(key, { ...(c || {}), pending: pnd }); return pnd; };
    if (c?.data !== undefined && now - c.at < ttl) return Promise.resolve({ data: c.data, at: c.at, from: "cache" });
    if (c?.data !== undefined && now - c.at < STALE) { refresh().then((v) => onFresh && onFresh({ data: v, at: Date.now(), from: "direct" })).catch(() => {}); return Promise.resolve({ data: c.data, at: c.at, from: "cache ancien" }); }
    return refresh().then((v) => ({ data: v, at: Date.now(), from: "direct" }));
  }
  const mapPos = (p) => ({ title: p.title, slug: p.event_slug, outcome: p.outcome, oi: p.outcome_index, cid: p.condition_id, token: p.token_id, size: num(p.current_size), avg: num(p.avg_price), price: num(p.current_price), value: num(p.current_value), cost: num(p.total_cost_usdc), upnl: num(p.unrealized_pnl), rpnl: num(p.realized_pnl), pnl: num(p.total_pnl), pct: num(p.percent_pnl) / 100, end: p.end_date });
  const posUrl = (a, limit, status, cursor) => `${API}/positions?user=${a}&limit=${limit}&status=${status}&sortBy=CURRENT_VALUE&sortDirection=DESC${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`;

  /* ---------- mémoire locale des plus grosses positions ---------- */
  const LS = "wc-pm-top"; let store = {}; try { store = JSON.parse(localStorage.getItem(LS) || "{}"); } catch {}
  function remember(a, rows) { store[a] = { at: Date.now(), rows: rows.slice(0, 15) }; const ks = Object.keys(store); if (ks.length > 120) for (const k of ks.sort((x, y) => store[x].at - store[y].at).slice(0, ks.length - 120)) delete store[k]; try { localStorage.setItem(LS, JSON.stringify(store)); } catch {} }
  const remembered = (addr) => store[addr.toLowerCase()] || null;

  // Les n plus grosses positions ouvertes : UNE requête, triée et limitée côté serveur.
  function top(addr, n = 15, o = {}) { const a = addr.toLowerCase(); return swr("top:" + a, posUrl(a, Math.max(n, 15), "OPEN"), { prio: true, ...o, map: (d) => { const rows = (d.data || []).map(mapPos); if (rows.length) remember(a, rows); return { rows, more: !!d.pagination?.has_more, cursor: d.pagination?.next_cursor || "" }; } }); }
  // Suite des positions (pages suivantes), en basse priorité
  async function rest(addr, cursor, maxPages = 4) { const a = addr.toLowerCase(), rows = []; let c = cursor; for (let i = 0; i < maxPages && c; i++) { const d = await raw(posUrl(a, 100, "OPEN", c), false); rows.push(...(d.data || []).map(mapPos)); c = d.pagination?.has_more ? d.pagination.next_cursor : ""; } return { rows, more: !!c }; }
  const resolved = (addr) => swr("res:" + addr.toLowerCase(), posUrl(addr.toLowerCase(), 100, "REDEEMABLE"), { ttl: 5 * 60e3, map: (d) => (d.data || []).map(mapPos) });
  const value = (addr) => swr("val:" + addr.toLowerCase(), `${API}/value?user=${addr.toLowerCase()}`, { map: (d) => d?.data?.value ?? null });
  const activity = (addr, o = {}) => swr("act:" + addr.toLowerCase(), `${API}/activity?user=${addr.toLowerCase()}&limit=100`, { ...o, map: (d) => (d.data || []).map((x) => ({ t: num(x.timestamp) * 1000, type: x.type, side: x.side, usdc: num(x.usdc_size), size: num(x.size), price: num(x.price), title: x.title, outcome: x.outcome, slug: x.event_slug, tx: x.transaction_hash, pseudo: x.pseudonym || null })) });
  // Transactions récentes de tout Polymarket au-dessus d'un montant : une seule requête pour le « tape »
  const trades = (minUsd = 10000, limit = 100) => raw(`${API}/trades?limit=${limit}&filterType=CASH&filterAmount=${minUsd}`, false).then((d) => (d.data || []).map((x) => ({ t: num(x.timestamp) * 1000, addr: (x.proxy_wallet || "").toLowerCase(), name: x.name && !/^0x/i.test(x.name) ? x.name : x.pseudonym || null, side: x.side, outcome: x.outcome, oi: x.outcome_index, title: x.title, slug: x.event_slug, cid: x.condition_id, token: x.token_id, price: num(x.price), size: num(x.size), usd: num(x.size) * num(x.price), tx: x.transaction_hash })));
  const dayChange = (cids) => raw(`${GAMMA}/markets?limit=100&${cids.map((c) => "condition_ids=" + c).join("&")}`, false).then((ms) => Object.fromEntries(ms.map((m) => [m.conditionId, num(m.oneDayPriceChange)])));
  const status = () => ({ queued: q.length, active, cooling: Math.max(0, coolUntil - Date.now()), ...st });
  return { top, rest, resolved, value, activity, trades, dayChange, remembered, status, raw };
})();
