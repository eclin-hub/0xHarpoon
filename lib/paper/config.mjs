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
    warmupDays: 30,                      // phase de démarrage : baleines sans historique admises (poids borné)
    maxCumDrawdown: 4,                   // pire creux toléré de la somme des scores (≈ 4 pertes franches d'affilée)
    hlReturnScale: 0.05,                 // un trade HL à ±5 % du notionnel vaut un score de ±0.76 (tanh)
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
    minScore: 2.0,              // score minimal pour réveiller les LLM (≈ deux baleines de poids 1 entrées ensemble)
    confirmWeight: 0.5,         // une baleine déjà en position (sans entrée récente) compte pour moitié
    contrarianBonus: 0.2,       // +20 % si les baleines vont contre la foule (funding)
    fundingHigh: 0.00003,       // funding horaire « élevé » (≈ 26 %/an)
    fundingExtreme: 0.00005,    // funding horaire « extrême » (≈ 44 %/an)
    liqWallAtr: 1,              // mur de liquidations : positions de la cohorte liquidées à moins de 1 ATR…
    liqWallShare: 0.25,         // …représentant au moins 25 % du notionnel de la cohorte dans ce sens
    prefilterMax: 8,            // groupes Hyperliquid pour lesquels on va chercher l'ATR
    pairMinCorr: 0.6, pairStrong: 0.6, pairNeutral: 0.2, corrDays: 30,
    leadLagMinMove: 0.10, leadLagWindowH: 2, leadLagReactAtr: 0.25, leadLagScore: 3.0,
    historyKeepH: 48,
  }),

  // §4 — couche IA
  ai: Object.freeze({
    voters: 3, quorum: 2, minConviction: 60, dailyReviewUtcHour: 14,
  }),

  // garde-fous d'exécution (audit des 3 premiers jours : sorties trop rapides, churn, shorts corrélés, barrières lointaines)
  guards: Object.freeze({
    voteCloseMinHoldH: 8,          // pas de fermeture par vote avant 8 h de détention…
    voteCloseOverride: 0.85,       // …sauf si ≥ 85 % des votes disent CLOSE avec une conviction moyenne ≥ 85
    reentryCooldownH: 4,           // pas de réouverture d'un actif (ou marché) fermé il y a moins de 4 h
    correlatedBasket: Object.freeze(["BTC", "ETH", "SOL", "HYPE", "ZEC", "NVDA", "SOXL"]),
    correlatedMaxSameSide: 3,      // au plus 3 positions du panier dans le même sens
    pmBarrierMaxDist: 0.08,        // signal Polymarket à barrière (hit, reach, above…) : seuil à 8 % du prix au plus
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
