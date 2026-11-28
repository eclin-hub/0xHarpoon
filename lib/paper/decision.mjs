// Couche décisionnelle (SPEC §4.2) : vote parallèle de 3 modèles indépendants, quorum, arbitre, secours déterministe.
//
// Règles :
// - Ouvrir un candidat : au moins 2 votes valides. Unanimité OPEN → ouverture ; unanimité contre → rejet ;
//   1 contre 1 (2 votes valides) → pas d'ouverture ; 2 contre 1 → arbitre (famille distincte des votants).
// - Un REJECT dont `cited_risk_metric` ne nomme pas une métrique du dossier avec sa valeur est écarté (pas d'avocat
//   du diable : une objection doit être chiffrée). HOLD sur un candidat = ne pas ouvrir, sans obligation de citer.
// - Positions ouvertes : fermeture si la majorité stricte des votes valides dit CLOSE (un seul vote valide suffit
//   quand un seul modèle a répondu : gestion de l'existant).
// - Aucun vote valide : agent de secours déterministe — aucune ouverture, aucune fermeture discrétionnaire ;
//   les stops, échéances et freins de drawdown restent appliqués par le simulateur à chaque cycle.
// - L'IA ne fixe aucune taille : la conviction retenue est transmise au moteur de risque, qui la borne.
import { CONFIG } from "./config.mjs";
import { validateBallot, validateArbiter, checkCitation } from "./schema.mjs";

const H = 3600e3;
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);

/* ---------- réveil (règle anti-overtrading, SPEC §1) ---------- */

// Une position « approche de son invalidation » quand il reste moins de 25 % de la distance entre l'entrée et le stop.
export function nearStop(q, markets = {}) {
  if (q.venue !== "hl" || q.stopPx == null) return false;
  const m = markets[q.coin]?.mark ?? q.mark, span = Math.abs(q.entryPx - q.stopPx);
  return span > 0 && m > 0 && Math.abs(m - q.stopPx) / span <= 0.25;
}

export function wakeReasons({ dossier, portfolio, markets = {}, now = Date.now() }, cfg = CONFIG) {
  const out = [];
  if (dossier?.wakeLLM) out.push("candidat au-dessus du seuil");
  const near = portfolio.positions.filter((q) => nearStop(q, markets)).map((q) => q.id);
  if (near.length) out.push(`proche du stop : ${near.join(", ")}`);
  const d = new Date(now), today = d.toISOString().slice(0, 10);
  if (d.getUTCHours() >= cfg.ai.dailyReviewUtcHour && portfolio.lastReviewDay !== today) out.push("revue quotidienne");
  return out;
}

/* ---------- dossier envoyé aux modèles ---------- */

export function positionsView(portfolio, markets = {}, now = Date.now()) {
  return portfolio.positions.map((q) => {
    const base = { id: q.id, venue: q.venue, pocket: q.pocket, opened_hours_ago: r4((now - Date.parse(q.openedAt)) / H), horizon_hours: q.horizonH, invalidation: q.invalidation };
    if (q.venue === "hl") {
      const mark = markets[q.coin]?.mark ?? q.mark;
      return { ...base, coin: q.coin, side: q.side, metrics: { entry: r4(q.entryPx), mark: r4(mark), notional_usd: r4(q.size * mark),
        pnl_pct: r4((q.side === "long" ? 1 : -1) * (mark / q.entryPx - 1)), stop: r4(q.stopPx), dist_to_stop_pct: q.stopPx ? r4(Math.abs(mark / q.stopPx - 1)) : null, funding_paid_usd: r4(-q.funding) } };
    }
    return { ...base, title: q.title, outcome: q.outcome, metrics: { entry: r4(q.entryPx), price: r4(q.mark), shares: r4(q.shares), cost_usd: r4(q.cost), pnl_pct: r4(q.mark / q.entryPx - 1) } };
  });
}

export function portfolioView(portfolio) {
  return { equity: r4(portfolio.equity), cash: r4(portfolio.cash), drawdown: r4(portfolio.drawdown ?? 0), mode: portfolio.mode, open_positions: portfolio.positions.length };
}

export const SYSTEM_PROMPT = `You are one of three independent analysts voting on paper trades for a whale-following strategy (Hyperliquid perps, Polymarket).
You do not see the other analysts' votes. A deterministic risk engine sizes every trade; you only judge whether each idea is worth taking.
For EVERY candidate and EVERY open position listed, return exactly one vote. Answer with JSON only, no prose:
{"votes":[{"candidate_id":"<id from the dossier>","action":"OPEN|REJECT|HOLD|CLOSE","conviction":0-100,"invalidation_condition":"<what would prove the idea wrong, in French>","horizon_hours":<1-2160>,"cited_risk_metric":"<metric name and value copied from the dossier, e.g. dist_atr = 0.55>"}]}
Rules: candidates take OPEN, REJECT or HOLD; open positions take HOLD or CLOSE. A REJECT is discarded unless cited_risk_metric names a metric of that candidate together with its exact value.
Conviction below 60 means you would not open. Judge on the numbers given; do not invent data.`;

// Flux ε (x_scraper.mjs) : contexte social par ticker, demi-vie < 4 h. Ajouté au message système quand il existe.
export const X_RULES = `
Social context: the field "x_epsilon" gives, per ticker (BTC, ETH, SOL, HYPE, ZEC, NVDA = xyz:NVDA, SOXL, BRENTOIL = xyz:BRENTOIL), X (Twitter) signals
with a half-life under 4 hours: mentionVelocityRatio (last hour vs the previous 23 h), netNarrativeBias (-1 bearish to +1 bullish), squeezeWarning and top catalysts.
Hard rules: never vote OPEN on a SHORT (short side, or the short leg of a pair) whose ticker has squeezeWarning = true, unless a technical metric of that
candidate clearly contradicts the squeeze, and then cite that metric. Never vote CLOSE on a position opened less than 8 hours ago: the engine enforces an
8-hour exit cooldown and refuses such votes. X data alone is never a reason to open; it can only confirm or veto what the dossier metrics show.`;

export function userPrompt(dossier, portfolio, positions, xContext = null) {
  const cands = dossier.candidates.map(({ id, type, venue, coin, side, title, outcome, category, pocket, score, metrics, whales, long, short }) =>
    ({ id, type, venue, coin, side, title, outcome, category, pocket, score, metrics, long, short, whales: whales?.slice(0, 8) }));
  return JSON.stringify({ portfolio: portfolioView(portfolio), candidates: cands, open_positions: positions, ...(xContext ? { x_epsilon: xContext } : {}) });
}

/* ---------- dépouillement ---------- */

const isOpen = (v) => v.action === "OPEN";

// ballots : [{ model, family, votes: [vote validé] }]. metricsOf(id) → bloc metrics du candidat ou de la position.
export function annotate(ballots, metricsOf) {
  const out = [];
  for (const b of ballots) for (const v of b.votes) {
    const cit = checkCitation(v.cited_risk_metric, metricsOf(v.candidate_id));
    const valid = !(v.action === "REJECT" && !cit.ok);
    out.push({ ...v, model: b.model, provider: b.provider, family: b.family, citation_ok: cit.ok, cited_key: cit.key, valid, invalid_reason: valid ? null : "objection sans métrique chiffrée du dossier" });
  }
  return out;
}

// Seuls les votes à poids non nul comptent : les modèles « ombre » (weight 0) n'alimentent que le PnL contrefactuel.
const counts = (v) => v.valid && v.weight !== 0;

export function tallyCandidate(id, votes, cfg = CONFIG) {
  const vs = votes.filter((v) => v.candidate_id === id && counts(v)), nOpen = vs.filter(isOpen).length, n = vs.length;
  const base = { id, n, nOpen, nAgainst: n - nOpen };
  if (n < cfg.ai.quorum) return { ...base, status: "no_quorum" };
  if (nOpen === n) return { ...base, status: "open", via: "unanimité", conviction: Math.round(vs.reduce((s, v) => s + v.conviction, 0) / n), vote: pick(vs, isOpen) };
  if (nOpen === 0) return { ...base, status: "reject", via: "unanimité" };
  if (n === 2) return { ...base, status: "reject", via: "1 contre 1" };
  return { ...base, status: "arbiter" };
}

export function tallyPosition(id, votes) {
  const vs = votes.filter((v) => v.candidate_id === id && counts(v)), cl = vs.filter((v) => v.action === "CLOSE"), nClose = cl.length;
  return { id, n: vs.length, nClose, close: vs.length > 0 && nClose > vs.length / 2, vote: pick(vs, (v) => v.action === "CLOSE"),
    closeShare: vs.length ? nClose / vs.length : 0, conviction: nClose ? Math.round(cl.reduce((s, v) => s + v.conviction, 0) / nClose) : null };
}

// vote le plus convaincu parmi ceux qui satisfont f (pour reprendre son invalidation et son horizon)
const pick = (vs, f) => vs.filter(f).sort((a, b) => b.conviction - a.conviction)[0] ?? null;

export const ARBITER_PROMPT = `You are the arbiter between three analysts who disagree on one paper trade. Decide OPEN or REJECT.
Ignore any objection that does not cite a numeric metric of the dossier (the field "citation_ok" says whether the code could verify it).
Answer with JSON only: {"candidate_id":"<id>","action":"OPEN|REJECT","conviction":0-100,"reason":"<one or two sentences in French>","cited_metric":"<metric name and value from the dossier>"}`;

/* ---------- décision complète ---------- */

// router : instance de LLMRouter (ou objet compatible : collect, available)
// xContext : résumé du flux ε (x_scraper.promptContext), ou null
export async function decide({ router, dossier, portfolio, markets = {}, now = Date.now(), xContext = null }, cfg = CONFIG) {
  const xc = xContext && Object.keys(xContext).length ? xContext : null;
  const positions = positionsView(portfolio, markets, now);
  const ids = [...dossier.candidates.map((c) => c.id), ...positions.map((p) => p.id)];
  const metricsOf = (id) => dossier.candidates.find((c) => c.id === id)?.metrics ?? positions.find((p) => p.id === id)?.metrics ?? {};
  const at = new Date(now).toISOString(), errors = [], shadowErrors = [];
  if (!ids.length) return { mode: "idle", decisions: [], votes: [], records: [], errors, shadowErrors };
  const messages = [{ role: "system", content: SYSTEM_PROMPT + (xc ? X_RULES : "") }, { role: "user", content: userPrompt(dossier, portfolio, positions, xc) }];
  const check = (json) => { const b = validateBallot(json, ids); return b.ok ? { ok: true, value: b } : { ok: false, error: b.errors.join(" ; ") }; };
  // votants et modèles « ombre » en parallèle ; les seconds ne comptent pas dans les décisions (weight 0)
  const [col, sh] = await Promise.all([router.collect(cfg.ai.voters, messages, check, { role: "voter" }),
    router.collectShadow ? router.collectShadow(messages, check) : { results: [], errors: [] }]);
  // échecs des modèles « ombre » (poids nul) : à part, ils ne polluent pas les problèmes du cycle
  errors.push(...col.errors); shadowErrors.push(...sh.errors);
  const asBallot = (r) => ({ provider: r.provider, model: r.model, family: r.family, votes: r.value.votes });
  const ballots = col.results.map(asBallot);
  const votes = [...annotate(ballots, metricsOf).map((v) => ({ at, ...v, weight: 1 })),
    ...annotate(sh.results.map(asBallot), metricsOf).map((v) => ({ at, ...v, weight: 0, shadowOnly: true }))];
  const mode = ballots.length === 0 ? "fallback" : ballots.length === 1 ? "single" : "vote";
  const decisions = [], records = [];

  for (const p of positions) {
    const t = tallyPosition(p.id, votes);
    if (t.close) decisions.push({ id: p.id, action: "CLOSE", via: `${t.nClose}/${t.n} votes`, reason: t.vote?.invalidation_condition ?? null, closeShare: t.closeShare, conviction: t.conviction });
    records.push({ at, type: "decision", candidate_id: p.id, decision: t.close ? "CLOSE" : "HOLD", n: t.n, nClose: t.nClose, conviction: t.conviction });
  }
  if (mode === "vote") for (const c of dossier.candidates) {
    const t = tallyCandidate(c.id, votes, cfg);
    let decision = t.status === "open" ? "OPEN" : "REJECT", via = t.via ?? t.status, conviction = t.conviction ?? null, vote = t.vote ?? null, arbiter = null;
    if (t.status === "arbiter") {
      const exclude = ballots.map((b) => b.family);
      const arb = await router.collect(1, [{ role: "system", content: ARBITER_PROMPT + (xc ? X_RULES : "") }, { role: "user", content: JSON.stringify({ candidate: c, votes: votes.filter((v) => v.candidate_id === c.id && v.weight !== 0), ...(xc ? { x_epsilon: xc } : {}) }) }],
        (json) => validateArbiter(json, c.id), { excludeFamilies: exclude, role: "arbiter" });
      errors.push(...arb.errors);
      const a = arb.results[0];
      arbiter = a ? { provider: a.provider, model: a.model, family: a.family, ...a.value } : null;
      decision = a?.value.action === "OPEN" ? "OPEN" : "REJECT";
      via = a ? "arbitre" : "arbitre indisponible";
      conviction = a?.value.conviction ?? null;
      vote = pick(votes.filter((v) => v.candidate_id === c.id && counts(v)), isOpen);
    }
    if (decision === "OPEN") decisions.push({ id: c.id, action: "OPEN", via, conviction, horizonH: vote?.horizon_hours ?? null, invalidation: vote?.invalidation_condition ?? null });
    records.push({ at, type: "decision", candidate_id: c.id, decision, via, conviction, n: t.n, nOpen: t.nOpen, arbiter });
  }
  else for (const c of dossier.candidates) records.push({ at, type: "decision", candidate_id: c.id, decision: "REJECT", via: mode === "single" ? "un seul modèle : pas d'ouverture" : "secours : aucun modèle" });
  return { mode, decisions, votes, records, errors, shadowErrors, xInjected: xc ? Object.keys(xc) : [] };
}
