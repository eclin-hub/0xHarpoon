// Synthèse : une direction par actif à partir de tous les signaux, et la liste des anomalies exploitables.
import { clamp } from "./util.mjs";

const ASSETS = [
  { key: "BTC", name: "Bitcoin", coin: "BTC", topic: "BTC", opt: "BTC", beta: 1 },
  { key: "ETH", name: "Ethereum", coin: "ETH", topic: "ETH", opt: "ETH", beta: 1 },
  { key: "SOL", name: "Solana", coin: "SOL", topic: "SOL", beta: 1 },
  { key: "SPX", name: "S&P 500", coin: "xyz:SP500", topic: "US_EQ", cot: "13874A", beta: 1 },
  { key: "NDX", name: "Nasdaq 100", coin: "xyz:XYZ100", topic: "US_EQ", cot: "209742", beta: 1 },
  { key: "GOLD", name: "Or", coin: "xyz:GOLD", topic: "GOLD", cot: "088691", beta: 0 },
  { key: "OIL", name: "Pétrole WTI", coin: "xyz:CL", topic: "OIL", cot: "067651", beta: 0.3 },
  { key: "USD", name: "Dollar (DXY)", coin: "xyz:DXY", topic: "USD", cot: "098662", beta: -0.6 },
];
const pc = (x, d = 0) => (x > 0 ? "+" : x < 0 ? "−" : "") + Math.abs(x * 100).toFixed(d) + " %";

export function directions({ candles, sentiment, cot, macro, options, markets }) {
  const sent = Object.fromEntries((sentiment || []).map((s) => [s.topic, s])), cots = Object.fromEntries((cot?.markets || []).map((m) => [m.code, m]));
  const opts = Object.fromEntries((options?.list || []).map((o) => [o.cur, o])), mk = markets || {}, S = macro?.series || {};
  return ASSETS.map((a) => {
    const parts = [], add = (name, score, w, text) => { if (Number.isFinite(score)) parts.push({ name, score: clamp(score), w, text }); };
    const st = candles?.stats?.[a.coin];
    if (st) add("Tendance", (st.ma50 ?? 0) / 0.08 * 0.6 + (st.r30 ?? 0) / 0.12 * 0.4, 1.2, `Prix ${pc(st.ma50, 1)} par rapport à sa moyenne 50 jours, ${pc(st.r30 ?? 0, 1)} sur 30 jours`);
    const s = sent[a.topic];
    if (s?.hl && s.hl.nLong + s.hl.nShort >= 4) add("Baleines Hyperliquid", s.hl.score, 1.2, `${s.hl.nLong} comptes long, ${s.hl.nShort} short (score ${pc(s.hl.score)})`);
    if (s?.pm && s.pm.nBull + s.pm.nBear >= 3) add("Parieurs Polymarket", s.pm.score, 0.6, `${s.pm.nBull} baleines haussières, ${s.pm.nBear} baissières`);
    const c = cots[a.cot];
    if (c) add("Hedge funds (CFTC)", c.w4 / 0.04 * 0.6 + (c.pctl >= 0.9 ? -0.5 : c.pctl <= 0.1 ? 0.5 : 0), 1, `Position nette ${pc(c.net, 1)} de l'open interest, ${pc(c.w4, 1)} en 4 semaines, ${Math.round(c.pctl * 100)}e centile sur 3 ans${c.pctl >= 0.9 ? " (au plus haut de 3 ans, risque de débouclage)" : c.pctl <= 0.1 ? " (au plus bas de 3 ans, risque de rachat)" : ""}`);
    if (macro?.regime) {
      if (a.key === "GOLD") { if (S.DFII10 && S.DTWEXBGS) add("Macro", -S.DFII10.m1 / 0.2 * 0.6 - (S.DTWEXBGS.m1 / S.DTWEXBGS.last) / 0.015 * 0.4, 0.9, `Taux réels ${S.DFII10.m1 >= 0 ? "+" : ""}${S.DFII10.m1.toFixed(2)} pt et dollar ${pc(S.DTWEXBGS.m1 / S.DTWEXBGS.last, 1)} sur 1 mois`); }
      else if (a.beta) add("Régime macro", macro.regime.score * a.beta, 0.9, `${macro.regime.label} (score ${pc(macro.regime.score)})`);
    }
    const o = opts[a.opt];
    if (o?.skew30 != null) add("Options", -o.skew30 / 12, 0.7, `Les puts coûtent ${o.skew30 >= 0 ? "+" : ""}${o.skew30.toFixed(1)} pts de volatilité de plus que les calls à 30 jours${o.skew30 > 6 ? " (forte demande de protection)" : ""}`);
    const m = mk[a.coin];
    if (m) { const f = m.funding * 24 * 365; if (Math.abs(f) > 0.2) add("Funding (contrarien)", -Math.sign(f) * 0.5, 0.5, `Funding ${pc(f, 0)}/an : ${f > 0 ? "longs" : "shorts"} encombrés`); }
    const W = parts.reduce((x, p) => x + p.w, 0) || 1, score = parts.reduce((x, p) => x + p.score * p.w, 0) / W;
    const agree = parts.filter((p) => Math.sign(p.score) === Math.sign(score) && Math.abs(p.score) > 0.15).length;
    return { ...a, score, n: parts.length, agree, conviction: Math.abs(score) * (parts.length ? agree / parts.length : 0), label: parts.length < 3 ? "Données insuffisantes" : score >= 0.2 ? "Haussier" : score <= -0.2 ? "Baissier" : "Neutre", price: st?.last ?? m?.mark ?? null, r7: st?.r7 ?? null, r30: st?.r30 ?? null,
      parts: parts.sort((x, y) => Math.abs(y.score * y.w) - Math.abs(x.score * x.w)), against: parts.filter((p) => Math.sign(p.score) === -Math.sign(score) && Math.abs(p.score) > 0.25).map((p) => p.name) };
  });
}

// Anomalies : endroits où deux sources se contredisent, ou où un indicateur sort de sa plage habituelle.
export function edgeSignals({ sentiment, cot, macro, options, fng, stable, wiki, apps, appsPrev, odds, liq, markets, coins, dirs }) {
  const out = [], add = (kind, tone, title, detail, assets = [], strength = 1) => out.push({ kind, tone, title, detail, assets, strength });
  for (const m of (odds?.movers || []).slice(0, 4)) if (Math.abs(m.d1) >= 0.08) add("Cotes", m.d1 > 0 ? "up" : "down", `Cote en mouvement : ${m.title}`, `« ${m.q} » passe à ${(m.p * 100).toFixed(0)} % (${m.d1 > 0 ? "+" : ""}${(m.d1 * 100).toFixed(0)} pts en 24 h, ${Math.round(m.vol / 1000)} k$ échangés). Les marchés de prédiction bougent souvent avant les gros titres.`, m.topic ? [m.topic] : [], Math.min(1.7, Math.abs(m.d1) * 10));
  for (const s of sentiment || []) {
    if (s.elite && s.crowd && Math.abs(s.elite.score - s.crowd.score) >= 0.6 && s.elite.nLong + s.elite.nShort >= 4) add("Baleines", "warn", `${s.name} : les meilleurs comptes divergent de la foule`, `Top 20 par rendement à ${pc(s.elite.score)}, les autres à ${pc(s.crowd.score)}.`, [s.topic], 1.5);
    if (s.agree === "diverge") add("Baleines", "warn", `${s.name} : Hyperliquid et Polymarket en désaccord`, `Hyperliquid ${pc(s.hl.score)}, Polymarket ${pc(s.pm.score)}. L'un des deux marchés a tort.`, [s.topic], 1);
  }
  const sent = Object.fromEntries((sentiment || []).map((s) => [s.topic, s]));
  const ARB = new Set(["133741", "146021", "043602", "042601"]); // marchés où les fonds sont vendeurs par arbitrage : pas un signal
  for (const c of (cot?.markets || []).filter((m) => !ARB.has(m.code))) {
    if (c.pctl >= 0.95 || c.pctl <= 0.05) add("Hedge funds", "warn", `${c.name} : positionnement extrême des hedge funds`, `Position nette au ${Math.round(c.pctl * 100)}e centile sur 3 ans (${pc(c.net, 1)} de l'open interest). Un extrême précède souvent un débouclage.`, c.topic ? [c.topic] : [], 1.6);
    const s = c.topic && sent[c.topic];
    if (s?.hl && s.hl.nLong + s.hl.nShort >= 6 && Math.abs(s.hl.score) >= 0.4 && Math.abs(c.net) >= 0.03 && Math.sign(s.hl.score) !== Math.sign(c.net)) add("Hedge funds", "warn", `${c.name} : baleines crypto contre hedge funds`, `Baleines Hyperliquid à ${pc(s.hl.score)}, hedge funds ${c.net > 0 ? "net long" : "net short"} sur les futures (${pc(c.net, 1)} de l'open interest).`, [c.topic], 1.3);
  }
  if (fng) { if (fng.value <= 20) add("Sentiment", "up", `Peur extrême sur la crypto (${fng.value}/100)`, "Signal contrarien classique : les creux de marché se forment dans la peur extrême, mais elle peut durer.", ["BTC"], 1.4); else if (fng.value >= 80) add("Sentiment", "down", `Avidité extrême sur la crypto (${fng.value}/100)`, "Signal contrarien : l'euphorie précède souvent une correction.", ["BTC"], 1.4); }
  if (stable && Math.abs(stable.p7) >= 0.007) add("Liquidité", stable.p7 > 0 ? "up" : "down", `Stablecoins : ${pc(stable.p7, 1)} en 7 jours`, `${stable.d7 > 0 ? "+" : "−"}${(Math.abs(stable.d7) / 1e9).toFixed(1)} Md$ d'offre. ${stable.p7 > 0 ? "De l'argent frais entre dans l'écosystème crypto." : "De l'argent sort de l'écosystème crypto."}`, ["BTC", "ETH"], 1.2);
  for (const w of (wiki?.items || []).filter((x) => x.z >= 2.5).slice(0, 4)) add("Attention", "warn", `Pic d'attention : « ${w.label} »`, `${w.last.toLocaleString("fr-FR")} vues Wikipedia hier, ${w.ratio.toFixed(1)}× la moyenne du mois. Un pic d'attention du grand public arrive souvent tard dans un mouvement.`, w.topic ? [w.topic] : [], Math.min(3, w.z / 2));
  if (apps && appsPrev) for (const a of apps.ranks) { const p = appsPrev.ranks.find((x) => x.name === a.name); if (a.rank && p?.rank && Math.abs(p.rank - a.rank) >= 8) add("Particuliers", a.rank < p.rank ? "up" : "down", `${a.name} ${a.rank < p.rank ? "grimpe" : "recule"} dans l'App Store`, `Rang ${p.rank} → ${a.rank} dans les apps de finance aux États-Unis. Indicateur de l'afflux ou du départ des particuliers.`, ["BTC"], 1); }
  for (const o of options?.list || []) { if (o.skew30 != null && Math.abs(o.skew30) >= 8) add("Options", o.skew30 > 0 ? "down" : "up", `${o.cur} : ${o.skew30 > 0 ? "forte demande de puts" : "forte demande de calls"}`, `Écart de volatilité put − call à 30 jours : ${o.skew30.toFixed(1)} pts.`, [o.cur], 1.2); if (o.dvolChg7 != null && Math.abs(o.dvolChg7) >= 8) add("Options", "warn", `${o.cur} : volatilité implicite ${o.dvolChg7 > 0 ? "en hausse" : "en baisse"}`, `Indice DVOL ${o.dvol.toFixed(0)} (${o.dvolChg7 > 0 ? "+" : ""}${o.dvolChg7.toFixed(0)} pts en 7 jours). Le marché des options anticipe ${o.dvolChg7 > 0 ? "plus" : "moins"} de mouvement.`, [o.cur], 1.1); }
  const cb = Object.fromEntries((coins || []).map((c) => [c.coin, c]));
  for (const m of Object.values(markets || {})) { const f = m.funding * 24 * 365, c = cb[m.coin], sk = c ? (c.longN - c.shortN) / (c.gross || 1) : 0; if (m.oi >= 5e7 && Math.abs(f) >= 0.3 && Math.sign(f) === Math.sign(sk) && Math.abs(sk) >= 0.4) add("Funding", "warn", `${m.coin.replace("xyz:", "")} : ${f > 0 ? "longs" : "shorts"} encombrés`, `Funding ${pc(f, 0)}/an et baleines à ${pc(sk)} du même côté. Configuration typique d'un squeeze dans l'autre sens.`, [], 1.3); }
  for (const l of liq || []) { const near = l.list.filter((x) => Math.abs(x.px / l.mark - 1) <= 0.05), L = near.filter((x) => x.side === "long").reduce((s, x) => s + x.n, 0), Sx = near.filter((x) => x.side === "short").reduce((s, x) => s + x.n, 0); if (Math.max(L, Sx) >= 2e7) add("Liquidations", L > Sx ? "down" : "up", `${l.coin.replace("xyz:", "")} : liquidations proches du prix`, `${(Math.max(L, Sx) / 1e6).toFixed(0)} M$ de ${L > Sx ? "longs" : "shorts"} liquidables à moins de 5 % du cours. Une mèche dans ce sens peut déclencher une cascade.`, [], 1.2); }
  const NL = macro?.series?.NETLIQ; if (NL && Math.abs(NL.m1) >= 0.08) add("Liquidité", NL.m1 > 0 ? "up" : "down", `Liquidité nette en dollars : ${NL.m1 > 0 ? "+" : "−"}${Math.abs(NL.m1 * 1000).toFixed(0)} Md$ sur 1 mois`, "Bilan de la Fed moins compte du Trésor moins reverse repo. Les actifs risqués suivent cette mesure avec retard.", ["BTC", "US_EQ"], 1.3);
  for (const d of dirs || []) if (d.n >= 4 && d.against.length >= 2 && Math.abs(d.score) < 0.2) add("Synthèse", "warn", `${d.name} : signaux contradictoires`, `Aucune direction nette : ${d.against.join(", ")} s'opposent au reste. Zone à éviter ou à jouer en volatilité.`, [d.topic], 0.8);
  return out.sort((a, b) => b.strength - a.strength).slice(0, 40);
}
