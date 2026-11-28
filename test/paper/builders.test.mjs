// Chasse « Alpha & Builders » : Google News indexé (site:x.com, Substack, r/algotrading), Hacker News (Algolia), GitHub ;
// filtre déterministe sans LLM,
// notation groupée par deepseek-flash (seuil 7/10), badge de source jusqu'au Labo D1 ; plafond de 8 candidats D1 / 24 h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { prefilterBuilders, compileBuilders, huntBuilders, collectBuilders, parseGoogleNews, parseHackerNews, parseGithub, srcOfDomain, gnewsUrl, hnUrl, GNEWS_QUERIES, HN_QUERIES, builderScorer, fingerprint, ledgerKnown, runXAlpha, BADGE } from "../../lib/paper/x_scraper.mjs";
import { validateBlueprint } from "../../lib/paper/blueprint.mjs";
import { emptyLeagues, admitBlueprints, updateLedger, LEAGUE } from "../../lib/paper/league_engine.mjs";

const NOW = Date.UTC(2026, 10, 28, 12), H = 3600e3;
const QUANT_POST = "Hyperliquid funding arb: when the 8h funding z-score on HYPE exceeds 2 while open interest rises, short the perp and hedge spot; exit when funding mean-reverts to 0 or after 48h, stop at 2 ATR. Backtest 2025: PF 1.6, max DD 9%.";
const BP = { name: "Arbitrage de funding HYPE", thesis: "Funding extrême et OI en hausse : vendre la perp, sortie au retour à la moyenne.", universe: ["HYPE"], side: "short", horizon_hours: 48,
  blocks: [{ type: "bollinger_zscore", weight: 0.7, params: { period: 20, z: 2 } }, { type: "momentum", weight: 0.3, params: { lookback: 12 } }],
  entry: { score_above: 0.3 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 48 } };
const esc = (x) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const gnItem = ([title, srcName, srcUrl, guid, desc = title]) => `<item><title>${esc(title)} - ${esc(srcName)}</title><link>https://news.google.com/rss/articles/${guid}?oc=5</link><guid isPermaLink="false">${guid}</guid><pubDate>Thu, 26 Nov 2026 18:34:14 GMT</pubDate>`
  + `<description>${esc(`<a href="https://news.google.com/rss/articles/${guid}?oc=5" target="_blank">${esc(desc)}</a>&nbsp;&nbsp;<font color="#6f6f6f">${esc(srcName)}</font>`)}</description><source url="${srcUrl}">${esc(srcName)}</source></item>`;
const gnRss = (rows) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Google News</title>${rows.map(gnItem).join("")}</channel></rss>`;

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

test("chasse complète : post X indexé (Google News) noté ≥ 7 compilé avec le badge X · Builder ; < 7 rejeté ; promo jamais envoyée au LLM", async () => {
  const rss = gnRss([
    [QUANT_POST, "X", "https://x.com", "CBMiQUANT"],
    ["Momentum is everything in this market, volume and liquidity keep growing on Hyperliquid, I think we see much higher prices soon enough.", "X", "https://x.com", "CBMiVAGUE"],
    ["VIP group: funding arb and breakout signals daily, DM me for the Telegram link, limited spots in the signals group, 100x leverage", "X", "https://x.com", "CBMiSHILL"],
  ]);
  const fetch = async (url) => ({ ok: true, status: 200, text: async () => (String(url).includes("news.google.com") ? rss : ""), json: async () => ({ items: [], hits: [] }) });
  const ID = (g) => `gn:${parseGoogleNews(gnRss([[QUANT_POST, "X", "https://x.com", g]]))[0].id.slice(3)}`, QID = ID("CBMiQUANT"), VID = ID("CBMiVAGUE");
  const seen = [];
  const scorer = async (posts) => { seen.push(...posts.map((p) => p.id)); return { model: "deepseek-flash",
    scores: posts.map((p, i) => ({ i, score: p.id === QID ? 8 : 4 })), blueprints: posts.map((p, i) => ({ i, blueprint: BP })) }; };   // un Blueprint rendu à tort pour le post à 4 : ignoré
  const { alpha, cache } = await runXAlpha({ env: {}, exec: async () => ({ stdout: "[]" }), fetch, extract: null, scorer, now: NOW, free: { feeds: [], arxiv: false },
    builders: { queries: [GNEWS_QUERIES[0]], hn: [], github: false } });
  assert.deepEqual(seen.sort(), [QID, VID].sort());   // la promo n'atteint jamais le LLM
  assert.equal(alpha.builders.counts.x, 3); assert.equal(alpha.builders.filter.promo, 1); assert.deepEqual(alpha.builders.compile.compiled, 1);
  const bp = alpha.infinity.blueprints.find((b) => b.id === `bp-${QID}`);
  assert.ok(bp, "Blueprint compilé"); assert.equal(alpha.infinity.blueprints.length, 1);
  assert.equal(bp.source.src, "x"); assert.equal(bp.source.badge, BADGE.x); assert.equal(bp.source.url, "https://news.google.com/rss/articles/CBMiQUANT?oc=5"); assert.equal(bp.source.author, "X");
  assert.equal(bp.testability, 8); assert.equal(validateBlueprint(bp.blueprint).ok, true); assert.match(bp.source.excerpt, /funding z-score/);
  assert.equal(cache.builders.queue.length, 0); assert.equal(cache.builders.seen[fingerprint(QUANT_POST)].score, 8);
  // badge conservé jusqu'au Labo D1 et au carnet
  const st = admitBlueprints(emptyLeagues(), alpha.infinity.blueprints, { now: NOW, bench: () => ({ trades: 40, profitFactor: 1.6, winRate: 0.55, maxDrawdown: 0.06, sharpe: 2, psr: 0.9, stressSurvivalRate: 1 }) });
  assert.equal(st.entries[0].badge, "X · Builder"); assert.equal(st.entries[0].src, "x"); assert.match(st.entries[0].excerpt, /Hyperliquid funding arb/);
  const L = updateLedger(null, st, NOW);
  assert.equal(L.strategies[0].source, "X · Builder"); assert.equal(L.strategies[0].fingerprint, fingerprint(QUANT_POST));
  // cycle suivant : la même idée (déjà notée, déjà au carnet) n'est pas remise en file
  const again = await huntBuilders(cache, { fetch, now: NOW + H, ledger: L, queries: [GNEWS_QUERIES[0]], hn: [], github: false });
  assert.equal(again.report.filter.dup, 2); assert.equal(again.cache.builders.queue.length, 0);
});

test("Google News RSS : site:x.com, Substack et r/algotrading → badges X · Builder, Substack · Quant, Reddit · Quant ; suffixe « - Source » retiré", () => {
  const items = parseGoogleNews(gnRss([
    ["Thread: HYPE funding arb, short the perp when the 8h funding z-score > 2, exit at 0 or after 48h", "X", "https://x.com", "CBMiX1"],
    ["Mean reversion on BTC perps: a volatility-scaled z-score rule with an ATR stop - Part 2", "Lauren’s data Substack", "https://laurensdata.substack.com", "CBMiS1"],
    ["Built an NQ intraday breakout system on volume spikes. Backtest looks good, but I don't trust it", "Reddit", "https://www.reddit.com", "CBMiR1"],
    ["Bitcoin price today", "CoinDesk", "https://www.coindesk.com", "CBMiC1"],
  ]), null);
  assert.deepEqual(items.map((p) => p.src), ["x", "substack", "reddit"]);   // domaine inconnu sans badge par défaut : écarté
  assert.equal(items[0].text, "Thread: HYPE funding arb, short the perp when the 8h funding z-score > 2, exit at 0 or after 48h");
  assert.equal(items[1].text, "Mean reversion on BTC perps: a volatility-scaled z-score rule with an ATR stop - Part 2");   // « - Part 2 » gardé, seul « - Source » retiré
  assert.equal(items[1].author, "Lauren’s data Substack"); assert.equal(items[0].url, "https://news.google.com/rss/articles/CBMiX1?oc=5");
  assert.equal(Date.parse(items[0].createdAt), Date.UTC(2026, 10, 26, 18, 34, 14));
  const kept = prefilterBuilders(items).kept;
  assert.deepEqual(kept.map((p) => p.badge), ["X · Builder", "Substack · Quant", "Reddit · Quant"]);
  // description plus riche que le titre : ajoutée
  const rich = parseGoogleNews(gnRss([["Short title", "X", "https://x.com", "G", "Full post text with the funding arb rule"]]), null)[0];
  assert.equal(rich.text, "Short title. Full post text with the funding arb rule");
  assert.equal(srcOfDomain("https://twitter.com", null), "x"); assert.equal(srcOfDomain("https://foo.example", "x"), "x");
  assert.match(gnewsUrl(GNEWS_QUERIES[0].q), /^https:\/\/news\.google\.com\/rss\/search\?q=site%3Ax\.com.*&hl=en-US&gl=US&ceid=US:en$/);
  assert.deepEqual(GNEWS_QUERIES.map((q) => q.src), ["x", "substack", "reddit"]);
});

test("Algolia Hacker News : stories et commentaires → badge HackerNews · Quant, puis le même filtre A", () => {
  const hits = parseHackerNews({ hits: [
    { objectID: "501", _tags: ["comment", "story_500"], author: "quantdev", story_title: "Show HN: Hyperliquid funding scanner", created_at: "2026-11-27T10:00:00Z",
      comment_text: "We short the perp when the 8h funding z-score exceeds 2 and open interest rises, hedge spot, exit when funding reverts to zero or after 48h; stop at 2 ATR." },
    { objectID: "502", _tags: ["story"], author: "maker", title: "Show HN: WebGL2 GPU Liquidity Heatmap for Hyperliquid L2 Orderbooks", url: "https://example.org/heatmap.html", created_at: "2026-11-09T18:32:12Z" },
    { objectID: "503", _tags: ["comment"], author: "shill", story_title: "Polymarket", comment_text: "Join my VIP signals group on Telegram for funding arb entries with 100x leverage, DM me today for access" },
    { objectID: "504", _tags: ["comment"], author: "x", comment_text: "" },
  ] });
  assert.deepEqual(hits.map((x) => x.id), ["hn:501", "hn:502", "hn:503"]);
  assert.equal(hits[0].url, "https://news.ycombinator.com/item?id=501"); assert.match(hits[0].text, /\(fil : Show HN: Hyperliquid funding scanner\)$/);
  assert.match(hits[1].text, /^Show HN: WebGL2 .* https:\/\/example\.org\/heatmap\.html$/);
  const { kept, stats } = prefilterBuilders(hits);
  assert.equal(stats.promo, 1); assert.deepEqual(kept.map((p) => [p.id, p.badge]), [["hn:501", "HackerNews · Quant"], ["hn:502", "HackerNews · Quant"]]);
  assert.equal(hnUrl("funding rate"), "https://hn.algolia.com/api/v1/search_by_date?tags=(story,comment)&query=funding%20rate&hitsPerPage=25");
  assert.deepEqual([...HN_QUERIES], ["hyperliquid", "polymarket", "algorithmic trading", "funding rate"]);
});

test("collecte : Google News (3 requêtes) + Hacker News (4) + GitHub, comptes par badge ; une source en échec n'arrête pas les autres", async () => {
  const urls = [];
  const fetch = async (url) => {
    urls.push(String(url));
    if (url.includes("news.google.com")) return { ok: true, status: 200, text: async () => (url.includes("substack") ? gnRss([["Systematic vol targeting rule with a z-score entry and ATR stop", "Quant Substack", "https://q.substack.com", "S" + urls.length]]) : gnRss([])) };
    if (url.includes("hn.algolia.com")) return url.includes("polymarket") ? { ok: false, status: 503 } : { ok: true, status: 200, json: async () => ({ hits: [{ objectID: String(urls.length), _tags: ["story"], title: "Funding arb", author: "a" }] }) };
    return { ok: true, status: 200, json: async () => ({ items: [{ full_name: "o/hl", description: "Funding arb bot", owner: { login: "o" }, html_url: "https://github.com/o/hl" }] }) };
  };
  const r = await collectBuilders({ fetch, now: NOW });
  assert.equal(urls.filter((u) => u.includes("news.google.com")).length, 3); assert.equal(urls.filter((u) => u.includes("hn.algolia.com")).length, 4);
  assert.ok(!urls.some((u) => /duckduckgo|bing\.com|reddit\.com\/r\/algotrading\/top/.test(u)));   // anciennes impasses retirées
  assert.deepEqual(r.counts, { x: 0, substack: 1, reddit: 0, hn: 3, github: 2 });
  assert.ok(r.notes.some((n) => /Hacker News « polymarket » : HTTP 503/.test(n))); assert.ok(r.notes.some((n) => /Google News gn-x : aucun résultat/.test(n)));
  const gh = parseGithub({ items: [{ full_name: "o/hl-bot", description: "Funding arb bot", owner: { login: "o" }, html_url: "https://github.com/o/hl-bot", topics: ["hyperliquid"] }, { full_name: "f/fork", fork: true }] });
  assert.equal(gh.length, 1); assert.match(gh[0].text, /Topics: hyperliquid/);
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
