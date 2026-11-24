# Tâche planifiée « Border » (Claude, 3 à 4 fois par jour)

Instructions à donner à la tâche Claude planifiée qui alimente la poche Border de l'agent de paper trading (voir `SPEC.md` §1 et §2, `lib/paper/border.mjs`).

## Mission

Chercher dans l'actualité du jour 0 à 3 thèses **non consensuelles** avec un **catalyseur daté** (décision de banque centrale, vote, publication de données, échéance d'un ultimatum, livraison, audience…), dont le marché sous-estime nettement la probabilité. Ne rien proposer plutôt que proposer une idée faible.

Chaque thèse doit être jouable :

- soit sur **Polymarket** : un marché ouvert dont l'option visée coûte **0,25 $ au plus** (gain/risque ≥ 3) ;
- soit sur **Hyperliquid** : un actif coté (marché principal ou dex `xyz`, par exemple `xyz:CL`, `xyz:GOLD`, `BTC`) avec un objectif de prix au moins **3 fois** plus loin que le stop (stop = 2 × ATR quotidien, borné entre 3 et 15 %).

Le moteur refusera seul toute proposition hors de ces bornes, et les trois modèles votants peuvent rejeter l'idée. Il est donc inutile de forcer.

## Sortie

Écrire **uniquement** le fichier `border_proposals.json` à la racine de la branche `border` du dépôt (branche orpheline qui ne contient que ce fichier), puis pousser cette branche. Ne jamais toucher aux branches `main` et `state`.

```json
{
  "updatedAt": "2026-11-24T08:00:00Z",
  "proposals": [
    {
      "id": "2026-11-24-opep-coupe",
      "createdAt": "2026-11-24T08:00:00Z",
      "venue": "pm",
      "thesis": "20 à 1000 caractères : pourquoi le marché se trompe, avec les faits vérifiés.",
      "catalyst": "Réunion OPEP+ du 30 novembre",
      "catalystAt": "2026-11-30T14:00:00Z",
      "conviction": 70,
      "sources": ["https://…", "https://…"],
      "pm": { "cid": "0x…", "token": "<token_id de l'option visée>", "outcome": "Yes", "title": "<question exacte du marché>" }
    },
    {
      "id": "2026-11-24-or-short",
      "createdAt": "2026-11-24T08:00:00Z",
      "venue": "hl",
      "thesis": "…",
      "catalyst": "Publication du CPI américain",
      "catalystAt": "2026-12-10T13:30:00Z",
      "conviction": 65,
      "sources": ["https://…"],
      "hl": { "coin": "xyz:GOLD", "side": "short", "targetPx": 3400 }
    }
  ]
}
```

Règles :

- `id` unique et stable (une proposition déjà votée n'est jamais revotée, même si elle reste dans le fichier).
- `catalystAt` dans le futur et à 90 jours au plus : c'est la date de clôture automatique de la position.
- Une proposition de plus de 24 h est ignorée : réécrire le fichier entier à chaque passage, avec seulement les idées du jour.
- `cid` et `token` se trouvent avec l'API Gamma de Polymarket (`https://gamma-api.polymarket.com/markets?slug=…` : champs `conditionId` et `clobTokenIds`, dans l'ordre des `outcomes`).
- Au moins une source vérifiable par thèse ; pas de rumeur non sourcée.
