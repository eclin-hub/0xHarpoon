# PROGRESS — Boussole des baleines

Dernière mise à jour : 24 novembre 2026.

## 1. État actuel

Terminal web de suivi des « baleines » (Hyperliquid, Polymarket) enrichi de données macro, institutionnelles et géopolitiques. Il fonctionne en trois modes :

| Mode | Lancement | Données |
|---|---|---|
| Local | `node server.mjs` puis http://localhost:8787 | collecte en direct (SSE), bouton Actualiser |
| En ligne (GitHub Pages) | `.github/workflows/update.yml`, chaque heure à :00 (cron-job.org) et à chaque push sur `main` ; agent `trading_loop.yml` à :10 | analyses recalculées par GitHub ; prix, positions Hyperliquid et Whale Tape rafraîchis en direct par le navigateur |
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

Spécification complète dans `SPEC.md` (elle prime sur cette section). Implémentation en cours sur la branche `feat/paper-trading` : étapes 1 à 9 faites : l'agent est complet, il reste à le mettre en service. Un agent gère 10 000 $ fictifs à partir des signaux du terminal, pour une compétition avec d'autres participants. Stratégie : copy whale confirmé par la macro, plus raisonnement macro. Tout doit rester 100 % gratuit.

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

- Compte Groq gratuit, avec sa clé `GROQ_API_KEY` dans les secrets du dépôt GitHub (fait).
- GitHub Models a été retiré le 30 juillet 2026 : il n'est plus utilisé. Votants : Groq (`openai/gpt-oss-120b`, `qwen/qwen3.8-27b`, vérifiés en réel, ~2,5 s) et Gemini (`gemini-3.8-flash`, clé ajoutée, pas encore vérifié en réel). Arbitre : Gemma 4 servi par Google avec la clé Gemini (`gemma-4-31b-it`, secours `gemma-4-26b-a4b-it`, API native `generateContent`), pas encore vérifié en réel (quota gratuit non documenté) ; OpenRouter (`gemma-4-31b-it:free`, `ernie-5.5-flash-preview:free`, en 429 au cycle du 24/11/2026) en dernier recours. `nemotron-3-ultra` (60 s) et `nemotron-3.5-lightning` (réponse vide) retirés. Cerebras et SambaNova : identifiants non vérifiés.
- Vérifier que les identifiants de modèles de `lib/paper/router.mjs` existent toujours chez chaque fournisseur (ils changent souvent).

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
7. ✅ IA : `schema.mjs` (validation stricte, vérification des métriques citées), `router.mjs` (6 fournisseurs gratuits, familles distinctes, repli automatique, mode JSON optionnel), `decision.mjs` (réveil, prompts, quorum, arbitre, secours), `execute.mjs` (taille par le moteur de risque, exécution sur le carnet réel, jambe orpheline refermée). Votes et décisions dans `model_votes.jsonl` ; option `--no-llm`. 68 tests avec un faux fournisseur ; **jamais appelé avec de vraies clés** (aucune clé sur le poste).
8. ✅ Métriques : `lib/paper/metrics.mjs` (Sharpe, Sortino, Calmar, drawdown max, rendement annualisé, PSR, espérance, profit factor, Brier agent contre marché, références BTC et 50/50 BTC-or) et `lib/paper/shadow.mjs` (positions fantômes par modèle, mesurées en R). La conviction est conservée sur les positions et les trades. Écrit chaque cycle dans `metrics.json` et `shadow_book.json`. 80 tests.
9. ✅ Intégration : `.github/workflows/trading_loop.yml` (horaire, groupe de concurrence `boussole`, garde-fou sur `state`, `models: read`, tests avant le cycle), même garde-fou ajouté à `update.yml`, copie de `data/paper` dans `site/paper/` (liste fermée), route locale `/api/paper/…`, page « Paper trading » (`public/views5.js`), propositions border (`lib/paper/border.mjs`, branche `border`, instructions `scripts/border_prompt.md`). 84 tests ; page vérifiée dans le navigateur en local et en mode GitHub Pages sur un jeu de démonstration.

### Assainissement après 3,2 jours (27/11/2026)
- `gemini-3.6-flash` et `gemini-3.5-flash-lite` passent en ombre (poids nul, suivis dans le PnL contrefactuel) ; votants gpt-oss-120b, qwen3.8, gemini-3.8-flash (ernie en remplaçant), arbitre gemma-4-26b.
- Garde-fous : pas de sortie par vote avant 8 h, pas de ré-entrée avant 4 h, 3 positions au plus par sens dans le panier crypto/semi corrélé, barrières Polymarket à plus de 8 % du prix écartées (SPEC §4.3).
- Page : lieu d'exécution (Hyperliquid ou Polymarket) sur chaque position et trade ; cote du signal Polymarket (entrée → maintenant) sur les positions lead-lag.

### Collecte X et page X Alpha (27/11/2026)
- `x_scraper.mjs` : agent-reach (ou API X / twitterapi.io), filtre anti-spam, déduplication, poids crédibilité × engagement ; flux ε par ticker injecté dans le dossier des votants ; flux ∞ traduit en Blueprints JSON déclaratifs (`blueprint.mjs`). Page « X Alpha (ε / ∞) » (`views6.js`), emplacement réservé aux 3 Ligues.
- Flux réel en CI : twitter-cli (version figée) installé par le workflow, cookies X lus dans les secrets `X_AUTH_TOKEN` / `X_CT0`, collecte réutilisée pendant 45 min (anti-ban), option `force_x` au lancement manuel. agent-reach reste utilisable en local seulement (connexion manuelle dans son navigateur). Cookies à renouveler quand la page affiche « cookies X expirés ».
- 28/11/2026 : premier cycle réel en échec (HTTP 404 puis 429). Cause : nouveau frontend x.com (en-tête de transaction impossible à calculer sans session) et queryId périmés. Correctif `scripts/x_twitter.py` (vérifié sur un faux twitter-cli ; l'appel réel se vérifie au prochain cycle, étape « Diagnostic de la collecte X »). Secours gratuit RSS (ε) et arXiv (∞) en place, vérifié en réel : 120 articles RSS, 15 abstracts arXiv.

### Compétition à 3 divisions (28/11/2026)
- Panel : votants gpt-oss-120b, qwen3.8, gemini-3.8-flash ; arbitre gemma-4-26b ; ombre gemini-3.5-flash-lite et ernie ; gemini-3.6-flash et gpt-oss-20b retirés.
- Blueprints : qwen3.8 d'abord, normalisation avant validation, compilation à chaque cycle même avec une collecte réutilisée.
- D1 labo synthétique (GJR-GARCH, sauts, régimes), D2 live sur les vrais prix horaires, D3 champions mêlés aux LLM (65 / 35). Rien n'est encore en D2 en production : il faut d'abord des Blueprints compilés (clé Groq) qui passent la D1, puis au moins 15 trades réels pour atteindre la D3.

### Mode One-Way et plafonds des ligues (28/11/2026)
- Livre principal : une seule ligne par actif (ou par marché Polymarket). Même sens : doublon refusé ; sens opposé : la position existante est clôturée (« signal inverse », votes et raison gardés, délai de détention de 8 h respecté), jamais deux lignes opposées ; l'ouverture dans le nouveau sens est possible au cycle suivant (cette clôture ne déclenche pas le délai de ré-entrée de 4 h). Paire : refusée si une jambe est déjà tenue.
- D2 / D3 (et labo D1, même moteur) : position ≤ 15 % du capital virtuel (1 500 $), exposition brute ≤ 60 % (6 000 $), 4 positions au plus, 3 du même sens par classe (crypto, tradfi, pm), risque de 1 % au stop ATR ; famille stat_arb_leadlag : pas de 3e jambe dans un sens sans jambe inverse dans la même classe.
- GraphFactorStatArb retypé stat_arb_leadlag (nom et thèse d'arbitrage statistique ; ses blocs donnaient une égalité tendance / retour à la moyenne). Ses positions déjà ouvertes au-delà des nouveaux plafonds courent jusqu'à leur sortie ; les plafonds valent pour toute nouvelle entrée.

### Quota Groq et routage OpenRouter (28/11/2026)
- Cause des « 429 TPM » sur qwen3.8 : Groq compte l'entrée ET le max_tokens demandé ; dossier réel ≈ 3 800 tokens + 4 000 demandés ≈ 7 800 pour 8 000/min. Dossier compacté (métriques arrondies, titres coupés, flux ε sans titres, coupe progressive) : 2 495 tokens sur le cycle réel (budget 2 500) ; réponse Groq plafonnée à 1 400 tokens, gpt-oss en raisonnement court (`reasoning_effort: low`, retiré automatiquement si refusé).
- OpenRouter : Gemma 4 gratuit (pool saturé, 429) et Ernie (réponses vides) exclus de la découverte ; openrouter/free reçoit le champ `models` avec les 3 meilleurs :free du catalogue (aujourd'hui particle-1, flint, nemotron-3.5-super-vl). Seul modèle gratuit ≥ 24 Md restant comme votant : nemotron-3-nano-omni 30B (3 Md actifs, sans mode JSON).
- À surveiller : bulletins tronqués si 1 400 tokens ne suffisent pas (beaucoup de positions ouvertes) — l'erreur apparaîtrait en « JSON » dans le classement.

### Univers élargi, positions D2 et votes expliqués (28/11/2026)
- Votes tracés et colonne « Avis / Raison » : vérifié en réel, l'historique publié montre déjà des phrases générées en CI (« Ouvert par l'arbitre deepseek-v4-pro (votes partagés 2/3) : … »).
- Univers : catalogue réel du jour 304 perps Hyperliquid (125 TradFi) et 82 marchés Polymarket actifs ; GraphFactorStatArb migré de BTC, ETH vers BTC, ETH, HL_CRYPTO (20 cryptos) et ouvre aussitôt HYPE et NEAR en plus de BTC et ETH. Exposition virtuelle bornée à 3 × l'équité (sinon 20 positions × 1 × le capital).
- Arène X Alpha : tiroir des positions et trades D2 / D3 au clic (vérifié dans l'app avec les données réelles).

### Socle LLM nettoyé : DeepSeek, Groq, OpenRouter (28/11/2026)
- Retirés du code et des workflows : Mistral (402), Gemini / Gemma via Google AI Studio (429, JSON incomplets), Ernie (réponses vides), Cerebras et SambaNova (sans clé). Ajouté : DeepSeek (`DEEPSEEK_API_KEY`), identifiants vérifiés dans sa documentation (`deepseek-v4-pro`, `deepseek-flash`).
- Socle de 6 votants : deepseek-v4-pro, deepseek-flash, gpt-oss-120b, qwen3.8-27b, openrouter/free et 1 modèle OpenRouter ≥ 24 Md (catalogue réel : `google/gemma-4-31b-it:free`) ; 16,7 % chacun au score neutre, 30 % au plus.
- Arbitrage et régime macro : deepseek-v4-pro d'abord ; Blueprints et mutation Gen-2 : deepseek-flash d'abord (le quota de Groq reste au vote). L'arbitre peut désormais être un des votants.
- Classement : seuls les modèles du routeur actif s'affichent (`configured`), les anciens trades fantômes de Gemini, Ernie ou Mistral restent dans le shadow book sans être montrés.
- À vérifier au prochain cycle réel : réponses de DeepSeek (délai, mode JSON avec raisonnement) et coût par cycle (DeepSeek est payant).

### Votants OpenRouter découverts dans le catalogue (28/11/2026)
- Cycle réel : `meta-llama/llama-3.3-70b-instruct:free` (404 « payant seulement ») et `qwen/qwen3-235b-a22b:free` (404 « déprécié le 9 oct. 2026 ») retirés ; votants gratuits désormais découverts dans le catalogue public d'OpenRouter (6 h de cache). Catalogue réel du jour : 13 modèles gratuits → `particle-ai/particle-1:free`, `recursive/flint-v1.0:free`, `nvidia/nemotron-3.5-super-vl:free` (réponses réelles à vérifier au prochain cycle : clé OpenRouter absente en local).
- `openrouter/free` en « délai » : il atteignait la limite de 60 s, déjà la valeur par défaut ; la limite est gardée à 60 s (35 s aurait multiplié les abandons), désormais réglable par fournisseur.
- GitHub Models non ajouté : `models.inference.ai.azure.com` n'existe plus (DNS) et `models.github.ai` répond « OK » en texte brut à toute requête.
- `mistral-small-latest` : HTTP 402 « You need a subscription » (`billing_no_api_budget_configured`) au cycle réel ; à régler dans la console Mistral (offre gratuite « Experiment » à activer). Code court ajouté : « 402 abonnement ».

### Tous les modèles actifs votent, poids continus 4 % à 30 % (28/11/2026)
- Fin du Top 6 et du repêchage : tous les modèles non `shadowOnly` votent à chaque réveil (`LLMRouter.collectAll`), poids cible max(0,2 ; score)² borné entre 4 % et 30 % ; un modèle muet pèse 0 sur le cycle, sa part est redistribuée.
- Moins d'échecs « sans réponse » : Blueprints compilés après le vote et par mistral-small en priorité (quota TPM de gpt-oss-120b réservé au vote) ; 400 ms entre deux requêtes OpenRouter ; extraction JSON plus tolérante (plusieurs blocs markdown, accolades dans la prose, `</think>` seul, virgules finales).
- Classement : colonne Poids « 16,7 % (cible 12,1 %) », « Cible 15,1 % · Cycle 0 % » pour un actif muet, « 0 % exclu » pour un modèle grisé ; Statut « Actif · sans réponse · 429 TPM / 404 policy / JSON / délai ».
- Une voix par modèle : llama 3.3 70b, servi par Cerebras et OpenRouter, vote deux fois mais n'a qu'un poids, partagé entre ses copies (pool réel à score neutre : 7 voix de 14,3 %, les deux copies de llama à 7,15 % chacune).

### Carnet permanent des stratégies (28/11/2026)
- `d1Stats` figées à l'évaluation D1 et gardées après promotion ; `strategy_ledger.json` (jamais purgé) mis à jour à chaque cycle et publié ; page autonome `public/ledger.html` ouverte depuis l'arène X Alpha.
- X Alpha : tableau D1 avec les qualifiées en tête (badge « qualifié → D2 »), sous-ligne « Labo D1 : PF · DD · Stress » dans D2 et D3, lien discret vers le carnet ; aucun nouveau bloc.
- Vérifié sur l'état réel (branche state) : 9 stratégies, 1 qualifiée (GraphFactorStatArb, PF labo 1,31, active en D2), 8 éliminées en D1 ; page et filtres vérifiés sur le serveur local ; construction du site vérifiée (`site/ledger.html`, `site/app.css`, `site/paper/strategy_ledger.json`).

### Méta-Agent de Régime Macro (28/11/2026)
- `lib/paper/regime_agent.mjs` : calendrier économique live (ForexFactory, déjà utilisé par le terminal via `lib/alt.mjs`, désormais lu aussi par l'agent), volatilité / tendance / funding sur BTC, ETH, NVDA et BRENTOIL, Flux ε, synthèse LLM en cache 2 h → 5 régimes. Vérifié en réel : calendrier de la semaine (77 événements, Core PCE du 25/11 reconnu comme critique, CPI australien non) ; prix réels de la branche state → `RANGE_COMPRESSION` (force de tendance 0,08, volatilité 1,1 × la normale).
- Familles de stratégies déduites des règles des Blueprints ; filtrage par régime en D2/D3 (ouvertures) et dans le meta-ensemble (poids des champions) ; en stress, taille × 0,5 et conviction minimale 70.
- Bandeau « Régime macro » sur Paper trading et X Alpha (vérifié dans l'app avec un FOMC simulé à 2 h).
- Limite connue : le flux ForexFactory ne couvre que la semaine en cours ; le samedi et le dimanche, les événements de la semaine suivante n'apparaissent qu'après sa mise à jour.

### Pool multi-LLM élargi et classement dynamique (28/11/2026)
- Nouveaux votants gratuits : Cerebras (`llama-3.3-70b`, `qwen-3-32b`), Mistral (`mistral-small-latest`), OpenRouter (`llama-3.3-70b-instruct:free`, `qwen3-235b-a22b:free`, `openrouter/free`). Secret `MISTRAL_API_KEY` ajouté au workflow ; un secret absent laisse le fournisseur de côté. Identifiants non encore vérifiés en réel : à surveiller dans « Classement des modèles IA » (colonne Statut, infobulle de la dernière erreur).
- `lib/paper/llm_ranking.mjs` : score par modèle sur le shadow book (PSR, PF, réussite, prior neutre sous 5 trades, pénalité d'échecs), 6 votants actifs, poids plafonné à 30 %, sourdine à 0 % et repêchage par rotation (2 modèles en ombre par réveil). `decision.mjs` : dépouillement pondéré. Vérifié sur le vrai shadow book (22 trades clos) : gpt-oss-120b en tête (score 1,16, 18,8 %), les autres au prior neutre (16,2 %).
- Interface : « Classement des modèles IA » remplace l'ancien tableau du PnL contrefactuel par modèle (même information, plus le statut et le poids).

### Blueprints débloqués, Gemini 3.8 en ombre (28/11/2026)
- Cycle de 00:10 UTC : `infinity: 11`, `blueprints: 0`. Trois causes : (1) seuil d'intérêt unique de 75, que les abstracts arXiv (sans likes ni format thread) dépassent rarement ; (2) conservation des posts ∞ limitée à 7 jours alors que le flux arXiv couvre ~3 semaines : la plupart des abstracts étaient effacés juste après avoir été comptés ; (3) les 3 abstracts à 78 avaient bien été envoyés à Groq à 23:24 UTC, mais qwen3.8 a répondu `{"none":true}` (prompt écrit pour « une idée postée sur X ») et ce rejet était silencieux.
- Correctifs : seuil arXiv 60 (X reste à 75), conservation 21 jours, prompt v2 qui demande d'approcher le signal central d'un article par les blocs connus, `{"none":true}` de qwen3.8 → gpt-oss-120b essayé, posts écartés par le prompt v1 réessayés une fois, et chaque échec ou rejet (modèle par modèle) tracé dans `x.notes`. En réel sur arXiv : 13 abstracts sur 15 au seuil (contre 3).
- `scripts/blueprint_smoke.mjs` : test réel de bout en bout (arXiv → Groq → validateur → Division 1) sans rien écrire dans `data/` ; il demande `GROQ_API_KEY`.
- `gemini-3.8-flash` en ombre (HTTP 429 en 210 ms) : votants gpt-oss-120b et qwen3.8 (quorum 2 inchangé), arbitre gemma-4-26b. Les échecs des modèles ombre vont dans `ai.shadowErrors`, plus dans `problems`.

### Refonte de l'interface (28/11/2026)
- Direction « terminal quantitatif épuré » : fonds pleins, bordures de 1 px, plus de halos ni de lueurs, palette et graphiques harmonisés (bloc final de `public/app.css`).
- Doublons supprimés : la vue d'ensemble ne recopie plus Directions, Signaux d'edge, À la une ni le flux ; « comptes net short » et les notionnels n'apparaissent qu'à un endroit ; la fraîcheur des données n'est plus affichée qu'une fois dans le rail (détail par source dans un tiroir).
- 4 indicateurs au plus en tête de chaque onglet ; 6 colonnes au plus par tableau ; Paper trading : une ligne par décision (votes dépliables) au lieu d'un tableau par candidat ; Macro : un tableau par famille au lieu de 27 tuiles.
- `Tidy` (`public/core.js`) : sur toutes les pages, colonnes numériques alignées à droite en chiffres tabulaires, cellules longues coupées sur une ligne avec infobulle, « Voir plus » au-delà de 15 lignes ; notes de méthode et détails techniques dans des tiroirs fermés ; badges communs (`tag`).

### Mise en service (à faire)

1. Ajouter `GROQ_API_KEY` dans les secrets du dépôt.
2. Vérifier les identifiants de modèles de `lib/paper/router.mjs` (ou les remplacer par la variable `PAPER_LLM_PROVIDERS`).
3. Fusionner la branche `feat/paper-trading`, puis lancer « Agent de paper trading » à la main dans l'onglet Actions et lire le résumé du cycle.
4. Créer la tâche Claude planifiée pour la poche Border (`scripts/border_prompt.md`).
5. Premiers vrais votes : vérifier dans `model_votes.jsonl` que les modèles respectent le format et citent bien les métriques.
