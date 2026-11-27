// Collecte X (Twitter) pour l'agent de paper trading : deux flux tirés des mêmes recherches.
//   Flux ε (epsilon, alpha direct, demi-vie < 4 h) : catalyseurs, alertes on-chain, funding/OI, pics de vélocité sur nos
//     tickers ; résumé compact par ticker injecté dans le dossier des LLM votants (decision.mjs).
//   Flux ∞ (infini, bibliothèque R&D) : threads de stratégies quant/ML ; les plus intéressants (score ≥ 75/100) sont
//     traduits par gpt-oss-120b ou qwen3.8 en Blueprints JSON déclaratifs (blueprint.mjs), jamais en code exécuté.
//
// Source : la CLI agent-reach (recherche X par cookies, sans API payante). Sa syntaxe a changé selon les versions :
// la commande se règle avec X_REACH_CMD (tableau JSON, {q} = requête, {n} = nombre), par défaut
// ["agent-reach","search-twitter","{q}","-n","{n}"]. Repli : API X v2 (X_BEARER_TOKEN) ou twitterapi.io (TWITTERAPI_IO_KEY).
// Sans aucune source (cas normal en CI sans cookies), ou en cas de limite de débit, le flux est neutre : aucune erreur,
// aucun signal, le cycle continue. Cache local (data/paper/x_cache.json) : posts des dernières 24 h (vélocité), posts déjà
// traduits, et pause d'une heure après une limite de débit.
import { execFile } from "node:child_process";
import { LLMRouter, DEFAULT_PROVIDERS } from "./router.mjs";
import { validateBlueprint, BLUEPRINT_PROMPT, TICKERS } from "./blueprint.mjs";

const H = 3600e3;
export const X_CONFIG = Object.freeze({
  ttlH: 4,                 // durée de vie d'un signal ε
  recentH: 1, keepH: 24,   // vélocité : mentions de la dernière heure contre la moyenne horaire des 23 h précédentes
  minBaseRate: 0.25,       // plancher de la moyenne horaire (mentions pondérées) : évite les ratios infinis au démarrage
  squeezeVelocity: 2.2, squeezeBias: 0.35,
  squeezeMinMentions: 3,   // un seul post ne suffit pas à lever une alerte de squeeze (vélocité trompeuse au démarrage)
  interestMin: 75, maxBlueprintsPerCycle: 3, libraryMax: 60,
  perQuery: 40, timeoutMs: 45_000, rateLimitPauseH: 1,
  tier1Weight: 1, generalWeight: 0.35,
});

// Comptes de référence (CT, macro, on-chain) : remplaçables par X_TIER1 (liste séparée par des virgules).
export const DEFAULT_TIER1 = Object.freeze(["DeItaone", "unusual_whales", "KobeissiLetter", "zerohedge", "NickTimiraos", "WatcherGuru", "tier10k",
  "lookonchain", "spotonchain", "EmberCN", "WuBlockchain", "whale_alert", "glassnode", "cryptoquant_com", "coinglass_com", "financialjuice",
  "LiveSquawk", "FirstSquawk", "Pentosh1", "HsakaTrades", "CryptoHayes", "GCRClassic", "macrocephalopod"]);
const tier1Of = (env) => new Set((env.X_TIER1 ? env.X_TIER1.split(",") : DEFAULT_TIER1).map((s) => s.trim().toLowerCase()).filter(Boolean));

export const TICKER_PATTERNS = Object.freeze({
  BTC: /\$btc\b|\bbtc\b|\bbitcoin\b/i,
  ETH: /\$eth\b|\beth\b|\bethereum\b/i,
  SOL: /\$sol\b|\bsolana\b/i,
  HYPE: /\$hype\b|\bhyperliquid\b/i,
  ZEC: /\$zec\b|\bzec\b|\bzcash\b/i,
  NVDA: /\$nvda\b|\bnvda\b|\bnvidia\b/i,
  SOXL: /\$soxl\b|\bsoxl\b|\bsemis\b|\bsemiconductors?\b/i,
  BRENTOIL: /\bbrent\b|\bcrude\b|\boil prices?\b|\bopec\b/i,
});
const TICKER_QUERY = { BTC: "$BTC OR bitcoin", ETH: "$ETH OR ethereum", SOL: "$SOL OR solana", HYPE: "$HYPE OR hyperliquid", ZEC: "$ZEC OR zcash",
  NVDA: "$NVDA OR nvidia", SOXL: "$SOXL OR semiconductors", BRENTOIL: "brent OR crude OR OPEC" };
const CATALYST_QUERY = '(breaking OR "just in" OR liquidation OR liquidated OR "funding rate" OR "open interest" OR whale OR hack OR ETF OR SEC OR Fed OR CPI OR earnings OR squeeze)';
export const INFINITY_QUERY = '("alpha" OR "backtest" OR "sharpe" OR "orderbook" OR "funding rate" OR "feature engineering" OR "mean reversion" OR "kalman")';
const NO_SPAM = " -airdrop -giveaway -whitelist";

export function buildQueries(tickers = TICKERS) {
  return [...tickers.map((t) => ({ flow: "epsilon", ticker: t, q: `(${TICKER_QUERY[t]}) ${CATALYST_QUERY}${NO_SPAM}` })), { flow: "infinity", q: INFINITY_QUERY + NO_SPAM }];
}

/* ---------------- filtres et classement ---------------- */

const SPAM = /\b(airdrops?|giveaways?|give ?away|whitelist(ed)?|wl spot|presale|free mint|claim (now|your)|dm me|join (my|our) (vip|group|channel)|referral|invite code|promo code|bonus code|use (my )?code)\b|t\.me\/|telegram\.(me|org)|\btelegram\b|[?&]ref=|\/ref\/|\bref link\b/i;
export const isSpam = (text) => SPAM.test(text || "");
export const dedupeKey = (text) => String(text || "").toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/[@#$]\w+/g, (m) => (m[0] === "$" ? m : "")).replace(/[^a-z0-9$%. ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);

const CATALYST = /\b(breaking|just in|alert|listing|listed|delist\w*|hack(ed)?|exploit\w*|etf|sec|fed|fomc|cpi|ppi|nfp|rate (cut|hike)|liquidat\w+|unlock\w*|whales?|on-?chain|inflows?|outflows?|funding|open interest|\boi\b|earnings|guidance|opec|sanctions?|squeeze|halt\w*|approv\w+|tariffs?|short interest)\b/i;
const QUANT = ["alpha", "backtest", "sharpe", "orderbook", "order book", "funding rate", "feature engineering", "mean reversion", "kalman", "regression",
  "xgboost", "lstm", "random forest", "z-score", "zscore", "rsi", "bollinger", "atr", "momentum", "walk-forward", "out-of-sample", "overfit", "signal", "strategy", "factor", "volatility regime", "drawdown", "win rate"];
const BULL = /\b(bull\w*|breakout|break(s|ing)? out|rall(y|ies)|pump\w*|surg\w+|soar\w*|moon\w*|ath|all-time high|higher|bid|buy(ing|ers)?|accumulat\w+|inflows?|upgrade\w*|beat\w*|short squeeze|squeez\w+|approv\w+|long(s|ing)?)\b/i;
const BEAR = /\b(bear\w*|dump\w*|crash\w*|plung\w+|drop\w*|sell(ing|ers|off|-off)?|outflows?|downgrade\w*|miss\w*|hack(ed)?|exploit\w*|lower|reject\w*|top(ped)?|short(s|ing)?|rug\w*|delist\w*)\b/i;
const count = (re, text) => (String(text).match(new RegExp(re.source, "gi")) || []).length;
const clip = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

// Biais d'un post : +1 haussier, −1 baissier, 0 neutre ou mitigé
export function postBias(text) {
  const b = count(BULL, text), s = count(BEAR, text);
  return b + s ? (b - s) / (b + s) : 0;
}

export function classify(p, tier1) {
  const text = p.text || "", lower = text.toLowerCase();
  const tickers = TICKERS.filter((t) => TICKER_PATTERNS[t].test(text));
  const quantHits = QUANT.filter((k) => lower.includes(k)).length;
  const tier = tier1.has(String(p.author || "").toLowerCase()) ? 1 : 2;
  const eng = 1 + Math.min(2, Math.log10(1 + (p.likes || 0) + 2 * (p.reposts || 0) + (p.replies || 0) + (p.views || 0) / 1000) / 2);
  const w = (tier === 1 ? X_CONFIG.tier1Weight : X_CONFIG.generalWeight) * eng;
  // stratégie (∞) d'abord : un thread quant cite souvent BTC sans être un catalyseur
  const kind = quantHits >= 2 ? "infinity" : tickers.length && (CATALYST.test(text) || tier === 1) ? "epsilon" : null;
  return { ...p, tickers, kind, tier, w: r2(w), bias: r2(postBias(text)), quantHits };
}

// Intérêt d'un post du flux ∞ (0–100) : vocabulaire quant, règles chiffrées, format thread, crédibilité, engagement.
export function interestScore(p) {
  const text = p.text || "";
  let s = Math.min(48, (p.quantHits || 0) * 12);
  if (/🧵|\bthread\b|\b1\/\d*\b|\(1\/\d+\)/i.test(text)) s += 10;
  if (/[<>=]\s*-?\d|\d+(\.\d+)?\s*%|\bsharpe\s*(of|=|:)?\s*\d|\bperiod\s*\d|\b\d+\s*-?(day|period|bar|hour)s?\b/i.test(text)) s += 12;
  if (text.length > 280) s += 8;
  if (p.tier === 1) s += 12;
  s += Math.min(10, Math.round(Math.log10(1 + (p.likes || 0) + 2 * (p.reposts || 0)) * 4));
  return Math.min(100, s);
}

/* ---------------- lecture des posts bruts ---------------- */

const first = (...xs) => xs.find((x) => x != null && x !== "");
const numOf = (...xs) => { const v = first(...xs); const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Accepte les formes courantes (agent-reach / twitter-cli, API X v2, twitterapi.io).
export function normalizePost(raw, fetchedAt = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const lg = raw.legacy || {}, pm = raw.public_metrics || raw.metrics || {};
  const text = first(raw.text, raw.full_text, raw.content, lg.full_text, raw.rawContent);
  if (!text) return null;
  const a = raw.author || raw.user || {};
  const author = String(first(typeof raw.author === "string" ? raw.author : null, a.userName, a.username, a.screen_name, a.handle, raw.username, raw.screen_name, raw.user_screen_name) || "?").replace(/^@/, "");
  const id = String(first(raw.id_str, raw.id, raw.rest_id, raw.tweet_id, raw.tweetId) ?? "h" + dedupeKey(text).slice(0, 40));
  const t = Date.parse(first(raw.createdAt, raw.created_at, raw.date, raw.time, lg.created_at) || "") || (Number(raw.timestamp) ? Number(raw.timestamp) * (raw.timestamp < 1e12 ? 1000 : 1) : fetchedAt);
  return { id, text: String(text), author, t,
    likes: numOf(raw.likeCount, raw.favorite_count, raw.likes, raw.favorites, pm.like_count, lg.favorite_count),
    reposts: numOf(raw.retweetCount, raw.retweet_count, raw.retweets, raw.reposts, pm.retweet_count, lg.retweet_count),
    replies: numOf(raw.replyCount, raw.reply_count, raw.replies, pm.reply_count, lg.reply_count),
    views: numOf(raw.viewCount, raw.views, raw.view_count, pm.impression_count),
    url: first(raw.url, raw.tweet_url, raw.link) || (author !== "?" && !id.startsWith("h") ? `https://x.com/${author}/status/${id}` : null) };
}

export function parseOutput(out) {
  const s = String(out || "").trim();
  if (!s) return [];
  const pick = (j) => (Array.isArray(j) ? j : j?.tweets || j?.data || j?.results || j?.items || j?.posts || []);
  try { return pick(JSON.parse(s)); } catch {}
  const rows = s.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!rows.length) throw new Error("sortie illisible (JSON attendu)");
  return rows.flatMap((r) => (Array.isArray(r) ? r : r.tweets || r.data ? pick(r) : [r]));
}

const RATE = /rate.?limit|too many requests|\b429\b/i;
export const reachArgs = (q, n, env = process.env) =>
  (env.X_REACH_CMD ? JSON.parse(env.X_REACH_CMD) : ["agent-reach", "search-twitter", "{q}", "-n", "{n}"]).map((a) => String(a).replace("{q}", q).replace("{n}", String(n)));

// exec(cmd, args) → Promise<{ stdout, stderr }> ; erreurs : code ENOENT (CLI absente), ou message de limite de débit
export const defaultExec = (cmd, args, timeoutMs = X_CONFIG.timeoutMs) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr }))));

async function apiSearch(q, n, env, f) {
  if (env.X_BEARER_TOKEN) {
    const r = await f(`https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(q + " -is:retweet")}&max_results=${Math.min(100, Math.max(10, n))}&tweet.fields=created_at,author_id,public_metrics&expansions=author_id&user.fields=username`,
      { headers: { authorization: `Bearer ${env.X_BEARER_TOKEN}` } });
    if (r.status === 429) throw Object.assign(new Error("HTTP 429"), { rate: true });
    if (!r.ok) throw new Error(`API X : HTTP ${r.status}`);
    const d = await r.json(), users = Object.fromEntries((d.includes?.users || []).map((u) => [u.id, u.username]));
    return { source: "API X v2", posts: (d.data || []).map((t) => ({ ...t, author: users[t.author_id] })) };
  }
  if (env.TWITTERAPI_IO_KEY) {
    const r = await f(`https://api.twitterapi.io/twitter/tweet/advanced_search?query=${encodeURIComponent(q)}&queryType=Latest`, { headers: { "X-API-Key": env.TWITTERAPI_IO_KEY } });
    if (r.status === 429) throw Object.assign(new Error("HTTP 429"), { rate: true });
    if (!r.ok) throw new Error(`twitterapi.io : HTTP ${r.status}`);
    return { source: "twitterapi.io", posts: (await r.json()).tweets || [] };
  }
  return null;
}

// Lance toutes les requêtes. Jamais d'exception : { posts: [{ raw, flow, ticker }], source, status, notes }.
export async function collect(queries, { env = process.env, exec = defaultExec, fetch: f = globalThis.fetch, cache = {}, now = Date.now(), cfg = X_CONFIG } = {}) {
  const out = [], notes = [];
  if (cache.pausedUntil && now < Date.parse(cache.pausedUntil)) return { posts: [], source: null, status: `neutre : limite de débit, reprise après ${cache.pausedUntil.slice(11, 16)} UTC`, notes, paused: cache.pausedUntil };
  let cli = !env.X_REACH_DISABLE, source = null, paused = null;
  for (const qq of queries) {
    if (paused) break;
    let got = null;
    if (cli) {
      const [cmd, ...args] = reachArgs(qq.q, cfg.perQuery, env);
      try { const r = await exec(cmd, args); got = { source: "agent-reach", posts: parseOutput(r.stdout) }; }
      catch (e) {
        const msg = `${e.message || ""} ${e.stderr || ""} ${e.stdout || ""}`;
        if (e.code === "ENOENT") { cli = false; notes.push(`${cmd} absent`); }
        else if (RATE.test(msg)) { paused = new Date(now + cfg.rateLimitPauseH * H).toISOString(); notes.push("agent-reach : limite de débit"); }
        else notes.push(`agent-reach : ${String(e.message || e).slice(0, 120)}`);
      }
    }
    if (!got && !paused) {
      try { got = await apiSearch(qq.q, cfg.perQuery, env, f); }
      catch (e) { if (e.rate) paused = new Date(now + cfg.rateLimitPauseH * H).toISOString(); notes.push(String(e.message || e).slice(0, 120)); }
    }
    if (got) { source ??= got.source; for (const raw of got.posts) out.push({ raw, flow: qq.flow, ticker: qq.ticker ?? null }); }
  }
  const status = source ? `actif (${source})` : paused ? `neutre : limite de débit, reprise après ${paused.slice(11, 16)} UTC` : "neutre : aucune source X (agent-reach absent, pas de clé API)";
  return { posts: out, source, status, notes: [...new Set(notes)], paused };
}

/* ---------------- flux ε ---------------- */

// Range les posts bruts dans le cache (dédoublonnés, spams écartés). Retourne les compteurs du tri.
export function ingest(rawPosts, cache, { env = process.env, now = Date.now(), cfg = X_CONFIG } = {}) {
  const c = { posts: {}, keys: {}, done: {}, ...cache }, tier1 = tier1Of(env), stats = { raw: rawPosts.length, spam: 0, dup: 0, known: 0, epsilon: 0, infinity: 0, ignored: 0 };
  c.posts = { ...c.posts }; c.keys = { ...c.keys };
  for (const r of rawPosts) {
    const p = normalizePost(r.raw ?? r, now);
    if (!p) { stats.ignored++; continue; }
    if (c.posts[p.id]) { stats.known++; continue; }
    if (isSpam(p.text)) { stats.spam++; continue; }
    const k = dedupeKey(p.text);
    if (c.keys[k]) { stats.dup++; continue; }
    const q = classify(p, tier1);
    if (!q.kind) { stats.ignored++; continue; }
    if (q.kind === "infinity") q.interest = interestScore(q);
    c.posts[q.id] = q; c.keys[k] = q.id; stats[q.kind]++;
  }
  // on oublie ce qui a plus de 24 h (les posts ∞ déjà traduits restent dans `done`)
  for (const [id, p] of Object.entries(c.posts)) if (now - p.t > cfg.keepH * H) { delete c.posts[id]; for (const [k, v] of Object.entries(c.keys)) if (v === id) delete c.keys[k]; }
  return { cache: c, stats };
}

export function epsilonSummary(cache, now = Date.now(), cfg = X_CONFIG) {
  const eps = Object.values(cache.posts || {}).filter((p) => p.kind === "epsilon"), out = {};
  for (const t of TICKERS) {
    const ps = eps.filter((p) => p.tickers.includes(t) && p.t <= now + 5 * 60e3);
    if (!ps.length) continue;
    const recent = ps.filter((p) => p.t >= now - cfg.recentH * H), base = ps.filter((p) => p.t < now - cfg.recentH * H && p.t >= now - cfg.keepH * H);
    const sw = (xs) => xs.reduce((a, p) => a + p.w, 0);
    const baseRate = sw(base) / (cfg.keepH - cfg.recentH), velocity = sw(recent) / cfg.recentH / Math.max(baseRate, cfg.minBaseRate);
    const live = ps.filter((p) => p.t >= now - cfg.ttlH * H), wl = sw(live);
    const bias = wl ? clip(live.reduce((a, p) => a + p.w * p.bias, 0) / wl) : 0;
    const lastT = Math.max(...ps.map((p) => p.t)), expiresAt = new Date(lastT + cfg.ttlH * H).toISOString();
    out[t] = { ticker: t, active: lastT + cfg.ttlH * H > now, mentionVelocityRatio: r2(velocity), netNarrativeBias: r2(bias),
      squeezeWarning: velocity >= cfg.squeezeVelocity && bias > cfg.squeezeBias && recent.length >= cfg.squeezeMinMentions, mentions1h: recent.length, mentions24h: ps.length, expiresAt,
      catalysts: live.sort((a, b) => b.w - a.w || b.t - a.t).slice(0, 3).map((p) => ({ text: p.text.replace(/\s+/g, " ").slice(0, 220), author: p.author, url: p.url, t: new Date(p.t).toISOString(), bias: p.bias, tier: p.tier })) };
  }
  return out;
}

// Résumé compact pour les LLM votants : signaux encore actifs seulement.
export function promptContext(epsilon, now = Date.now()) {
  const out = {};
  for (const [t, e] of Object.entries(epsilon || {})) {
    if (!e.active || Date.parse(e.expiresAt) <= now) continue;
    out[t] = { mentionVelocityRatio: e.mentionVelocityRatio, netNarrativeBias: e.netNarrativeBias, squeezeWarning: e.squeezeWarning,
      expires_in_min: Math.round((Date.parse(e.expiresAt) - now) / 60e3),
      catalysts: e.catalysts.map((c) => ({ text: c.text.slice(0, 160), author: c.author, age_min: Math.round((now - Date.parse(c.t)) / 60e3) })) };
  }
  return out;
}

/* ---------------- flux ∞ ---------------- */

// Traducteur : gpt-oss-120b, puis qwen3.8 si le premier échoue ou rend un JSON invalide. null sans clé Groq.
export function blueprintExtractor({ env = process.env, fetch: f = globalThis.fetch, providers = DEFAULT_PROVIDERS } = {}) {
  const keep = ["openai/gpt-oss-120b", "qwen/qwen3.8-27b"];
  const list = providers.map((p) => ({ ...p, models: p.models.filter((m) => keep.includes(m.id)).map((m) => ({ id: m.id, family: "blueprint" })) })).filter((p) => p.models.length);
  const router = new LLMRouter({ env, providers: list, fetch: f });
  if (!router.available().length) return null;
  return async (post) => {
    const messages = [{ role: "system", content: BLUEPRINT_PROMPT }, { role: "user", content: JSON.stringify({ author: post.author, text: post.text.slice(0, 2000) }) }];
    const r = await router.collect(1, messages, (json) => {
      if (json?.none === true) return { ok: true, value: null };
      const v = validateBlueprint(json);
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.errors.slice(0, 4).join(" ; ") };
    });
    const res = r.results[0];
    return res ? { blueprint: res.value, model: res.model } : { error: r.errors.at(-1) || "aucun modèle" };
  };
}

// Traduit au plus maxBlueprintsPerCycle posts ∞ intéressants pas encore traités ; enrichit la bibliothèque.
export async function updateLibrary(library, cache, extract, { now = Date.now(), cfg = X_CONFIG } = {}) {
  const lib = [...(library || [])], c = { ...cache, done: { ...(cache.done || {}) } }, errors = [];
  const todo = Object.values(c.posts || {}).filter((p) => p.kind === "infinity" && p.interest >= cfg.interestMin && !c.done[p.id]).sort((a, b) => b.interest - a.interest);
  const pending = Math.max(0, todo.length - (extract ? cfg.maxBlueprintsPerCycle : 0));
  if (extract) for (const p of todo.slice(0, cfg.maxBlueprintsPerCycle)) {
    let r;
    try { r = await extract(p); } catch (e) { r = { error: String(e.message || e) }; }
    if (r.error) { errors.push(`@${p.author} : ${r.error}`.slice(0, 200)); continue; }   // réessayé au cycle suivant
    c.done[p.id] = new Date(now).toISOString();
    if (!r.blueprint) continue;   // aucune règle testable dans le post
    lib.unshift({ id: `bp-${p.id}`, name: r.blueprint.name, status: "En attente D1", createdAt: new Date(now).toISOString(), interest: p.interest, model: r.model,
      source: { author: p.author, url: p.url, postId: p.id, t: new Date(p.t).toISOString(), excerpt: p.text.replace(/\s+/g, " ").slice(0, 280) }, blueprint: r.blueprint });
  }
  return { library: lib.slice(0, cfg.libraryMax), cache: c, errors, pending };
}

/* ---------------- cycle complet ---------------- */

// prev : x_alpha.json précédent ; cache : x_cache.json. net = false : aucun appel (relecture du cache seulement).
export async function runXAlpha({ prev = null, cache = {}, env = process.env, exec, fetch: f, extract = undefined, now = Date.now(), net = true, cfg = X_CONFIG } = {}) {
  const col = net ? await collect(buildQueries(), { env, exec, fetch: f, cache, now, cfg }) : { posts: [], source: null, status: "désactivé (--no-net)", notes: [] };
  let { cache: c, stats } = ingest(col.posts, cache, { env, now, cfg });
  if (col.paused) c.pausedUntil = col.paused; else if (net) delete c.pausedUntil;
  const ext = extract === undefined ? (net ? blueprintExtractor({ env, fetch: f }) : null) : extract;
  const lib = await updateLibrary(prev?.infinity?.blueprints, c, ext, { now, cfg });
  c = lib.cache;
  const epsilon = epsilonSummary(c, now, cfg);
  const alpha = {
    at: new Date(now).toISOString(), source: col.source, status: col.status, notes: col.notes, stats,
    epsilon: { ttlH: cfg.ttlH, squeeze: { velocity: cfg.squeezeVelocity, bias: cfg.squeezeBias }, tickers: epsilon, router: { injected: false, at: null, tickers: [] } },
    infinity: { interestMin: cfg.interestMin, blueprints: lib.library, pending: lib.pending, errors: lib.errors, translator: ext ? "gpt-oss-120b / qwen3.8" : "indisponible (pas de clé Groq)" },
    leagues: null,   // tableau des 3 Ligues : étape suivante
  };
  return { alpha, cache: c };
}
