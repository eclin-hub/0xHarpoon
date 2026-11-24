import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProposal, borderCandidates, borderNeeds, markSeen } from "../../lib/paper/border.mjs";
import { executeDecisions } from "../../lib/paper/execute.mjs";
import { initialPortfolio, PUBLIC_PAPER_FILES } from "../../lib/paper/store.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≠ ${b}`);
const NOW = Date.UTC(2026, 10, 24, 8);
const H = 3600e3, DAY = 86400e3;
const iso = (t) => new Date(t).toISOString();
const base = { createdAt: iso(NOW - H), thesis: "Le marché sous-estime nettement la probabilité de cet événement.", catalyst: "Réunion OPEP+", catalystAt: iso(NOW + 6 * DAY), conviction: 70, sources: ["https://example.org/a"] };
const PM = { ...base, id: "p1", venue: "pm", pm: { cid: "0xc", token: "t1", outcome: "Yes", title: "Will OPEC cut output?" } };
const HL = { ...base, id: "h1", venue: "hl", hl: { coin: "xyz:CL", side: "long", targetPx: 115 } };

test("validateProposal : champs, dates, sources", () => {
  assert.equal(validateProposal(PM, NOW).ok, true); assert.equal(validateProposal(HL, NOW).ok, true);
  assert.match(validateProposal({ ...PM, catalystAt: iso(NOW - H) }, NOW).error, /catalystAt/);
  assert.match(validateProposal({ ...PM, catalystAt: iso(NOW + 100 * DAY) }, NOW).error, /90 jours/);
  assert.match(validateProposal({ ...PM, sources: ["pas une url"] }, NOW).error, /sources/);
  assert.match(validateProposal({ ...PM, thesis: "court" }, NOW).error, /thèse/);
  assert.match(validateProposal({ ...HL, hl: { coin: "BTC", side: "up", targetPx: 1 } }, NOW).error, /hl\./);
  assert.match(validateProposal({ ...PM, venue: "x" }, NOW).error, /venue/);
});

test("borderCandidates : prix ≤ 0,25, gain/risque ≥ 3, une seule fois, 24 h au plus", () => {
  const data = { markets: { "xyz:CL": { mark: 100 } }, ohlc: { "xyz:CL": { atr: 2 } }, pmBooks: { t1: { asks: [[0.2, 1000]] } } };
  const r = borderCandidates({ proposals: [PM, HL] }, [], data, NOW);
  assert.deepEqual(r.candidates.map((c) => c.id), ["border|p1", "border|h1"]);
  const [pm, hl] = r.candidates;
  assert.equal(pm.pocket, "border"); assert.equal(pm.expiresAt, PM.catalystAt); close(pm.metrics.reward_risk, 4);
  close(hl.metrics.stop_dist_pct, 0.04); close(hl.metrics.reward_risk, 15 / 4); assert.equal(hl.targetPx, 115);
  // déjà votée, trop chère, objectif trop proche, trop ancienne
  assert.equal(borderCandidates({ proposals: [PM] }, ["p1"], data, NOW).candidates.length, 0);
  assert.match(borderCandidates({ proposals: [PM] }, [], { ...data, pmBooks: { t1: { asks: [[0.3, 10]] } } }, NOW).rejected[0].reason, /0\.3 > 0\.25/);
  assert.match(borderCandidates({ proposals: [{ ...HL, hl: { ...HL.hl, targetPx: 110 } }] }, [], data, NOW).rejected[0].reason, /2\.50 < 3/);
  assert.match(borderCandidates({ proposals: [{ ...PM, createdAt: iso(NOW - 25 * H) }] }, [], data, NOW).rejected[0].reason, /24 h/);
  // au plus 2 par cycle
  assert.equal(borderCandidates({ proposals: [PM, { ...PM, id: "p2" }, { ...PM, id: "p3" }] }, [], data, NOW).candidates.length, 2);
  assert.deepEqual(borderNeeds({ proposals: [PM, HL] }, ["h1"]), { tokens: ["t1"], coins: [] });
  assert.equal(markSeen(Array.from({ length: 250 }, (_, i) => "x" + i), ["new"]).at(-1), "new");
  assert.equal(markSeen(Array.from({ length: 250 }, (_, i) => "x" + i), ["new"]).length, 200);
});

test("exécution border : 300 $ max, clôture à la date du catalyseur, objectif transmis au moteur de risque", async () => {
  const data = { markets: { "xyz:CL": { mark: 100 } }, ohlc: { "xyz:CL": { atr: 2 } }, pmBooks: { t1: { asks: [[0.2, 1e5]] } } };
  const { candidates } = borderCandidates({ proposals: [PM, HL] }, [], data, NOW);
  const deps = { fetchBook: async () => ({ asks: [[0.2, 1e5]], bids: [[0.19, 1e5]] }), fetchL2Book: async () => ({ asks: [[100, 1e6]], bids: [[99.9, 1e6]] }) };
  const r = await executeDecisions(initialPortfolio(), candidates.map((c) => ({ id: c.id, action: "OPEN", conviction: 100, horizonH: 24 })), { candidates }, { markets: data.markets, deps, now: NOW });
  assert.equal(r.refused.length, 0);
  const [pm, hl] = r.portfolio.positions;
  close(pm.cost, 300); assert.equal(pm.expiresAt, PM.catalystAt); assert.equal(pm.pocket, "border");
  close(hl.entryUsd, 200); assert.equal(hl.expiresAt, HL.catalystAt); close(hl.stopPx, 96);   // poche border = 5 % de 10 000 $ : il reste 200 $ après la première idée
});

test("fichiers publiés : jamais les fichiers internes", () => {
  assert.ok(PUBLIC_PAPER_FILES.includes("metrics.json"));
  assert.ok(!PUBLIC_PAPER_FILES.includes("whale_scores.json") && !PUBLIC_PAPER_FILES.includes("market_history.json"));
});
