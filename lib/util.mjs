export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };

export async function fetchJson(url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeout ?? 45000) });
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); const ra = Number(res.headers.get("retry-after")); await sleep(ra > 0 ? Math.min(ra, 30) * 1000 + 300 : 1200 * 2 ** i); continue; }   // respecte Retry-After
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return await res.json();
    } catch (e) { last = e; await sleep(500 * 2 ** i); }
  }
  throw last;
}

// exécute fn sur chaque élément avec n tâches en parallèle
export async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e.message || e) }; } }
  }));
  return out;
}

export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

const UA = process.env.HTTP_USER_AGENT || "Mozilla/5.0 (compatible; WhaleCompass/0.3; local dashboard)";
export async function fetchText(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, headers: { "user-agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(opts.timeout ?? 30000) });
      if (res.status === 429 || res.status >= 500) { last = new Error(`HTTP ${res.status}`); await sleep(1500 * 2 ** i); continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
      return await res.text();
    } catch (e) { last = e; await sleep(700 * 2 ** i); }
  }
  throw last;
}
export const getJson = async (url, opts) => JSON.parse(await fetchText(url, opts));
export const decodeEntities = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&nbsp;/g, " ");
export const stripTags = (s) => decodeEntities(s.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
export const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
export function downsample(arr, n = 60) { if (arr.length <= n) return arr; const out = []; for (let i = 0; i < n; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (n - 1))]); return out; }
