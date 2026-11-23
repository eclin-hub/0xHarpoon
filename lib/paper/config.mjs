// Tous les seuils de l'agent de paper trading (SPEC.md), à un seul endroit.
// Les modules lisent ces valeurs, ils ne les recopient jamais. Fractions : 0.05 = 5 %.

export const CONFIG = Object.freeze({
  startCapital: 10_000,

  // §2 — trois poches isolées (part maximale de l'equity)
  pockets: Object.freeze({
    core: Object.freeze({ maxShare: 0.70 }),
    portage: Object.freeze({ maxShare: 0.25, minPrice: 0.88, maxPrice: 0.95, maxDays: 14, maxStakeShare: 0.05 }),
    border: Object.freeze({ maxShare: 0.05, perIdeaUsd: 300, minRewardRisk: 3, maxBuyPrice: 0.25, leverage: 1 }),
  }),

  // §3.1 — notes des baleines
  whales: Object.freeze({
    categories: Object.freeze(["macro", "geopolitics", "crypto", "commodities"]),
    weightMin: 0.5, weightMax: 2.0,
    warmupMin: 0.75, warmupMax: 1.25,   // bornes du poids tant que l'historique est insuffisant
    minResolved: 15,                     // filtre anti-survivant
    emaAlpha: 0.2,
  }),

  // §3.2 — filtres obligatoires
  filters: Object.freeze({
    minPositionShareOfEquity: 0.05,
    convergenceMinWhales: 2,
    convergenceWindowH: 4,
    convergenceWindowMacroH: 24,
    hlFreshAtrMult: 1.2,
    pmFreshMaxDelta: 0.10,
    hedgeMinNetRatio: 0.3,               // |long − short| / (long + short) en dessous : compte couvert
    maxCandidates: 5,
  }),

  // §3.3 — signaux avancés
  signals: Object.freeze({
    pairMinCorr: 0.6,
    leadLagMinMove: 0.10, leadLagWindowH: 2,
  }),

  // §4 — couche IA
  ai: Object.freeze({
    voters: 3, quorum: 2, minConviction: 60, dailyReviewUtcHour: 14,
  }),

  // §5 — risque
  risk: Object.freeze({
    rMin: 0.01, rMax: 0.015,
    stopAtrMult: 2.0, stopMin: 0.03, stopMax: 0.15,
    perPositionEquityCap: 0.20, maxPositionLeverage: 3, maxGrossLeverage: 2.5,
    factorCap: 0.40,
    ddHalveR: 0.10, ddReduceOnly: 0.20, ddKill: 0.25,
    minOrderUsd: 25,         // en dessous, l'ordre n'en vaut pas les frais : refusé
  }),

  // §6 — exécution simulée
  exec: Object.freeze({
    hlTakerFee: 0.00035,
    hlMaxSlippage: 0.005,    // écart relatif max entre prix moyen rempli et meilleur prix
    pmMaxSlippage: 0.02,     // écart absolu max (en $ par part)
    minFillShare: 0.5,       // ouverture annulée si le carnet absorbe moins de la moitié de la taille demandée
    atrPeriod: 14, atrInterval: "1d", atrLookbackDays: 40,
  }),

  // données
  data: Object.freeze({
    snapshotMaxAgeMin: 45,   // au-delà, le dernier relevé du terminal est jugé périmé
  }),

  // §5.2 — facteurs d'exposition par actif Hyperliquid (le reste : IDIOSYNCRATIC)
  factors: Object.freeze({
    CRYPTO_BETA: Object.freeze(["BTC", "ETH", "SOL", "HYPE", "XRP", "DOGE"]),
    RATES_MACRO: Object.freeze(["xyz:SP500", "xyz:XYZ100", "xyz:DXY", "xyz:EUR", "xyz:JPY", "xyz:NVDA", "xyz:TSLA"]),
    ENERGY_GEO: Object.freeze(["xyz:CL", "xyz:BRENTOIL", "xyz:NATGAS"]),
    GOLD_SAFEHAVEN: Object.freeze(["xyz:GOLD", "xyz:SILVER", "PAXG"]),
  }),
});

export function factorOf(coin) {
  for (const [f, list] of Object.entries(CONFIG.factors)) if (list.includes(coin)) return f;
  return "IDIOSYNCRATIC";
}
