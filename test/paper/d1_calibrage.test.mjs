// Flux de création continu : chaîne de repli de la compilation (deepseek-flash → deepseek-chat → gpt-oss-120b → qwen3.8),
// 6 Blueprints par cycle, seuil Builders 6/10 ; barre D1 → D2 calibrée (12 trades, PF ≥ 1,15, DD ≤ 18 %, survie ≥ 66 %),
// éliminées rejugées une fois, D2 diversifiée (6 places, 3 au plus par famille).
import { test } from "node:test";
import assert from "node:assert/strict";
import { blueprintExtractor, builderScorer, compileLibrary, compileBuilders, BUILDERS_CONFIG, X_CONFIG } from "../../lib/paper/x_scraper.mjs";
import { COMPILE_PREFER } from "../../lib/paper/router.mjs";
import { emptyLeagues, admitBlueprints, stepLeagues, d1Verdict, updateLedger, LEAGUE } from "../../lib/paper/league_engine.mjs";
import { inferFamily } from "../../lib/paper/blueprint.mjs";

const NOW = Date.UTC(2026, 10, 28, 13), H = 3600e3;
const ENV = { DEEPSEEK_API_KEY: "d", GROQ_API_KEY: "g" };
const mk = (name, blocks, thesis = "Règle testée.") => ({ name, thesis, universe: ["BTC", "ETH"], side: "both", horizon_hours: 24, blocks, entry: { score_above: 0.3 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 24 } });
const MR = (n) => mk(`Retour ${n}`, [{ type: "bollinger_zscore", weight: 0.6, params: { period: 20, z: 2 } }, { type: "rsi", weight: 0.4, params: { period: 14, low: 30, high: 70 } }]);
const TR = (n) => mk(`Tendance ${n}`, [{ type: "momentum", weight: 1, params: { lookback: 24 } }]);
const SA = (n) => mk(`Lead-lag ${n}`, [{ type: "polymarket_edge", weight: 1, params: { min_move: 0.05 } }], "Lead-lag Polymarket → perp.");
const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

test("compilation d'un candidat : deepseek-flash vide → deepseek-chat en erreur → gpt-oss-120b répond ; DeepSeek à 4 096 tokens", async () => {
  const sent = [];
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    if (b.model === "deepseek-flash") return reply("");                                    // réponse vide
    if (b.model === "deepseek-chat") return new Response('{"error":"overloaded"}', { status: 500 });
    return reply(JSON.stringify(TR(1)));
  };
  const r = await blueprintExtractor({ env: ENV, fetch })({ author: "a", text: "momentum rule", src: "x" });
  assert.deepEqual([...new Set(sent.map((b) => b.model))], ["deepseek-flash", "deepseek-chat", "openai/gpt-oss-120b"]);
  assert.equal(r.model, "openai/gpt-oss-120b"); assert.equal(r.blueprint.name, "Tendance 1"); assert.equal(r.tried, 2);
  assert.ok(sent.filter((b) => b.model.startsWith("deepseek")).every((b) => b.max_tokens === 4096));
  assert.ok(sent.filter((b) => b.model === "openai/gpt-oss-120b").every((b) => b.response_format === undefined));
  assert.deepEqual([...COMPILE_PREFER], ["deepseek-flash", "deepseek-chat", "openai/gpt-oss-120b", "qwen/qwen3.8-27b"]);
  // toute la chaîne en échec : erreur explicite (plus d'échec silencieux)
  const none = await blueprintExtractor({ env: ENV, fetch: async () => reply("") })({ author: "a", text: "x", src: "x" });
  assert.match(none.error, /deepseek-flash.*\| .*deepseek-chat.*\| .*gpt-oss-120b.*\| .*qwen3\.8/);
});

test("lot Builders : scores vides de deepseek-flash → deepseek-chat ; seuil 6/10, paramètres complétés demandés ; bilan publié (modèle, en attente)", async () => {
  const sent = [];
  const queue = Array.from({ length: 8 }, (_, k) => ({ id: `hn:${k}`, src: "hn", badge: "HackerNews · Quant", author: "a", text: `Funding spread idea number ${k} with an entry rule on z-score, exits left unspecified by the author.`, fp: `fp${k}` }));
  const fetch = async (url, init) => {
    const b = JSON.parse(init.body); sent.push(b);
    if (b.model === "deepseek-flash") return reply('{"scores":[],"blueprints":[]}');
    return reply(JSON.stringify({ scores: queue.map((_, i) => ({ i, score: i < 7 ? 6 + (i % 3) : 5 })), blueprints: queue.map((_, i) => ({ i, blueprint: SA(i) })) }));
  };
  const scorer = builderScorer({ env: ENV, fetch });
  const alpha = { infinity: { blueprints: [{ id: "old", blueprint: MR(0) }] }, builders: { queued: 8 } };
  const out = await compileLibrary(alpha, { builders: { queue, seen: {} } }, null, { now: NOW, env: ENV, scorer });
  assert.deepEqual(sent.map((b) => b.model), ["deepseek-flash", "deepseek-chat"]);
  assert.match(sent[0].messages[0].content, /ONLY for items scoring 6 or more/); assert.match(sent[0].messages[0].content, /stop_atr 2 \(stop-loss at\s+2×ATR\)/);
  assert.equal(BUILDERS_CONFIG.minScore, 6); assert.equal(X_CONFIG.maxBlueprintsPerCycle, 6);
  const c = out.alpha.compile;
  assert.equal(c.made, 6); assert.equal(c.builders, 6); assert.equal(c.quota, 6);                 // 7 notés ≥ 6, quota de 6 par cycle
  assert.deepEqual(c.models, { "deepseek-chat": 6 }); assert.equal(c.pending.builders, 1);        // le 7e retenu revient en file
  assert.equal(out.cache.builders.queue.length, 1); assert.equal(out.cache.builders.seen.fp7.score, 5);
  assert.ok(out.alpha.notes.some((n) => /repli de compilation — deepseek\/deepseek-flash : réponse invalide : champ scores absent ou vide/.test(n)));
  assert.equal(out.alpha.infinity.blueprints.length, 7);
  // chaîne entière en échec : erreur visible dans le bilan, lot gardé
  const fail = await compileBuilders([], { builders: { queue, seen: {} } }, async () => ({ error: "deepseek/deepseek-flash : HTTP 500" }), { now: NOW });
  assert.equal(fail.stats.error, "deepseek/deepseek-flash : HTTP 500"); assert.equal(fail.cache.builders.queue.length, 8);
});

test("barre D1 → D2 calibrée : 12 trades, PF ≥ 1,15, DD ≤ 18 %, survie ≥ 66 % (4 scénarios sur 5)", () => {
  const base = { trades: 12, profitFactor: 1.15, maxDrawdown: 0.18, stressSurvivalRate: 0.8 };
  assert.equal(d1Verdict(base).pass, true);
  assert.equal(d1Verdict({ ...base, trades: 11 }).pass, false);
  assert.equal(d1Verdict({ ...base, profitFactor: 1.14 }).pass, false);
  assert.equal(d1Verdict({ ...base, maxDrawdown: 0.181 }).pass, false);
  assert.equal(d1Verdict({ ...base, stressSurvivalRate: 0.6 }).pass, false);   // 3 sur 5
  // l'ancienne barre (PF 1,25 / DD 12 % / survie 80 % / 25 trades) aurait éliminé ce Blueprint : il est qualifié
  const st = admitBlueprints(emptyLeagues(), [{ id: "bp-1", blueprint: TR(1), source: { src: "x" } }], { now: NOW, bench: () => ({ trades: 14, profitFactor: 1.2, winRate: 0.5, maxDrawdown: 0.15, sharpe: 1, psr: 0.7, stressSurvivalRate: 0.8 }) });
  assert.equal(st.entries[0].division, "D1Q");
});

test("plusieurs stratégies actives en D2 : 6 places, familles diversifiées (3 au plus par famille)", () => {
  const lib = [...[1, 2, 3, 4, 5].map((k) => ({ id: `mr${k}`, blueprint: MR(k), interest: 90 - k })), ...[1, 2].map((k) => ({ id: `tr${k}`, blueprint: TR(k), interest: 70 - k })), ...[1, 2].map((k) => ({ id: `sa${k}`, blueprint: SA(k), interest: 60 - k }))]
    .map((x) => ({ ...x, source: { src: "x" } }));
  assert.deepEqual([...new Set(lib.map((x) => inferFamily(x.blueprint)))], ["mean_reversion", "trend_breakout", "stat_arb_leadlag"]);
  const pf = { mr: 2.0, tr: 1.3, sa: 1.2 };
  let st = admitBlueprints(emptyLeagues(), lib, { now: NOW, cfg: { ...LEAGUE, d1: { ...LEAGUE.d1, maxPerDay: Infinity } },
    bench: (bp) => ({ trades: 20, profitFactor: pf[bp.name.startsWith("Retour") ? "mr" : bp.name.startsWith("Tendance") ? "tr" : "sa"], winRate: 0.5, maxDrawdown: 0.1, sharpe: 1, psr: 0.8, stressSurvivalRate: 0.8 }) });
  assert.equal(st.entries.filter((e) => e.division === "D1Q").length, 9);
  st = stepLeagues(st, { series: {} }, { now: NOW });
  const d2 = st.entries.filter((e) => e.division === "D2"), fam = {};
  for (const e of d2) fam[e.family] = (fam[e.family] || 0) + 1;
  assert.equal(d2.length, 6);
  assert.deepEqual(fam, { mean_reversion: 2, trend_breakout: 2, stat_arb_leadlag: 2 });   // la meilleure PF ne monopolise pas D2
  assert.equal(st.entries.filter((e) => e.division === "D1Q").length, 3);
  assert.ok(d2.every((e) => e.d2.book.capital === 10_000));
});

test("éliminées de D1 sous l'ancienne barre : rejugées une fois sur leurs statistiques figées, requalifiées, carnet rouvert", () => {
  const out = (id, m) => ({ id, name: id, gen: "Gen-1", src: "arxiv", family: "mean_reversion", blueprint: MR(1), createdAt: new Date(NOW - 72 * H).toISOString(), division: "OUT",
    outAt: new Date(NOW - 72 * H).toISOString(), outReason: "D1 : PF 1.2 < 1.25", d1: { ...m, at: new Date(NOW - 72 * H).toISOString() }, d1Stats: { ...m, evaluatedAt: new Date(NOW - 72 * H).toISOString() } });
  const old = { ...emptyLeagues(), entries: [out("good", { trades: 18, profitFactor: 1.2, maxDrawdown: 0.14, stressSurvivalRate: 0.8 }), out("bad", { trades: 30, profitFactor: 0.95, maxDrawdown: 0.25, stressSurvivalRate: 0.4 })] };
  const ledger0 = updateLedger(null, old, NOW - 72 * H);
  assert.equal(ledger0.strategies.find((s) => s.id === "good").status, "D1_OUT");
  const st = admitBlueprints(old, [], { now: NOW });
  assert.equal(st.entries.find((e) => e.id === "good").division, "D1Q"); assert.equal(st.entries.find((e) => e.id === "good").outReason, null);
  assert.equal(st.entries.find((e) => e.id === "bad").division, "OUT"); assert.match(st.entries.find((e) => e.id === "bad").outReason, /PF 0\.95 < 1\.15/);
  assert.match(st.log[0].msg, /barre D1 recalibrée \(v2.*1 éliminée\(s\) requalifiée\(s\)/);
  assert.equal(admitBlueprints(st, [], { now: NOW + H }).log.length, st.log.length);   // une seule fois
  const L = updateLedger(ledger0, st, NOW), g = L.strategies.find((s) => s.id === "good");
  assert.equal(g.status, "D1_QUALIFIED"); assert.equal(g.dates.closedAt, undefined); assert.equal(g.exitReason, null);
  assert.deepEqual(g.history.map((x) => x.status), ["D1_OUT", "D1_QUALIFIED"]);
  // puis D2 au cycle live suivant
  assert.equal(stepLeagues(st, { series: {} }, { now: NOW }).entries.find((e) => e.id === "good").division, "D2");
});
