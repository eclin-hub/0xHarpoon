// Chasse « Alpha & Builders » : posts X indexés (DuckDuckGo / Bing), r/algotrading, GitHub ; filtre déterministe sans LLM,
// notation groupée par deepseek-flash (seuil 7/10), badge de source jusqu'au Labo D1 ; plafond de 8 candidats D1 / 24 h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilterBuilders, compileBuilders, huntBuilders, parseDuckDuckGo, parseReddit, parseGithub, xStatusOf, builderScorer, fingerprint, ledgerKnown, runXAlpha, BADGE } from "../../lib/paper/x_scraper.mjs";
import { validateBlueprint } from "../../lib/paper/blueprint.mjs";
import { emptyLeagues, admitBlueprints, updateLedger, LEAGUE } from "../../lib/paper/league_engine.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3;
const QUANT_POST = "Hyperliquid funding arb: when the 8h funding z-score on HYPE exceeds 2 while open interest rises, short the perp and hedge spot; exit when funding mean-reverts to 0 or after 48h, stop at 2 ATR. Backtest 2025: PF 1.6, max DD 9%.";
const BP = { name: "Arbitrage de funding HYPE", thesis: "Funding extrême et OI en hausse : vendre la perp, sortie au retour à la moyenne.", universe: ["HYPE"], side: "short", horizon_hours: 48,
  blocks: [{ type: "bollinger_zscore", weight: 0.7, params: { period: 20, z: 2 } }, { type: "momentum", weight: 0.3, params: { lookback: 12 } }],
  entry: { score_above: 0.3 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 48 } };
const ddgHtml = (rows) => `<html><body>${rows.map(([url, title, snip]) => `<div class="result results_links"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(url)}&amp;rut=abc">${title}</a></h2><a class="result__snippet" href="#">${snip}</a></div>`).join("")}</body></html>`;

test("filtre A : promotions (DM me, VIP, Telegram, 100x, airdrop), textes courts et sans règle mécanique écartés, sans aucun appel LLM", async () => {
  const items = [
    { id: "x:1", src: "x", author: "pumpking", url: "https://x.com/pumpking/status/1", text: "Join my VIP signals group, funding arb entries every day with 90% win rate and huge volume, DM me for access now!!!" },
    { id: "x:2", src: "x", author: "alpha", url: "https://x.com/alpha/status/2", text: "Free calls on our Telegram t.me/hlalpha — breakout entries with tight stops, open interest tracking, spread alerts and more" },
    { id: "x:3", src: "x", author: "lev", url: "https://x.com/lev/status/3", text: "This breakout setup on HYPE is a 100x play, open interest exploding and volume confirming the move, load up before it runs" },
    { id: "x:4", src: "x", author: "short", url: "https://x.com/short/status/4", text: "funding arb looks good today" },
    { id: "x:5", src: "x", author: "vibes", url: "https://x.com/vibes/status/5", text: "I really believe the market will go up this week, everyone is so bullish and the vibes are incredible, great time to be early" },
    { id: "x:6", src: "x", author: "quant", url: "https://x.com/quant/status/6", text: QUANT_POST },
    { id: "x:7", src: "x", author: "copy", url: "https://x.com/copy/status/7", text: QUANT_POST + " https://t.co/abc" },
  ];
  let calls = 0;
  const scorer = async () => { calls++; return { scores: [], blueprints: [] }; };
  const { kept, stats } = prefilterBuilders(items);
  assert.deepEqual(stats, { raw: 7, promo: 3, short: 1, noMech: 1, dup: 1, kept: 1 });
  assert.deepEqual(kept.map((p) => p.id), ["x:6"]); assert.equal(kept[0].badge, "X · Builder");
  // déjà au carnet (empreinte ou lien) : jamais recompilé
  const ledger = { strategies: [{ id: "bp-x:6", fingerprint: fingerprint(QUANT_POST) }] };
  assert.equal(prefilterBuilders(items, { known: ledgerKnown(ledger) }).stats.kept, 0);
  // file vide après le filtre : le scorer n'est jamais appelé
  const c = { builders: { queue: prefilterBuilders(items.slice(0, 5)).kept, seen: {} } };
  assert.equal(c.builders.queue.length, 0);
  const r = await compileBuilders([], c, scorer, { now: NOW });
  assert.equal(calls, 0); assert.equal(r.library.length, 0);
});

test("chasse complète : post X indexé (DuckDuckGo) noté ≥ 7 compilé avec le badge X · Builder ; < 7 rejeté ; promo jamais envoyée au LLM", async () => {
  const html = ddgHtml([
    ["https://twitter.com/hlquant/status/1861", "hlquant on X: &quot;Hyperliquid funding arb&quot; / X", QUANT_POST],
    ["https://x.com/vague/status/1862", "vague on X", "Momentum is everything in this market, volume and liquidity keep growing on Hyperliquid, I think we see much higher prices soon enough."],
    ["https://x.com/shill/status/1863", "shill on X", "VIP group: funding arb and breakout signals daily, DM me for the Telegram link, limited spots in the signals group, 100x leverage"],
    ["https://x.com/hlquant", "profil", "pas un post"],
  ]);
  const fetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes("duckduckgo") ? html : "") , json: async () => ({ items: [] }) });
  const seen = [];
  const scorer = async (posts) => { seen.push(...posts.map((p) => p.id)); return { model: "deepseek-flash",
    scores: posts.map((p, i) => ({ i, score: p.id === "x:1861" ? 8 : 4 })), blueprints: posts.map((p, i) => ({ i, blueprint: BP })) }; };   // un Blueprint rendu à tort pour le post à 4 : ignoré
  const { alpha, cache } = await runXAlpha({ env: {}, exec: async () => ({ stdout: "[]" }), fetch, extract: null, scorer, now: NOW, free: { feeds: [], arxiv: false },
    builders: { queries: [{ id: "x-hl-pm", q: "site:x.com hyperliquid funding" }], reddit: false, github: false } });
  assert.deepEqual(seen.sort(), ["x:1861", "x:1862"]);   // la promo n'atteint jamais le LLM
  assert.equal(alpha.builders.counts.x, 3); assert.equal(alpha.builders.filter.promo, 1); assert.deepEqual(alpha.builders.compile.compiled, 1);
  const bp = alpha.infinity.blueprints.find((b) => b.id === "bp-x:1861");
  assert.ok(bp, "Blueprint compilé"); assert.equal(alpha.infinity.blueprints.length, 1);
  assert.equal(bp.source.src, "x"); assert.equal(bp.source.badge, BADGE.x); assert.equal(bp.source.url, "https://x.com/hlquant/status/1861"); assert.equal(bp.source.author, "hlquant");
  assert.equal(bp.testability, 8); assert.equal(validateBlueprint(bp.blueprint).ok, true); assert.match(bp.source.excerpt, /funding z-score/);
  assert.equal(cache.builders.queue.length, 0); assert.equal(cache.builders.seen[fingerprint(QUANT_POST)].score, 8);
  // badge conservé jusqu'au Labo D1 et au carnet
  const st = admitBlueprints(emptyLeagues(), alpha.infinity.blueprints, { now: NOW, bench: () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 }) });
  assert.equal(st.entries[0].badge, "X · Builder"); assert.equal(st.entries[0].src, "x"); assert.match(st.entries[0].excerpt, /Hyperliquid funding arb/);
  const L = updateLedger(null, st, NOW);
  assert.equal(L.strategies[0].source, "X · Builder"); assert.equal(L.strategies[0].fingerprint, fingerprint(QUANT_POST));
  // cycle suivant : la même idée (déjà notée, déjà au carnet) n'est pas remise en file
  const again = await huntBuilders(cache, { fetch, now: NOW + H, ledger: L, queries: [{ id: "x-hl-pm", q: "q" }], reddit: false, github: false });
  assert.equal(again.report.filter.dup, 2); assert.equal(again.cache.builders.queue.length, 0);
});

test("parseurs : lien de post X canonique, Reddit sans pied de page, GitHub sans forks ; deepseek-flash seul dans le scorer", () => {
  assert.deepEqual(xStatusOf("https://mobile.twitter.com/a_b/status/42?s=20"), { author: "a_b", id: "42", url: "https://x.com/a_b/status/42" });
  assert.equal(xStatusOf("https://x.com/a_b"), null);
  assert.equal(parseDuckDuckGo(ddgHtml([["https://x.com/q/status/9", "t", "s"]]))[0].id, "x:9");
  const rd = parseReddit(`<feed><entry><author><name>/u/lagtrader</name></author><id>t3_abc</id><link href="https://www.reddit.com/r/algotrading/comments/abc/"/><title>BTC/ETH lead-lag</title><content type="html">&lt;p&gt;Rule: z-score of spread &amp;gt; 2&lt;/p&gt; submitted by /u/lagtrader [link] [comments]</content><updated>2026-11-27T10:00:00Z</updated></entry></feed>`);
  assert.equal(rd[0].src, "reddit"); assert.equal(rd[0].author, "lagtrader"); assert.equal(rd[0].text, "BTC/ETH lead-lag. Rule: z-score of spread > 2");
  const gh = parseGithub({ items: [{ full_name: "o/hl-bot", description: "Funding arb bot", owner: { login: "o" }, html_url: "https://github.com/o/hl-bot", topics: ["hyperliquid"] }, { full_name: "f/fork", fork: true }] });
  assert.equal(gh.length, 1); assert.equal(gh[0].src, "github"); assert.match(gh[0].text, /Topics: hyperliquid/);
  assert.equal(builderScorer({ env: { GROQ_API_KEY: "k" } }), null);   // Groq seul : pas de notation (quota réservé au vote)
  assert.ok(builderScorer({ env: { DEEPSEEK_API_KEY: "k" } }));
});

test("D1 : au plus 8 nouveaux candidats Gen-1 par 24 h glissantes, les plus intéressants d'abord ; le reste attend", () => {
  assert.equal(LEAGUE.d1.maxPerDay, 8);
  const lib = Array.from({ length: 11 }, (_, k) => ({ id: `bp-${k}`, name: `S${k}`, interest: k * 5, blueprint: BP, source: { src: "x", badge: "X · Builder" } }));
  const bench = () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 });
  let st = admitBlueprints(emptyLeagues(), lib, { now: NOW, bench });
  assert.equal(st.entries.length, 8); assert.deepEqual(st.d1Queue, { at: new Date(NOW).toISOString(), admitted24h: 8, cap: 8, waiting: 3 });
  assert.ok(!st.entries.some((e) => ["bp-0", "bp-1", "bp-2"].includes(e.id)));   // intérêt le plus faible : en attente
  st = admitBlueprints(st, lib, { now: NOW + 23 * H, bench });
  assert.equal(st.entries.length, 8);                                              // toujours dans la fenêtre de 24 h
  st = admitBlueprints(st, lib, { now: NOW + 24 * H, bench });
  assert.equal(st.entries.length, 11); assert.equal(st.d1Queue.waiting, 0);
});
