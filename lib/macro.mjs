// Macro-économie : séries publiques de la Fed de Saint-Louis (FRED), sans clé.
import { fetchText, pool, clamp, downsample } from "./util.mjs";

export const SERIES = [
  ["DFF", "Taux directeur Fed", "Taux", "%"], ["DGS3MO", "Bon du Trésor 3 mois", "Taux", "%"], ["DGS1", "Trésor 1 an", "Taux", "%"], ["DGS2", "Trésor 2 ans", "Taux", "%"],
  ["DGS5", "Trésor 5 ans", "Taux", "%"], ["DGS10", "Trésor 10 ans", "Taux", "%"], ["DGS30", "Trésor 30 ans", "Taux", "%"],
  ["T10Y2Y", "Pente 10 ans − 2 ans", "Courbe", "pt"], ["T10Y3M", "Pente 10 ans − 3 mois", "Courbe", "pt"],
  ["DFII10", "Taux réel 10 ans", "Taux", "%"], ["T10YIE", "Inflation anticipée 10 ans", "Inflation", "%"], ["CPIAUCSL", "Indice des prix (CPI)", "Inflation", "idx"],
  ["UNRATE", "Chômage", "Emploi", "%"], ["ICSA", "Inscriptions hebdo au chômage", "Emploi", "n"],
  ["BAMLH0A0HYM2", "Spread haut rendement", "Crédit", "%"], ["NFCI", "Conditions financières (Chicago)", "Crédit", "idx"], ["VIXCLS", "VIX", "Risque", "idx"],
  ["DTWEXBGS", "Dollar (indice large)", "Devises", "idx"], ["DCOILWTICO", "Pétrole WTI", "Matières", "$"], ["SP500", "S&P 500", "Actions", "idx"],
  ["WALCL", "Bilan de la Fed", "Liquidité", "M$"], ["WTREGEN", "Compte du Trésor (TGA)", "Liquidité", "M$"], ["RRPONTSYD", "Reverse repo", "Liquidité", "Md$"], ["M2SL", "Masse monétaire M2", "Liquidité", "Md$"],
  ["MORTGAGE30US", "Taux hypothécaire 30 ans", "Taux", "%"],
];

async function series(id) {
  const from = new Date(Date.now() - 800 * 86400e3).toISOString().slice(0, 10);
  const csv = await fetchText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${from}`, { timeout: 40000 }, 4);
  return csv.trim().split("\n").slice(1).map((l) => l.split(",")).filter((p) => p[1] && p[1] !== ".").map(([d, v]) => [Date.parse(d), Number(v)]).filter((p) => Number.isFinite(p[1]));
}
const at = (pts, daysAgo) => { const t = pts.at(-1)[0] - daysAgo * 86400e3; let best = pts[0]; for (const p of pts) if (p[0] <= t) best = p; else break; return best[1]; };

export async function fetchMacro() {
  const res = await pool(SERIES, 3, ([id]) => series(id));
  const raw = {}, out = { at: Date.now(), series: {}, failed: [] };
  SERIES.forEach(([id, label, group, unit], i) => {
    const pts = res[i];
    if (!Array.isArray(pts) || pts.length < 3) { out.failed.push(id); return; }
    raw[id] = pts; const last = pts.at(-1)[1];
    out.series[id] = { id, label, group, unit, last, date: pts.at(-1)[0], d1: last - pts.at(-2)[1], m1: last - at(pts, 30), m3: last - at(pts, 91), y1: last - at(pts, 365), spark: downsample(pts.slice(-260).map((p) => +p[1].toFixed(4)), 70) };
  });
  const S = out.series;
  if (raw.CPIAUCSL) { const p = raw.CPIAUCSL, yoy = (i) => p[i][1] / at(p.slice(0, i + 1), 365) - 1; S.CPIYOY = { id: "CPIYOY", label: "Inflation (CPI sur 1 an)", group: "Inflation", unit: "%", last: yoy(p.length - 1) * 100, date: p.at(-1)[0], d1: (yoy(p.length - 1) - yoy(p.length - 2)) * 100, m1: (yoy(p.length - 1) - yoy(p.length - 2)) * 100, m3: (yoy(p.length - 1) - yoy(Math.max(12, p.length - 4))) * 100, y1: 0, spark: p.slice(-14).map((_, k, a) => +(yoy(p.length - a.length + k) * 100).toFixed(2)) }; }
  // liquidité nette = bilan de la Fed − compte du Trésor − reverse repo (en milliers de milliards $)
  if (raw.WALCL && raw.WTREGEN && raw.RRPONTSYD) {
    const val = (pts, t) => { let b = pts[0][1]; for (const p of pts) if (p[0] <= t) b = p[1]; else break; return b; };
    const nl = raw.WALCL.map(([t, v]) => [t, v / 1e6 - val(raw.WTREGEN, t) / 1e6 - val(raw.RRPONTSYD, t) / 1e3]);
    const last = nl.at(-1)[1];
    S.NETLIQ = { id: "NETLIQ", label: "Liquidité nette (Fed − TGA − RRP)", group: "Liquidité", unit: "k Md$", last, date: nl.at(-1)[0], d1: last - nl.at(-2)[1], m1: last - at(nl, 30), m3: last - at(nl, 91), y1: last - at(nl, 365), spark: downsample(nl.slice(-104).map((p) => +p[1].toFixed(3)), 70) };
  }
  // courbe des taux : aujourd'hui, il y a 1 mois, il y a 1 an
  const tenors = [["DGS3MO", "3 m"], ["DGS1", "1 an"], ["DGS2", "2 ans"], ["DGS5", "5 ans"], ["DGS10", "10 ans"], ["DGS30", "30 ans"]].filter(([id]) => raw[id]);
  out.curve = { tenors: tenors.map((t) => t[1]), now: tenors.map(([id]) => raw[id].at(-1)[1]), m1: tenors.map(([id]) => at(raw[id], 30)), y1: tenors.map(([id]) => at(raw[id], 365)) };
  out.regime = regime(S);
  return out;
}

// Score de régime : +1 = appétit pour le risque, −1 = aversion
export function regime(S) {
  const parts = [], add = (name, score, text) => parts.push({ name, score: clamp(score), text });
  if (S.VIXCLS) add("Volatilité (VIX)", (20 - S.VIXCLS.last) / 6, `VIX à ${S.VIXCLS.last.toFixed(1)}`);
  if (S.BAMLH0A0HYM2) add("Crédit", (4.2 - S.BAMLH0A0HYM2.last) / 1.2 - S.BAMLH0A0HYM2.m1 * 1.5, `Spread haut rendement ${S.BAMLH0A0HYM2.last.toFixed(2)} % (${S.BAMLH0A0HYM2.m1 >= 0 ? "+" : ""}${S.BAMLH0A0HYM2.m1.toFixed(2)} sur 1 mois)`);
  if (S.NETLIQ) add("Liquidité", S.NETLIQ.m3 / 0.15, `Liquidité nette ${S.NETLIQ.m3 >= 0 ? "+" : ""}${(S.NETLIQ.m3 * 1000).toFixed(0)} Md$ sur 3 mois`);
  if (S.NFCI) add("Conditions financières", -S.NFCI.last / 0.4, `Indice NFCI ${S.NFCI.last.toFixed(2)} (négatif = conditions souples)`);
  if (S.DTWEXBGS) add("Dollar", -(S.DTWEXBGS.m1 / S.DTWEXBGS.last) / 0.015, `Dollar ${(S.DTWEXBGS.m1 / S.DTWEXBGS.last * 100).toFixed(1)} % sur 1 mois`);
  if (S.DFII10) add("Taux réels", -S.DFII10.m1 / 0.2, `Taux réel 10 ans ${S.DFII10.last.toFixed(2)} % (${S.DFII10.m1 >= 0 ? "+" : ""}${S.DFII10.m1.toFixed(2)} sur 1 mois)`);
  if (S.T10Y3M) add("Courbe des taux", S.T10Y3M.last < 0 ? -0.6 : S.T10Y3M.m3 > 0.3 && S.T10Y3M.last < 0.8 ? -0.3 : 0.3, `Pente 10 ans − 3 mois ${S.T10Y3M.last.toFixed(2)} pt${S.T10Y3M.last < 0 ? " (inversée)" : ""}`);
  const score = parts.length ? parts.reduce((s, p) => s + p.score, 0) / parts.length : 0;
  return { score, label: score >= 0.25 ? "Appétit pour le risque" : score <= -0.25 ? "Aversion au risque" : "Régime neutre", parts };
}
