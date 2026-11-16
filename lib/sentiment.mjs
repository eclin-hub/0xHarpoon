import { TOPICS } from "./topics.mjs";

const skew = (a, b) => (a + b > 0 ? (a - b) / (a + b) : 0); // -1..+1

export function hlByTopic(accounts) {
  const t = {};
  for (const a of accounts) {
    const per = {}; // net par compte et par thème
    for (const p of a.positions) {
      if (!p.topic || p.notional < 10_000) continue;
      const e = (per[p.topic] ??= { l: 0, s: 0 });
      p.side === "long" ? (e.l += p.notional) : (e.s += p.notional);
    }
    for (const [topic, e] of Object.entries(per)) {
      const x = (t[topic] ??= { longN: 0, shortN: 0, longers: [], shorters: [] });
      x.longN += e.l; x.shortN += e.s;
      const net = e.l - e.s;
      (net >= 0 ? x.longers : x.shorters).push({ addr: a.addr, name: a.name, notional: Math.abs(net) });
    }
  }
  for (const x of Object.values(t)) {
    x.longers.sort((a, b) => b.notional - a.notional); x.shorters.sort((a, b) => b.notional - a.notional);
    x.nLong = x.longers.length; x.nShort = x.shorters.length;
    x.score = 0.5 * skew(x.longN, x.shortN) + 0.5 * skew(x.nLong, x.nShort);
  }
  return t;
}

export function pmByTopic(whales) {
  const t = {};
  for (const w of whales) {
    const per = {};
    for (const p of w.positions) {
      if (!p.topic || p.view == null || p.value < 500 || p.price < 0.05 || p.price > 0.95) continue;
      const e = (per[p.topic] ??= { bull: 0, bear: 0, items: [] });
      p.view > 0 ? (e.bull += p.value) : (e.bear += p.value);
      e.items.push({ title: p.title, outcome: p.outcome, value: p.value, view: p.view });
    }
    for (const [topic, e] of Object.entries(per)) {
      const x = (t[topic] ??= { bullN: 0, bearN: 0, bull: [], bear: [] });
      const net = e.bull - e.bear;
      x.bullN += e.bull; x.bearN += e.bear;
      (net >= 0 ? x.bull : x.bear).push({ addr: w.addr, name: w.name, value: Math.abs(net), items: e.items.sort((a, b) => b.value - a.value).slice(0, 3) });
    }
  }
  for (const x of Object.values(t)) {
    x.bull.sort((a, b) => b.value - a.value); x.bear.sort((a, b) => b.value - a.value);
    x.nBull = x.bull.length; x.nBear = x.bear.length;
    x.score = 0.5 * skew(x.bullN, x.bearN) + 0.5 * skew(x.nBull, x.nBear);
  }
  return t;
}

const label = (s) => (s >= 0.6 ? "Très haussier" : s >= 0.25 ? "Haussier" : s <= -0.6 ? "Très baissier" : s <= -0.25 ? "Baissier" : "Neutre");

export function crossSentiment(hl, pm) {
  const out = [];
  for (const topic of new Set([...Object.keys(hl), ...Object.keys(pm)])) {
    const h = hl[topic], p = pm[topic];
    const nH = h ? h.nLong + h.nShort : 0, nP = p ? p.nBull + p.nBear : 0;
    const parts = [];
    if (h && nH >= 2) parts.push({ s: h.score, w: Math.min(1, nH / 8) });
    if (p && nP >= 2) parts.push({ s: p.score, w: Math.min(1, nP / 8) });
    if (!parts.length) continue;
    const wsum = parts.reduce((a, b) => a + b.w, 0);
    const score = parts.reduce((a, b) => a + b.s * b.w, 0) / wsum;
    const agree = parts.length === 2 ? (Math.sign(parts[0].s) === Math.sign(parts[1].s) && Math.abs(parts[0].s) > 0.1 && Math.abs(parts[1].s) > 0.1 ? "aligned" : "diverge") : "single";
    const conviction = Math.abs(score) * Math.min(1, (nH + nP) / 10) * (agree === "aligned" ? 1.25 : agree === "diverge" ? 0.6 : 0.85);
    out.push({
      topic, name: TOPICS[topic]?.label ?? topic, group: TOPICS[topic]?.group ?? "Autre",
      score, label: label(score), agree, conviction,
      hl: h ? { nLong: h.nLong, nShort: h.nShort, longN: h.longN, shortN: h.shortN, score: h.score, longers: h.longers.slice(0, 8), shorters: h.shorters.slice(0, 8) } : null,
      pm: p ? { nBull: p.nBull, nBear: p.nBear, bull: p.bullN, bear: p.bearN, score: p.score, bullW: p.bull.slice(0, 8), bearW: p.bear.slice(0, 8) } : null,
    });
  }
  return out.sort((a, b) => b.conviction - a.conviction);
}

// Tous les coins (pas seulement les thèmes communs) : exposition nette de la cohorte
export function coinBoard(accounts) {
  const c = {};
  for (const a of accounts) for (const p of a.positions) {
    const e = (c[p.coin] ??= { coin: p.coin, longN: 0, shortN: 0, nLong: 0, nShort: 0 });
    if (p.side === "long") { e.longN += p.notional; e.nLong++; } else { e.shortN += p.notional; e.nShort++; }
  }
  return Object.values(c).map((e) => ({ ...e, net: e.longN - e.shortN, gross: e.longN + e.shortN }))
    .sort((a, b) => b.gross - a.gross).slice(0, 40);
}
