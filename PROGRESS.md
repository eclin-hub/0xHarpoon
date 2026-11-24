# PROGRESS — Boussole des baleines

Dernière mise à jour : 24 novembre 2026.

## 1. État actuel

Terminal web de suivi des « baleines » (Hyperliquid, Polymarket) enrichi de données macro, institutionnelles et géopolitiques. Il fonctionne en trois modes :

| Mode | Lancement | Données |
|---|---|---|
| Local | `node server.mjs` puis http://localhost:8787 | collecte en direct (SSE), bouton Actualiser |
| En ligne (GitHub Pages) | `.github/workflows/update.yml`, toutes les 10 à 20 min | analyses recalculées par GitHub ; prix, positions Hyperliquid et Whale Tape rafraîchis en direct par le navigateur |
| Instantané (artefact Claude) | `node scripts/snapshot.mjs --artifact` | figé ; le bouton Actualiser demande à Claude de republier |

### Pages (18)

- **Synthèse** : Tableau de bord, Directions, Signaux d'edge.
- **Monde** : Globe (conflits, blocs, alliés et rivaux, soutiens des camps), Infos et réseaux, Calendrier, Probabilités.
- **Marchés** : Macro, Prix et funding, Hedge funds (CFTC), Options, Liquidations.
- **Baleines** : Sentiment, Hyperliquid, Polymarket, Flux en direct, Whale Tape.
- **Outil** : Calculateur.

### Quant Vault (bouton cadenas)

11 vues, une par onglet, avec mosaïque et plein écran.

- **Outils 1 à 7** : Sankey, frontière 3D, robustesse, contagion, corrélations, cônes à sauts, bêta 3D.
- **Outil 11** : facteurs cachés.
- **Outils 8 à 10** : laboratoire du mémoire (DFM par filtre de Kalman, Fama-MacBeth et test GRS, Factor-GJR-GARCH), avec export CSV et JSON.

Le Vault tourne sur un modèle stylisé et des données simulées, sauf l'option « cours réels » de l'outil 11.

### Derniers chantiers terminés et testés

1. **Paysage de robustesse réparé** : échelle propre à chaque surface, nettoyage des valeurs aberrantes, redimensionnement automatique.
2. **Module « Find Hidden Factors »** : régression sur les facteurs évidents, débruitage (Marchenko-Pastur ou Ledoit-Wolf), ACP des résidus, corrélations partielles, risque caché du portefeuille.
3. **Refonte du Vault** : en-tête unique de 46 px, un graphique par vue, plein écran ; état et flux conservés entre les vues.
4. **API Polymarket fiabilisée** : file d'attente à 2 requêtes, reprise avec délai exponentiel, cache de 45 s, 15 plus grosses positions affichées en premier, mémoire locale. Collecte du serveur : 134 comptes sur 134 relevés en 16 s.
5. **Whale Tape** : transactions Polymarket d'au moins 10 000 $ toutes les 30 s, seuils 10 k à 100 k, détection des convergences, repli à 10 min en cas de limite.

Vérification : 18 pages et 11 vues du Vault sans erreur, sur ordinateur et sur mobile, plus une panne simulée de Polymarket (tape jamais vide, inspecteur qui garde les positions).

### Points connus

- Les routes Polymarket sans version (`/positions`…) sont retirées : le code utilise `/v2/...`.
- L'export du laboratoire dans l'artefact passe par la capacité `downloads` ; il n'a pas été testé en cliquant dans l'artefact.
- X (Twitter) n'est pas branché : il faut une clé (`X_BEARER_TOKEN` ou `TWITTERAPI_IO_KEY`).
- Les foyers de tension et les alliances du globe sont une base éditoriale arrêtée à mi-2026.

## 2. Fichiers

Tous les fichiers ci-dessous ont été créés ou modifiés au fil du projet.

### Serveur et collecte (`lib/`, `server.mjs`, `scripts/`)

| Fichier | Rôle |
|---|---|
| `server.mjs` | Serveur local, boucles de collecte, persistance dans `data/`, routes `/api/state`, `/api/events`, `/api/refresh`, `/api/country`, `/api/hl/account` |
| `lib/util.mjs` | Requêtes avec reprise (Retry-After), file d'exécution, utilitaires |
| `lib/hl.mjs` | Hyperliquid : classement, échantillon de 100 comptes, positions, marchés, bougies, liquidations, détection des mouvements |
| `lib/pm.mjs` | Polymarket : classements, cohorte, positions ouvertes (file d'attente limitée), marchés encombrés, mouvements |
| `lib/sentiment.mjs`, `lib/topics.mjs` | Sentiment croisé par thème, correspondance des actifs |
| `lib/macro.mjs` | Séries FRED, liquidité nette, courbe des taux, score de régime |
| `lib/alt.mjs` | CFTC, options Deribit, calendrier, peur et avidité, stablecoins, Wikipedia, App Store, séismes, Banque mondiale |
| `lib/news.mjs`, `lib/odds.mjs`, `lib/world.mjs`, `lib/countries.json` | Actualités, cotes Polymarket, foyers de tension, pays |
| `lib/synth.mjs` | Directions par actif et signaux d'edge |
| `scripts/snapshot.mjs` | Construction du site statique (`--site`), de l'artefact (`--artifact`) ou reconstruction sans nouvelle collecte (`--reuse`) |
| `.github/workflows/update.yml` | Collecte et publication GitHub Pages, historique dans la branche `state` |

### Interface (`public/`)

| Fichier | Rôle |
|---|---|
| `index.html`, `app.css` | Coquille et styles |
| `charts.js`, `charts2.js`, `globe.js`, `geodata.js` | Graphiques SVG, globe 3D, base géopolitique |
| `core.js`, `main.js`, `live.js` | Navigation, actualisation, direct dans le navigateur |
| `drawer.js`, `pmapi.js`, `pmwhale.js` | Fiches portefeuille, actif et marché ; client Polymarket fiabilisé ; inspecteur de baleine |
| `views1.js` à `views4.js`, `tape.js` | Pages du terminal et Whale Tape |
| `q-model.js`, `q-canvas.js`, `q-tools.js`, `q-hidden.js`, `q-thesis.js`, `q-vault.js` | Quant Vault et laboratoire du mémoire |

### Générés, non versionnés (`.gitignore`)

`data/`, `site/`, `dist/`.

## 3. Prochaine étape : agent de paper trading autonome

Spécification complète dans `SPEC.md` (elle prime sur cette section). Implémentation en cours sur la branche `feat/paper-trading` : étapes 1 à 6 faites. Un agent gère 10 000 $ fictifs à partir des signaux du terminal, pour une compétition avec d'autres participants. Stratégie : copy whale confirmé par la macro, plus raisonnement macro. Tout doit rester 100 % gratuit.

### Conception retenue

- **Moteur déterministe** (code), qui seul décide des tailles et des limites : filtrage des candidats, risque, exécution simulée sur les carnets d'ordres, comptabilité.
- **Couche IA** : vote parallèle de 3 modèles gratuits indépendants (pas d'avocat du diable), puis un arbitre en cas de divergence ; 1 contre 1 = pas d'ouverture. Les objections doivent citer une métrique du dossier ; au moins 2 modèles sont nécessaires pour ouvrir une position ; un agent à règles fixes prend le relais en secours.
- **Trois poches** :
  - cœur (copy whale, macro et paires long/short) ;
  - portage Polymarket à haute probabilité (plafonné par marché) ;
  - border (thèses spéculatives issues de l'actualité, 5 % au plus, sans levier, avec catalyseur daté et arrêt automatique).
- **Filtres avant l'IA** : prix encore proche de l'entrée des baleines, poids de la position dans le compte de la baleine, fenêtre de convergence, baleines contre la foule (funding, liquidations), exclusion des comptes couverts, notes de baleines par domaine calculées par formule.
- **Risque** : taille calculée à partir du risque par trade (1 à 1,5 % du capital) avec un stop fixé par la volatilité, levier global plafonné à 2 à 3×, limite d'exposition par facteur ; sur Polymarket, perte totale acceptée sur la mise et sortie sur invalidation.
- **Cadence** : contrôle chaque heure ; IA réveillée seulement sur événement, plus une revue quotidienne. Claude en tâche planifiée 3 à 4 fois par jour pour le modèle border, avec recherche web.
- **Évaluation** : ratios de Sharpe, Sortino et Calmar, score de Brier, comparaison avec BTC acheté et conservé, Sharpe probabiliste ; gain qu'aurait obtenu chaque modèle seul.
- **Page dédiée** : capital, courbe, drawdown, positions ouvertes, historique, votes et raisonnements.

### Décisions prises (24/11/2026)

1. Drawdown : freins à 10 % (risque divisé par 2), 20 % (plus d'ouverture), arrêt total à 25 %.
2. Langage : Node ESM, zéro dépendance (validation des votes écrite à la main, pas de Zod).
3. État dans `data/paper/`, sauvegardé sur la branche `state` ; `trading_loop.yml` partage le groupe de concurrence `boussole` et ne pousse jamais si la récupération de `state` a échoué.
4. Un seul déploiement Pages (celui de `update.yml`).

### Reste à faire de ton côté

- Compte Groq gratuit, avec sa clé dans les secrets du dépôt GitHub ; GitHub Models ne demande rien de plus.

### Données : solutions retenues

- Historique des baleines : poids de départ 1.0 ajusté par le PnL connu (bornes 0.75 à 1.25), filtre N ≥ 15 appliqué baleine par baleine.
- Prix d'entrée Hyperliquid : `entryPx` ; l'heure d'entrée n'est connue que pour les ouvertures détectées entre deux relevés.
- Comptes couverts : ratio directionnel net < 0.3 ; `spotClearinghouseState` disponible en option (`hl.fetchSpotBalances`).
- Polymarket CLOB : `pm.fetchBook` et `pm.fetchResolution` sur `clob.polymarket.com`.
- **Accès local à Polymarket bloqué** : le DNS du fournisseur d'accès renvoie `*.polymarket.com` vers la page de blocage de l'ANJ (certificat expiré). Les appels Polymarket ne peuvent être vérifiés que sur GitHub Actions.

### Avancement (tests : `npm test`, soit `node --test`)

1. ✅ Socle : `lib/paper/config.mjs` (tous les seuils), `lib/paper/store.mjs` (JSON atomique, JSONL), `scripts/paper.mjs` (`--dry-run`, `--no-net`, `--data=`).
2. ✅ Données : `hl.fetchOhlc`, `hl.atr` (Wilder), `hl.fetchL2Book`, `hl.fetchSpotBalances` ; `token` conservé dans les positions Polymarket, `pm.fetchBook`, `pm.fetchResolution`, `pm.payoutOf` ; `lib/paper/loader.mjs` (dernier relevé, `entryVwap`, `recentEntries`, `enrich`). 16 tests ; Hyperliquid vérifié en réel, Polymarket seulement avec des réponses simulées.
3. ✅ Simulateur `lib/paper/simulator.mjs` (fonctions pures) : `walkBook` (parcours du carnet, limite de glissement), `openHl`/`closeHl` (frais taker, fermeture forcée complétée au prix dégradé si le carnet est trop mince), `applyFunding` (une fois par heure pleine, taux courant), `openPm`/`closePm` (vente partielle si peu d'acheteurs), `settlePm` (1 $ / 0 $), `markToMarket` (mark HL, milieu du carnet PM, sommet, drawdown), `dueExits` (stops, échéances), `tick`. Branché dans `scripts/paper.mjs` (journaux `trades_history.jsonl`, `equity_curve.jsonl`). 28 tests ; cycle réel vérifié sur le carnet BTC.
4. ✅ Moteur de risque `lib/paper/risk.mjs` : `nextMode` (freins 10 / 20 / 25 %, arrêt d'urgence définitif), `riskPerTrade` (R selon la conviction), `hlStop` (2 × ATR, borné 3 à 15 %), `riskState`, `sizeHl`, `sizePm`, `sizePair` (chaque ordre indique la limite qui a joué), `killExits`. Les freins sont appliqués dans `tick` à chaque cycle. 38 tests.
5. ✅ Notes des baleines `lib/paper/scorer.mjs` : catégories, score par position résolue (Hyperliquid : PnL / notionnel ; Polymarket : issue − prix moyen), moyenne mobile par catégorie, phase de démarrage de 30 jours, poids de départ tirés des classements, exclusion sur creux cumulé. Les événements Polymarket portent désormais `cid`, `token` et `avg`. Branché dans le cycle (`whale_scores.json`). 47 tests ; vérifié sur 10 vraies baleines Hyperliquid.
6. ✅ Candidats et signaux : `lib/paper/candidates.mjs` (regroupement, comptes couverts, poids de position ≥ 5 %, convergence sur entrées détectées, fraîcheur, contrariant, mur de liquidations, score, sélection des 5 meilleurs) et `lib/paper/cross.mjs` (paires par sentiment et corrélation, décalage Polymarket → Hyperliquid sur historique de 48 h). Dossier écrit dans `candidates.json`. 57 tests ; vérifié sur la vraie cohorte de 100 comptes (entrées simulées).
7. IA : schéma, routeur, vote, arbitre, secours.
8. Métriques.
9. Intégration : `trading_loop.yml`, copie dans `site/`, page `views5.js`, propositions border.
