// Collecte X (Twitter) pour l'agent de paper trading : deux flux tirés des mêmes recherches.
//   Flux ε (epsilon, alpha direct, demi-vie < 4 h) : catalyseurs, alertes on-chain, funding/OI, pics de vélocité sur nos
//     tickers ; résumé compact par ticker injecté dans le dossier des LLM votants (decision.mjs).
//   Flux ∞ (infini, bibliothèque R&D) : threads de stratégies quant/ML ; les plus intéressants (score ≥ 75/100 pour X,
//     ≥ 60/100 pour arXiv q-fin, déjà filtré sur nos sujets par x_free.mjs) sont
//     traduits par gpt-oss-120b ou qwen3.8 en Blueprints JSON déclaratifs (blueprint.mjs), jamais en code exécuté.
//
// Sources, dans l'ordre (gratuites d'abord) :
//   1. twitter-cli (PyPI twitter-cli, commande `twitter`) avec les cookies d'une session X : TWITTER_AUTH_TOKEN et
//      TWITTER_CT0 (en CI : secrets X_AUTH_TOKEN et X_CT0). C'est la seule voie automatisable en CI : agent-reach ne prend
//      pas ces cookies (sa recherche X passe par un navigateur Chrome connecté à la main). Commande : X_TWITTER_CMD.
//   2. agent-reach, sur un poste où son navigateur est connecté à x.com : `agent-reach twitter search <q> --limit <n>`
//      (X_REACH_CMD). Absent en CI.
//   3. API X v2 (X_BEARER_TOKEN) ou twitterapi.io (TWITTERAPI_IO_KEY).
// Commandes réglables : tableau JSON, {q} = requête, {n} = nombre. Sans source, cookies expirés ou limite de débit, le flux
// est neutre (raison explicite dans le statut et les journaux) et le cycle continue. Cache local (data/paper/x_cache.json) :
// posts des dernières 24 h (vélocité), posts déjà traduits, pause d'une heure après une limite de débit. Anti-ban : une
// collecte réussie de moins de 45 min est réutilisée telle quelle (sauf X_FORCE).
// Sources gratuites sans authentification (x_free.mjs), collectées à chaque cycle en complément, et seules quand X échoue :
// RSS crypto/macro pour ε, arXiv q-fin pour ∞.
import { execFile } from "node:child_process";
import { LLMRouter, DEFAULT_PROVIDERS, COMPILE_PREFER, compileProviders } from "./router.mjs";
import { validateBlueprint, coerceBlueprint, blueprintPrompt, BLUEPRINT_PROMPT_V, TICKERS, inferFamily } from "./blueprint.mjs";
import { catalogPrompt } from "./universe.mjs";
import { collectFree, ARXIV_TOPICS, parseFeed } from "./x_free.mjs";

const H = 3600e3;
export const X_CONFIG = Object.freeze({
  ttlH: 4,                 // durée de vie d'un signal ε
  // ∞ gardé 21 jours : le flux arXiv q-fin (40 derniers dépôts, filtrés par sujet) couvre ~3 semaines ; à 7 jours, la
  // plupart des abstracts étaient effacés juste après avoir été comptés (stats.infinity) et jamais compilés.
  recentH: 1, keepH: 24, keepInfinityD: 21,   // vélocité : mentions de la dernière heure contre la moyenne horaire des 23 h précédentes
  minBaseRate: 0.25,       // plancher de la moyenne horaire (mentions pondérées) : évite les ratios infinis au démarrage
  squeezeVelocity: 2.2, squeezeBias: 0.35,
  squeezeMinMentions: 3,   // un seul post ne suffit pas à lever une alerte de squeeze (vélocité trompeuse au démarrage)
  // seuil d'intérêt du flux ∞. arXiv : abstracts q-fin déjà filtrés sur nos sujets (ARXIV_TOPICS), sans likes ni format
  // thread, ils plafonnent vers 55–70/100 : à 75 aucun n'était jamais compilé (cycle du 28/11/2026, 00:10 UTC : infinity 11,
  // blueprints 0).
  // maxBlueprintsPerCycle : nouveaux Blueprints par cycle, posts ∞ et lots « Builders » confondus (les Builders d'abord)
  interestMin: 75, interestMinArxiv: 60, maxBlueprintsPerCycle: 6, maxBlueprintsBootstrap: 6, libraryMax: 60,
  perQuery: 40, timeoutMs: 90_000, rateLimitPauseH: 1,
  reuseMin: 45,            // anti-ban : pas de nouvelle collecte si la dernière, réussie, a moins de 45 min
  tier1Weight: 1, generalWeight: 0.35, newsWeight: 0.6,   // un article de presse compte un peu plus qu'un compte X ordinaire
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
  "xgboost", "lstm", "random forest", "z-score", "zscore", "rsi", "bollinger", "atr", "momentum", "walk-forward", "out-of-sample", "overfit", "signal", "strategy", "factor", "volatility regime", "drawdown", "win rate",
  "garch", "statistical arbitrage", "pairs trading", "cointegration", "microstructure", "order flow", "market making", "regime", "machine learning", "deep learning", "reinforcement learning", "predict", "forecast"];
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
  const src = p.src || "x", free = src !== "x";
  const tier = free || tier1.has(String(p.author || "").toLowerCase()) ? 1 : 2;   // presse et arXiv : sources identifiées
  const eng = 1 + Math.min(2, Math.log10(1 + (p.likes || 0) + 2 * (p.reposts || 0) + (p.replies || 0) + (p.views || 0) / 1000) / 2);
  const w = (src === "rss" ? X_CONFIG.newsWeight : tier === 1 ? X_CONFIG.tier1Weight : X_CONFIG.generalWeight) * eng;
  // stratégie (∞) d'abord : un thread quant cite souvent BTC sans être un catalyseur. RSS : ε seulement ; arXiv : ∞ seulement.
  const kind = src === "arxiv" ? (quantHits >= 1 ? "infinity" : null)
    : src === "rss" ? (tickers.length ? "epsilon" : null)
    : quantHits >= 2 ? "infinity" : tickers.length && (CATALYST.test(text) || tier === 1) ? "epsilon" : null;
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
  if (p.src === "arxiv" && ARXIV_TOPICS.test(text)) s += 10;   // modèle publié sur un sujet testable (facteurs, GARCH, microstructure…)
  s += Math.min(10, Math.round(Math.log10(1 + (p.likes || 0) + 2 * (p.reposts || 0)) * 4));
  return Math.min(100, s);
}

/* ---------------- lecture des posts bruts ---------------- */

const first = (...xs) => xs.find((x) => x != null && x !== "");
const numOf = (...xs) => { const v = first(...xs); const n = Number(v); return Number.isFinite(n) ? n : 0; };
// Accepte les formes courantes (agent-reach / twitter-cli, API X v2, twitterapi.io).
export function normalizePost(raw, fetchedAt = Date.now()) {
  if (!raw || typeof raw !== "object") return null;
  const lg = raw.legacy || {}, pm = raw.public_metrics || raw.metrics || raw.raw?.metrics || {};
  const text = first(raw.text, raw.full_text, raw.content, lg.full_text, raw.rawContent);
  if (!text) return null;
  const a = raw.author || raw.user || {};
  const author = String(first(typeof raw.author === "string" ? raw.author : null, a.screenName, a.userName, a.username, a.screen_name, a.handle, raw.username, raw.screen_name, raw.user_screen_name) || "?").replace(/^@/, "");
  const id = String(first(raw.id_str, raw.id, raw.rest_id, raw.tweet_id, raw.tweetId) ?? "h" + dedupeKey(text).slice(0, 40));
  const t = Date.parse(first(raw.createdAtISO, raw.published_at, raw.createdAt, raw.created_at, raw.date, raw.time, lg.created_at) || "") || (Number(raw.timestamp) ? Number(raw.timestamp) * (raw.timestamp < 1e12 ? 1000 : 1) : fetchedAt);
  return { id, text: String(text), author, t, src: raw.src || "x",
    likes: numOf(raw.likeCount, raw.favorite_count, raw.likes, raw.favorites, pm.likes, pm.like_count, lg.favorite_count),
    reposts: numOf(raw.retweetCount, raw.retweet_count, raw.retweets, raw.reposts, pm.retweets, pm.retweet_count, lg.retweet_count),
    replies: numOf(raw.replyCount, raw.reply_count, raw.replies, pm.replies, pm.reply_count, lg.reply_count),
    views: numOf(raw.viewCount, raw.views, raw.view_count, pm.views, pm.impression_count),
    url: first(raw.url, raw.tweet_url, raw.link) || (author !== "?" && !id.startsWith("h") ? `https://x.com/${author}/status/${id}` : null) };
}

export function parseOutput(out) {
  const s = String(out || "").trim();
  if (!s) return [];
  const pick = (j) => (Array.isArray(j) ? j : j?.tweets || j?.data || j?.results || j?.items || j?.posts || []);
  let j;
  try { j = JSON.parse(s); } catch {}
  if (j !== undefined) {
    if (j && j.ok === false) throw Object.assign(new Error(j.error?.message || j.error?.code || "erreur"), { envelope: j });
    return pick(j);
  }
  const rows = s.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (!rows.length) throw new Error("sortie illisible (JSON attendu)");
  return rows.flatMap((r) => (Array.isArray(r) ? r : r.tweets || r.data ? pick(r) : [r]));
}

const RATE = /rate.?limit|too many requests|\b429\b/i;
const AUTH = /cookie expired|no twitter cookies|not_authenticated|need_login|log ?in to x|http 40[13]\b/i;

// CLI disponibles, par ordre de priorité. twitter-cli seulement si les deux cookies sont fournis.
export function cliBackends(env = process.env) {
  const out = [];
  if (env.TWITTER_AUTH_TOKEN && env.TWITTER_CT0 && !env.X_TWITTER_DISABLE)
    out.push({ name: "twitter-cli", tpl: env.X_TWITTER_CMD ? JSON.parse(env.X_TWITTER_CMD) : ["twitter", "search", "{q}", "-t", "Latest", "--max", "{n}", "--json"] });
  if (!env.X_REACH_DISABLE) out.push({ name: "agent-reach", tpl: env.X_REACH_CMD ? JSON.parse(env.X_REACH_CMD) : ["agent-reach", "twitter", "search", "{q}", "--limit", "{n}"] });
  return out;
}
const fill = (tpl, q, n) => tpl.map((a) => String(a).replace("{q}", q).replace("{n}", String(n)));
export const reachArgs = (q, n, env = process.env) => fill(cliBackends({ ...env, TWITTER_AUTH_TOKEN: "", X_REACH_DISABLE: "" }).at(-1).tpl, q, n);

// Erreur d'une CLI → missing (pas installée), auth (cookies expirés / pas connecté), rate (limite ou blocage), other.
export function cliError(e) {
  if (e.code === "ENOENT") return { kind: "missing" };
  let env = e.envelope;
  if (!env) try { env = JSON.parse(String(e.stdout || "").trim()); } catch {}
  const code = String(env?.error?.code || ""), msg = String(env?.error?.message || e.stderr || e.message || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (/not_authenticated|need_login/i.test(code) || AUTH.test(msg)) return { kind: "auth", msg };
  if (/rate_limited|platform_blocked/i.test(code) || RATE.test(`${msg} ${e.stderr || ""}`)) return { kind: "rate", msg };
  return { kind: "other", msg: msg || String(e.message || e).slice(0, 160) };
}

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
  const clis = cliBackends(env);
  let source = null, paused = null, authFail = null, otherFail = null;
  for (const qq of queries) {
    if (paused) break;
    let got = null;
    for (const b of clis) {
      if (got || b.off) continue;
      const [cmd, ...args] = fill(b.tpl, qq.q, cfg.perQuery);
      try { const r = await exec(cmd, args); got = { source: b.name, posts: parseOutput(r.stdout) }; }
      catch (e) {
        const k = cliError(e);
        if (k.kind === "missing") { b.off = true; notes.push(`${b.name} absent`); }
        else if (k.kind === "auth") { b.off = true; authFail ??= b.name; notes.push(`${b.name} : cookies X expirés ou invalides (${k.msg})`); }
        else if (k.kind === "rate") { paused = new Date(now + cfg.rateLimitPauseH * H).toISOString(); notes.push(`${b.name} : limite de débit ou blocage (${k.msg})`); break; }
        else { otherFail ??= `${b.name} : ${k.msg}`; notes.push(`${b.name} : ${k.msg}`); }
      }
    }
    if (!got && !paused) {
      try { got = await apiSearch(qq.q, cfg.perQuery, env, f); }
      catch (e) { if (e.rate) paused = new Date(now + cfg.rateLimitPauseH * H).toISOString(); notes.push(String(e.message || e).slice(0, 120)); }
    }
    if (got) { source ??= got.source; for (const raw of got.posts) out.push({ raw, flow: qq.flow, ticker: qq.ticker ?? null }); }
  }
  const status = source ? `actif (${source})` : paused ? `neutre : limite de débit, reprise après ${paused.slice(11, 16)} UTC`
    : authFail ? "neutre : cookies X expirés ou invalides, renouveler les secrets X_AUTH_TOKEN et X_CT0"
    : otherFail ? `neutre : échec de la recherche X (${otherFail})`
    : "neutre : aucune source X (ni cookies, ni agent-reach, ni clé API)";
  const uniq = [...new Set(notes)];
  if (!source && uniq.length) console.warn(`[X] ${status} — ${uniq.join(" ; ")}`);   // visible dans les journaux du workflow
  return { posts: out, source, status, notes: uniq, paused, authFail };
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
  // ε : 24 h (vélocité) ; ∞ : 21 jours, le temps d'être traduits (le flux arXiv couvre ~3 semaines de dépôts).
  // Les posts ∞ déjà traduits restent dans `done`.
  for (const [id, p] of Object.entries(c.posts)) if (now - p.t > (p.kind === "infinity" ? cfg.keepInfinityD * 24 : cfg.keepH) * H) { delete c.posts[id]; for (const [k, v] of Object.entries(c.keys)) if (v === id) delete c.keys[k]; }
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
      catalysts: live.sort((a, b) => b.w - a.w || b.t - a.t).slice(0, 3).map((p) => ({ text: p.text.replace(/\s+/g, " ").slice(0, 220), author: p.author, url: p.url, t: new Date(p.t).toISOString(), bias: p.bias, tier: p.tier, src: p.src || "x" })) };
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

// Traducteur : deepseek-flash d'abord (rapide, sans limite stricte par minute : le quota de Groq reste au vote live), puis
// deepseek-v4-pro, qwen3.8, gpt-oss-120b et openrouter/free, chacun en secours du précédent s'il échoue, rend un Blueprint invalide ou
// répond {"none":true} (« aucune règle testable » : le post n'est écarté que si tous le disent). Seuls les modèles dont la
// clé est présente sont essayés.
// La réponse est normalisée (coerceBlueprint) avant la validation stricte. null sans clé Groq.
const NONE = "aucune règle testable ({\"none\":true})";
// catalog : catalogue du cycle (universe.buildCatalog) ; le compilateur choisit alors ses actifs dans tout Hyperliquid et Polymarket
export function blueprintExtractor({ env = process.env, fetch: f = globalThis.fetch, providers = DEFAULT_PROVIDERS, catalog = null } = {}) {
  const system = blueprintPrompt(catalogPrompt(catalog));
  const keep = [...COMPILE_PREFER];   // deepseek-flash → deepseek-chat → gpt-oss-120b → qwen3.8 (router.mjs)
  const router = new LLMRouter({ env, providers: compileProviders(providers, keep), fetch: f });
  if (!router.available().length) return null;
  return async (post) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ source: post.src || "x", author: post.author, text: post.text.slice(0, 2000) }) }];
    const r = await router.collect(1, messages, (json) => {
      if (json?.none === true) return { ok: false, error: NONE };
      const v = validateBlueprint(coerceBlueprint(json));
      return v.ok ? { ok: true, value: v.value } : { ok: false, error: v.errors.slice(0, 4).join(" ; ") };
    }, { prefer: keep });   // ordre global de priorité, tous fournisseurs confondus (DeepSeek avant Groq)
    const res = r.results[0];
    if (res?.resolved) res.model = `${res.model} → ${res.resolved}`;
    if (!res && r.errors.length && r.errors.every((e) => e.endsWith(NONE))) return { blueprint: null, reason: r.errors.join(" | ") };
    // toutes les raisons (modèle par modèle : HTTP, JSON illisible, champ rejeté par le validateur), pas seulement la dernière
    return res ? { blueprint: res.value, model: res.model, tried: r.errors.length } : { error: r.errors.length ? r.errors.join(" | ") : "aucun modèle de compilation disponible" };
  };
}

// Traduit les posts ∞ intéressants (X et arXiv) pas encore compilés ; enrichit la bibliothèque. Tourne à chaque cycle, que la
// collecte soit neuve ou réutilisée : ce qui attend dans le cache est compilé dès qu'un traducteur répond. Bibliothèque vide :
// quota relevé (maxBlueprintsBootstrap) pour alimenter la Division 1 sans attendre plusieurs cycles.
export const interestMinOf = (p, cfg = X_CONFIG) => (p.src === "arxiv" ? cfg.interestMinArxiv ?? cfg.interestMin : cfg.interestMin);

// → { library, cache, errors, pending, notes } ; notes : trace lisible de la compilation (x.notes du journal)
// quota : nombre maximal de compilations ce cycle (par défaut celui de cfg) ; → aussi made et models (modèles qui ont compilé)
export async function updateLibrary(library, cache, extract, { now = Date.now(), cfg = X_CONFIG, quota: qMax = null } = {}) {
  const lib = [...(library || [])], c = { ...cache, done: { ...(cache.done || {}) } }, errors = [], notes = [];
  // prompt changé : les posts écartés (« sans règle testable ») par une version antérieure sont réessayés une fois
  if ((c.doneV ?? 1) < BLUEPRINT_PROMPT_V) {
    const kept = new Set(lib.map((b) => b.source?.postId)), retry = Object.keys(c.done).filter((id) => !kept.has(id));
    for (const id of retry) delete c.done[id];
    if (retry.length) notes.push(`Blueprints : prompt v${BLUEPRINT_PROMPT_V}, ${retry.length} post(s) écarté(s) auparavant réessayé(s)`);
  }
  c.doneV = BLUEPRINT_PROMPT_V;
  const inf = Object.values(c.posts || {}).filter((p) => p.kind === "infinity" && !c.done[p.id]);
  const todo = inf.filter((p) => p.interest >= interestMinOf(p, cfg)).sort((a, b) => b.interest - a.interest);
  const quota = qMax ?? (lib.length ? cfg.maxBlueprintsPerCycle : cfg.maxBlueprintsBootstrap);
  const pending = Math.max(0, todo.length - (extract ? quota : 0));
  const who = (p) => `${p.src === "arxiv" ? "arXiv " : "@"}${p.author} (${p.id}, intérêt ${p.interest})`;
  if (inf.length && !todo.length) notes.push(`Blueprints : ${inf.length} post(s) ∞ en attente, aucun au seuil (max ${Math.max(...inf.map((p) => p.interest))}, seuils X ${cfg.interestMin} / arXiv ${cfg.interestMinArxiv ?? cfg.interestMin})`);
  if (todo.length && !extract) notes.push(`Blueprints : ${todo.length} post(s) au seuil non compilés, traducteur indisponible (pas de GROQ_API_KEY ou --no-llm)`);
  let made = 0, none = 0;
  const models = [];
  if (extract) for (const p of todo.slice(0, quota)) {
    let r;
    try { r = await extract(p); } catch (e) { r = { error: String(e.message || e) }; }
    if (r.error) {   // réessayé au cycle suivant
      errors.push(`${who(p)} : ${r.error}`.slice(0, 600));
      notes.push(`Blueprint échoué, ${who(p)} : ${r.error}`.slice(0, 600));
      continue;
    }
    c.done[p.id] = new Date(now).toISOString();
    if (!r.blueprint) { none++; notes.push(`Blueprint écarté, ${who(p)} : aucune règle testable${r.reason ? ` (${r.reason})` : ' ({"none":true})'}`.slice(0, 400)); continue; }
    made++; models.push(r.model);
    lib.unshift({ id: `bp-${p.id}`, name: r.blueprint.name, family: inferFamily(r.blueprint), status: "En attente D1", createdAt: new Date(now).toISOString(), interest: p.interest, model: r.model,
      source: { src: p.src || "x", author: p.author, url: p.url, postId: p.id, t: new Date(p.t).toISOString(), excerpt: p.text.replace(/\s+/g, " ").slice(0, 280) }, blueprint: r.blueprint });
  }
  if (extract && todo.length) notes.push(`Blueprints : ${made} compilé(s), ${none} sans règle testable, ${errors.length} échec(s) sur ${Math.min(quota, todo.length)} tenté(s) ; ${pending} en attente`);
  return { library: lib.slice(0, cfg.libraryMax), cache: c, errors, pending, notes, made, models };
}

const translatorLabel = (env = process.env) => [env.DEEPSEEK_API_KEY && "deepseek-flash → deepseek-chat", env.GROQ_API_KEY && "gpt-oss-120b → qwen3.8"].filter(Boolean).join(" → ") || "indisponible";

// Bilan de compilation du cycle (x_alpha.json → compile), lu par l'encart « État de la collecte »
export function compileReport({ now = Date.now(), lib, bl, extract, scorer, total }) {
  const models = [...lib.models, ...(bl.stats.model ? Array(bl.stats.compiled).fill(bl.stats.model) : [])];
  const count = {};
  for (const m of models) count[m] = (count[m] || 0) + 1;
  return { at: new Date(now).toISOString(), quota: total, made: lib.made + bl.stats.compiled, posts: lib.made, builders: bl.stats.compiled,
    pending: { posts: lib.pending, builders: bl.stats.pending }, models: count,
    errors: [...(bl.stats.error ? [`Builders : ${bl.stats.error}`] : []), ...lib.errors].map((e) => String(e).slice(0, 300)).slice(0, 6),
    available: { posts: !!extract, builders: !!scorer } };
}

// Compilation différée (après le vote) : traduit les posts ∞ en attente et met à jour la page X Alpha. Les nouveaux
// Blueprints entrent en Division 1 au cycle suivant. → { alpha, cache }
// scorer : lot groupé des posts « Builders » filtrés (builderScorer, deepseek-flash) ; null : file gardée pour plus tard.
export async function compileLibrary(alpha, cache, extract, { now = Date.now(), env = process.env, cfg = X_CONFIG, scorer = null } = {}) {
  if (!alpha?.infinity || !cache) return { alpha, cache };
  const total = (alpha.infinity.blueprints || []).length ? cfg.maxBlueprintsPerCycle : cfg.maxBlueprintsBootstrap;
  const bl = await compileBuilders(alpha.infinity.blueprints, cache, scorer, { now, maxNew: total });
  const lib = await updateLibrary(bl.library, bl.cache, extract, { now, cfg, quota: Math.max(0, total - bl.stats.compiled) });
  const a = { ...alpha, notes: [...new Set([...(alpha.notes || []), ...bl.notes, ...lib.notes])],
    builders: alpha.builders ? { ...alpha.builders, compile: bl.stats, queued: bl.stats.pending } : alpha.builders,
    compile: compileReport({ now, lib, bl, extract, scorer, total }),
    infinity: { ...alpha.infinity, blueprints: lib.library, pending: lib.pending, errors: [...(bl.stats.error ? [`Builders : ${bl.stats.error}`.slice(0, 600)] : []), ...lib.errors], translator: extract ? `${translatorLabel(env)} (après le vote)` : "indisponible (pas de clé LLM)" } };
  return { alpha: a, cache: lib.cache };
}

/* ---------------- chasse « Alpha & Builders » (Google News indexé, Hacker News, GitHub) ---------------- */
// Idées de stratégies concrètes partagées hors arXiv, sans clé API payante, par des sources ouvertes aux IP de datacenter
// (runners GitHub Actions). DuckDuckGo HTML (HTTP 202 anti-robot), Bing RSS (ignore site:) et Reddit direct (429) ne le
// sont pas et ont été retirés.
//   - Google News RSS (news.google.com/rss/search), qui accepte site: : posts X, billets Substack, fils r/algotrading.
//     Les liens rendus sont des redirections Google News (le lien d'origine n'est pas décodable sans appel) ; le domaine
//     d'origine vient de <source url> et fixe le badge.
//   - API Algolia de Hacker News (search_by_date, stories et commentaires).
//   - Dépôts GitHub récents (API publique de recherche, sans jeton) sur les stratégies Hyperliquid / Polymarket.
// Entonnoir en 2 étapes avant le Labo D1 :
//   A. filtre déterministe (0 token) : promotion / vente de signaux, texte < 80 caractères, aucun terme mécanique,
//      doublon (empreinte textuelle, déjà vu, ou déjà au carnet strategy_ledger.json) → écartés ;
//   B. un lot groupé envoyé à deepseek-flash : note de testabilité 0–10 par post (règle d'entrée, sortie / risque, logique
//      économique), rejet sous 7, et compilation des seuls retenus en Blueprints (badge de source conservé).
// src : badge par défaut de la requête (corrigé par le domaine d'origine de chaque élément).
// Reddit : « site:reddit.com/r/algotrading » ne rend rien sur Google News (pas de chemin dans site:, vérifié le
// 28/11/2026) ; le nom du sous-forum passe donc en mot-clé.
export const GNEWS_QUERIES = Object.freeze([
  { id: "gn-x", src: "x", q: "site:x.com (hyperliquid OR polymarket) (funding OR arb OR backtest OR strategy OR alpha)" },
  { id: "gn-substack", src: "substack", q: "site:substack.com (quant OR systematic trading OR volatility OR mean reversion OR hyperliquid)" },
  { id: "gn-reddit", src: "reddit", q: "site:reddit.com algotrading (strategy OR backtest OR sharpe OR funding OR arb)" },
]);
export const gnewsUrl = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
export const HN_QUERIES = Object.freeze(["hyperliquid", "polymarket", "algorithmic trading", "funding rate"]);
export const hnUrl = (q, n = 25) => `https://hn.algolia.com/api/v1/search_by_date?tags=(story,comment)&query=${encodeURIComponent(q)}&hitsPerPage=${n}`;
export const GITHUB_QUERIES = Object.freeze(["hyperliquid trading strategy", "polymarket trading strategy"]);
export const BUILDERS_CONFIG = Object.freeze({ minChars: 80, minScore: 6, batchMax: 8, queueMax: 40, perSource: 20, hnPerQuery: 25, githubDays: 30, timeoutMs: 20_000, seenKeepD: 90 });
export const BADGE = Object.freeze({ x: "X · Builder", substack: "Substack · Quant", reddit: "Reddit · Quant", hn: "HackerNews · Quant", github: "GitHub", arxiv: "arXiv" });

const BUILDER_UA = "Mozilla/5.0 (compatible; boussole-paper/1.0; +https://github.com)";
const fnv = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h.toString(36); };
const unhtml = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#0?39;|&apos;/g, "'").replace(/&#x2F;/gi, "/").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
// domaine d'origine (balise <source url> de Google News) → source ; fallback sinon
export function srcOfDomain(url, fallback = null) {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return "x";
  if (/(^|\.)substack\.com$/.test(host)) return "substack";
  if (/(^|\.)reddit\.com$/.test(host)) return "reddit";
  if (/(^|\.)ycombinator\.com$/.test(host)) return "hn";
  return fallback;
}

// Google News RSS → éléments. Titre « texte - Source » : le suffixe est retiré ; la description répète le titre
// (lien + nom de la source), elle n'est gardée que si elle apporte du texte.
export function parseGoogleNews(xml, fallbackSrc = null) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const it = m[0], g = (n) => it.match(new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i"))?.[1] ?? "";
    const srcTag = it.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i), srcName = unhtml(srcTag?.[2] || ""), srcUrl = srcTag?.[1] || "";
    const src = srcOfDomain(srcUrl, fallbackSrc);
    if (!src) continue;
    let title = unhtml(g("title"));
    if (srcName && title.endsWith(` - ${srcName}`)) title = title.slice(0, -(srcName.length + 3)).trim();
    let desc = unhtml(unhtml(g("description")));
    if (srcName && desc.endsWith(srcName)) desc = desc.slice(0, -srcName.length).trim();
    if (!title) continue;
    const text = desc && !desc.startsWith(title.slice(0, 60)) ? `${title}. ${desc}` : title;
    const link = unhtml(g("link")) || null, guid = unhtml(g("guid"));
    out.push({ id: `gn:${fnv(guid || link || title)}`, text: text.slice(0, 2000), author: srcName || src, url: link, createdAt: unhtml(g("pubDate")) || null, src, via: "google-news" });
  }
  return out;
}
// Algolia Hacker News (search_by_date) → éléments ; commentaires : texte du commentaire + titre du fil
export function parseHackerNews(json) {
  return (json?.hits || []).map((x) => {
    const isComment = (x._tags || []).includes("comment"), body = unhtml(x.comment_text || x.story_text || "");
    const title = unhtml(x.title || x.story_title || "");
    const text = isComment ? `${body}${title ? ` (fil : ${title})` : ""}` : `${title}${body ? `. ${body}` : ""}${x.url ? ` ${x.url}` : ""}`;
    return { id: `hn:${x.objectID}`, text: text.trim().slice(0, 2000), author: x.author || "hn", url: `https://news.ycombinator.com/item?id=${x.objectID}`, createdAt: x.created_at || null, src: "hn" };
  }).filter((x) => x.text);
}
// Recherche de dépôts GitHub (JSON) → éléments (nom, description, sujets)
export function parseGithub(json) {
  return (json?.items || []).filter((r) => r && !r.fork && !r.archived).map((r) => ({ id: `gh:${r.full_name}`,
    text: `${r.full_name}: ${r.description || ""}${r.topics?.length ? ` Topics: ${r.topics.join(", ")}.` : ""}`.trim(), author: r.owner?.login || r.full_name.split("/")[0],
    url: r.html_url, createdAt: r.pushed_at || r.updated_at || null, src: "github", stars: r.stargazers_count || 0 }));
}

// Collecte des sources ; jamais d'exception. → { items, counts: { x, substack, reddit, hn, github }, notes }
export async function collectBuilders({ fetch: f = globalThis.fetch, now = Date.now(), queries = GNEWS_QUERIES, hn = HN_QUERIES, github = true, cfg = BUILDERS_CONFIG } = {}) {
  const items = [], notes = [], counts = { x: 0, substack: 0, reddit: 0, hn: 0, github: 0 };
  const get = async (url, accept) => {
    const r = await f(url, { headers: { "user-agent": BUILDER_UA, accept }, signal: AbortSignal.timeout(cfg.timeoutMs) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r;
  };
  const add = (got) => { for (const p of got) { items.push(p); counts[p.src] = (counts[p.src] || 0) + 1; } };
  await Promise.all([
    ...(queries || []).map(async (q) => {
      try {
        const got = parseGoogleNews(await (await get(gnewsUrl(q.q), "application/rss+xml, application/xml, text/xml")).text(), q.src).slice(0, cfg.perSource).map((p) => ({ ...p, query: q.id }));
        if (!got.length) notes.push(`Google News ${q.id} : aucun résultat`);
        add(got);
      } catch (e) { notes.push(`Google News ${q.id} : ${String(e.message || e).slice(0, 80)}`); }
    }),
    ...(hn || []).map(async (q) => {
      try { add(parseHackerNews(await (await get(hnUrl(q, cfg.hnPerQuery), "application/json")).json()).map((p) => ({ ...p, query: `hn:${q}` }))); }
      catch (e) { notes.push(`Hacker News « ${q} » : ${String(e.message || e).slice(0, 80)}`); }
    }),
    ...(github ? GITHUB_QUERIES : []).map(async (q) => {
      const since = new Date(now - cfg.githubDays * 24 * H).toISOString().slice(0, 10);
      try { add(parseGithub(await (await get(`https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} pushed:>${since}`)}&sort=stars&order=desc&per_page=${cfg.perSource}`, "application/vnd.github+json")).json())); }
      catch (e) { notes.push(`GitHub « ${q} » : ${String(e.message || e).slice(0, 80)}`); }
    }),
  ]);
  return { items, counts, notes };
}

// Étape A : filtre déterministe, aucun appel LLM.
export const PROMO = /\bvip\b|\bdm (me|us)\b|\bdm for\b|telegram|t\.me\/|\bsignals? (group|channel)\b|\b100x\b|airdrop/i;
export const MECHANICAL = /\b(funding|spreads?|arb|arbs|arbitrage|rsi|atr|z-?score|breakouts?|reversion|imbalances?|liquidity|oi|open interest|volume|hedg(e|es|ed|ing)|correlations?|lead|lag|lead-lag)\b/i;
export const fingerprint = (text) => fnv(dedupeKey(text));
export function prefilterBuilders(items, { seen = {}, known = new Set(), cfg = BUILDERS_CONFIG } = {}) {
  const kept = [], stats = { raw: items.length, promo: 0, short: 0, noMech: 0, dup: 0, kept: 0 }, batch = new Set();
  for (const it of items) {
    const text = String(it?.text || "").replace(/\s+/g, " ").trim();
    if (PROMO.test(text)) { stats.promo++; continue; }
    if (text.length < cfg.minChars) { stats.short++; continue; }
    if (!MECHANICAL.test(text)) { stats.noMech++; continue; }
    const fp = fingerprint(text);
    if (batch.has(fp) || seen[fp] || known.has(fp) || (it.url && (known.has(it.url) || batch.has(it.url)))) { stats.dup++; continue; }
    batch.add(fp); if (it.url) batch.add(it.url);
    kept.push({ ...it, text: text.slice(0, 2000), fp, badge: BADGE[it.src] || it.src });
  }
  stats.kept = kept.length;
  return { kept, stats };
}
// Empreintes et liens déjà présents au carnet permanent (strategy_ledger.json) : jamais recompilés
export function ledgerKnown(ledger) {
  const out = new Set();
  for (const s of ledger?.strategies || []) { if (s.fingerprint) out.add(s.fingerprint); if (s.url) out.add(s.url); }
  return out;
}

// Étape B : un lot groupé, deepseek-flash seul (le quota de Groq reste au vote).
export const builderPrompt = (catalog = null) => `You triage trading ideas collected from X, Reddit (r/algotrading) and GitHub, then compile the best ones.
Step 1. For EVERY item, score its quantitative testability from 0 to 10. 6 or more requires a mechanical, testable entry idea
(an indicator, spread, funding, lead-lag, breakout, imbalance… with a direction) and a clear economic logic (why the edge should exist).
A missing exit or parameter does NOT lower the score below 6: you will complete it. 8 or more: entry rule, exit or risk condition
and numbers are all explicit. Promotion, vague opinion, price calls without a mechanism: 0 to 3.
Step 2. ONLY for items scoring 6 or more, write one declarative blueprint each, following the blueprint format below. When the idea
is valid but incomplete, complete the missing parameters with standard values instead of rejecting it: stop_atr 2 (stop-loss at
2×ATR), take_profit_atr 3, max_hold_hours 48 (or the horizon the text implies), lookback / period / window 20, entry score_above 0.3.
Answer with JSON only: {"scores":[{"i":0,"score":8,"why":"<12 words max>"}],"blueprints":[{"i":0,"blueprint":{...}}]}
Blueprint format (it describes ONE blueprint; in this task never answer {"none":true}, simply omit weak items from "blueprints"):
${blueprintPrompt(catalog)}`;

// Chaîne de repli de la compilation (COMPILE_PREFER) : deepseek-flash → deepseek-chat → gpt-oss-120b → qwen3.8 ; un modèle
// est sauté s'il échoue, rend un JSON vide ou sans tableau « scores ».
export function builderScorer({ env = process.env, fetch: f = globalThis.fetch, providers = DEFAULT_PROVIDERS, catalog = null, models = [...COMPILE_PREFER] } = {}) {
  const system = builderPrompt(catalogPrompt(catalog));
  const router = new LLMRouter({ env, providers: compileProviders(providers, models), fetch: f });
  if (!router.available().length) return null;
  return async (posts) => {
    const messages = [{ role: "system", content: system }, { role: "user", content: JSON.stringify({ items: posts.map((p, i) => ({ i, source: p.badge, author: p.author, text: p.text.slice(0, 700) })) }) }];
    const r = await router.collect(1, messages, (json) => (Array.isArray(json?.scores) && json.scores.length ? { ok: true, value: json } : { ok: false, error: "champ scores absent ou vide" }), { prefer: models });
    const res = r.results[0];
    return res ? { scores: res.value.scores, blueprints: Array.isArray(res.value.blueprints) ? res.value.blueprints : [], model: res.resolved ? `${res.model} → ${res.resolved}` : res.model, errors: r.errors }
      : { error: r.errors.join(" | ") || "aucun modèle de compilation disponible" };
  };
}

// File d'attente (cache.builders.queue) → un lot noté puis compilé. → { library, cache, notes, stats }
// maxNew : Blueprints compilés au plus ce cycle (les retenus au-delà, meilleures notes d'abord, retournent en file)
export async function compileBuilders(library, cache, scorer, { now = Date.now(), cfg = BUILDERS_CONFIG, maxNew = Infinity } = {}) {
  const lib = [...(library || [])], b = { queue: [], seen: {}, ...(cache?.builders || {}) }, notes = [], stats = { scored: 0, rejected: 0, compiled: 0, invalid: 0 };
  b.queue = [...b.queue]; b.seen = { ...b.seen };
  const out = (extra = {}) => ({ library: lib, cache: { ...cache, builders: b }, notes, stats: { ...stats, pending: b.queue.length, ...extra } });
  if (!b.queue.length) return out();
  if (!scorer) { notes.push(`Builders : ${b.queue.length} post(s) filtré(s) en attente, aucun modèle de compilation (pas de clé DeepSeek ni Groq, ou --no-llm)`); return out(); }
  if (!(maxNew > 0)) { notes.push(`Builders : quota du cycle atteint, ${b.queue.length} post(s) en attente`); return out(); }
  const batch = b.queue.slice(0, cfg.batchMax);
  let r;
  try { r = await scorer(batch); } catch (e) { r = { error: String(e.message || e) }; }
  if (r.error) { notes.push(`Builders : notation échouée sur toute la chaîne, lot gardé pour le cycle suivant (${r.error})`.slice(0, 400)); return out({ error: String(r.error).slice(0, 400) }); }
  if (r.errors?.length) notes.push(`Builders : repli de compilation — ${r.errors.join(" | ")}`.slice(0, 400));
  const score = new Map((r.scores || []).map((s) => [Number(s.i), Number(s.score)]));
  const bps = new Map((r.blueprints || []).map((x) => [Number(x.i), x.blueprint ?? x]));
  const scoreOf = (i) => (Number.isFinite(score.get(i)) ? score.get(i) : 0);
  // retenus (note ≥ seuil) au-delà du quota du cycle : remis en tête de file, sans être notés comme vus
  const keepIdx = new Set(batch.map((_, i) => i).filter((i) => scoreOf(i) >= cfg.minScore).sort((x, y) => scoreOf(y) - scoreOf(x)).slice(0, maxNew));
  const deferred = batch.filter((_, i) => scoreOf(i) >= cfg.minScore && !keepIdx.has(i));
  batch.forEach((p, i) => {
    const sc = scoreOf(i);
    if (sc >= cfg.minScore && !keepIdx.has(i)) return;
    stats.scored++;
    b.seen[p.fp] = { at: new Date(now).toISOString(), score: sc };
    if (sc < cfg.minScore) { stats.rejected++; return; }
    const v = bps.has(i) ? validateBlueprint(coerceBlueprint(bps.get(i))) : { ok: false, errors: ["aucun Blueprint rendu"] };
    if (!v.ok) { stats.invalid++; notes.push(`Builders : ${p.badge} @${p.author} noté ${sc}/10 mais Blueprint invalide (${v.errors.slice(0, 2).join(" ; ")})`.slice(0, 300)); return; }
    stats.compiled++;
    lib.unshift({ id: `bp-${p.id}`, name: v.value.name, family: inferFamily(v.value), status: "En attente D1", createdAt: new Date(now).toISOString(), interest: Math.round(sc * 10), testability: sc, model: r.model,
      source: { src: p.src, badge: p.badge, author: p.author, url: p.url, postId: p.id, fingerprint: p.fp, t: p.createdAt ? new Date(Date.parse(p.createdAt) || now).toISOString() : null, excerpt: p.text.slice(0, 280) }, blueprint: v.value });
  });
  b.queue = [...deferred, ...b.queue.slice(batch.length)];
  notes.push(`Builders : ${stats.scored} noté(s) par ${r.model || "?"}, ${stats.rejected} sous ${cfg.minScore}/10, ${stats.compiled} compilé(s), ${stats.invalid} invalide(s) ; ${b.queue.length} en attente`);
  return out({ model: r.model || null });
}

// Collecte + étape A ; la file est gardée dans le cache (x_cache.json). → { cache, report }
export async function huntBuilders(cache, { fetch: f = globalThis.fetch, now = Date.now(), ledger = null, cfg = BUILDERS_CONFIG, ...opts } = {}) {
  const b = { queue: [], seen: {}, ...(cache?.builders || {}) };
  b.seen = Object.fromEntries(Object.entries(b.seen).filter(([, v]) => now - Date.parse(v.at || 0) < cfg.seenKeepD * 24 * H));
  const col = await collectBuilders({ fetch: f, now, cfg, ...opts });
  const known = ledgerKnown(ledger);
  for (const p of b.queue) { known.add(p.fp); if (p.url) known.add(p.url); }
  const { kept, stats } = prefilterBuilders(col.items, { seen: b.seen, known, cfg });
  b.queue = [...b.queue, ...kept].slice(-cfg.queueMax);
  if (col.notes.length) console.warn(`[X] builders : ${col.notes.join(" ; ")}`);
  return { cache: { ...cache, builders: b }, report: { at: new Date(now).toISOString(), counts: col.counts, filter: stats, queued: b.queue.length, notes: col.notes } };
}

/* ---------------- cycle complet ---------------- */

// prev : x_alpha.json précédent ; cache : x_cache.json. net = false : aucun appel (relecture du cache seulement).
// Anti-ban (runners GitHub = IP de datacenter) : la dernière collecte est réutilisée si elle a réussi (source X réelle),
// a produit quelque chose et date de moins de reuseMin minutes. force (X_FORCE, lancement manuel) relance la collecte.
export function reusable(prev, now = Date.now(), cfg = X_CONFIG) {
  const at = Date.parse(prev?.collectedAt || "");
  const content = Object.keys(prev?.epsilon?.tickers || {}).length > 0 || (prev?.infinity?.blueprints?.length || 0) > 0 || (prev?.stats?.epsilon || 0) + (prev?.stats?.infinity || 0) > 0;
  return !!prev?.source && content && Number.isFinite(at) && now - at >= 0 && now - at < cfg.reuseMin * 60e3;
}

// free : sources gratuites (RSS, arXiv), true par défaut ; un objet { fetch, feeds, arxiv } règle collectFree.
// deferCompile : la compilation des Blueprints est faite plus tard (compileLibrary, après le vote de trading) pour ne pas
// consommer le quota par minute des votants ; ici, la bibliothèque est seulement relue.
// builders : chasse « Alpha & Builders » (Google News indexé, Hacker News, GitHub), active avec les sources gratuites ; false la coupe, un
// objet règle collectBuilders. scorer : notation groupée (deepseek-flash) quand la compilation n'est pas différée ; ledger :
// carnet permanent (empreintes déjà compilées).
export async function runXAlpha({ prev = null, cache = {}, env = process.env, exec, fetch: f, extract = undefined, now = Date.now(), net = true, force = false, free = true, deferCompile = false, cfg = X_CONFIG,
  builders = undefined, scorer = undefined, ledger = null } = {}) {
  const reuse = net && !force && reusable(prev, now, cfg);
  const col = !net ? { posts: [], source: null, status: "désactivé (--no-net)", notes: [] }
    : reuse ? { posts: [], source: prev.source, status: `réutilisé : collecte ${prev.source} de ${prev.collectedAt.slice(11, 16)} UTC (< ${cfg.reuseMin} min, protection anti-ban)`, notes: [], reused: true }
    : await collect(buildQueries(), { env, exec, fetch: f, cache, now, cfg });
  // sources gratuites : à chaque cycle (elles ne sont pas soumises à la protection anti-ban de X)
  const fr = net && free ? await collectFree({ fetch: f, ...(typeof free === "object" ? free : {}) }) : { posts: [], counts: { rss: 0, arxiv: 0 }, notes: [] };
  const freeN = fr.counts.rss + fr.counts.arxiv;
  if (net && !col.source && !reuse) col.status = freeN ? `secours : ${col.status.replace(/^neutre : /, "X indisponible (")}) → RSS et arXiv seuls` : col.status;
  else if (col.source && freeN) col.status += " + RSS / arXiv";
  if (fr.notes.length) console.warn(`[X] sources gratuites : ${fr.notes.join(" ; ")}`);
  let { cache: c, stats } = ingest([...col.posts, ...fr.posts], cache, { env, now, cfg });
  if (reuse) stats = { ...(prev.stats ?? stats), free: fr.counts };
  else stats.free = fr.counts;
  if (col.paused) c.pausedUntil = col.paused; else if (net && !reuse) delete c.pausedUntil;
  const collectedAt = reuse ? prev.collectedAt : col.source ? new Date(now).toISOString() : prev?.collectedAt ?? null;
  const ext = deferCompile ? null : extract === undefined ? (net ? blueprintExtractor({ env, fetch: f }) : null) : extract;
  const lib = await updateLibrary(prev?.infinity?.blueprints, c, ext, { now, cfg });
  if (deferCompile) lib.notes = lib.notes.filter((n) => !/traducteur indisponible/.test(n));
  c = lib.cache;
  // chasse « Alpha & Builders » : collecte et filtre déterministe à chaque cycle, notation groupée ensuite
  const huntOn = net && (builders ?? free) !== false;
  let hunt = null;
  if (huntOn) try { const hr = await huntBuilders(c, { fetch: f, now, ledger, ...(typeof builders === "object" ? builders : {}) }); c = hr.cache; hunt = hr.report; }
    catch (e) { hunt = { at: new Date(now).toISOString(), error: String(e.message || e).slice(0, 160) }; }
  const sc = deferCompile ? null : scorer === undefined ? (net ? builderScorer({ env, fetch: f }) : null) : scorer;
  let library = lib.library;
  if (!deferCompile && (c.builders?.queue?.length)) {
    const bl = await compileBuilders(library, c, sc, { now });
    library = bl.library.slice(0, cfg.libraryMax); c = bl.cache; lib.notes.push(...bl.notes);
    if (hunt) hunt.compile = bl.stats;
  }
  if (hunt) hunt.queued = c.builders?.queue?.length ?? 0;
  const epsilon = epsilonSummary(c, now, cfg);
  const alpha = {
    at: new Date(now).toISOString(), collectedAt, source: col.source, status: col.status, notes: [...col.notes, ...fr.notes, ...lib.notes], stats,
    free: { rss: fr.counts.rss, arxiv: fr.counts.arxiv },
    epsilon: { ttlH: cfg.ttlH, squeeze: { velocity: cfg.squeezeVelocity, bias: cfg.squeezeBias }, tickers: epsilon, router: { injected: false, at: null, tickers: [] } },
    builders: hunt ?? prev?.builders ?? null,
    infinity: { interestMin: cfg.interestMin, interestMinArxiv: cfg.interestMinArxiv ?? cfg.interestMin, blueprints: library, pending: lib.pending, errors: lib.errors, translator: deferCompile ? "après le vote de trading" : ext ? translatorLabel(env) : "indisponible (pas de clé LLM)" },
    leagues: null,   // tableau des 3 Ligues : étape suivante
  };
  return { alpha, cache: c };
}
