// Sources gratuites et sans authentification de la page X Alpha, collectées en complément de X (et seules quand X échoue :
// cookies expirés, queryId GraphQL périmés, blocage de l'IP du runner). Aucune clé, aucun compte.
//   Flux ε : flux RSS publics crypto et macro (CoinDesk, Cointelegraph, Decrypt, Réserve fédérale, OilPrice), filtrés ensuite
//            sur nos tickers par x_scraper (classify).
//   Flux ∞ : API publique d'arXiv, catégories q-fin.TR (microstructure, exécution), q-fin.PM (gestion de portefeuille) et
//            q-fin.ST (statistique financière) ; abstracts récents de modèles factoriels, GARCH, arbitrage statistique,
//            microstructure… traduits ensuite en Blueprints comme les threads X.
// Chaque élément est rendu au format d'un post (id, text, author, createdAt, url, src) pour suivre le même tri.

export const RSS_FEEDS = Object.freeze([
  { name: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { name: "Decrypt", url: "https://decrypt.co/feed" },
  { name: "Federal Reserve", url: "https://www.federalreserve.gov/feeds/press_all.xml" },
  { name: "OilPrice", url: "https://oilprice.com/rss/main" },
]);
export const ARXIV_URL = "https://export.arxiv.org/api/query?search_query=" + encodeURIComponent("cat:q-fin.TR OR cat:q-fin.PM OR cat:q-fin.ST")
  + "&sortBy=submittedDate&sortOrder=descending&start=0&max_results=40";
// Sujets retenus dans arXiv : ceux qu'on peut tester sur nos données (le reste — retraites, assurance, crédit… — est écarté)
export const ARXIV_TOPICS = /\b(factor (model|investing|zoo)|garch|statistical arbitrage|pairs? trading|cointegrat\w*|microstructure|limit order book|order ?book|order flow|market making|momentum|mean.reversion|volatility (forecast\w*|regime\w*|clustering)|realized volatility|regime.switching|kalman|high.frequency|cryptocurrenc\w*|bitcoin|funding rates?|perpetual|machine learning|deep learning|reinforcement learning|transformer)\b/i;
const UA = "Mozilla/5.0 (compatible; boussole-paper/1.0; +https://github.com)";

// entités d'abord (les descriptions RSS contiennent souvent du HTML encodé : &lt;p&gt;…), balises ensuite
const decode = (s) => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i")); return m ? m[1] : ""; };
const hash = (s) => { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0; return h.toString(36); };

// RSS 2.0 (<item>) et Atom (<entry>)
export function parseFeed(xml, source) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)) {
    const it = m[0], title = decode(tag(it, "title")), desc = decode(tag(it, "description") || tag(it, "summary") || tag(it, "content"));
    const link = decode(tag(it, "link")) || (it.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? "");
    const date = decode(tag(it, "pubDate") || tag(it, "published") || tag(it, "updated") || tag(it, "dc:date"));
    if (!title) continue;
    out.push({ id: `rss:${hash(link || title)}`, text: desc && !desc.startsWith(title) ? `${title}. ${desc}`.slice(0, 600) : title, author: source, createdAt: date || null, url: link || null, src: "rss" });
  }
  return out;
}

export function parseArxiv(xml) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<entry>[\s\S]*?<\/entry>/gi)) {
    const e = m[0], title = decode(tag(e, "title")), summary = decode(tag(e, "summary"));
    const id = decode(tag(e, "id")), authors = [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((a) => decode(a[1]));
    if (!title || !ARXIV_TOPICS.test(`${title} ${summary}`)) continue;
    out.push({ id: `arxiv:${id.replace(/^https?:\/\/arxiv\.org\/abs\//, "")}`, text: `${title}. ${summary}`.slice(0, 2000),
      author: authors.length ? `${authors[0]}${authors.length > 1 ? " et al." : ""}` : "arXiv", createdAt: decode(tag(e, "published")) || null,
      url: id.replace(/^http:/, "https:") || null, src: "arxiv" });
  }
  return out;
}

async function getText(f, url, timeoutMs) {
  const r = await f(url, { headers: { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// → { posts, counts: { rss, arxiv }, notes } ; jamais d'exception
export async function collectFree({ fetch: f = globalThis.fetch, feeds = RSS_FEEDS, arxiv = true, timeoutMs = 20_000 } = {}) {
  const posts = [], notes = [], counts = { rss: 0, arxiv: 0 };
  await Promise.all(feeds.map(async (feed) => {
    try { const items = parseFeed(await getText(f, feed.url, timeoutMs), feed.name).slice(0, 30); posts.push(...items); counts.rss += items.length; }
    catch (e) { notes.push(`RSS ${feed.name} : ${String(e.message || e).slice(0, 80)}`); }
  }));
  if (arxiv) {
    try { const items = parseArxiv(await getText(f, ARXIV_URL, timeoutMs)); posts.push(...items); counts.arxiv = items.length; }
    catch (e) { notes.push(`arXiv : ${String(e.message || e).slice(0, 80)}`); }
  }
  return { posts, counts, notes };
}
