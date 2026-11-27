"""Lanceur de twitter-cli pour la collecte X de l'agent de paper trading (lib/paper/x_scraper.mjs).

Mêmes arguments que la commande `twitter` (ex. : search "<q>" -t Latest --max 40 --json), même sortie JSON sur stdout.
Il corrige deux ruptures de twitter-cli 0.8.5 dues au nouveau frontend de x.com (HTTP 404 au corps vide) :

1. En-tête x-client-transaction-id : twitter-cli le calcule à partir du script « ondemand.s » référencé par la page
   d'accueil, qu'il charge SANS cookies. Sans session, x.com sert désormais le frontend « x-web » (entry-client-logged-out),
   qui ne référence plus ce script : l'en-tête manque et X répond 404. Ici, la page est chargée AVEC les cookies de session
   (frontend connecté), puis le cache que twitter-cli relit (~/.twitter-cli/transaction_cache.json, 1 h) est préparé.
2. queryId GraphQL (SearchTimeline, UserTweets, HomeTimeline, ListLatestTweetsTimeline…) : identifiants à jour lus dans les
   bundles du frontend connecté, puis dans le fichier communautaire fa0311/twitter-openapi, puis ceux codés dans le paquet ;
   sur 404/422, chaque identifiant est essayé en GET puis en POST.

`python scripts/x_twitter.py --diagnose` affiche l'état (en-tête de transaction, queryId retenus) sans faire de recherche.
Les cookies (TWITTER_AUTH_TOKEN, TWITTER_CT0) ne sont jamais affichés ; les messages de diagnostic vont sur stderr.
"""
import json
import logging
import os
import re
import sys
import time

import bs4
from twitter_cli import client as tc
from twitter_cli import graphql as gq
from twitter_cli.constants import get_user_agent
from twitter_cli.exceptions import TwitterAPIError
from x_client_transaction import ClientTransaction
from x_client_transaction.utils import get_ondemand_file_url

STATE_DIR = os.path.join(os.path.expanduser("~"), ".twitter-cli")
QID_CACHE = os.path.join(STATE_DIR, "x_query_ids.json")
# Mémoire entre les appels d'un même cycle (chaque recherche est un processus) : combinaison qui a marché, ou échec total.
# Sans elle, chaque recherche réessaierait toutes les combinaisons en échec et X finirait par répondre 429.
WORKED = os.path.join(STATE_DIR, "x_query_ok.json")
OPS = ["SearchTimeline", "UserTweets", "HomeTimeline", "ListLatestTweetsTimeline", "UserByScreenName"]
TTL_S = 50 * 60


def log(msg):
    print("[x_twitter] " + msg, file=sys.stderr)


def _fresh(path):
    try:
        with open(path, encoding="utf-8") as f:
            return time.time() - json.load(f).get("created_at", 0) < TTL_S
    except Exception:
        return False


def _page_headers(with_cookies):
    h = {"user-agent": get_user_agent(), "accept": "text/html,application/xhtml+xml,*/*;q=0.8", "accept-language": "en-US,en;q=0.9"}
    tok, ct0 = os.environ.get("TWITTER_AUTH_TOKEN", ""), os.environ.get("TWITTER_CT0", "")
    if with_cookies and tok and ct0:
        h["cookie"] = "auth_token=%s; ct0=%s" % (tok, ct0)
    return h


def logged_in_home():
    """Page d'accueil du frontend connecté (celle qui référence encore ondemand.s), ou (None, raison)."""
    session = tc._get_cffi_session()
    reason = "aucune page"
    for url in ("https://x.com/home", "https://x.com/"):
        try:
            r = session.get(url, headers=_page_headers(True), timeout=20)
            if r.status_code == 200 and "ondemand.s" in r.text:
                return r.text, url
            reason = "HTTP %d sans ondemand.s (%s)" % (r.status_code, "x-web" if "entry-client" in r.text else "frontend inconnu")
        except Exception as exc:  # réseau
            reason = str(exc)[:120]
    return None, reason


def prepare_transaction(html, why):
    path = tc.TwitterClient._ct_cache_path()
    if _fresh(path):
        return "cache valide"
    if not html:
        return "échec : %s" % why
    try:
        soup = bs4.BeautifulSoup(html, "html.parser")
        ondemand = tc._get_cffi_session().get(get_ondemand_file_url(response=soup), headers=_page_headers(False), timeout=20).text
        ClientTransaction(home_page_response=soup, ondemand_file_response=ondemand)   # valide avant d'écrire le cache
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"home_html": html, "ondemand_text": ondemand, "created_at": time.time()}, f)
        return "ok (frontend connecté)"
    except Exception as exc:
        return "échec : %s" % str(exc)[:160]


def scan_bundles(html):
    found = {}
    urls = re.findall(r'(?:src|href)=["\'](https://abs\.twimg\.com/responsive-web/client-web[^"\']+\.js)["\']', html or "")
    session = tc._get_cffi_session()
    for url in urls:
        try:
            js = session.get(url, headers=_page_headers(False), timeout=20).text
        except Exception:
            continue
        for m in re.finditer(r'queryId:\s*"([A-Za-z0-9_-]+)"[^}]{0,200}operationName:\s*"([^"]+)"', js):
            found.setdefault(m.group(2), m.group(1))
    return found


def community_ids():
    try:
        data = json.loads(tc._url_fetch(gq.TWITTER_OPENAPI_URL))
        return {k: v["queryId"] for k, v in data.items() if isinstance(v, dict) and isinstance(v.get("queryId"), str)}
    except Exception as exc:
        log("fa0311/twitter-openapi indisponible : %s" % str(exc)[:120])
        return {}


def query_ids(html):
    """{ opération : [queryId à essayer dans l'ordre] } : bundles connectés, communauté, paquet."""
    if _fresh(QID_CACHE):
        with open(QID_CACHE, encoding="utf-8") as f:
            return json.load(f)["ids"]
    live, comm = scan_bundles(html), community_ids()
    ids = {}
    for op in set(live) | set(comm) | set(gq.FALLBACK_QUERY_IDS):
        seen = []
        for q in (live.get(op), comm.get(op), gq.FALLBACK_QUERY_IDS.get(op)):
            if q and q not in seen:
                seen.append(q)
        ids[op] = seen
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(QID_CACHE, "w", encoding="utf-8") as f:
        json.dump({"created_at": time.time(), "ids": ids, "sources": {"bundles": len(live), "communaute": len(comm)}}, f)
    return ids


def _memory():
    try:
        with open(WORKED, encoding="utf-8") as f:
            m = json.load(f)
        return m if time.time() - m.get("created_at", 0) < TTL_S else {}
    except Exception:
        return {}


def _remember(op, value):
    m = _memory()
    m[op] = value
    m.setdefault("created_at", time.time())
    os.makedirs(STATE_DIR, exist_ok=True)
    with open(WORKED, "w", encoding="utf-8") as f:
        json.dump(m, f)


def install(ids):
    """Remplace la requête GraphQL de twitter-cli : chaque queryId candidat, en GET puis en POST, jusqu'à une réponse."""
    def graphql_get(self, operation_name, variables, features, field_toggles=None):
        cands = ids.get(operation_name) or [gq._resolve_query_id(operation_name, prefer_fallback=True, url_fetch_fn=tc._url_fetch)]
        known = _memory().get(operation_name)
        if known == "échec":
            log("%s : toutes les combinaisons ont échoué il y a moins de 50 min, pas de nouvel essai" % operation_name)
            raise TwitterAPIError(404, "Twitter API error 404: queryId et en-tête de transaction refusés (déjà constaté)")
        combos = [(q, m) for q in cands for m in ("GET", "POST")]
        if isinstance(known, list) and tuple(known) in combos:
            combos.remove(tuple(known))
            combos.insert(0, tuple(known))
        last = None
        for qid, method in combos:
            try:
                if method == "GET":
                    out = self._api_get(gq._build_graphql_url(qid, operation_name, variables, features, field_toggles))
                else:
                    body = {"variables": variables, "features": {k: v for k, v in features.items() if v is not False}, "queryId": qid}
                    if field_toggles:
                        body["fieldToggles"] = field_toggles
                    out = self._api_request("https://x.com/i/api/graphql/%s/%s" % (qid, operation_name), method="POST", body=body)
                if (qid, method) != (cands[0], "GET"):
                    log("%s : réponse avec le queryId %s en %s" % (operation_name, qid, method))
                if known != [qid, method]:
                    _remember(operation_name, [qid, method])
                return out
            except TwitterAPIError as exc:
                if exc.status_code not in (404, 422):
                    raise
                last = exc
        log("%s : HTTP 404/422 pour tous les queryId essayés (%s)" % (operation_name, ", ".join(cands)))
        _remember(operation_name, "échec")
        raise last

    tc.TwitterClient._graphql_get = graphql_get


def main(argv):
    logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
    diagnose = "--diagnose" in argv
    ct_path = tc.TwitterClient._ct_cache_path()
    html, why = (None, "cache") if (_fresh(ct_path) and _fresh(QID_CACHE)) else logged_in_home()
    ct = prepare_transaction(html, why)
    ids = query_ids(html)
    log("x-client-transaction-id : %s ; SearchTimeline : %s" % (ct, ", ".join(ids.get("SearchTimeline", [])) or "aucun"))
    if diagnose:
        print(json.dumps({"transaction": ct, "frontend": why if html else None, "queryIds": {op: ids.get(op, []) for op in OPS}}, ensure_ascii=False, indent=1))
        return 0 if ct.startswith(("ok", "cache")) else 1
    install(ids)
    from twitter_cli.cli import cli
    return cli.main(args=argv, prog_name="twitter", standalone_mode=True)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
