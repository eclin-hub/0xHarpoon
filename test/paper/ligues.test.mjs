// Compétition à 3 divisions : compilation des Blueprints, marché synthétique, promotions, relégations, meta-ensemble.
import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceBlueprint, validateBlueprint, BLUEPRINT_PROMPT_V } from "../../lib/paper/blueprint.mjs";
import { blueprintExtractor, runXAlpha, updateLibrary, ingest, X_CONFIG } from "../../lib/paper/x_scraper.mjs";
import { generateScenario, runSyntheticBenchmark, GJR } from "../../lib/paper/synthetic_market.mjs";
import { newBook } from "../../lib/paper/blueprint_eval.mjs";
import { emptyLeagues, admitBlueprints, stepLeagues, maybeMutate, defaultMutator, championSignals, libraryStatus, updateLiveMarket, d1Verdict, LEAGUE } from "../../lib/paper/league_engine.mjs";
import { metaWeights, mixDecisions, DEFAULT_PROVIDERS } from "../../lib/paper/router.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3;
const BP = { name: "Retour à la moyenne", thesis: "z-score et RSI.", universe: ["BTC", "ETH"], side: "both", horizon_hours: 24,
  blocks: [{ type: "bollinger_zscore", weight: 0.6, params: { period: 20, z: 2 } }, { type: "rsi", weight: 0.4, params: { period: 14, low: 30, high: 70 } }],
  entry: { score_above: 0.3 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 24 } };
const lib = (id, src = "arxiv", bp = BP) => ({ id, name: bp.name, status: "En attente D1", blueprint: bp, source: { src, author: "A. Martin et al.", url: `https://arxiv.org/abs/${id}` } });
const PASS = () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 });
const FAIL = () => ({ trades: 40, profitFactor: 0.9, winRate: 0.45, maxDrawdown: 0.2, sharpe: -1, psr: 0.2, stressSurvivalRate: 0.4 });

/* ---------- compilation des Blueprints ---------- */

test("compilation : JSON presque correct normalisé (alias, bornes, champs inconnus) ; qwen3.8 essayé en premier", async () => {
  const raw = { name: "Momentum crypto", thesis: "Suivre la tendance.", universe: ["bitcoin", "xyz:NVDA", "DOGE"], side: "LONG", horizon_hours: 5000,
    blocks: [{ type: "Bollinger", weight: 3, params: { period: 20, z: 9, color: "red" } }, { type: "eval", weight: 1 }, { type: "ml", weight: 0.5, params: { features: ["funding", "magic"], coefs: [-2, 1] } }],
    entry: 0.4, exit: { stop_atr: 0.1, max_hold_hours: 48 }, code: "rm -rf /" };
  const v = validateBlueprint(coerceBlueprint(raw));
  assert.equal(v.ok, true, v.errors?.join());
  assert.deepEqual(v.value.universe, ["BTC", "NVDA", "DOGE"]);   // univers élargi : DOGE (Hyperliquid) accepté assert.equal(v.value.side, "long"); assert.equal(v.value.horizon_hours, 720);
  assert.deepEqual(v.value.blocks.map((b) => [b.type, b.weight]), [["bollinger_zscore", 1], ["linear_ml_score", 0.5]]);
  assert.deepEqual(v.value.blocks[0].params, { period: 20, z: 4 }); assert.deepEqual(v.value.blocks[1].params, { features: ["funding"], coefs: [-2] });
  assert.equal(v.value.entry.score_above, 0.4); assert.equal(v.value.exit.stop_atr, 0.5); assert.equal(v.value.code, undefined);
  assert.equal(validateBlueprint(coerceBlueprint({ name: "x", thesis: "y", universe: ["!!"], blocks: [{ type: "rsi", weight: 1 }] })).ok, false);   // aucun actif utilisable : refusé
  const order = [];
  const f = async (url, init) => { const m = JSON.parse(init.body).model; order.push(m); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(m.startsWith("qwen") ? { nope: 1 } : raw) } }] }), { status: 200 }); };
  const ex = blueprintExtractor({ env: { GROQ_API_KEY: "k" }, fetch: f });
  const r = await ex({ author: "a", text: "thread" });
  assert.deepEqual(order, ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"]); assert.equal(r.model, "openai/gpt-oss-120b"); assert.equal(r.blueprint.universe[0], "BTC");
});

test("compilation : abstracts arXiv et posts X en attente compilés même quand la collecte est réutilisée ; bibliothèque vide → quota relevé", async () => {
  const posts = {};
  for (let k = 0; k < 8; k++) posts[`arxiv:26${k}`] = { id: `arxiv:26${k}`, kind: "infinity", interest: 80, src: "arxiv", author: "B", text: "Factor model for momentum.", t: NOW - H, url: null };
  posts["x1"] = { id: "x1", kind: "infinity", interest: 90, src: "x", author: "quant", text: "thread", t: NOW - H, url: "https://x.com/quant/status/1" };
  const prev = { source: "twitter-cli", collectedAt: new Date(NOW - 10 * 60e3).toISOString(), stats: { infinity: 9 }, epsilon: { tickers: {} }, infinity: { blueprints: [] } };
  let calls = 0;
  const { alpha } = await runXAlpha({ prev, cache: { posts }, env: {}, free: false, now: NOW, exec: async () => { throw new Error("X ne doit pas être appelé"); },
    extract: async () => { calls++; return { blueprint: BP, model: "qwen/qwen3.8-27b" }; } });
  assert.match(alpha.status, /^réutilisé/);
  assert.equal(calls, 6); assert.equal(alpha.infinity.blueprints.length, 6); assert.equal(alpha.infinity.pending, 3);   // bibliothèque vide : 6 au lieu de 3
  assert.equal(alpha.infinity.blueprints.at(-1).source.src, "x");                                                      // le post X (intérêt 90) passe en premier
  const next = await updateLibrary(alpha.infinity.blueprints, { posts, done: Object.fromEntries(alpha.infinity.blueprints.map((b) => [b.source.postId, "x"])) }, async () => ({ blueprint: BP }), { now: NOW });
  assert.equal(next.library.length, 9);   // ensuite 3 par cycle
});

test("compilation : seuil arXiv 60 (abstracts q-fin déjà filtrés) contre 75 pour X ; chaque échec ou rejet tracé dans x.notes", async () => {
  const P = (id, src, interest) => ({ id, kind: "infinity", interest, src, author: src === "arxiv" ? "A. Martin et al." : "quant", text: "GARCH volatility regime with momentum filter.", t: NOW - H, url: null });
  const posts = { "arxiv:a": P("arxiv:a", "arxiv", 66), "arxiv:b": P("arxiv:b", "arxiv", 62), "arxiv:c": P("arxiv:c", "arxiv", 58), x1: P("x1", "x", 70) };
  // cycle du 28/11/2026 00:10 UTC : infinity 11, blueprints 0 — avec l'ancien seuil unique (75), rien n'était tenté
  const old = await updateLibrary([], { posts }, async () => ({ blueprint: BP }), { now: NOW, cfg: { ...X_CONFIG, interestMinArxiv: undefined } });
  assert.equal(old.library.length, 0); assert.match(old.notes[0], /4 post\(s\) ∞ en attente, aucun au seuil \(max 70/);
  // nouveau seuil : les deux arXiv ≥ 60 sont compilés ; arXiv 58 et X 70 attendent
  const seen = [];
  const r = await updateLibrary([], { posts }, async (p) => { seen.push(p.id); return p.id === "arxiv:b" ? { error: "groq/qwen/qwen3.8-27b : réponse invalide : universe : tickers parmi BTC | groq/openai/gpt-oss-120b : HTTP 429 : rate limit" } : { blueprint: BP, model: "qwen/qwen3.8-27b" }; }, { now: NOW });
  assert.deepEqual(seen, ["arxiv:a", "arxiv:b"]);
  assert.deepEqual(r.library.map((b) => b.source.postId), ["arxiv:a"]);
  assert.ok(r.notes.some((n) => /Blueprint échoué, arXiv A\. Martin et al\. \(arxiv:b, intérêt 62\) : groq\/qwen.*réponse invalide.*\| groq\/openai\/gpt-oss-120b : HTTP 429/.test(n)), r.notes.join(" / "));
  assert.ok(r.notes.some((n) => /1 compilé\(s\), 0 sans règle testable, 1 échec\(s\) sur 2 tenté\(s\)/.test(n)));
  // {"none":true} : tracé aussi ; pas de traducteur : dit pourquoi
  const none = await updateLibrary([], { posts: { "arxiv:a": posts["arxiv:a"] } }, async () => ({ blueprint: null }), { now: NOW });
  assert.match(none.notes[0], /Blueprint écarté.*aucune règle testable/);
  assert.match((await updateLibrary([], { posts }, null, { now: NOW })).notes[0], /traducteur indisponible/);
  // de bout en bout : les notes remontent dans x.notes et les Blueprints compilés entrent en Division 1
  const { alpha } = await runXAlpha({ cache: { posts }, env: {}, free: false, net: false, now: NOW, extract: async () => ({ blueprint: BP, model: "openai/gpt-oss-120b" }) });
  assert.equal(alpha.infinity.blueprints.length, 2); assert.equal(alpha.infinity.interestMinArxiv, 60);
  assert.ok(alpha.notes.some((n) => /2 compilé\(s\)/.test(n)));
  const st = admitBlueprints(emptyLeagues(), alpha.infinity.blueprints, { now: NOW, bench: PASS });
  assert.equal(st.entries.length, 2); assert.ok(st.entries.every((e) => e.src === "arxiv" && e.gen === "Gen-1"));
});

test("compilation : {\"none\":true} de qwen3.8 → gpt-oss-120b essayé ; écarté seulement si tous le disent ; prompt v2 → anciens rejets réessayés ; arXiv de 15 jours gardé", async () => {
  const BPJ = JSON.stringify(BP), order = [];
  const reply = (fn) => async (url, init) => { const m = JSON.parse(init.body).model, body = JSON.parse(init.body); order.push(m);
    return new Response(JSON.stringify({ choices: [{ message: { content: fn(m, body) } }] }), { status: 200 }); };
  const post = { id: "arxiv:1", src: "arxiv", author: "A", text: "GARCH volatility forecasting." };
  const ex = blueprintExtractor({ env: { GROQ_API_KEY: "k" }, fetch: reply((m, b) => { assert.equal(JSON.parse(b.messages[1].content).source, "arxiv"); return m.startsWith("qwen") ? '{"none":true}' : BPJ; }) });
  const r = await ex(post);
  assert.deepEqual(order, ["qwen/qwen3.8-27b", "openai/gpt-oss-120b"]); assert.equal(r.model, "openai/gpt-oss-120b"); assert.equal(r.blueprint.name, BP.name);
  const both = await blueprintExtractor({ env: { GROQ_API_KEY: "k" }, fetch: reply(() => '{"none":true}') })(post);
  assert.equal(both.blueprint, null); assert.equal(both.error, undefined); assert.match(both.reason, /qwen.*aucune règle testable.*\| .*gpt-oss-120b.*aucune règle testable/);
  // état réel du 28/11/2026 : 3 abstracts « done » sans Blueprint (prompt v1) → réessayés une fois avec le prompt v2
  const P = (id) => ({ id, kind: "infinity", interest: 78, src: "arxiv", author: "B", text: "Deep factor model for statistical arbitrage.", t: NOW - 3 * 24 * H, url: null });
  const cache = { posts: { a: P("a"), b: P("b"), c: P("c") }, done: { a: "2026-11-27T23:24:31Z", b: "2026-11-27T23:24:31Z", c: "2026-11-27T23:24:31Z" } };
  const up = await updateLibrary([], cache, async () => ({ blueprint: BP, model: "qwen/qwen3.8-27b" }), { now: NOW });
  assert.equal(up.library.length, 3); assert.equal(up.cache.doneV, BLUEPRINT_PROMPT_V); assert.match(up.notes[0], /3 post\(s\) écarté\(s\) auparavant réessayé/);
  assert.equal((await updateLibrary(up.library, up.cache, async () => ({ blueprint: BP }), { now: NOW })).library.length, 3);   // pas de seconde reprise
  // un abstract arXiv de 15 jours reste dans le cache (le flux couvre ~3 semaines)
  const old = { id: "arxiv:2611.14245v1", text: "Momentum and mean reversion in cryptocurrency factor models with GARCH volatility regimes.", author: "C", createdAt: new Date(NOW - 15 * 24 * H).toISOString(), src: "arxiv" };
  const ing = ingest([old], {}, { env: {}, now: NOW });
  assert.equal(ing.stats.infinity, 1); assert.ok(ing.cache.posts["arxiv:2611.14245v1"]);
});

/* ---------- marché synthétique ---------- */

const logRets = (c) => c.slice(1).map((x, i) => Math.log(x / c[i]));
test("marché synthétique : déterministe, GJR-GARCH (grappes et asymétrie), sauts (queues épaisses), régimes et séries annexes", () => {
  const a = generateScenario(42, { bars: 2000 }), b = generateScenario(42, { bars: 2000 });
  assert.deepEqual(a.series.BTC.c.slice(0, 50), b.series.BTC.c.slice(0, 50));
  assert.notDeepEqual(generateScenario(43, { bars: 200 }).series.BTC.c.slice(1, 20), a.series.BTC.c.slice(1, 20));
  assert.ok(GJR.alpha + GJR.gamma / 2 + GJR.beta < 1);                                     // stationnaire
  assert.deepEqual([...new Set(a.regimes)].sort(), ["bear", "bull", "crisis", "range"]);
  let clus = 0, nAll = 0, upNext = 0, nUp = 0, dnNext = 0, nDn = 0, kurt = 0;
  for (const T of ["BTC", "ETH", "SOL", "HYPE"]) {
    const r = logRets(a.series[T].c), r2 = r.map((x) => x * x), m2 = r2.reduce((x, y) => x + y) / r2.length;
    for (let i = 1; i < r.length; i++) { clus += (r2[i] - m2) * (r2[i - 1] - m2); nAll++; if (r[i - 1] < 0) { dnNext += r2[i]; nDn++; } else { upNext += r2[i]; nUp++; } }
    kurt += r.reduce((x, y) => x + y ** 4, 0) / r.length / m2 ** 2;
  }
  assert.ok(clus / nAll > 0, "autocorrélation des carrés > 0 (grappes de volatilité)");
  assert.ok(dnNext / nDn > upNext / nUp, "variance plus forte après un choc baissier (effet levier GJR)");
  assert.ok(kurt / 4 > 4, `kurtosis ${kurt / 4} > 4 (sauts)`);
  // la crise est plus volatile que le range
  const r = logRets(a.series.BTC.c), vol = (g) => { const x = r.filter((_, i) => a.regimes[i + 1] === g); return Math.sqrt(x.reduce((s, y) => s + y * y, 0) / x.length); };
  assert.ok(vol("crisis") > 1.8 * vol("range"), `crise ${vol("crisis")} contre range ${vol("range")}`);
  const s = a.series.HYPE;
  for (const k of ["c", "h", "l", "funding", "xVel", "xBias", "pm", "t"]) assert.equal(s[k].length, 2000, k);
  assert.ok(s.h.every((h, i) => h >= s.c[i] && s.l[i] <= s.c[i]));
});

test("runSyntheticBenchmark : 5 scénarios de 500 barres, métriques complètes ; un signal en avance est qualifié, un Blueprint naïf non", () => {
  const edge = { ...BP, name: "Avance Polymarket", universe: ["BTC", "ETH", "SOL", "HYPE"], horizon_hours: 6, blocks: [{ type: "polymarket_edge", weight: 1, params: { min_move: 0.1 } }],
    exit: { stop_atr: 1.5, take_profit_atr: 2, max_hold_hours: 6 } };
  const m = runSyntheticBenchmark(edge);
  assert.equal(m.scenarios.length, 5);
  for (const k of ["profitFactor", "winRate", "maxDrawdown", "sharpe", "psr", "stressSurvivalRate"]) assert.ok(Number.isFinite(m[k]), k);
  assert.equal(d1Verdict(m).pass, true, d1Verdict(m).why.join());
  const naive = runSyntheticBenchmark({ ...BP, blocks: [{ type: "momentum", weight: 1, params: { lookback: 24 } }], universe: ["BTC", "ETH", "SOL", "HYPE", "ZEC", "SOXL"] });
  assert.equal(d1Verdict(naive).pass, false);
  assert.deepEqual(runSyntheticBenchmark(edge, 2).profitFactor, runSyntheticBenchmark(edge, 2).profitFactor);   // mêmes graines : même verdict
});

/* ---------- divisions ---------- */

test("promotion D1 → D2 : seuils PF / DD / survie / 25 trades ; places limitées à 6, paramètres gelés", () => {
  let st = admitBlueprints(emptyLeagues(), [lib("2611.1"), lib("2611.2", "x")], { now: NOW, bench: (bp) => (bp === BP ? PASS() : FAIL()) });
  assert.deepEqual(st.entries.map((e) => e.division), ["D1Q", "D1Q"]);
  st = admitBlueprints(st, [lib("2611.3", "arxiv", { ...BP, name: "Faible" })], { now: NOW, bench: FAIL });
  const out = st.entries.find((e) => e.id === "2611.3");
  assert.equal(out.division, "OUT"); assert.match(out.outReason, /PF 0\.9 < 1\.25.*DD 20\.0 % > 12 %.*survie au stress 40 % < 80 %/);
  assert.equal(admitBlueprints(st, [lib("2611.9")], { now: NOW, bench: () => ({ ...PASS(), trades: 24 }) }).entries.at(-1).division, "OUT");   // 24 trades : trop peu
  for (let k = 4; k < 12; k++) st = admitBlueprints(st, [lib(`2611.${k}`)], { now: NOW, bench: PASS });
  st = stepLeagues(st, { series: {} }, { now: NOW });
  assert.equal(st.entries.filter((e) => e.division === "D2").length, 6); assert.equal(st.entries.filter((e) => e.division === "D1Q").length, 4);
  const d2 = st.entries.find((e) => e.division === "D2");
  assert.equal(d2.d2.book.capital, 10_000); assert.deepEqual(d2.blueprint, BP);
  assert.deepEqual(Object.values(libraryStatus(st)).filter((s) => s === "Éliminé D1").length, 1);
});

// carnet D2 fabriqué : n trades de rendement donné, rendements horaires alternés
function fakeBook(n, ret, { equity = 10_000 * (1 + n * ret), returns = null } = {}) {
  const b = newBook(10_000);
  for (let k = 0; k < n; k++) b.trades.push({ T: "BTC", pnl: ret * 10_000 * (k % 4 === 3 ? -0.5 : 1), ret: ret * (k % 4 === 3 ? -0.5 : 1) });
  b.returns = returns ?? Array.from({ length: 40 }, (_, k) => [NOW - (40 - k) * H, k % 2 ? 0.004 : -0.001]);
  Object.assign(b, { equity, peak: equity, lastT: NOW });
  return b;
}
const d2Entry = (id, book, extra = {}) => ({ id, name: id, gen: "Gen-1", src: "arxiv", blueprint: BP, division: "D2", d1: PASS(), d2: { since: new Date(NOW - 72 * H).toISOString(), book, metrics: null }, ...extra });

test("promotion D2 → D3 : 15 trades, PSR ≥ 0,75, PF ≥ 1,30, corrélation < 0,60 avec D3 ; relégation au-delà de 20 trades", () => {
  const st = { ...emptyLeagues(), entries: [d2Entry("good", fakeBook(16, 0.01)), d2Entry("young", fakeBook(10, 0.01)), d2Entry("bad", fakeBook(22, -0.01))] };
  const s1 = stepLeagues(st, { series: {} }, { now: NOW });
  const by = Object.fromEntries(s1.entries.map((e) => [e.id, e]));
  assert.equal(by.good.division, "D3"); assert.ok(by.good.d2.metrics.psr >= 0.75 && by.good.d2.metrics.profitFactor >= 1.3);
  assert.equal(by.young.division, "D2"); assert.ok(by.young.d2.metrics.progress < 1);
  assert.equal(by.bad.division, "OUT"); assert.match(by.bad.outReason, /PSR .* < 0\.35 après 22 trades/);
  // un clone (rendements identiques) d'un champion de D3 n'est pas promu : corrélation 1
  const s2 = stepLeagues({ ...s1, entries: [...s1.entries, d2Entry("clone", fakeBook(16, 0.01, { returns: by.good.d2.book.returns }))] }, { series: {} }, { now: NOW });
  assert.equal(s2.entries.find((e) => e.id === "clone").division, "D2");
  const s3 = stepLeagues({ ...s1, entries: [...s1.entries, d2Entry("ortho", fakeBook(16, 0.01, { returns: by.good.d2.book.returns.map(([t], k) => [t, k % 3 ? 0.002 : -0.003]) }))] }, { series: {} }, { now: NOW });
  assert.equal(s3.entries.find((e) => e.id === "ortho").division, "D3");
});

test("coupe-circuit D3 : drawdown individuel > 8 % → retour immédiat en D2, pas de nouvelle promotion pendant 72 h", () => {
  const book = fakeBook(16, 0.01);
  const st = { ...emptyLeagues(), entries: [d2Entry("champ", book, { division: "D3", d3: { since: new Date(NOW - 24 * H).toISOString(), peak: book.equity / 0.91, drawdown: 0 } })] };
  const s1 = stepLeagues(st, { series: {} }, { now: NOW });
  const e = s1.entries[0];
  assert.equal(e.division, "D2"); assert.equal(e.demotedAt, new Date(NOW).toISOString()); assert.equal(e.d3, null);
  assert.match(s1.log[0].msg, /rétrogradé de D3 en D2 \(drawdown 9\.0 % > 8 %\)/);
  assert.equal(stepLeagues(s1, { series: {} }, { now: NOW + 24 * H }).entries[0].division, "D2");       // délai de 72 h
  assert.equal(stepLeagues(s1, { series: {} }, { now: NOW + 73 * H }).entries[0].division, "D3");
  // PSR glissant sous 0,50 : même sanction
  const weak = fakeBook(16, 0.01); weak.trades.push(...Array.from({ length: 20 }, (_, k) => ({ T: "BTC", pnl: k % 2 ? -60 : -30, ret: k % 2 ? -0.006 : -0.003 })));
  const s2 = stepLeagues({ ...emptyLeagues(), entries: [d2Entry("w", weak, { division: "D3", d3: { since: new Date(NOW).toISOString(), peak: weak.equity, drawdown: 0 } })] }, { series: {} }, { now: NOW });
  assert.match(s2.log[0].msg, /PSR glissant .* < 0\.5/);
});

test("D2 trade sur les vrais prix : une barre par heure, frais et glissement ; signaux des champions", () => {
  const mk = (px) => ({ BTC: { mark: px, funding: 0.0001 }, ETH: { mark: px / 30, funding: 0 } });
  const candles = { BTC: Array.from({ length: 300 }, (_, k) => ({ t: NOW - (300 - k) * H, c: 60_000 + 2_000 * Math.sin(k / 6), h: 60_300 + 2_000 * Math.sin(k / 6), l: 59_700 + 2_000 * Math.sin(k / 6) })) };
  let live = updateLiveMarket(null, { markets: mk(58_000), now: NOW, candles });
  assert.equal(live.series.BTC.c.length, 301); assert.equal(live.series.ETH.c.length, 1);
  assert.equal(updateLiveMarket(live, { markets: mk(58_100), now: NOW + 10 * 60e3 }).series.BTC.c.length, 301);   // moins de 30 min : pas de nouvelle barre
  let st = admitBlueprints(emptyLeagues(), [lib("2611.1")], { now: NOW, bench: PASS });
  st = stepLeagues(st, live, { now: NOW });
  const b = st.entries[0].d2.book;
  assert.equal(b.curve.length, 1); assert.equal(b.lastT, NOW);
  assert.equal(stepLeagues(st, live, { now: NOW + 600e3 }).entries[0].d2.book.curve.length, 1);    // même barre : pas de second pas
  st.entries[0].division = "D3"; st.entries[0].d3 = { since: new Date(NOW).toISOString(), peak: 10_000 };
  const sig = championSignals(st, live);
  assert.equal(sig[0].id, "2611.1"); assert.ok(Number.isFinite(sig[0].signals.BTC));
});

test("mutation Gen-2 : hybride des 2 meilleurs survivants, repasse par D1, au plus une fois par 24 h", async () => {
  let st = admitBlueprints(emptyLeagues(), [lib("p1"), lib("p2", "x")], { now: NOW, bench: PASS });
  const seen = [];
  const mutator = async (a, b) => { seen.push([a.id, b.id]); return { blueprint: { ...BP, name: "Hybride", blocks: [...BP.blocks, { type: "polymarket_edge", weight: 0.5, params: { min_move: 0.1 } }] }, model: "gemma-4-26b-a4b-it" }; };
  st = await maybeMutate(st, { now: NOW, mutator, bench: PASS });
  const g2 = st.entries.find((e) => e.gen === "Gen-2");
  assert.equal(seen.length, 1); assert.equal(g2.division, "D1Q"); assert.deepEqual(g2.parents.sort(), ["p1", "p2"]); assert.deepEqual(g2.parentSrc.sort(), ["arxiv", "x"]);
  assert.equal(g2.author, "gemma-4-26b-a4b-it");
  st = await maybeMutate(st, { now: NOW + 3 * H, mutator, bench: PASS });
  assert.equal(seen.length, 1);
  // mutateur par défaut : deepseek-flash d'abord, Groq ensuite
  const order = [];
  const f = async (url, init) => { const m = JSON.parse(init.body).model; order.push(m); return new Response(JSON.stringify({ choices: [{ message: { content: m === "deepseek-flash" ? "pas de JSON" : JSON.stringify(BP) } }] }), { status: 200 }); };
  const mut = defaultMutator({ env: { DEEPSEEK_API_KEY: "d", GROQ_API_KEY: "g" }, fetch: f });
  const out = await mut(st.entries[0], st.entries[1]);
  assert.deepEqual(order.slice(0, 2), ["deepseek-flash", "deepseek-v4-pro"]); assert.equal(out.model, "deepseek-v4-pro");
  assert.equal(defaultMutator({ env: {} }), null);
});

/* ---------- meta-ensemble ---------- */

test("meta-ensemble : LLM 65 % / D3 35 % au prorata du PSR et de l'orthogonalité ; 100 % LLM sans champion ; veto sous 60", () => {
  assert.deepEqual(metaWeights([], null).llm, 1);
  const pf = { positions: [{ venue: "hl", side: "short", entryUsd: 3000 }, { venue: "hl", side: "short", entryUsd: 1000 }] };   // biais net −1
  const champs = [{ id: "A", psr: 0.9, signals: { BTC: 0.6, ETH: 0.4 } }, { id: "B", psr: 0.9, signals: { BTC: -0.5 } }];
  const w = metaWeights(champs, pf);
  assert.equal(w.llm, 0.65); assert.equal(w.bias, -1);
  assert.ok(Math.abs(w.champions.reduce((a, c) => a + c.weight, 0) - 0.35) < 1e-3);
  const A = w.champions.find((c) => c.id === "A"), B = w.champions.find((c) => c.id === "B");
  assert.equal(A.orth, 1.5); assert.equal(B.orth, 1); assert.ok(A.weight > B.weight);   // A penche long contre un portefeuille tout short
  const dossier = { candidates: [{ id: "c1", venue: "hl", type: "whale", coin: "ETH", side: "long" }, { id: "c2", venue: "hl", type: "whale", coin: "BTC", side: "short" },
    { id: "c3", venue: "hl", type: "whale", coin: "xyz:GOLD", side: "long" }, { id: "c4", venue: "pm", type: "whale" }] };
  const dec = [{ id: "c1", action: "OPEN", via: "unanimité", conviction: 80 }, { id: "c2", action: "OPEN", via: "arbitre", conviction: 62 },
    { id: "c3", action: "OPEN", via: "unanimité", conviction: 70 }, { id: "c4", action: "OPEN", via: "unanimité", conviction: 75 }, { id: "hl-1", action: "CLOSE", via: "3/3" }];
  const m = mixDecisions(dec, dossier, champs, w, { tickerOf: (c) => c });
  const c1 = m.mixed.find((x) => x.id === "c1");
  assert.equal(c1.wD3, A.weight); assert.equal(c1.conviction, Math.round((1 - A.weight) * 80 + A.weight * (50 + 50 * 0.4)));   // seul A couvre ETH
  // c2 : SHORT BTC, A est long (0,6), B court (−0,5) : accord net négatif, conviction tombée sous 60 → écarté
  const c2 = m.mixed.find((x) => x.id === "c2");
  assert.ok(c2.conviction < 60); assert.match(m.vetoed[0].reason, /^meta-ensemble : conviction \d+ < 60 \(LLM 62, champions D3 \d+\)$/);
  assert.deepEqual(m.decisions.map((d) => d.id), ["c1", "c3", "c4", "hl-1"]);
  assert.equal(m.decisions.find((d) => d.id === "c3").conviction, 70);   // aucun champion ne couvre l'or : 100 % LLM
  assert.equal(m.decisions.find((d) => d.id === "c1").via, "unanimité + D3");
  // sans champion : décisions inchangées
  assert.deepEqual(mixDecisions(dec, dossier, [], metaWeights([], pf)).decisions, dec);
});
