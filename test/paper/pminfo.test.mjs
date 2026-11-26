import { test } from "node:test";
import assert from "node:assert/strict";
import { cidOf, pmInfoFromSnapshot, resolvePmInfo, annotatePm } from "../../lib/paper/pminfo.mjs";
import { normalizeGammaMarket, pmEventUrl } from "../../lib/pm.mjs";
import { PUBLIC_PAPER_FILES, FILES } from "../../lib/paper/store.mjs";

const NOW = Date.UTC(2026, 10, 26, 1);
const A = "0x" + "ab".repeat(32), B = "0x" + "cd".repeat(32);

test("cidOf lit le conditionId d'un objet ou d'un identifiant de candidat", () => {
  assert.equal(cidOf(`leadlag|${A}|Yes`), A);
  assert.equal(cidOf({ candidateId: `pm|${A.toUpperCase().replace("0X", "0x")}|No` }), A);
  assert.equal(cidOf({ id: "hl|BTC|long" }), null);
});

test("Gamma : question, échéance et URL de l'événement", () => {
  const g = normalizeGammaMarket([{ conditionId: A, question: "Will Bitcoin reach $60,000?", endDate: "2026-11-30T00:00:00Z", slug: "btc-60k-market", events: [{ slug: "bitcoin-above-on-november-30" }] }]);
  assert.deepEqual(g, { cid: A, title: "Will Bitcoin reach $60,000?", endDate: "2026-11-30T00:00:00Z", slug: "bitcoin-above-on-november-30", url: "https://polymarket.com/event/bitcoin-above-on-november-30" });
  assert.equal(normalizeGammaMarket([]), null);
  assert.equal(pmEventUrl(null), null);
});

test("le relevé suffit quand il connaît le marché ; Gamma rattrape les autres, une fois par jour", async () => {
  const snap = { pm: [{ positions: [{ cid: A, title: "Will X happen?", end: "2026-12-31", slug: "x-event" }] }], events: [] };
  const calls = [];
  const fetchGamma = async (cid) => { calls.push(cid); return { title: "Will Y happen?", endDate: "2026-12-01", slug: "y-event", url: "https://polymarket.com/event/y-event" }; };
  const r = await resolvePmInfo([{ id: `pm|${A}|Yes` }, { candidateId: `leadlag|${B}|No` }], {}, { known: pmInfoFromSnapshot(snap, null), fetchGamma, now: NOW });
  assert.deepEqual(calls, [B]);
  assert.equal(r.cache[A].url, "https://polymarket.com/event/x-event");
  assert.equal(r.cache[B].title, "Will Y happen?");
  // marché introuvable : pas de nouvel essai avant 24 h
  const miss = await resolvePmInfo([B], { [B]: { triedAt: new Date(NOW - 3600e3).toISOString() } }, { fetchGamma, now: NOW });
  assert.equal(miss.calls, 0);
});

test("annotatePm : champs directs sur une position Polymarket, champ pm sur un signal lead-lag", () => {
  const cache = { [A]: { title: "Will X happen?", endDate: "2026-12-31", url: "https://polymarket.com/event/x-event" } };
  const pos = annotatePm({ id: "pm-1", venue: "pm", cid: A, outcome: "Yes", title: null }, cache);
  assert.equal(pos.title, "Will X happen?"); assert.equal(pos.url, "https://polymarket.com/event/x-event"); assert.equal(pos.endDate, "2026-12-31");
  const hl = annotatePm({ id: "hl-7", venue: "hl", coin: "BTC", candidateId: `leadlag|${A}|Yes` }, cache);
  assert.deepEqual(hl.pm, { cid: A, outcome: "Yes", title: "Will X happen?", endDate: "2026-12-31", url: "https://polymarket.com/event/x-event" });
  assert.equal(annotatePm({ id: "hl-1", venue: "hl", coin: "ETH", candidateId: "hl|ETH|long" }, cache).pm, undefined);
});

test("pm_markets.json est publié pour la page", () => {
  assert.ok(PUBLIC_PAPER_FILES.includes(FILES.pmMarkets));
});
