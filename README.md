# Boussole des baleines

## Mise en ligne gratuite (GitHub Pages)

Le dépôt contient tout pour publier le site gratuitement, sans ordinateur allumé : GitHub collecte les données toutes les 10 à 20 minutes et met la page à jour. Le lien est public et s'ouvre sur ordinateur, tablette ou téléphone.

1. Créez un compte sur github.com, puis un dépôt **public** (par exemple `boussole`). Un dépôt public est nécessaire pour que tout reste gratuit.
2. Envoyez-y tous les fichiers de ce dossier, **y compris le dossier caché `.github`** (avec GitHub Desktop, ou `git push`).
3. Dans le dépôt : **Settings → Pages → Source : GitHub Actions**.
4. Dans le dépôt : **Settings → Actions → General → Workflow permissions : Read and write permissions**.
5. Onglet **Actions → Mise à jour des données → Run workflow** pour la première publication (environ 1 minute).
6. Le site est à l'adresse `https://VOTRE-NOM.github.io/boussole/`.

Une fois en ligne, la page travaille en deux temps :
- **En direct, depuis le navigateur** : prix, funding et open interest toutes les 20 s, positions des 100 comptes Hyperliquid toutes les 45 s, avec la carte des liquidations et le flux des mouvements. À l'ouverture, la page compare les positions en direct avec la dernière collecte GitHub et affiche tout de suite ce qui a bougé entre-temps (étiquette « depuis la dernière collecte »).
- **Toutes les 10 à 20 minutes, par GitHub** : macro, hedge funds, options, actualités, calendrier, globe, Polymarket, sentiment, directions et signaux d'edge. La page relit ces analyses toute seule chaque minute.

Le direct se met en pause quand l'onglet est caché, pour économiser la batterie. L'historique et le flux d'activité sont conservés dans la branche `state`.

Limites : GitHub espace parfois les exécutions planifiées (jusqu'à 20 à 30 minutes aux heures chargées), et désactive les tâches planifiées d'un dépôt sans activité pendant 60 jours (un e-mail prévient, un clic les réactive). L'actualité « au clic » sur les pays non préchargés et le chargement des comptes Hyperliquid hors échantillon demandent la version locale.

Pour brancher X en ligne : **Settings → Secrets and variables → Actions**, ajoutez `X_BEARER_TOKEN` ou `TWITTERAPI_IO_KEY`.

## Version locale (en direct)

Site local qui suit les gros portefeuilles de **Hyperliquid** et de **Polymarket** et en tire un sentiment de marché.

## Lancer

```bash
cd whale-compass
node server.mjs        # Node 20 ou plus, aucune dépendance à installer
# puis ouvrir http://localhost:8787
```

Variables : `PORT` (8787), `HL_COHORT` (taille de l'échantillon Hyperliquid, 100 par défaut), `REFRESH_SCALE` (0.5 = rafraîchissement deux fois plus rapide).

L'historique et le flux d'activité sont conservés dans `data/` et survivent à un redémarrage.

## Quant Vault (page annexe)

Le bouton cadenas « 🔒 QUANT VAULT » bascule, sans rechargement, vers un laboratoire de recherche. Un en-tête unique et mince porte les onglets ; chaque graphique occupe toute la hauteur, avec un mode mosaïque et un bouton plein écran par graphique.

- **Outils 1 à 7** : Sankey capital → facteurs → CVaR, frontière efficiente 3D, paysage de robustesse, arbre couvrant minimal avec contagion, bascule de corrélation, cônes à sauts (Bates), surface de bêta conditionnel.
- **Outil 11, Facteurs cachés** : retrait des facteurs évidents par régression, covariance des résidus débruitée (Marchenko-Pastur ou Ledoit-Wolf), ACP, corrélations partielles, part du risque caché du portefeuille. Source au choix : simulation ou cours réels Hyperliquid.
- **Outils 8 à 10** (laboratoire du mémoire) : ACP, modèle à facteurs dynamiques par filtre de Kalman, bêtas dynamiques, Fama-MacBeth avec Newey-West, test GRS, Factor-GJR-GARCH, Kupiec. Export CSV et JSON.

**Important** : sauf l'option « cours réels » de l'outil 11, ce laboratoire tourne sur un modèle stylisé et des données simulées (graine fixe). La page n'est pas protégée : c'est une bascule d'affichage.

Les outils sont montés une seule fois puis masqués : leur état survit aux changements de vue. Les moteurs de données (`live.js`, `tape.js`, collecte) tournent indépendamment de l'affichage.

Fichiers : `q-model.js` (mathématiques), `q-canvas.js` (rendu 3D), `q-tools.js` (outils 1 à 7), `q-hidden.js` (outil 11), `q-thesis.js` (outils 8 à 10), `q-vault.js` (page, onglets, plein écran).

## Whale Tape

Page « Whale Tape » : toutes les transactions Polymarket d'au moins 10 000 $, relevées toutes les 30 secondes en une seule requête, plus les mouvements Hyperliquid des comptes suivis. Seuils 10 k, 25 k, 50 k (par défaut) et 100 k. Les **convergences** signalent une même issue achetée par plusieurs baleines. En cas de limite de débit, le moteur passe à un essai toutes les 10 minutes et continue d'afficher l'historique conservé dans le navigateur (24 h).

## Accès à l'API Polymarket

`public/pmapi.js` (navigateur) et `lib/pm.mjs` (collecte) passent par une file d'attente : 2 requêtes simultanées au plus, reprise avec délai exponentiel, pause générale après un refus. Côté navigateur, un cache de 45 s sert la réponse immédiatement puis la rafraîchit en arrière-plan, et les 15 plus grosses positions de chaque profil consulté sont gardées en mémoire locale.

## Inspecteur Polymarket

Un clic sur n'importe quel compte Polymarket ouvre sa fiche complète : valeur, PnL latent et réalisé, concentration, toutes les positions ouvertes (triables, filtrables), mouvements sur 7 jours, profil de risque. Les données sont lues en direct par le navigateur.

## Les pages (18)

Funding et open interest est intégré à « Prix et funding », l'historique à « Sentiment », les réseaux à « Infos et réseaux ».

**Synthèse**
- **Tableau de bord** : jauge de sentiment, directions par actif, signaux d'edge, à la une, convictions, radar des setups.
- **Directions** : une conclusion par actif (BTC, ETH, SOL, S&P 500, Nasdaq, or, pétrole, dollar) qui pèse tendance, baleines, hedge funds, options, macro et funding.
- **Signaux d'edge** : anomalies détectées en croisant les sources, plus les thermomètres alternatifs (peur/avidité, stablecoins, App Store, Wikipedia).

**Monde**
- **Globe** : globe 3D à faire tourner, 25 foyers de tension, séismes, clic sur un pays pour son actualité, ses chiffres clés et les paris liés.
- **Fil d'info** : dépêches étiquetées par thème et par actif touché.
- **Réseaux** : canaux Telegram, Truth Social, X (à brancher).
- **Calendrier** : publications économiques de la semaine.
- **Probabilités** : cotes Polymarket sur la politique, l'économie et la géopolitique, avec les cotes qui bougent.

**Institutionnel**
- **Macro** : régime de marché, courbe des taux, liquidité nette, inflation, emploi, crédit.
- **Marchés** : carte de chaleur multi-actifs, momentum, volatilité, corrélations.
- **Hedge funds** : positions des fonds sur les futures américains (rapport CFTC), centile sur 3 ans.
- **Options** : volatilité implicite, ratio puts/calls, écart put − call, max pain (Deribit).

**Baleines** : Hyperliquid, Polymarket, Sentiment croisé.

**Outils** : Flux en direct, Liquidations, Funding & OI, Historique, Calculateur.

## Brancher X (Twitter)

X n'offre plus d'accès public gratuit. Trois branchements au choix, par variable d'environnement :

```bash
X_BEARER_TOKEN=...      node server.mjs   # API officielle X
TWITTERAPI_IO_KEY=...   node server.mjs   # service tiers twitterapi.io
X_RSS_BASE=http://localhost:1200/twitter/user node server.mjs   # votre instance RSSHub ou Nitter
```

`X_ACCOUNTS` (liste séparée par des virgules) choisit les comptes suivis, `TELEGRAM_CHANNELS` les canaux Telegram.

## Bouton Actualiser

Le bouton en haut de la barre latérale recharge toutes les sources à la demande (`POST /api/refresh`) : prix et funding, classements, positions Hyperliquid et Polymarket. Il est limité à une fois toutes les 5 secondes, et l'âge des données s'affiche dessous (en orange quand elles vieillissent).

## Rafraîchissement automatique

| Donnée | Fréquence |
|---|---|
| Classement Hyperliquid (tous comptes) | 2 min |
| Positions Hyperliquid (échantillon) | 45 s |
| Prix, funding, open interest | 15 s |
| Classements Polymarket | 90 s |
| Positions Polymarket | 2,5 min |

Le navigateur reçoit les mises à jour par flux SSE (`/api/events`).

## Échantillon Hyperliquid

Comptes d'au moins 500 k$ de capital, actifs cette semaine, rentables sur le mois et sur toute la période, hors market makers (volume mensuel > 300 × capital). Score = 30 % PnL du mois, 20 % PnL total, 25 % rendement du mois, 25 % taille du compte. Réglages dans `lib/hl.mjs` (`selectCohort`).

## Limites à garder en tête

- Les positions Hyperliquid incluent le marché principal et le dex HIP-3 `xyz` (pétrole `CL`/`BRENTOIL`, or, indices, actions). Les autres dex HIP-3 ne sont pas lus.
- Sur Polymarket, le sens haussier/baissier d'un pari est **déduit du titre** (« above », « dip to », « Up »/« Down »…). C'est une heuristique, la liste des marchés cités est visible dans le détail de chaque actif. Les paris quasi résolus (prix > 95 % ou < 5 %) sont ignorés.
- Les catégories des marchés (onglet « marchés concentrés ») sont déduites par mots-clés dans le titre.
- Un échantillon de baleines n'est pas le marché entier, et un grand compte peut couvrir une position ailleurs. C'est un indicateur, pas un signal de trading.

## Instantané sans serveur

```bash
node scripts/snapshot.mjs      # écrit dist/snapshot.html avec les données du moment (interroge le serveur s'il tourne, sinon collecte directement)
```

## Sources complémentaires (toutes publiques, sans clé)

FRED (macro), CFTC (positions des fonds), Deribit (options), ForexFactory (calendrier), Google Actualités, Réserve fédérale, Telegram (aperçu web public), trumpstruth.org, Polymarket Gamma (cotes), Banque mondiale, USGS (séismes), Wikipedia (pages vues), App Store (classement), DefiLlama (stablecoins), alternative.me (peur et avidité).

La liste des foyers de tension du globe est une base éditoriale (`lib/world.mjs`) arrêtée à mi-2026 : modifiez-la librement. L'actualité associée est chargée en direct.

## Sources de base (API publiques, sans clé)

- `stats-data.hyperliquid.xyz/Mainnet/leaderboard`, `api.hyperliquid.xyz/info` (`clearinghouseState`)
- `data-api.polymarket.com/v2/leaderboard`, `/v2/positions`
