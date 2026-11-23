import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atr, normalizeCandles, normalizeHlBook } from "../../lib/hl.mjs";
import { normalizePmBook, normalizeResolution, payoutOf, fetchPositions } from "../../lib/pm.mjs";
import { loadSnapshot, enrich, entryVwap, recentEntries } from "../../lib/paper/loader.mjs";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test("normalizeCandles : chaînes → nombres, tri chronologique, bougies vides écartées", () => {
  const c = normalizeCandles([{ t: 2, o: "1", h: "2", l: "0.5", c: "1.5", v: "10" }, { t: 1, o: "1", h: "1.2", l: "0.9", c: "1", v: "3" }, { t: 3, o: "0", h: "0", l: "0", c: "0" }]);
  assert.deepEqual(c.map((k) => k.t), [1, 2]);
  assert.equal(c[1].h, 2);
});

test("atr : valeur de Wilder calculée à la main", () => {
  // TR : 2, 3 (|13−10|), 2  -> n = 2 : moyenne(2, 3) = 2.5, puis (2.5·1 + 2)/2 = 2.25
  const k = [{ h: 11, l: 9, c: 10 }, { h: 12, l: 10, c: 11 }, { h: 13, l: 11, c: 12 }, { h: 12, l: 10, c: 11 }].map((x, i) => ({ t: i, o: x.c, ...x }));
  k[2] = { ...k[2], h: 14 };   // TR2 = max(14−11, |14−11|, |11−11|) = 3
  k[3] = { ...k[3] };          // TR3 = max(2, |12−12|, |10−12|) = 2
  assert.equal(atr(k, 2), 2.25);
  assert.equal(atr(k.slice(0, 2), 2), null);   // pas assez de bougies
  // prix constant : ATR = écart haut-bas
  const flat = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 101, l: 99, c: 100 }));
  assert.equal(atr(flat, 14), 2);
});

test("normalizeHlBook : meilleur prix en tête, niveaux vides écartés", () => {
  const b = normalizeHlBook({ time: 5, levels: [[{ px: "99", sz: "1" }, { px: "100", sz: "2" }, { px: "98", sz: "0" }], [{ px: "102", sz: "1" }, { px: "101", sz: "3" }]] });
  assert.deepEqual(b, { t: 5, bids: [[100, 2], [99, 1]], asks: [[101, 3], [102, 1]] });
  assert.deepEqual(normalizeHlBook(null).bids, []);
});

test("normalizePmBook : tri forcé (le CLOB renvoie les bids du pire au meilleur)", () => {
  const b = normalizePmBook({ timestamp: "7", bids: [{ price: "0.40", size: "100" }, { price: "0.45", size: "50" }], asks: [{ price: "0.52", size: "10" }, { price: "0.48", size: "20" }, { price: "1", size: "5" }], tick_size: "0.01" });
  assert.deepEqual(b.bids, [[0.45, 50], [0.40, 100]]);
  assert.deepEqual(b.asks, [[0.48, 20], [0.52, 10]]);   // prix 1 hors bornes écarté
  assert.equal(b.tick, 0.01);
});

test("normalizeResolution + payoutOf", () => {
  const open = normalizeResolution({ condition_id: "0xc", closed: false, tokens: [{ token_id: 1, outcome: "Yes", price: 0.6, winner: false }, { token_id: 2, outcome: "No", price: 0.4, winner: false }] });
  assert.equal(open.resolved, false);
  assert.equal(payoutOf(open, "1"), null);
  const done = normalizeResolution({ condition_id: "0xc", closed: true, tokens: [{ token_id: 1, outcome: "Yes", winner: true }, { token_id: 2, outcome: "No", winner: false }] });
  assert.deepEqual(done.winner, { token: "1", outcome: "Yes" });
  assert.equal(payoutOf(done, 1), 1);
  assert.equal(payoutOf(done, "2"), 0);
});

test("pm.fetchPositions conserve token_id", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{ token_id: "123", title: "Will Bitcoin reach $150k?", outcome: "Yes", current_price: "0.3", avg_price: "0.25", current_size: "10", current_value: "3", condition_id: "0xc" }] }), { status: 200 });
  const [p] = await fetchPositions("0xabc", 1);
  assert.equal(p.token, "123");
  assert.equal(p.cid, "0xc");
  assert.equal(p.avg, 0.25);
});

test("entryVwap : moyenne pondérée par le notionnel, par actif et par sens", () => {
  const accounts = [
    { positions: [{ coin: "BTC", side: "long", entry: 100, notional: 1000 }, { coin: "ETH", side: "long", entry: 5, notional: 50 }] },
    { positions: [{ coin: "BTC", side: "long", entry: 110, notional: 3000 }, { coin: "BTC", side: "short", entry: 90, notional: 9999 }] },
  ];
  assert.deepEqual(entryVwap(accounts, "BTC", "long"), { px: 107.5, notional: 4000, whales: 2 });
  assert.equal(entryVwap(accounts, "SOL", "long"), null);
});

async function dataDir(last, events) {
  const d = await mkdtemp(path.join(tmpdir(), "paper-data-"));
  if (last !== undefined) await writeFile(path.join(d, "last.json"), JSON.stringify(last));
  if (events !== undefined) await writeFile(path.join(d, "events.json"), JSON.stringify(events));
  return d;
}

test("loadSnapshot : relevé frais, événements triés du plus récent au plus ancien", async () => {
  const now = 1_000_000_000_000;
  const d = await dataDir({ at: now - 10 * 60000, hl: [{ addr: "a", positions: [] }, { bad: 1 }], pm: [{ addr: "w", positions: [{ token: "1" }] }] },
    [{ t: now - 3600e3, kind: "open", src: "hl" }, { t: now - 60e3, kind: "add", src: "pm" }, { t: "x" }]);
  const s = await loadSnapshot(d, now);
  assert.equal(s.fresh, true);
  assert.equal(Math.round(s.ageMin), 10);
  assert.equal(s.hl.length, 1);
  assert.equal(s.pm.length, 1);
  assert.deepEqual(s.events.map((e) => e.src), ["pm", "hl"]);
  assert.deepEqual(s.problems, []);
  assert.equal(recentEntries(s.events, now - 4 * 3600e3, "hl").length, 1);
  assert.equal(recentEntries(s.events, now - 30 * 60e3).length, 1);
});

test("loadSnapshot : relevé périmé ou absent signalé, jamais d'exception", async () => {
  const now = 1_000_000_000_000;
  const old = await loadSnapshot(await dataDir({ at: now - 3 * 3600e3, hl: [], pm: [] }, []), now);
  assert.equal(old.fresh, false);
  assert.match(old.problems.join(), /périmé/);
  const none = await loadSnapshot(await dataDir(), now);
  assert.equal(none.fresh, false);
  assert.deepEqual(none.problems, ["last.json : absent", "events.json : absent"]);
});

test("enrich : ATR et carnets avec fournisseurs simulés, erreurs isolées", async () => {
  const candles = Array.from({ length: 20 }, (_, i) => ({ t: i, o: 100, h: 102, l: 98, c: 100 }));
  const deps = {
    fetchMarkets: async () => ({ BTC: { mark: 100 } }),
    fetchOhlc: async (coin) => { if (coin === "DOWN") throw new Error("HTTP 500"); return candles; },
    fetchL2Book: async (coin) => ({ coin, bids: [[99, 1]], asks: [[101, 1]] }),
    fetchBook: async (token) => ({ token, bids: [], asks: [[0.5, 10]] }),
    fetchResolution: async (cid) => ({ cid, resolved: false }),
  };
  const r = await enrich({ coins: ["BTC", "BTC", "DOWN"], tokens: ["1"], cids: ["0xc"] }, deps);
  assert.equal(r.ohlc.BTC.atr, 4);
  assert.equal(r.ohlc.BTC.atrPct, 0.04);
  assert.equal(r.hlBooks.BTC.asks[0][0], 101);
  assert.equal(r.pmBooks["1"].asks[0][1], 10);
  assert.equal(r.resolutions["0xc"].resolved, false);
  assert.ok(!r.ohlc.DOWN);
  assert.ok(r.errors.some((e) => e.startsWith("ATR DOWN")));
  assert.equal(r.errors.length, 1);   // BTC dédoublonné, DOWN échoue une seule fois côté ATR
});
