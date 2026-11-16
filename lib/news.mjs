// Fil d'information : Google Actualités (par thème et par pays), banques centrales, Telegram, Truth Social, X (optionnel).
import { fetchText, getJson, pool, decodeEntities, stripTags } from "./util.mjs";
import { COUNTRIES } from "./world.mjs";

/* ---------- lecture RSS minimale ---------- */
function rss(xml, src, limit = 25) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = (tag) => { const r = m[1].match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return r ? decodeEntities(r[1]).trim() : ""; };
    let title = stripTags(g("title")); const source = stripTags(g("source")) || src, t = Date.parse(g("pubDate")) || Date.now();
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -source.length - 3);
    if (title) out.push({ title, url: g("link"), t, src: source });
    if (out.length >= limit) break;
  }
  return out;
}
const gnews = (q, days = 2) => `https://news.google.com/rss/search?q=${encodeURIComponent(q + ` when:${days}d`)}&hl=fr&gl=FR&ceid=FR:fr`;

/* ---------- étiquetage : quels actifs une info peut-elle toucher ? ---------- */
const TAGS = [
  [/\b(fed|fomc|powell|bce|ecb|lagarde|taux directeur|taux d'intérêt|rate cut|baisse des taux|hausse des taux|banque centrale|boj|banque du japon)\b/i, ["Taux", "USD", "US_EQ"], "Banques centrales"],
  [/\b(inflation|cpi|ipc|prix à la consommation|pce|déflation)\b/i, ["Taux", "GOLD"], "Inflation"],
  [/\b(emploi|chômage|payrolls|jobs report|nfp|récession|pib|gdp|croissance)\b/i, ["US_EQ", "Taux"], "Croissance"],
  [/\b(p[ée]trole|opep|opec|brent|wti|baril|ormuz|hormuz|raffinerie|oil)\b/i, ["OIL"], "Énergie"],
  [/\b(gaz|lng|gnl|gazoduc)\b/i, ["NATGAS"], "Énergie"],
  [/\b(or |gold|lingot|métaux précieux|argent métal)\b/i, ["GOLD"], "Métaux"],
  [/\b(bitcoin|btc|crypto|ethereum|stablecoin|etf bitcoin|binance|coinbase|hyperliquid)\b/i, ["BTC", "ETH"], "Crypto"],
  [/\b(droits de douane|tarif|tariff|guerre commerciale|surtaxe|export control|terres rares)\b/i, ["US_EQ", "USD"], "Commerce"],
  [/\b(sanction|embargo|missile|frappe|drone|attaque|invasion|guerre|offensive|cessez-le-feu|ceasefire|nucléaire|troupes|otan|nato)\b/i, ["OIL", "GOLD"], "Géopolitique"],
  [/\b(nvidia|puces|semi-conducteur|chips|tsmc|intelligence artificielle|\bia\b|openai)\b/i, ["NVDA", "NDX"], "Tech"],
  [/\b(élection|election|scrutin|référendum|démission|motion de censure|shutdown|impeachment|coup d'état)\b/i, ["Politique"], "Politique"],
  [/\b(dette|défaut|notation|moody's|fitch|s&p global|déficit|budget|obligations|treasury|trésor)\b/i, ["Taux"], "Dette"],
  [/\b(dollar|euro|yen|yuan|devise|change|dxy)\b/i, ["USD"], "Devises"],
  [/\b(faillite|krach|effondrement|panique|bank run|liquidation|contagion|sauvetage)\b/i, ["US_EQ"], "Stress"],
];
const URGENT = /\b(urgent|breaking|alerte|flash|just in|krach|effondrement|invasion|frappe|défaut|emergency|état d'urgence|explosion|attentat|coup d'état|surprise)\b/i;
export function tag(item) {
  const assets = new Set(), themes = new Set();
  for (const [re, as, th] of TAGS) if (re.test(item.title)) { as.forEach((a) => assets.add(a)); themes.add(th); }
  return { ...item, assets: [...assets], themes: [...themes], hot: URGENT.test(item.title) };
}
const dedupe = (items) => { const seen = new Set(); return items.filter((i) => { const k = i.title.toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, " ").slice(0, 70); if (seen.has(k)) return false; seen.add(k); return true; }); };

/* ---------- fil général ---------- */
const TOPICS = [["Marchés", "bourse OR \"marchés financiers\" OR Wall Street"], ["Banques centrales", "Fed OR BCE OR \"taux directeur\""], ["Énergie", "pétrole OR OPEP OR Brent OR gaz"], ["Crypto", "bitcoin OR crypto OR ethereum"], ["Géopolitique", "sanctions OR guerre OR frappes OR \"cessez-le-feu\""], ["Commerce", "\"droits de douane\" OR \"guerre commerciale\""], ["Économie", "inflation OR récession OR chômage OR PIB"]];
export async function fetchWire() {
  const res = await pool(TOPICS, 3, async ([name, q]) => rss(await fetchText(gnews(q, 1)), name, 14).map((i) => ({ ...i, feed: name })));
  const fed = await fetchText("https://www.federalreserve.gov/feeds/press_all.xml").then((x) => rss(x, "Réserve fédérale", 6).map((i) => ({ ...i, feed: "Officiel", src: "Réserve fédérale" }))).catch(() => []);
  return dedupe([...res.filter(Array.isArray).flat(), ...fed]).map(tag).sort((a, b) => b.t - a.t).slice(0, 140);
}

/* ---------- actualité d'un pays ---------- */
export async function fetchCountry(iso2) {
  const c = COUNTRIES[iso2]; if (!c) return [];
  const xml = await fetchText(gnews(`"${c.fr}" (économie OR marchés OR sanctions OR guerre OR élections OR "banque centrale" OR pétrole OR crise)`, 3));
  return dedupe(rss(xml, c.fr, 12)).map(tag).sort((a, b) => b.t - a.t).slice(0, 9);
}
export async function fetchCountries(list) {
  const res = await pool(list, 3, fetchCountry), out = {};
  list.forEach((iso, i) => { if (Array.isArray(res[i]) && res[i].length) out[iso] = res[i]; });
  return out;
}
export async function fetchQuery(q) { return dedupe(rss(await fetchText(gnews(q, 3)), "", 10)).map(tag).sort((a, b) => b.t - a.t).slice(0, 6); }

/* ---------- canaux sociaux ---------- */
// Telegram : aperçu web public des canaux (t.me/s/<canal>), sans compte.
async function telegram(channel) {
  const html = await fetchText(`https://t.me/s/${channel}`);
  const out = [];
  for (const m of html.matchAll(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/section>)/g)) {
    const txt = m[0].match(/<div class="tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/), time = m[0].match(/<time[^>]*datetime="([^"]+)"/), link = m[0].match(/data-post="([^"]+)"/);
    if (txt && time) out.push({ title: stripTags(txt[1]).slice(0, 320), t: Date.parse(time[1]), url: link ? `https://t.me/${link[1]}` : `https://t.me/s/${channel}`, src: "@" + channel, net: "Telegram" });
  }
  return out;
}
// Truth Social (publications de Donald Trump) via l'archive publique trumpstruth.org
async function truth() {
  const xml = await fetchText("https://www.trumpstruth.org/feed", {}, 2);
  return rss(xml, "Donald Trump", 15).map((i) => ({ ...i, title: i.title.slice(0, 320), src: "@realDonaldTrump", net: "Truth Social" }));
}
// X : trois branchements possibles, tous à configurer par l'utilisateur (aucun n'est actif par défaut).
//   X_BEARER_TOKEN     -> API officielle X v2 (recherche récente)
//   TWITTERAPI_IO_KEY  -> service tiers twitterapi.io (celui qu'utilise polymarket-whale-watcher)
//   X_RSS_BASE         -> une instance RSSHub ou Nitter que vous hébergez (ex. http://localhost:1200/twitter/user)
export const X_ACCOUNTS = (process.env.X_ACCOUNTS || "DeItaone,unusual_whales,KobeissiLetter,zerohedge,NickTimiraos,WatcherGuru,tier10k,lookonchain").split(",").map((s) => s.trim()).filter(Boolean);
export const xMode = () => (process.env.X_BEARER_TOKEN ? "api" : process.env.TWITTERAPI_IO_KEY ? "twitterapi.io" : process.env.X_RSS_BASE ? "rss" : null);
async function xPosts() {
  const mode = xMode(); if (!mode) return [];
  if (mode === "api") {
    const q = encodeURIComponent(`(${X_ACCOUNTS.slice(0, 18).map((a) => "from:" + a).join(" OR ")}) -is:retweet`);
    const d = await getJson(`https://api.x.com/2/tweets/search/recent?query=${q}&max_results=50&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`, { headers: { authorization: `Bearer ${process.env.X_BEARER_TOKEN}` } });
    const users = Object.fromEntries((d.includes?.users || []).map((u) => [u.id, u.username]));
    return (d.data || []).map((t) => ({ title: t.text.slice(0, 320), t: Date.parse(t.created_at), url: `https://x.com/${users[t.author_id]}/status/${t.id}`, src: "@" + users[t.author_id], net: "X" }));
  }
  if (mode === "twitterapi.io") {
    const q = encodeURIComponent(X_ACCOUNTS.slice(0, 18).map((a) => "from:" + a).join(" OR "));
    const d = await getJson(`https://api.twitterapi.io/twitter/tweet/advanced_search?query=${q}&queryType=Latest`, { headers: { "X-API-Key": process.env.TWITTERAPI_IO_KEY } });
    return (d.tweets || []).map((t) => ({ title: (t.text || "").slice(0, 320), t: Date.parse(t.createdAt), url: t.url, src: "@" + (t.author?.userName || "?"), net: "X" }));
  }
  const res = await pool(X_ACCOUNTS, 3, async (a) => rss(await fetchText(`${process.env.X_RSS_BASE.replace(/\/$/, "")}/${a}`), "@" + a, 8).map((i) => ({ ...i, title: i.title.slice(0, 320), src: "@" + a, net: "X" })));
  return res.filter(Array.isArray).flat();
}
export const TG_CHANNELS = (process.env.TELEGRAM_CHANNELS || "WatcherGuru,unusual_whales,cointelegraph,financialjuice").split(",").map((s) => s.trim()).filter(Boolean);
export async function fetchSocial() {
  const status = {}, items = [];
  const run = async (name, fn) => { try { const r = await fn(); status[name] = r.length ? "ok" : "vide"; items.push(...r); } catch (e) { status[name] = "indisponible"; } };
  await Promise.all([...TG_CHANNELS.map((c) => run("Telegram @" + c, () => telegram(c))), run("Truth Social", truth), run("X", async () => { if (!xMode()) { status.X = "à configurer"; return []; } return xPosts(); })]);
  if (!xMode()) status.X = "à configurer";
  return { at: Date.now(), status, xMode: xMode(), items: items.filter((i) => i.t && i.title).map(tag).sort((a, b) => b.t - a.t).slice(0, 120) };
}
