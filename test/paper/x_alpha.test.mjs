// Dry-run de la collecte X : tweets bruts (spam, doublon, catalyseur court terme, thread de stratégie ML) → flux ε / ∞,
// Blueprint JSON validé, injection dans le dossier des votants, repli neutre sans agent-reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runXAlpha, collect, ingest, epsilonSummary, promptContext, isSpam, normalizePost, parseOutput, buildQueries, X_CONFIG } from "../../lib/paper/x_scraper.mjs";
import { validateBlueprint } from "../../lib/paper/blueprint.mjs";
import { decide, X_RULES } from "../../lib/paper/decision.mjs";
import { initialPortfolio, PUBLIC_PAPER_FILES, FILES } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 27, 23), H = 3600e3, iso = (t) => new Date(t).toISOString();
const tw = (id, author, text, ago, likes = 50, reposts = 10) => ({ id, text, author: { userName: author }, createdAt: iso(NOW - ago), likeCount: likes, retweetCount: reposts });

const SPAM = tw("1", "freecoins", "🚀 $BTC AIRDROP giveaway! Join our Telegram t.me/pumpzone for whitelist spots", 10 * 60e3, 900, 400);
const CATALYST = tw("2", "WatcherGuru", "JUST IN: $HYPE open interest hits record as shorts get liquidated, breakout above $70, short squeeze building", 20 * 60e3, 4000, 900);
const DUPLICATE = tw("3", "copycat", "JUST IN: $HYPE open interest hits record as shorts get liquidated, breakout above $70, short squeeze building https://x.com/x", 15 * 60e3);
const HYPE_RECENT = [4, 5, 6].map((i) => tw(String(i), "lookonchain", `Whale ${i} bought $HYPE on-chain, inflows surging, bullish breakout`, (5 + i) * 60e3, 800, 120));
const HYPE_OLD = tw("9", "tier10k", "$HYPE funding neutral, whales quiet", 20 * H, 100, 10);
const THREAD = tw("7", "macrocephalopod", "🧵 1/ Mean reversion on BTC perps: a 20-period bollinger z-score below -2 combined with RSI(14) < 30 and funding rate negative gave Sharpe 1.8 out-of-sample in a walk-forward backtest. Exit at z = 0 or 2 ATR stop. Feature engineering details below 👇",
  30 * 60e3, 2500, 600);
const NOISE = tw("8", "someone", "good morning everyone, coffee time", 5 * 60e3);
const RAW = [SPAM, CATALYST, DUPLICATE, ...HYPE_RECENT, HYPE_OLD, THREAD, NOISE];

const BLUEPRINT = { name: "Retour à la moyenne BTC (z-score)", thesis: "Acheter les excès baissiers : z-score de Bollinger sous -2, RSI bas et funding négatif.",
  universe: ["BTC"], side: "long", horizon_hours: 48,
  blocks: [{ type: "bollinger_zscore", weight: 0.5, params: { period: 20, z: 2 } }, { type: "rsi", weight: 0.3, params: { period: 14, low: 30, high: 70 } },
    { type: "linear_ml_score", weight: 0.2, params: { features: ["funding", "zscore"], coefs: [-1.5, -0.8], intercept: 0 } }],
  entry: { score_above: 0.4 }, exit: { stop_atr: 2, take_profit_atr: 3, max_hold_hours: 48 } };

// fausse CLI agent-reach : renvoie tous les tweets bruts à la première requête, rien ensuite
const fakeExec = () => { let n = 0; const calls = []; const f = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: n++ === 0 ? JSON.stringify(RAW) : "[]", stderr: "" }; }; f.calls = calls; return f; };

test("dry-run : spam et doublon écartés, catalyseur → ε, thread ML → ∞, Blueprint valide", async () => {
  const exec = fakeExec(), seen = [];
  const extract = async (post) => { seen.push(post.id); return { blueprint: validateBlueprint(BLUEPRINT).value, model: "openai/gpt-oss-120b" }; };
  const { alpha, cache } = await runXAlpha({ env: {}, exec, extract, now: NOW });
  assert.deepEqual(exec.calls[0].slice(0, 3), ["agent-reach", "twitter", "search"]); assert.deepEqual(exec.calls[0].slice(-2), ["--limit", "40"]);
  assert.equal(exec.calls.length, buildQueries().length);
  assert.equal(alpha.status, "actif (agent-reach)");
  assert.deepEqual({ spam: alpha.stats.spam, dup: alpha.stats.dup, epsilon: alpha.stats.epsilon, infinity: alpha.stats.infinity }, { spam: 1, dup: 1, epsilon: 5, infinity: 1 });
  assert.equal(cache.posts["1"], undefined); assert.equal(cache.posts["8"], undefined);    // spam et bruit hors cache
  assert.equal(cache.posts["2"].kind, "epsilon"); assert.equal(cache.posts["7"].kind, "infinity");
  // flux ε : HYPE en pic de vélocité, biais haussier → alerte de squeeze
  const hype = alpha.epsilon.tickers.HYPE;
  assert.ok(hype.mentionVelocityRatio >= X_CONFIG.squeezeVelocity, `vélocité ${hype.mentionVelocityRatio}`);
  assert.ok(hype.netNarrativeBias > X_CONFIG.squeezeBias, `biais ${hype.netNarrativeBias}`);
  assert.equal(hype.squeezeWarning, true); assert.equal(hype.catalysts.length, 3); assert.equal(hype.catalysts[0].author, "WatcherGuru");
  assert.equal(Date.parse(hype.expiresAt), NOW - 9 * 60e3 + 4 * H);   // 4 h après le dernier post (whale 4, il y a 9 min)
  assert.equal(alpha.epsilon.tickers.BTC, undefined);                    // le thread ML parle de BTC mais n'est pas un catalyseur
  // flux ∞ : un Blueprint, statut « En attente D1 »
  assert.ok(cache.posts["7"].interest >= 75, `intérêt ${cache.posts["7"].interest}`);
  assert.deepEqual(seen, ["7"]);
  const bp = alpha.infinity.blueprints[0];
  assert.equal(bp.status, "En attente D1"); assert.equal(bp.source.author, "macrocephalopod"); assert.equal(bp.source.url, "https://x.com/macrocephalopod/status/7");
  assert.equal(validateBlueprint(bp.blueprint).ok, true);
  // 10 min plus tard : collecte réutilisée (anti-ban), aucune requête X, signaux et bibliothèque conservés
  const idle = fakeExec(), reused = await runXAlpha({ prev: alpha, cache, env: {}, exec: idle, extract, now: NOW + 10 * 60e3 });
  assert.equal(idle.calls.length, 0); assert.match(reused.alpha.status, /^réutilisé : collecte agent-reach de 23:00 UTC/);
  assert.equal(reused.alpha.collectedAt, alpha.collectedAt); assert.equal(reused.alpha.epsilon.tickers.HYPE.squeezeWarning, true);
  // collecte forcée (lancement manuel) : le thread n'est pas retraduit, les posts déjà vus ne sont pas recomptés
  const again = await runXAlpha({ prev: alpha, cache, env: {}, exec: fakeExec(), extract, now: NOW + 60e3, force: true });
  assert.deepEqual(seen, ["7"]); assert.equal(again.alpha.infinity.blueprints.length, 1); assert.equal(again.alpha.stats.known, 6);   // les 6 posts gardés ; spam, doublon et bruit sont refiltrés
  // après 45 min : nouvelle collecte
  const later = fakeExec();
  await runXAlpha({ prev: alpha, cache, env: {}, exec: later, extract, now: NOW + 46 * 60e3 });
  assert.equal(later.calls.length, buildQueries().length);
});

test("twitter-cli en priorité avec les cookies ; cookies expirés → repli explicite, sans planter", async () => {
  const env = { TWITTER_AUTH_TOKEN: "a", TWITTER_CT0: "c" };
  const envelope = { ok: true, schema_version: "1", data: [{ id: "77", text: "BREAKING: $SOL ETF approved, solana rallies, bullish breakout", author: { id: "1", name: "W", screenName: "WatcherGuru" },
    metrics: { likes: 1200, retweets: 300, replies: 40, quotes: 5, views: 90000, bookmarks: 2 }, createdAt: "Fri Nov 27 22:50:00 +0000 2026", createdAtISO: "2026-11-27T22:50:00+00:00", isRetweet: false, lang: "en" }] };
  const calls = [];
  const ok = await collect(buildQueries(["SOL"]), { env, now: NOW, exec: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: JSON.stringify(envelope) }; } });
  assert.deepEqual(calls[0], ["twitter", "search", calls[0][2], "-t", "Latest", "--max", "40", "--json"]);
  assert.equal(ok.source, "twitter-cli"); assert.equal(ok.status, "actif (twitter-cli)");
  const p = normalizePost(ok.posts[0].raw);
  assert.deepEqual([p.id, p.author, p.likes, p.reposts, p.views, p.url, p.t], ["77", "WatcherGuru", 1200, 300, 90000, "https://x.com/WatcherGuru/status/77", Date.parse("2026-11-27T22:50:00Z")]);
  // cookies expirés : twitter-cli répond { ok:false, error:{ code:"not_authenticated" } } et sort en code 1
  const expired = { ok: false, schema_version: "1", error: { code: "not_authenticated", message: "Cookie expired or invalid (HTTP 401). Please re-login to x.com in your browser." } };
  const tried = [];
  const exec = async (cmd) => { tried.push(cmd); if (cmd === "twitter") throw Object.assign(new Error("exit 1"), { code: 1, stdout: JSON.stringify(expired) }); throw Object.assign(new Error("spawn agent-reach ENOENT"), { code: "ENOENT" }); };
  const warn = console.warn; let logged = ""; console.warn = (m) => { logged += m; };
  const ko = await collect(buildQueries(), { env, now: NOW, exec }).finally(() => { console.warn = warn; });
  assert.deepEqual(tried, ["twitter", "agent-reach"]);                   // une seule tentative par CLI et par cycle
  assert.equal(ko.posts.length, 0); assert.equal(ko.authFail, "twitter-cli");
  assert.equal(ko.status, "neutre : cookies X expirés ou invalides, renouveler les secrets X_AUTH_TOKEN et X_CT0");
  assert.match(logged, /\[X\] neutre : cookies X expirés .*twitter-cli : cookies X expirés ou invalides \(Cookie expired or invalid \(HTTP 401\)/);
  // une collecte en échec n'est jamais « réutilisée » : le cycle suivant réessaie
  const { alpha } = await runXAlpha({ env, exec, now: NOW, extract: null });
  assert.equal(alpha.collectedAt, null); assert.equal(alpha.source, null);
  // limite de débit signalée par twitter-cli : pause d'une heure
  const rl = await collect(buildQueries(), { env, now: NOW, exec: async () => { throw Object.assign(new Error("exit 1"), { stdout: JSON.stringify({ ok: false, error: { code: "rate_limited", message: "Rate limited after 3 retries" } }) }); } });
  assert.ok(rl.paused); assert.match(rl.status, /limite de débit/);
});

test("validateBlueprint : déclaratif strict (pas de code, champs et bornes vérifiés)", () => {
  assert.equal(validateBlueprint(BLUEPRINT).ok, true);
  const bad = (patch) => validateBlueprint({ ...structuredClone(BLUEPRINT), ...patch });
  assert.match(bad({ code: "return price > 1" }).errors.join(), /champ inconnu « code »/);
  assert.match(bad({ blocks: [{ type: "eval", weight: 1, params: {} }] }).errors.join(), /type/);
  assert.match(bad({ blocks: [{ type: "rsi", weight: 1, params: { period: "14; drop()" } }] }).errors.join(), /period/);
  assert.match(bad({ universe: ["DOGE"] }).errors.join(), /universe/);
  assert.match(bad({ blocks: [{ type: "linear_ml_score", weight: 1, params: { features: ["rsi"], coefs: [1, 2] } }] }).errors.join(), /coefs/);
});

test("flux ε injecté dans le dossier des votants avec la consigne squeeze / délai de 8 h", async () => {
  const { alpha } = await runXAlpha({ env: {}, exec: fakeExec(), extract: null, now: NOW });
  const ctx = promptContext(alpha.epsilon.tickers, NOW);
  assert.equal(ctx.HYPE.squeezeWarning, true); assert.ok(ctx.HYPE.expires_in_min > 0 && ctx.HYPE.expires_in_min <= 240);
  const sent = [];
  const router = { available: () => [{}], async collect(n, messages, validate) { sent.push(messages); return { results: [], errors: [] }; } };
  const cand = { id: "hl|HYPE|short", type: "whale", venue: "hl", coin: "HYPE", side: "short", pocket: "core", score: 3, metrics: { mark: 70 } };
  const d = await decide({ router, dossier: { candidates: [cand], rejected: [] }, portfolio: initialPortfolio(), now: NOW, xContext: ctx });
  assert.ok(sent[0][0].content.endsWith(X_RULES));
  assert.match(X_RULES, /never vote OPEN on a SHORT .* squeezeWarning = true/s); assert.match(X_RULES, /8-hour exit cooldown/);
  assert.equal(JSON.parse(sent[0][1].content).x_epsilon.HYPE.squeezeWarning, true);
  assert.deepEqual(d.xInjected, ["HYPE"]);
  // sans contexte X : prompt inchangé
  await decide({ router, dossier: { candidates: [cand], rejected: [] }, portfolio: initialPortfolio(), now: NOW, xContext: {} });
  assert.ok(!sent[1][0].content.includes("x_epsilon")); assert.equal(JSON.parse(sent[1][1].content).x_epsilon, undefined);
  // signal expiré : plus transmis
  assert.deepEqual(promptContext(alpha.epsilon.tickers, NOW + 5 * H), {});
});

test("repli neutre et silencieux : CLI absente, limite de débit, clé API en secours", async () => {
  const enoent = async () => { throw Object.assign(new Error("spawn agent-reach ENOENT"), { code: "ENOENT" }); };
  const none = await collect(buildQueries(), { env: {}, exec: enoent, now: NOW });
  assert.equal(none.posts.length, 0); assert.match(none.status, /^neutre : aucune source X/); assert.deepEqual(none.notes, ["agent-reach absent"]);
  const limited = await collect(buildQueries(), { env: {}, exec: async () => { throw Object.assign(new Error("exit 1"), { stderr: "Error: Rate limit exceeded (429)" }); }, now: NOW });
  assert.match(limited.status, /limite de débit, reprise après 00:00 UTC/);
  const paused = await collect(buildQueries(), { env: {}, exec: enoent, cache: { pausedUntil: limited.paused }, now: NOW + 10 * 60e3 });
  assert.match(paused.status, /limite de débit/); assert.equal(paused.posts.length, 0);
  const api = await collect(buildQueries(["HYPE"]), { env: { TWITTERAPI_IO_KEY: "k" }, exec: enoent, now: NOW,
    fetch: async (url, init) => { assert.equal(init.headers["X-API-Key"], "k"); return new Response(JSON.stringify({ tweets: [CATALYST] }), { status: 200 }); } });
  assert.equal(api.source, "twitterapi.io"); assert.equal(api.posts.length, 2);
  // cycle complet sans réseau : aucune erreur, flux vide
  const off = await runXAlpha({ env: {}, net: false, now: NOW });
  assert.equal(off.alpha.status, "désactivé (--no-net)"); assert.deepEqual(off.alpha.epsilon.tickers, {});
});

test("lecture des formats de sortie et filtres", () => {
  assert.equal(parseOutput('{"tweets":[{"id":"1","text":"a"}]}').length, 1);
  assert.equal(parseOutput('{"id":"1","text":"a"}\n{"id":"2","text":"b"}').length, 2);
  assert.throws(() => parseOutput("Usage: agent-reach ..."), /illisible/);
  const p = normalizePost({ id_str: "42", full_text: "hello $ETH", user: { screen_name: "abc" }, created_at: "Fri Nov 27 22:00:00 +0000 2026", favorite_count: 3 });
  assert.deepEqual([p.id, p.author, p.likes, p.url], ["42", "abc", 3, "https://x.com/abc/status/42"]);
  assert.ok(isSpam("Use my referral link")); assert.ok(isSpam("claim now at t.me/xyz")); assert.ok(!isSpam("BTC funding flips negative"));
  assert.ok(PUBLIC_PAPER_FILES.includes(FILES.xAlpha)); assert.ok(!PUBLIC_PAPER_FILES.includes(FILES.xCache));
  assert.equal(ingest([{ raw: NOISE }], {}, { now: NOW }).stats.ignored, 1);
  assert.deepEqual(epsilonSummary({ posts: {} }, NOW), {});
});
