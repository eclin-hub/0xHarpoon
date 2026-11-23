import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CONFIG, factorOf } from "../../lib/paper/config.mjs";
import { Store, FILES, initialPortfolio } from "../../lib/paper/store.mjs";

const tmp = () => mkdtemp(path.join(tmpdir(), "paper-"));

test("config : poches ≤ 100 % et seuils cohérents", () => {
  const p = CONFIG.pockets;
  assert.ok(p.core.maxShare + p.portage.maxShare + p.border.maxShare <= 1 + 1e-9);
  assert.ok(CONFIG.risk.rMin < CONFIG.risk.rMax);
  assert.ok(CONFIG.risk.ddHalveR < CONFIG.risk.ddReduceOnly && CONFIG.risk.ddReduceOnly < CONFIG.risk.ddKill);
  assert.equal(CONFIG.risk.ddKill, 0.25);
  assert.ok(CONFIG.risk.stopMin < CONFIG.risk.stopMax);
  assert.ok(CONFIG.pockets.portage.minPrice < CONFIG.pockets.portage.maxPrice);
  assert.equal(CONFIG.ai.quorum, 2);
  assert.throws(() => { CONFIG.risk.rMax = 1; });   // gelé : aucun module ne peut le modifier
});

test("config : facteurs", () => {
  assert.equal(factorOf("BTC"), "CRYPTO_BETA");
  assert.equal(factorOf("xyz:CL"), "ENERGY_GEO");
  assert.equal(factorOf("xyz:GOLD"), "GOLD_SAFEHAVEN");
  assert.equal(factorOf("FARTCOIN"), "IDIOSYNCRATIC");
});

test("store : portefeuille initial puis aller-retour", async () => {
  const s = new Store(await tmp());
  const p = await s.loadPortfolio();
  assert.deepEqual({ cash: p.cash, equity: p.equity, positions: p.positions, mode: p.mode }, { cash: 10_000, equity: 10_000, positions: [], mode: "normal" });
  await s.savePortfolio({ ...p, cash: 9_500 });
  const q = await s.loadPortfolio();
  assert.equal(q.cash, 9_500);
  assert.ok(q.updatedAt);
  assert.deepEqual((await readdir(s.dir)).sort(), [FILES.portfolio]);   // pas de .tmp résiduel
});

test("store : JSONL ajouté ligne par ligne, ligne corrompue signalée", async () => {
  const s = new Store(await tmp());
  assert.deepEqual(await s.readJsonl(FILES.votes), []);
  await s.appendJsonl(FILES.votes, { a: 1 });
  await s.appendJsonl(FILES.votes, [{ a: 2 }, { a: 3 }]);
  await s.appendJsonl(FILES.votes, []);
  assert.deepEqual(await s.readJsonl(FILES.votes), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  await writeFile(s.file(FILES.votes), (await readFile(s.file(FILES.votes), "utf8")) + "{oops\n");
  await assert.rejects(s.readJsonl(FILES.votes), /ligne 4/);
});

test("store : JSON corrompu = erreur, pas un portefeuille neuf silencieux", async () => {
  const s = new Store(await tmp());
  await mkdir(s.dir, { recursive: true });
  await writeFile(s.file(FILES.portfolio), "{pas du json");
  await assert.rejects(s.loadPortfolio(), /illisible/);
});

test("initialPortfolio : horodatage UTC ISO", () => {
  assert.match(initialPortfolio().createdAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
});
