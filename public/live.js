"use strict";
/* Mode « site en ligne » (GitHub Pages) : la page interroge elle-même Hyperliquid, sans serveur.
   - prix, funding, open interest : toutes les 20 s
   - positions des comptes de l'échantillon : toutes les 45 s, avec détection des mouvements
   - à l'ouverture : comparaison avec la dernière collecte GitHub (positions.json) pour montrer ce qui a bougé depuis
   Les analyses lentes (macro, hedge funds, options, actualités, sentiment, directions) restent celles de la collecte GitHub. */
const Live = (() => {
  const INFO = "https://api.hyperliquid.xyz/info", DEXES = [null, "xyz"], MIN_EV = 250000;
  const L = { markets: null, mkAt: 0, acc: new Map(), posAt: 0, events: [], prev: null, base: null, running: false, fails: 0 };
  const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
  const post = async (body) => { const r = await fetch(INFO, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
  async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } } })); return out; }

  async function markets() {
    const out = {};
    for (const dex of DEXES) {
      const [meta, ctx] = await post({ type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) });
      meta.universe.forEach((u, i) => { const c = ctx[i]; if (!c || u.isDelisted) return; const mark = num(c.markPx), prev = num(c.prevDayPx);
        out[u.name] = { coin: u.name, mark, prev, chg: prev ? mark / prev - 1 : 0, funding: num(c.funding), oi: num(c.openInterest) * mark, vol: num(c.dayNtlVlm), premium: num(c.premium), maxLev: u.maxLeverage }; });
    }
    L.markets = out; L.mkAt = Date.now();
  }
  async function account(addr) {
    const positions = []; let equity = 0;
    for (const dex of DEXES) {
      const s = await post({ type: "clearinghouseState", user: addr, ...(dex ? { dex } : {}) }); equity += num(s.marginSummary?.accountValue);
      for (const ap of s.assetPositions || []) { const p = ap.position, szi = num(p.szi); if (!szi) continue;
        positions.push({ coin: p.coin, side: szi > 0 ? "long" : "short", notional: Math.abs(num(p.positionValue)), size: Math.abs(szi), entry: num(p.entryPx), upnl: num(p.unrealizedPnl), roe: num(p.returnOnEquity), lev: p.leverage?.value ?? null, liq: p.liquidationPx ? num(p.liquidationPx) : null }); }
    }
    positions.sort((a, b) => b.notional - a.notional);
    const sum = (side) => positions.filter((p) => p.side === side).reduce((s, p) => s + p.notional, 0);
    return { addr, equity, positions, longN: sum("long"), shortN: sum("short") };
  }
  // même règle que la collecte GitHub (lib/hl.mjs, diffAccounts)
  function diff(prev, next, names, since) {
    const ev = [], t = Date.now();
    for (const [addr, a] of next) {
      const b = prev.get(addr); if (!b) continue;
      const key = (p) => p.coin + "|" + p.side, before = new Map(b.positions.map((p) => [key(p), p])), after = new Map(a.positions.map((p) => [key(p), p]));
      const base = { t, src: "hl", addr, name: names.get(addr) || null, since: since || undefined };
      for (const [k, p] of after) { const o = before.get(k);
        if (!o) { if (p.notional >= MIN_EV) ev.push({ ...base, kind: "open", coin: p.coin, side: p.side, notional: p.notional, delta: p.notional, px: p.entry }); }
        else if (o.size && Math.abs(p.size / o.size - 1) >= 0.15 && Math.abs(p.size - o.size) * (p.notional / p.size) >= MIN_EV) { const dn = (p.size - o.size) * (p.notional / p.size); ev.push({ ...base, kind: dn > 0 ? "add" : "reduce", coin: p.coin, side: p.side, notional: p.notional, delta: dn }); } }
      for (const [k, o] of before) if (!after.has(k) && o.notional >= MIN_EV) ev.push({ ...base, kind: "close", coin: o.coin, side: o.side, notional: o.notional, delta: -o.notional, upnl: o.upnl });
    }
    return ev;
  }
  async function positions() {
    const S = App.S; if (!S?.hl?.accounts?.length) return;
    const names = new Map(S.hl.accounts.map((a) => [a.addr, a.name])), addrs = S.hl.accounts.map((a) => a.addr);
    const res = await pool(addrs, 8, account), next = new Map(res.filter(Boolean).map((a) => [a.addr, a]));
    if (next.size < addrs.length * 0.5) { L.fails++; return; }   // trop d'échecs : on garde l'état précédent
    L.fails = 0;
    if (L.prev) L.events.unshift(...diff(L.prev, next, names));
    else if (L.base) L.events.unshift(...diff(L.base, next, names, true));   // mouvements depuis la dernière collecte GitHub
    for (const [k, v] of L.prev || []) if (!next.has(k)) next.set(k, v);
    L.prev = next; L.acc = next; L.posAt = Date.now(); if (L.events.length > 400) L.events.length = 400;
  }

  // reconstruit les vues dérivées (exposition par actif, carte des liquidations) à partir des données en direct
  function coinBoard(accts) {
    const c = {}; for (const a of accts) for (const p of a.positions) { const e = (c[p.coin] ??= { coin: p.coin, longN: 0, shortN: 0, nLong: 0, nShort: 0 }); if (p.side === "long") { e.longN += p.notional; e.nLong++; } else { e.shortN += p.notional; e.nShort++; } }
    return Object.values(c).map((e) => ({ ...e, net: e.longN - e.shortN, gross: e.longN + e.shortN })).sort((a, b) => b.gross - a.gross).slice(0, 40);
  }
  function liqMap(accts, mk) {
    const by = {}; for (const a of accts) for (const p of a.positions) { const m = mk[p.coin]; if (!p.liq || !m) continue; if (p.liq > m.mark * 2 || p.liq < m.mark * 0.3) continue; (by[p.coin] ??= []).push({ px: p.liq, n: p.notional, side: p.side }); }
    return Object.entries(by).map(([coin, list]) => ({ coin, mark: mk[coin].mark, total: list.reduce((s, x) => s + x.n, 0), list })).sort((a, b) => b.total - a.total).slice(0, 10);
  }
  const same = (a, b) => a.src === b.src && a.addr === b.addr && a.coin === b.coin && a.side === b.side && a.kind === b.kind && Math.abs(a.t - b.t) < 25 * 60e3;
  function overlay(S) {
    if (!S) return S;
    if (L.markets) { const held = new Set([...L.acc.values()].flatMap((a) => a.positions.map((p) => p.coin))), had = new Set(S.hl.markets.map((m) => m.coin));
      S.hl.markets = Object.values(L.markets).filter((m) => had.has(m.coin) || held.has(m.coin) || m.oi >= 3e6); S.hl.mkAt = L.mkAt; }
    if (L.acc.size) {
      S.hl.accounts = S.hl.accounts.map((a) => { const l = L.acc.get(a.addr); return l ? { ...a, equity: l.equity || a.equity, positions: l.positions, nPositions: l.positions.length, longN: l.longN, shortN: l.shortN, error: false } : a; });
      S.hl.coins = coinBoard(S.hl.accounts); S.hl.posAt = L.posAt;
      if (L.markets) S.liq = liqMap(S.hl.accounts, L.markets);
    }
    const gh = (S.events || []).filter((e) => !L.events.some((x) => same(x, e)));
    S.events = [...L.events, ...gh].sort((a, b) => b.t - a.t).slice(0, 500);
    return S;
  }
  async function cycle(kind, force) {
    if ((document.hidden && !force) || L.busy?.[kind]) return L.wait?.[kind]; (L.busy ??= {})[kind] = true; let done; (L.wait ??= {})[kind] = new Promise((r) => (done = r));
    try { await (kind === "mk" ? markets() : positions()); App.liveOk = true; App.checkedAt = Date.now(); if (App.S) accept(overlay(App.S)); }
    catch { App.liveOk = false; } finally { L.busy[kind] = false; done(); }
  }
  async function start() {
    if (L.running) return; L.running = true;
    try { const r = await fetch("positions.json?t=" + Date.now(), { cache: "no-store" }); if (r.ok) { const d = await r.json(); L.base = new Map((d.hl || []).map((a) => [a.addr, a])); } } catch {}
    await cycle("mk"); await cycle("pos");
    setInterval(() => cycle("mk"), 20000); setInterval(() => cycle("pos"), 45000);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) { cycle("mk"); cycle("pos"); } });
  }
  return { start, overlay, state: L, account, refreshNow: () => Promise.all([cycle("mk", true), cycle("pos", true)]) };
})();
if (App.PAGES) Live.start();
