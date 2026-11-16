// Probabilités de marché : événements politiques, économiques et géopolitiques sur Polymarket.
import { getJson, pool, num } from "./util.mjs";
import { pmTopic } from "./topics.mjs";
import { pmCountries } from "./world.mjs";
const TAGS = [["politics", "Politique"], ["geopolitics", "Géopolitique"], ["economy", "Économie"], ["finance", "Finance"], ["crypto", "Crypto"], ["world", "Monde"], ["tech", "Tech"]];
const SPORT = /sports?|nfl|nba|mlb|nhl|soccer|tennis|ufc|esports|games|golf|cricket|f1|boxing/i;
const NOISE = /tweets|searched|up or down|price will .* hit|above .* on |weekly|temperature|box office|billboard|rotten|grossing/i;
const parse = (s) => { try { return JSON.parse(s); } catch { return []; } };
export async function fetchOdds() {
  const sets = await pool(TAGS, 3, ([slug]) => getJson(`https://gamma-api.polymarket.com/events?closed=false&active=true&order=volume24hr&ascending=false&limit=45&tag_slug=${slug}`, { timeout: 40000 }));
  const seen = new Set(), out = [];
  sets.forEach((evs, i) => { if (!Array.isArray(evs)) return; for (const e of evs) {
    if (seen.has(e.id) || (e.tags || []).some((t) => SPORT.test(t.label || ""))) continue; seen.add(e.id);
    const ms = (e.markets || []).filter((m) => m.active && !m.closed).map((m) => { const o = parse(m.outcomes), p = parse(m.outcomePrices); return { q: m.groupItemTitle || m.question, yes: o[0], p: num(p[0]), d1: num(m.oneDayPriceChange), w1: num(m.oneWeekPriceChange), vol: num(m.volume24hr), liq: num(m.liquidityNum) }; })
      .filter((m) => m.p > 0.005 && m.p < 0.995).sort((a, b) => b.vol - a.vol);
    if (!ms.length) continue;
    out.push({ id: e.id, title: e.title, slug: e.slug, cat: TAGS[i][1], vol: num(e.volume24hr), liq: num(e.liquidity), end: e.endDate ? Date.parse(e.endDate) : null, topic: pmTopic(e.title), countries: pmCountries(e.title + " " + ms.slice(0, 3).map((m) => m.q).join(" ")), markets: ms.slice(0, 6), n: ms.length });
  } });
  out.sort((a, b) => b.vol - a.vol);
  const movers = out.filter((e) => !NOISE.test(e.title)).flatMap((e) => e.markets.filter((m) => Math.abs(m.d1) >= 0.05 && m.vol >= 20000).map((m) => ({ ...m, title: e.title, slug: e.slug, cat: e.cat, single: e.n === 1, countries: e.countries, topic: e.topic }))).sort((a, b) => Math.abs(b.d1) - Math.abs(a.d1)).slice(0, 40);
  return { at: Date.now(), events: out.slice(0, 160), movers };
}
