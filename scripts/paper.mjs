// Point d'entrée horaire de l'agent de paper trading (SPEC.md).
//   node scripts/paper.mjs             -> un cycle complet, écrit dans data/paper/
//   node scripts/paper.mjs --dry-run   -> même cycle, n'écrit rien
//   node scripts/paper.mjs --no-net    -> n'appelle aucune API (relevé local seulement)
//   node scripts/paper.mjs --no-llm    -> n'appelle aucun LLM (agent de secours)
//   node scripts/paper.mjs --no-x      -> sans collecte X (flux ε / ∞)
//   node scripts/paper.mjs --x-force   -> collecte X même si la dernière a moins de 45 min (aussi : X_FORCE=true)
//   --data=<dossier>                   -> autre dossier de données que ./data
// Étapes branchées : socle, données, simulateur (funding, résolutions, stops, échéances, valorisation),
// freins de drawdown, notes des baleines, candidats et signaux (data/paper/candidates.json), vote des LLM et exécution,
// PnL contrefactuel par modèle (shadow_book.json) et métriques (metrics.json), collecte X (x_alpha.json) et compétition
// à 3 divisions (leagues.json) dont les champions sont mêlés au vote des LLM (meta-ensemble, router.mjs).
import { Store, DEFAULT_DATA_DIR, FILES, utcNow } from "../lib/paper/store.mjs";
import { loadSnapshot, enrich, fetchPriorSources } from "../lib/paper/loader.mjs";
import { tick } from "../lib/paper/simulator.mjs";
import { emptyScores, updateScores, setPriors, priorsFromHl, priorsFromPm, keyOf } from "../lib/paper/scorer.mjs";
import { gatherHl, gatherPm, finalizeHl, finalizePm, selectCandidates } from "../lib/paper/candidates.mjs";
import { coinSentiment, partnersOf, findPairs, updateHistory, movedMarkets, detectLeadLag } from "../lib/paper/cross.mjs";
import { CONFIG } from "../lib/paper/config.mjs";
import { LLMRouter, metaWeights, mixDecisions, META, DEFAULT_PROVIDERS, discoverOpenRouter, withDiscovered } from "../lib/paper/router.mjs";
import { evaluateMacroRegime, emptyRegimeCache, regimeContext, withRegime, STRESS, REGIME_CFG } from "../lib/paper/regime_agent.mjs";
import { fetchCalendar } from "../lib/alt.mjs";
import { emptyLeagues, admitBlueprints, maybeMutate, defaultMutator, updateLiveMarket, stepLeagues, championSignals, libraryStatus, TICKER_OF, updateLedger } from "../lib/paper/league_engine.mjs";
import { wakeReasons, decide } from "../lib/paper/decision.mjs";
import { executeDecisions } from "../lib/paper/execute.mjs";
import { markToMarket } from "../lib/paper/simulator.mjs";
import { fetchL2Book, fetchOhlc } from "../lib/hl.mjs";
import { fetchBook, fetchGammaMarket } from "../lib/pm.mjs";
import { pmInfoFromSnapshot, resolvePmInfo, annotatePm, withSignalOdds } from "../lib/paper/pminfo.mjs";
import { exitKey } from "../lib/paper/risk.mjs";
import { emptyShadow, addShadows, updateShadows, modelStats } from "../lib/paper/shadow.mjs";
import { summarize } from "../lib/paper/metrics.mjs";
import { borderCandidates, borderNeeds, markSeen } from "../lib/paper/border.mjs";
import { runXAlpha, promptContext, compileLibrary, blueprintExtractor } from "../lib/paper/x_scraper.mjs";
import { emptyRanking, rankModels, updateHealth, recordCycle } from "../lib/paper/llm_ranking.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run"), noNet = args.includes("--no-net"), noLlm = args.includes("--no-llm"), noX = args.includes("--no-x");
const dataDir = args.find((a) => a.startsWith("--data="))?.slice(7) || DEFAULT_DATA_DIR;
const PRIORS_EVERY = 24 * 3600e3;

const now = Date.now();
const store = new Store(dataDir);
const portfolio = await store.loadPortfolio();
let scores = (await store.readJson(FILES.whaleScores)) ?? emptyScores(now);
const snap = await loadSnapshot(dataDir, now);
let shadow = (await store.readJson(FILES.shadow)) ?? emptyShadow();
const borderFile = await store.readJson(FILES.border).catch((e) => ({ proposals: [], error: e.message }));   // écrit par la tâche Claude (branche border)
const borderSeen = portfolio.borderSeen || [], bNeeds = borderNeeds(borderFile, borderSeen);

// données utiles : positions ouvertes de l'agent + marchés des baleines Polymarket fermées depuis le dernier cycle
const open = portfolio.positions || [];
const coins = open.filter((p) => p.venue === "hl").map((p) => p.coin);
const tokens = [...open.filter((p) => p.venue === "pm").map((p) => p.token), ...bNeeds.tokens];
const newPmCloses = snap.events.filter((e) => e.t > scores.cursor && e.kind === "close" && e.src === "pm" && e.cid);
const cids = [...open.filter((p) => p.venue === "pm").map((p) => p.cid), ...newPmCloses.map((e) => e.cid), ...shadow.open.filter((s) => s.venue === "pm").map((s) => s.cid)];
const extra = noNet ? { markets: {}, hlBooks: {}, pmBooks: {}, resolutions: {}, errors: [] } : await enrich({ coins, tokens, cids });
const problems = [...snap.problems, ...extra.errors];

// notes des baleines : poids de départ une fois par jour (baleines du relevé seulement), puis fermetures récentes
if (!noNet && (!scores.priorsAt || now - Date.parse(scores.priorsAt) > PRIORS_EVERY) && (snap.hl.length || snap.pm.length)) {
  const src = await fetchPriorSources();
  const known = new Set([...snap.hl.map((a) => keyOf("hl", a.addr)), ...snap.pm.map((w) => keyOf("pm", w.addr))]);
  const all = { ...priorsFromHl(src.hlRows), ...priorsFromPm(src.pmBoards) };
  scores = { ...setPriors(scores, Object.fromEntries(Object.entries(all).filter(([k]) => known.has(k)))), priorsAt: new Date(now).toISOString() };
  problems.push(...src.errors);
}
const sc = updateScores(scores, snap.events, { resolutions: extra.resolutions });
scores = sc.scores;

const t = tick(portfolio, extra, now);

// positions fantômes des modèles : sorties (stop, horizon, résolution) avant les nouveaux votes
const pmPrices = {};
for (const w of snap.pm) for (const q of w.positions) if (q.cid && q.price > 0) pmPrices[`${q.cid}|${q.outcome}`] = q.price;
const sh = updateShadows(shadow, { markets: extra.markets, resolutions: extra.resolutions, pmPrices }, now);
shadow = sh.book;

// candidats (SPEC §3) : regroupement et convergence sans réseau, puis ATR pour les meilleurs groupes seulement
const ghl = gatherHl(snap, scores, now), gpm = gatherPm(snap, scores, now);
const history = updateHistory(await store.readJson(FILES.history), snap, extra.markets, now);
const moved = movedMarkets(history, now), pre = ghl.pass.slice(0, CONFIG.signals.prefilterMax);
const atrCoins = [...pre.map((g) => g.coin), ...pre.flatMap((g) => partnersOf(g.coin)), ...moved.map((m) => m.coin), ...bNeeds.coins];
const ex2 = noNet || !atrCoins.length ? { ohlc: {}, errors: [] } : await enrich({ atrCoins, markets: extra.markets });
problems.push(...ex2.errors);
const data = { markets: extra.markets, ohlc: { ...extra.ohlc, ...ex2.ohlc } };
const rejected = [...ghl.rejected, ...gpm.rejected, ...ghl.pass.slice(CONFIG.signals.prefilterMax).map((g) => ({ id: g.id, reason: "hors des groupes préfiltrés" }))];
const hlFinal = [], pmFinal = [];
for (const g of pre) { const r = finalizeHl(g, data, snap.hl); r.ok ? hlFinal.push(r.cand) : rejected.push({ id: r.id, reason: r.reason }); }
for (const g of gpm.pass) { const r = finalizePm(g, now); r.ok ? pmFinal.push(r.cand) : rejected.push({ id: r.id, reason: r.reason }); }
const pairs = findPairs(hlFinal, coinSentiment(ghl.all), data.ohlc, data.markets);
const ll = detectLeadLag(history, data.ohlc, now);
rejected.push(...ll.rejected);
const sel = selectCandidates([...hlFinal, ...pmFinal, ...pairs, ...ll.candidates], t.portfolio);
const border = borderCandidates(borderFile, borderSeen, { markets: extra.markets, ohlc: data.ohlc, pmBooks: extra.pmBooks }, now);   // en plus des 5 meilleurs
if (borderFile?.error) problems.push(`border_proposals.json : ${borderFile.error}`);
const dossier = { at: new Date(now).toISOString(), wakeLLM: sel.wakeLLM || border.candidates.length > 0, minScore: CONFIG.signals.minScore,
  candidates: [...sel.candidates, ...border.candidates], rejected: [...sel.rejected, ...border.rejected, ...rejected].slice(0, 80) };
problems.push(...t.problems);

// intitulés lisibles des marchés Polymarket (titre, échéance, lien) : candidats, positions ouvertes, et rattrapage des
// lignes récentes de l'historique et des votes (la page relit pm_markets.json pour celles écrites sans intitulé)
const pastTrades = await store.readJsonl(FILES.trades), pastVotes = (await store.readJsonl(FILES.votes)).slice(-1000);
const pmWanted = [...t.portfolio.positions, ...dossier.candidates, ...dossier.rejected, ...pastTrades.slice(-500), ...pastVotes.filter((v) => v.type === "decision")];
const pmi = await resolvePmInfo(pmWanted, await store.readJson(FILES.pmMarkets), { known: pmInfoFromSnapshot(snap, history), fetchGamma: noNet ? null : fetchGammaMarket, now });
problems.push(...pmi.errors);
dossier.candidates = dossier.candidates.map((c) => annotatePm(c, pmi.cache));

// X (Twitter) : flux ε (contexte des votants, demi-vie < 4 h) et flux ∞ (Blueprints de stratégies). Jamais bloquant.
const prevX = await store.readJson(FILES.xAlpha).catch(() => null);
const xForce = args.includes("--x-force") || /^(1|true)$/i.test(process.env.X_FORCE || "");
// Blueprints compilés APRÈS le vote (compileLibrary, plus bas) : le quota par minute de Groq reste aux votants
const xr = noX ? { alpha: prevX, cache: null } : await runXAlpha({ prev: prevX, cache: (await store.readJson(FILES.xCache).catch(() => null)) ?? {}, now, net: !noNet, force: xForce,
  extract: noNet || noLlm ? null : undefined, deferCompile: !noNet && !noLlm }).catch((e) => { problems.push(`X : ${e.message || e}`); return { alpha: prevX, cache: null }; });
const xContext = xr.alpha ? promptContext(xr.alpha.epsilon?.tickers, now) : null;

// classement dynamique des modèles (shadow_book.json) : rang et poids cible (4 % à 30 %) de tous les modèles actifs,
// recalculé à chaque cycle ; poids du cycle et causes d'échec après le vote (recordCycle). Le meilleur votant actif
// sert aussi à la synthèse du régime macro.
// votants gratuits d'OpenRouter : découverts dans le catalogue public (gardé 6 h), les identifiants « :free » changeant souvent
let orModels = [], orCache = (await store.readJson(FILES.openrouterModels).catch(() => null)) ?? null;
if (process.env.OPENROUTER_API_KEY && !process.env.PAPER_LLM_PROVIDERS) {
  const od = await discoverOpenRouter({ cache: orCache, now, net: !noNet && !noLlm });
  orModels = od.models; orCache = od.cache;
  if (od.error) problems.push(od.models.length ? `${od.error} (liste en cache gardée)` : od.error);
}
const llmRouter = new LLMRouter(process.env.PAPER_LLM_PROVIDERS ? {} : { providers: withDiscovered(DEFAULT_PROVIDERS, orModels) });
const rankPrev = (await store.readJson(FILES.llmRanking).catch(() => null)) ?? emptyRanking();
let ranking = rankModels({ models: llmRouter.rankable(), book: shadow, state: rankPrev, now });

// Compétition à 3 divisions : D1 (labo synthétique) pour les nouveaux Blueprints du Flux ∞, mutation Gen-2 périodique,
// D2 et D3 sur les vrais prix horaires. Jamais bloquant : une erreur laisse les ligues en l'état.
let leagues = (await store.readJson(FILES.leagues).catch(() => null)) ?? emptyLeagues();
let live = (await store.readJson(FILES.leagueMarket).catch(() => null)) ?? { series: {} };
try {
  const candles = {};
  if (!noNet) for (const [coin, T] of Object.entries(TICKER_OF)) if ((live.series[T]?.c.length ?? 0) < 200) {
    try { candles[T] = await fetchOhlc(coin, "1h", 21); } catch (e) { problems.push(`ligues : bougies ${coin} : ${e.message || e}`); }
  }
  live = updateLiveMarket(live, { markets: extra.markets, xTickers: xr.alpha?.epsilon?.tickers, history, now, candles });
} catch (e) { problems.push(`ligues : prix live : ${e.message || e}`); }

// Méta-Agent de Régime Macro : calendrier économique, volatilité / funding / Flux ε, synthèse LLM (cache 2 h). Il décide
// quelles familles de stratégies D2/D3 sont autorisées et règle le risque des nouvelles ouvertures. Jamais bloquant.
let regimeCache = (await store.readJson(FILES.regimeCache).catch(() => null)) ?? emptyRegimeCache(), regime = null;
try {
  const rr = await evaluateMacroRegime({ fetchCalendar: noNet ? null : fetchCalendar, live, markets: extra.markets, epsilon: xr.alpha?.epsilon?.tickers,
    router: noNet || noLlm || !llmRouter.available().length ? null : llmRouter, ranking, cache: regimeCache, now });
  regime = rr.regime; regimeCache = rr.cache;
  for (const n of regime.notes) problems.push(`régime : ${n}`);
} catch (e) { problems.push(`régime : ${e.message || e}`); }
const stress = STRESS.includes(regime?.regime);

try {
  leagues = admitBlueprints(leagues, xr.alpha?.infinity?.blueprints, { now });
  leagues = await maybeMutate(leagues, { now, mutator: noNet || noLlm ? null : defaultMutator() });
  leagues = stepLeagues(leagues, live, { now, regime });
} catch (e) { problems.push(`ligues : ${e.message || e}`); }
const champions = championSignals(leagues, live, regime);
// en stress, le meta-ensemble relève aussi sa conviction minimale (60 → 70)
const metaCfg = stress ? { ...META, minConviction: REGIME_CFG.stressRisk.minConviction } : META;
leagues.meta = { at: new Date(now).toISOString(), regime: regime?.regime ?? null, ...metaWeights(champions, t.portfolio, metaCfg) };
// carnet permanent : relu, fusionné avec l'état des ligues de ce cycle (jamais de suppression), réécrit
let ledger = null;
try { ledger = updateLedger(await store.readJson(FILES.ledger).catch(() => null), leagues, now); } catch (e) { problems.push(`carnet des stratégies : ${e.message || e}`); }
if (xr.alpha?.infinity?.blueprints) {   // statut des Blueprints dans la bibliothèque ∞
  const status = libraryStatus(leagues);
  xr.alpha.infinity.blueprints = xr.alpha.infinity.blueprints.map((b) => (status[b.id] ? { ...b, status: status[b.id] } : b));
}

// IA (SPEC §4) : réveillée seulement sur événement ; l'exécution passe par le moteur de risque puis le simulateur
let p = t.portfolio, point = t.point;
const trades = [...t.trades], votesLog = [];
const wake = wakeReasons({ dossier, portfolio: p, markets: extra.markets, now });
const ai = { wake, mode: noNet || noLlm ? "désactivé" : wake.length ? null : "en veille", decisions: [], refused: [], models: [] };
if (!ai.mode) {
  const router = llmRouter;
  if (!router.available().length) { ai.mode = "secours"; problems.push("aucune clé LLM (DEEPSEEK_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY) : agent de secours, aucune ouverture"); }
  else {
    const d = await decide({ router, dossier, portfolio: p, markets: extra.markets, now, xContext, ranking, regime: regimeContext(regime) });
    ranking = recordCycle({ ...ranking, health: updateHealth(ranking.health, router.log, now) }, d.weights ?? {}, router.log);
    if (xr.alpha && d.mode !== "fallback") xr.alpha.epsilon.router = { injected: d.xInjected.length > 0, at: new Date(now).toISOString(), tickers: d.xInjected };
    const exits = {};   // dernière fermeture complète par actif ou marché (délai de ré-entrée)
    for (const x of [...pastTrades, ...t.trades]) if (x.type === "close" || x.type === "settle") exits[exitKey(x)] = x.at;
    // meta-ensemble : les champions de D3 pèsent 35 % de la conviction des ouvertures sur les actifs qu'ils couvrent
    const mix = mixDecisions(d.decisions, dossier, champions, metaWeights(champions, p, metaCfg), { tickerOf: (c) => TICKER_OF[c], cfg: metaCfg });
    leagues.meta = { ...leagues.meta, ...metaWeights(champions, p, metaCfg), mixed: mix.mixed, vetoed: mix.vetoed };
    // régime de stress : taille × 0,5 et conviction minimale 70 pour toute nouvelle ouverture (risk.mjs)
    const ex = await executeDecisions(p, mix.decisions, dossier, { markets: extra.markets, deps: { fetchL2Book, fetchBook }, now, exits }, withRegime(CONFIG, regime));
    ex.refused.push(...mix.vetoed);
    if (mix.mixed.length) votesLog.push(...mix.mixed.map((m) => ({ at: new Date(now).toISOString(), type: "meta", candidate_id: m.id, ...m })));
    p = ex.portfolio; trades.push(...ex.trades); votesLog.push(...d.votes, ...d.records);
    shadow = addShadows(shadow, d.votes, dossier, now).book;
    if (d.mode !== "fallback") p = { ...p, borderSeen: markSeen(borderSeen, border.candidates.map((c) => c.proposalId)) };   // une proposition n'est votée qu'une fois
    Object.assign(ai, { mode: d.mode, decisions: d.decisions.map((x) => `${x.action} ${x.id} (${x.via})`), refused: ex.refused, models: router.log, shadowErrors: d.shadowErrors ?? [], weights: d.weights });
    problems.push(...d.errors);
    if (d.mode !== "fallback" && wake.includes("revue quotidienne")) p = { ...p, lastReviewDay: new Date(now).toISOString().slice(0, 10) };
    if (ex.trades.length) { const m = markToMarket(p, { markets: extra.markets, pmBooks: extra.pmBooks }, now); p = m.portfolio; point = { ...m.point, mode: p.mode }; }
  }
}
// Flux ∞ : compilation des Blueprints en attente, après le vote (deepseek-flash d'abord, puis Groq, puis openrouter/free).
// Les nouveaux Blueprints entrent en Division 1 au cycle suivant. Jamais bloquant.
if (!noX && !noNet && !noLlm && xr.alpha && xr.cache) {
  try { const cr = await compileLibrary(xr.alpha, xr.cache, blueprintExtractor(), { now }); xr.alpha = cr.alpha; xr.cache = cr.cache; }
  catch (e) { problems.push(`X : compilation des Blueprints : ${e.message || e}`); }
}
// y compris les positions ouvertes avant cette mise à jour ; cote du signal à l'entrée (candidat du cycle, sinon historique) et maintenant
const entryOdds = (x) => dossier.candidates.find((c) => c.id === x.candidateId)?.metrics?.pm_price ?? null;
const odds = (x) => withSignalOdds(annotatePm(x, pmi.cache), { history, pmPrices, entry: x.openedAt === new Date(now).toISOString() || x.at === new Date(now).toISOString() ? entryOdds(x) : null });
p = { ...p, positions: p.positions.map(odds) };
trades.splice(0, trades.length, ...trades.map(odds));
votesLog.splice(0, votesLog.length, ...votesLog.map((x) => annotatePm(x, pmi.cache)));
const next = { ...p, lastTick: utcNow(), ticks: (portfolio.ticks || 0) + 1 };
point = { ...point, bench: { BTC: extra.markets.BTC?.mark ?? null, GOLD: extra.markets["xyz:GOLD"]?.mark ?? null } };   // références passives (SPEC §7)

// métriques sur tout l'historique (SPEC §7)
const metrics = summarize({ points: [...(await store.readJsonl(FILES.equity)), point], trades: [...pastTrades, ...trades],
  shadow: modelStats(shadow, extra.markets), startCapital: next.startCapital });
// régime macro publié (metrics.json pour Paper trading, x_alpha.json pour X Alpha / 3-League Arena)
const regimePub = regime ? { at: regime.at, regime: regime.regime, label: regime.label, source: regime.source, confidence: regime.confidence, hard: regime.hard, reasons: regime.reasons,
  llm: regime.llm, calendar: regime.calendar, policy: regime.policy, risk: regime.risk, metrics: regime.metrics, eps: regime.eps } : null;
metrics.regime = regimePub;
if (xr.alpha) xr.alpha.regime = regimePub;

const summary = {
  at: next.lastTick, dryRun: dry,
  snapshot: { ageMin: snap.ageMin == null ? null : Math.round(snap.ageMin), fresh: snap.fresh, hl: snap.hl.length, pm: snap.pm.length, events: snap.events.length },
  portfolio: { equity: point.equity, cash: point.cash, drawdown: point.drawdown, positions: next.positions.length, mode: next.mode },
  trades: trades.map((x) => `${x.type} ${x.id || ""} ${x.coin || x.title || x.token || x.to || ""} ${x.reason || ""} pnl=${x.pnl == null ? "-" : x.pnl.toFixed(2)}`),
  funding: t.funding.length,
  candidates: { kept: sel.candidates.map((c) => `${c.id} score=${c.score}`), wakeLLM: sel.wakeLLM, rejected: dossier.rejected.length },
  ai,
  regime: regime ? { regime: regime.regime, source: regime.source, reasons: regime.reasons, next: regime.calendar.next, cut: regime.policy.cut, risk: regime.risk } : null,
  openrouter: orModels.map((m) => m.id),
  ranking: { active: ranking.active.length, target: ranking.target, cycle: ranking.applied ?? null, silent: ranking.models.filter((m) => m.cycleError).map((m) => `${m.model} : ${m.cycleError.code}`) },
  metrics: { sharpe: metrics.performance.sharpe, maxDrawdown: metrics.performance.maxDrawdown, closedTrades: metrics.trades.closed, shadowOpen: shadow.open.length, shadowClosed: sh.closed.length },
  leagues: { d1q: leagues.entries.filter((e) => e.division === "D1Q").length, d2: leagues.entries.filter((e) => e.division === "D2").length,
    d3: leagues.entries.filter((e) => e.division === "D3").length, out: leagues.entries.filter((e) => e.division === "OUT").length, ledger: ledger?.strategies?.length ?? null, llmWeight: leagues.meta?.llm, log: leagues.log.slice(0, 5).map((l) => l.msg) },
  x: xr.alpha ? { status: xr.alpha.status, notes: xr.alpha.notes, collectedAt: xr.alpha.collectedAt, epsilon: Object.keys(xContext || {}), blueprints: xr.alpha.infinity?.blueprints?.length ?? 0, stats: xr.alpha.stats } : "désactivé",
  whales: { tracked: Object.keys(scores.whales).length, newOutcomes: sc.applied.length, skipped: sc.skipped.length, warmupEndsAt: scores.warmupEndsAt },
  enrich: noNet ? "désactivé" : { markets: Object.keys(extra.markets).length, hlBooks: Object.keys(extra.hlBooks).length, pmBooks: Object.keys(extra.pmBooks).length, resolutions: Object.keys(extra.resolutions).length, pmTitles: Object.keys(pmi.cache).length, gammaCalls: pmi.calls },
  problems,
};
console.log(JSON.stringify(summary, null, 1));

if (!dry) {
  await store.appendJsonl(FILES.trades, trades);
  await store.appendJsonl(FILES.equity, point);
  await store.appendJsonl(FILES.votes, votesLog);
  await store.writeJson(FILES.whaleScores, scores);
  await store.writeJson(FILES.history, history);
  await store.writeJson(FILES.candidates, dossier);
  await store.writeJson(FILES.shadow, shadow);
  await store.writeJson(FILES.metrics, metrics);
  await store.writeJson(FILES.pmMarkets, pmi.cache);
  await store.writeJson(FILES.leagues, leagues);
  await store.writeJson(FILES.leagueMarket, live);
  if (ledger) await store.writeJson(FILES.ledger, ledger);
  await store.writeJson(FILES.llmRanking, ranking);
  if (orCache) await store.writeJson(FILES.openrouterModels, orCache);
  await store.writeJson(FILES.regimeCache, regimeCache);
  if (xr.alpha && !noX) {
    if (xr.alpha.epsilon && !xr.alpha.epsilon.router.at && prevX?.epsilon?.router?.at) xr.alpha.epsilon.router = prevX.epsilon.router;   // dernier réveil connu
    await store.writeJson(FILES.xAlpha, xr.alpha);
  }
  if (xr.cache) await store.writeJson(FILES.xCache, xr.cache);
  await store.savePortfolio(next);
}
