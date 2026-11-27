// Intitulés lisibles des marchés Polymarket : titre (question), échéance et lien public, par conditionId.
// Sources, dans l'ordre : le relevé des baleines (titre, end_date, slug d'événement), l'historique des cotes,
// puis l'API Gamma pour un conditionId encore inconnu (ex. position ouverte sur un marché sorti du relevé).
// Le résultat est mis en cache dans data/paper/pm_markets.json, que la page relit aussi pour les anciennes lignes
// (historique des trades, journal des votes) écrites avant que les intitulés ne soient enregistrés.
import { pmEventUrl } from "../pm.mjs";

const CID = /0x[0-9a-f]{64}/i, DAY = 864e5;
const RETRY_MS = DAY, KEEP_MS = 30 * DAY;

// conditionId d'un objet (position, trade, candidat, vote) ou d'un identifiant « pm|0x…|Yes », « leadlag|0x…|No »
export function cidOf(x) {
  if (!x) return null;
  if (typeof x === "string") return x.match(CID)?.[0]?.toLowerCase() ?? null;
  return cidOf(x.cid || x.pm?.cid || x.candidateId || x.candidate_id || x.id || "");
}
const outcomeOf = (x) => x?.outcome ?? x?.pm?.outcome ?? x?.metrics?.pm_outcome ?? String(x?.candidateId || x?.candidate_id || x?.id || "").split("|")[2] ?? null;

// Ce que le cycle connaît déjà, sans réseau.
export function pmInfoFromSnapshot(snap, history) {
  const out = {}, put = (cid, v) => { const k = cidOf(cid); if (!k) return; const o = (out[k] ??= {});
    for (const [f, x] of Object.entries(v)) if (x != null && o[f] == null) o[f] = x; };
  for (const w of snap?.pm || []) for (const p of w.positions || []) put(p.cid, { title: p.title, endDate: p.end, slug: p.slug, url: pmEventUrl(p.slug) });
  for (const e of snap?.events || []) if (e.src === "pm") put(e.cid, { title: e.title, slug: e.slug, url: pmEventUrl(e.slug) });
  for (const e of Object.values(history?.pm || {})) put(e.cid, { title: e.title });
  return out;
}

// Complète le cache pour les conditionId demandés : d'abord avec `known`, puis avec Gamma (au plus `max` appels,
// un essai par jour pour un marché introuvable). fetchGamma = null : aucun appel réseau.
export async function resolvePmInfo(cids, cache = {}, { known = {}, fetchGamma = null, max = 25, now = Date.now() } = {}) {
  const c = structuredClone(cache || {}), errors = [];
  const wanted = [...new Set(cids.map(cidOf).filter(Boolean))];
  let calls = 0;
  for (const k of wanted) {
    const e = (c[k] ??= {});
    for (const [f, x] of Object.entries(known[k] || {})) if (x != null && e[f] == null) e[f] = x;
    e.seenAt = new Date(now).toISOString();
    const complete = e.title && e.url && e.endDate;
    if (complete || !fetchGamma || calls >= max || (e.triedAt && now - Date.parse(e.triedAt) < RETRY_MS)) continue;
    calls++; e.triedAt = new Date(now).toISOString();
    try {
      const g = await fetchGamma(k);
      if (!g) { errors.push(`Gamma ${k.slice(0, 10)}… : marché introuvable`); continue; }
      for (const f of ["title", "endDate", "slug", "url"]) if (g[f] && !e[f]) e[f] = g[f];
    } catch (err) { errors.push(`Gamma ${k.slice(0, 10)}… : ${err.message || err}`); }
  }
  for (const [k, e] of Object.entries(c)) if (!e.seenAt || now - Date.parse(e.seenAt) > KEEP_MS) delete c[k];
  return { cache: c, calls, errors };
}

// Cote du pari Polymarket qui a déclenché une position Hyperliquid (lead-lag) : au moment de l'entrée et maintenant.
// Ce n'est pas un prix payé (aucune part Polymarket n'est achetée), seulement l'état du signal.
// history : market_history.json (cotes horodatées) ; pmPrices : { "cid|outcome" → cote du dernier relevé }.
export function withSignalOdds(x, { history = null, pmPrices = {}, entry = null } = {}) {
  if (!x?.pm?.cid || x.venue === "pm") return x;
  const want = `${x.pm.cid}|${x.pm.outcome}`.toLowerCase();
  const k = Object.keys(history?.pm || {}).find((key) => key.toLowerCase() === want), pts = k ? history.pm[k].pts : [];
  const t0 = Date.parse(x.openedAt || x.at || "");
  const atOpen = Number.isFinite(t0) ? pts.filter(([t]) => t <= t0 + 60e3).at(-1)?.[1] ?? null : null;
  const cur = pmPrices[k] ?? Object.entries(pmPrices).find(([key]) => key.toLowerCase() === want)?.[1] ?? pts.at(-1)?.[1] ?? null;
  return { ...x, pm: { ...x.pm, entryOdds: x.pm.entryOdds ?? entry ?? atOpen, odds: cur ?? x.pm.odds ?? null } };
}

// Ajoute l'intitulé : directement sur un objet Polymarket (venue pm), sinon dans un champ `pm`
// (position, trade ou vote issu d'un signal de cote Polymarket, comme le lead-lag).
export function annotatePm(x, cache) {
  const k = cidOf(x), i = k ? cache?.[k] : null;
  if (!x || !k) return x;
  if (x.venue === "pm") return { ...x, cid: x.cid ?? k, title: x.title || i?.title || null, endDate: x.endDate || x.end || i?.endDate || null, url: x.url || i?.url || null };
  const title = x.pm?.title || x.metrics?.pm_title || i?.title || null;
  return { ...x, pm: { ...(x.pm || {}), cid: k, outcome: outcomeOf(x), title, endDate: x.pm?.endDate || i?.endDate || null, url: x.pm?.url || i?.url || null } };
}
