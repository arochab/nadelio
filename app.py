import base64
import datetime
import hashlib
import hmac
import html as _html
import http.client
import json
import logging
import math
import os
import pathlib
import random
import re
import secrets
import socket
import ssl
import tempfile
import threading
import time
import urllib.parse
import urllib.request

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="web", static_url_path="")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
# Public site URL. Single source of truth for every canonical / OG / share /
# user-agent URL so no deployment hostname is ever hard-coded twice. Override
# via env SITE_URL. Flip this to https://nadelio.com the moment the custom
# domain is verified live on Render; until then it stays on the Render URL so
# canonical/OG never point at a host that does not yet answer.
SITE_URL = os.environ.get("SITE_URL", "https://brandpulseapp.onrender.com").rstrip("/")

ZONE = "serpleadresearch"
SERP_ENDPOINT = "https://api.brightdata.com/request"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"  # cheapest model — minimal cost
# Model used ONLY for the identity-inference step (infer_strategy). Kept distinct
# from ANTHROPIC_MODEL so the identification call can be a stronger model without
# raising cost on the high-volume AI-visibility calls. Entity identification and
# disambiguation of obscure bare names (e.g. an unknown French SME sharing a name
# with a famous US company) benefit from a more capable model, so this defaults to
# Sonnet 5 — meaningfully better than Haiku at brand knowledge / disambiguation, at
# a reasonable cost since it runs at most once per audit. Override via env
# INFER_MODEL if needed. The 3 AI-visibility calls always use ANTHROPIC_MODEL
# (Haiku) to keep the per-audit volume cheap.
INFER_MODEL = os.environ.get("INFER_MODEL", "claude-sonnet-5")

MAX_LIVE_RUNS = int(os.environ.get("MAX_LIVE_RUNS", "15"))
LIVE_RUNS_PER_IP = int(os.environ.get("LIVE_RUNS_PER_IP", "3"))
MAX_BRANDS = 6
# Query depth. Free/demo runs stay at the cheapest possible sample (2 SERP
# calls); a "deep" run (future paid tier) widens the sample to 5 for a less
# noisy, more defensible read. MAX_QUERIES is kept as a backward-compatible
# alias equal to the free default so any older reference keeps working.
MAX_QUERIES_FREE = 2       # absolute minimum SERP calls — lowest cost (public default)
MAX_QUERIES_PAID = 5       # deep audit — wider, less noisy sample (paid tier)
MAX_QUERIES = MAX_QUERIES_FREE  # legacy alias — do not raise without checking cost model
MAX_BRAND_LEN = 100        # reject absurdly long brand names
MAX_CACHE_ENTRIES = 500    # cap in-memory + on-disk cache size

# Cost model (USD). Haiku is ~$1/M input, $5/M output; SERP ~ $0.0015/query.
LLM_COST_PER_CALL = 0.00012   # one Haiku call (strategy inference OR AI engine sim)
SERP_COST_PER_QUERY = 0.0015

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Live-run counter (thread-safe within one process)
# NOTE: gunicorn with >1 worker uses separate processes; each gets its own
# counter, so the effective global limit is MAX_LIVE_RUNS * num_workers.
# For a free-tier Render deploy (1 worker) this is fine.  Cross-process
# limiting would require Redis or a shared file lock.
#
# Both the global counter and the per-IP counters reset when the UTC date
# changes (a simple daily quota, no external scheduler needed).
# ---------------------------------------------------------------------------
_live_lock = threading.Lock()
_live_runs = 0
_live_runs_date = None  # UTC date (str) the counter above applies to
_ip_runs = {}  # {ip: [date_utc_str, count]}


def _today_utc():
    return datetime.datetime.now(datetime.timezone.utc).date().isoformat()


def _now_utc_iso():
    """Full UTC ISO-8601 instant (unlike _today_utc's bare date), used to
    stamp exactly when a measurement completed for real transparency
    (see /api/analyze's "measured_at" field)."""
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _client_ip():
    # X-Forwarded-For is a comma-separated hop chain the PROXY appends to as
    # the request passes through, Render's edge proxy appends the real
    # client IP as the LAST entry. The FIRST (leftmost) entry is whatever the
    # client itself sent in the header, so it is fully attacker-controlled: a
    # naive split(",")[0] (the previous behaviour here) let anyone spoof a
    # fresh identity on every request and walk straight through every
    # per-IP guard (free daily quota, /api/infer, /api/event, /api/share
    # rate limits). Render does not let client-supplied XFF hops survive
    # past its own edge, it appends, it never trusts what arrives, so the
    # rightmost hop is the one hop here we did not write ourselves.
    # https://render.com (platform forwards true client IP as the last
    # X-Forwarded-For entry; behind any OTHER proxy chain this assumption
    # would need revisiting).
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        hops = [h.strip() for h in fwd.split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.remote_addr or "unknown"

# ---------------------------------------------------------------------------
# Persistent cache
# ---------------------------------------------------------------------------
_CACHE_FILE = pathlib.Path(os.environ.get("CACHE_FILE", "cache.json"))


def _load_cache():
    try:
        return json.loads(_CACHE_FILE.read_text())
    except Exception:
        return {}


def _save_cache(c):
    try:
        tmp = _CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(c))
        os.replace(str(tmp), str(_CACHE_FILE))
    except Exception:
        logger.exception("Failed to write cache file %s", _CACHE_FILE)


_cache = _load_cache()  # persists across restarts — never re-pay for a brand

# ---------------------------------------------------------------------------
# Stripe Checkout (Deep Audit paywall) — implemented with urllib, no SDK
# ---------------------------------------------------------------------------
# The Deep Audit (5 SERP queries instead of the free 2) is a one-time paid
# unlock. We create a Stripe Checkout session server-side, redirect the buyer
# to Stripe's hosted page, and on return verify the payment server-side before
# ever running a deep analysis. Keys are read from the environment only — never
# hard-coded — so the app runs fine in dev/demo with Stripe unconfigured.
#
# ===========================================================================
# ANTI-REPLAY SECURITY MODEL (durable, zero-infra-cost)
# ===========================================================================
# ONE paid Stripe session == ONE deep audit. The hard problem is preventing a
# customer who already paid from replaying their own (real, paid) session_id to
# get extra deep audits for free. A previous version tracked consumed sessions
# only in a Python set in process memory, which is wiped on every Render free-
# tier restart/redeploy/sleep — so after a restart a paid session could be
# replayed. This version closes that hole WITHOUT any paid infra (no persistent
# disk, no Redis, no DB) using two independent, layered defenses:
#
#   DEFENSE 1 — Stripe is the durable source of truth (survives any restart).
#   ----------------------------------------------------------------------
#   When a deep audit is granted, we STAMP the consumption on the PaymentIntent
#   that backs the paid Checkout Session, by writing metadata[bp_consumed]=<unix
#   ts> via POST /v1/payment_intents/<id>. On every subsequent request we
#   RETRIEVE the session with expand[]=payment_intent and read back that stamp.
#   If bp_consumed is already present, the session is refused. Because the stamp
#   lives on Stripe's servers (not our dyno), it survives every restart,
#   redeploy and sleep at zero cost to us.
#
#   Why the PaymentIntent and not the Checkout Session itself: Stripe's docs
#   confirm PaymentIntent metadata is a mutable key/value store that can be
#   updated at any time via the update API (only the *Charge* receives a frozen
#   metadata snapshot at creation; the PaymentIntent object itself stays
#   editable). The PaymentIntent is a stable per-payment object we can expand
#   from the session in a single GET, so it is the natural durable anchor.
#
#   FAIL-CLOSED on the stamp write: if we cannot durably record consumption on
#   Stripe (network error, unexpected response), we DO NOT grant the deep audit.
#   Granting-then-failing-to-stamp is exactly the replay hole we are closing, so
#   an un-recordable grant is refused rather than given for free.
#
#   DEFENSE 2 — Time-boxed acceptance window (bounds any residual replay).
#   ----------------------------------------------------------------------
#   Independently of the stamp, a paid_session is only accepted within
#   PAID_SESSION_MAX_AGE_S seconds of session.created (a Stripe Unix timestamp,
#   also durable and restart-proof). The normal flow is: pay -> Stripe redirects
#   straight back -> audit runs within seconds. Legitimate use is well inside
#   the window; a stale session presented long after payment is refused even if
#   Defense 1 somehow did not apply. This alone bounds the worst-case replay
#   surface to a few minutes right after payment, and it composes with Defense 1
#   (both must pass).
#
#   The in-memory _consumed_sessions set is kept ONLY as a first-line cache to
#   short-circuit obvious same-process replays without a Stripe round-trip. It
#   is authoritative for NOTHING: after a restart it is empty, and the durable
#   Stripe stamp (Defense 1) plus the time window (Defense 2) still hold. The
#   truth is always re-derived from Stripe.
# ===========================================================================
STRIPE_API_BASE = "https://api.stripe.com/v1"

# Deep-audit metadata key stamped on the PaymentIntent once its paid session has
# been redeemed. Namespaced ("bp_") so it never collides with other metadata.
STRIPE_CONSUMED_META_KEY = "bp_consumed"

# Defense 2: how long after Stripe's session.created a paid_session stays
# redeemable. The pay->redirect->audit round-trip takes seconds; a generous
# window (default 30 min) covers slow networks / a brief pause on the success
# page while still refusing sessions replayed long after payment. Configurable
# so the window can be tightened/loosened without a code change.
PAID_SESSION_MAX_AGE_S = int(os.environ.get("PAID_SESSION_MAX_AGE_S", "1800"))


def _stripe_config():
    """Return (secret_key, price_id) from the environment, or (None, None) if
    either is missing. Payment endpoints treat a missing config as
    'payments not configured' rather than crashing."""
    return os.environ.get("STRIPE_SECRET_KEY"), os.environ.get("STRIPE_PRICE_ID")


def _stripe_auth_header(secret_key):
    """Stripe uses HTTP Basic auth with the secret key as the username and an
    empty password: base64("sk_...:"). Note the trailing colon."""
    token = base64.b64encode((secret_key + ":").encode()).decode()
    return "Basic " + token


def _stripe_request(method, path, secret_key, form=None):
    """Minimal Stripe API call over urllib. `form` is a dict serialized as
    application/x-www-form-urlencoded (Stripe's expected content type).
    Returns the parsed JSON dict. Raises RuntimeError on transport/HTTP error
    with a safe message (full detail is logged server-side, never leaked)."""
    url = STRIPE_API_BASE + path
    headers = {
        "Authorization": _stripe_auth_header(secret_key),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as he:
        detail = he.read().decode()[:300]
        logger.error("Stripe API HTTP %d on %s %s: %s", he.code, method, path, detail)
        raise RuntimeError("Stripe API returned an error (HTTP " + str(he.code) + ")")
    except urllib.error.URLError as ue:
        logger.error("Stripe API unreachable: %s", ue.reason)
        raise RuntimeError("Could not reach the Stripe API")
    except (json.JSONDecodeError, ValueError):
        logger.error("Stripe API returned non-JSON on %s %s", method, path)
        raise RuntimeError("Stripe API returned an unexpected response")


# First-line cache of session_id strings already redeemed IN THIS PROCESS
# (protected by _live_lock). NOT authoritative: it is empty after any restart.
# The durable truth is the Stripe PaymentIntent stamp (see security model above).
_consumed_sessions = set()


def _site_base():
    """Public base URL to build Stripe success/cancel URLs from. Prefer an
    explicit STRIPE_SUCCESS_URL_BASE (e.g. behind a proxy where request.host_url
    is wrong), else derive from the incoming request. Always returned without a
    trailing slash."""
    base = (os.environ.get("STRIPE_SUCCESS_URL_BASE") or request.host_url or "").strip()
    return base.rstrip("/")


def _inspect_paid_session(session_id):
    """Fetch a Checkout Session from Stripe (with its PaymentIntent expanded in
    the same round-trip) and return everything the paid gate needs to make a
    durable, restart-proof decision.

    Returns a dict:
        {
          "ok":          bool,   # real session AND payment_status == "paid"
          "brand":       str,    # from session metadata (never trusted from client)
          "created":     int,    # session.created — Stripe Unix ts (Defense 2)
          "pi_id":       str,    # PaymentIntent id backing this payment
          "consumed":    bool,   # durable Stripe stamp already present (Defense 1)
          "inspectable": bool,   # we successfully reached Stripe and parsed it
        }

    `inspectable` distinguishes "we checked Stripe and it says X" from "we could
    not reach/parse Stripe". Callers MUST fail closed when inspectable is False:
    an unverifiable session is never granted a deep audit. `ok` is only True when
    we positively confirmed the session is paid.
    """
    result = {"ok": False, "brand": "", "market": "", "created": 0, "pi_id": "",
              "consumed": False, "inspectable": False}
    secret_key, _ = _stripe_config()
    if not secret_key or not session_id:
        return result
    try:
        # expand[]=payment_intent inlines the full PaymentIntent object so we
        # read its durable bp_consumed stamp without a second round-trip.
        session = _stripe_request(
            "GET",
            "/checkout/sessions/" + urllib.parse.quote(str(session_id), safe="")
            + "?expand[]=payment_intent",
            secret_key,
        )
    except RuntimeError:
        return result  # inspectable stays False -> caller fails closed

    result["inspectable"] = True
    try:
        result["created"] = int(session.get("created") or 0)
    except (TypeError, ValueError):
        result["created"] = 0

    meta = session.get("metadata") or {}
    if isinstance(meta, dict):
        result["brand"] = str(meta.get("brand") or "").strip()
        # The free preview's market (stamped at /api/checkout time, see
        # api_checkout) - returned so a resumed paid deep audit can force the
        # SAME market instead of silently re-inferring a different one.
        result["market"] = str(meta.get("market") or "").strip()

    # The expanded PaymentIntent is where the durable consumption stamp lives.
    pi = session.get("payment_intent")
    if isinstance(pi, dict):
        result["pi_id"] = str(pi.get("id") or "")
        pi_meta = pi.get("metadata") or {}
        if isinstance(pi_meta, dict) and str(pi_meta.get(STRIPE_CONSUMED_META_KEY) or "").strip():
            result["consumed"] = True
    elif isinstance(pi, str):
        # Not expanded for some reason: keep the id so we can still stamp it,
        # but we could not read the stamp -> treat consumption as UNKNOWN, and
        # since we default consumed=False the caller relies on the atomic stamp
        # write (which is conditional/observable) plus the memory cache.
        result["pi_id"] = pi

    result["ok"] = session.get("payment_status") == "paid"
    return result


def _mark_session_consumed_on_stripe(pi_id):
    """DURABLY record that this payment's single deep audit has been redeemed, by
    stamping metadata[bp_consumed]=<unix ts> on the PaymentIntent. This is the
    restart-proof anti-replay record (Defense 1): it lives on Stripe, so it
    survives any dyno restart/redeploy/sleep at zero infra cost.

    Returns True only if Stripe acknowledged the write with the stamp present in
    the response. Returns False on any error or unexpected response. Callers MUST
    fail closed on False: if we cannot durably record consumption, we must not
    grant the deep audit (otherwise the grant would be replayable — the exact
    hole we are closing)."""
    secret_key, _ = _stripe_config()
    if not secret_key or not pi_id:
        return False
    stamp = str(int(time.time()))
    try:
        pi = _stripe_request(
            "POST", "/payment_intents/" + urllib.parse.quote(str(pi_id), safe=""),
            secret_key,
            form={"metadata[" + STRIPE_CONSUMED_META_KEY + "]": stamp},
        )
    except RuntimeError:
        logger.error("Could not stamp bp_consumed on PaymentIntent %s (fail-closed)", pi_id)
        return False
    meta = pi.get("metadata") or {}
    ok = isinstance(meta, dict) and str(meta.get(STRIPE_CONSUMED_META_KEY) or "").strip() == stamp
    if not ok:
        logger.error("Stripe did not persist bp_consumed on PaymentIntent %s", pi_id)
    return ok


def _unmark_session_consumed_on_stripe(pi_id):
    """Best-effort DURABLE rollback of the consumption stamp, by unsetting
    metadata[bp_consumed] on the PaymentIntent (Stripe unsets a key when its
    value is empty). Used only when a paid deep audit FAILED before producing a
    result, so the paying customer can retry without losing their single unlock.

    Fail-safe direction: if this rollback cannot be persisted, the worst case is
    the customer must re-run within the time window and finds the session marked
    consumed — i.e. we err toward NOT over-refunding audits, never toward
    granting an extra one. Returns True on confirmed unset, False otherwise."""
    secret_key, _ = _stripe_config()
    if not secret_key or not pi_id:
        return False
    try:
        pi = _stripe_request(
            "POST", "/payment_intents/" + urllib.parse.quote(str(pi_id), safe=""),
            secret_key,
            form={"metadata[" + STRIPE_CONSUMED_META_KEY + "]": ""},  # empty => unset
        )
    except RuntimeError:
        logger.error("Could not roll back bp_consumed on PaymentIntent %s", pi_id)
        return False
    meta = pi.get("metadata") or {}
    return not (isinstance(meta, dict) and str(meta.get(STRIPE_CONSUMED_META_KEY) or "").strip())


def _verify_paid_session(session_id):
    """Back-compat wrapper: return (ok, brand, market) for a real, fully-paid
    session. Used by /api/verify-payment, which only reports payment status
    and does NOT consume the unlock. Deep-audit authorization/consumption
    goes through _resolve_paid_depth(), which uses the richer
    _inspect_paid_session()."""
    info = _inspect_paid_session(session_id)
    return info["ok"], info["brand"], info["market"]


# ---------------------------------------------------------------------------
# Security / production headers
# ---------------------------------------------------------------------------
@app.after_request
def set_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    # HSTS: only effective over HTTPS (Render enforces HTTPS)
    response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    # /v2.html and /index.html are reachable verbatim through Flask's raw
    # static handler (static_folder="web", static_url_path=""), bypassing the
    # asset-version stamping and no-cache header that ONLY the "/" and "/v2"
    # routes apply (see _load_v2_html / _ASSET_VERSION above). Left alone, a
    # visitor landing on either literal URL keeps Flask's default conditional
    # (ETag) caching, so across a deploy they can pair a FRESH cached html with
    # a STALE cached nadelio.js, or the reverse, exactly the silent pairing
    # mismatch the stamping was added to prevent. Force the same no-cache
    # policy on these two raw paths so a browser always revalidates instead of
    # risking a mismatched pair. This does not touch caching for any other
    # static asset (fonts, vendor scripts, /assets/*).
    if request.path in ("/v2.html", "/index.html"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


# ---------------------------------------------------------------------------
# Demo data: what the pipeline produces for "Notion", precomputed
# ---------------------------------------------------------------------------
SAMPLE = {
  "brand": "Notion",
  "sector": "Productivity & project management software",
  "queries": ["best project management tool", "notion alternative"],
  "ranking": [
    {"brand":"Notion","query_coverage":"2/2","avg_rank":2.0,"share_of_voice":33.3,
     "cells":{"best project management tool":{"rank":3,"title":"Notion - The all-in-one workspace","link":"https://notion.so"},
              "notion alternative":{"rank":1,"title":"Notion vs the rest","link":"https://notion.so/compare"}},
     "ai_cells":{"best project management tool":{"rank":1},"notion alternative":{"rank":1}},
     "ai_coverage":"2/2","ai_avg_rank":1.0,
     "evidence":[{"title":"Notion - The all-in-one workspace","link":"https://notion.so","query":"best project management tool","rank":3}]},
    {"brand":"Asana","query_coverage":"1/2","avg_rank":2.0,"share_of_voice":16.7,
     "cells":{"best project management tool":{"rank":2,"title":"Asana: Manage your team's work","link":"https://asana.com"}},
     "ai_cells":{"best project management tool":{"rank":2}},
     "ai_coverage":"1/2","ai_avg_rank":2.0,
     "evidence":[{"title":"Asana: Manage your team's work","link":"https://asana.com","query":"best project management tool","rank":2}]},
    {"brand":"ClickUp","query_coverage":"1/2","avg_rank":4.0,"share_of_voice":16.7,
     "cells":{"best project management tool":{"rank":4,"title":"ClickUp - One app to replace them all","link":"https://clickup.com"}},
     "ai_cells":{"best project management tool":{"rank":3}},
     "ai_coverage":"1/2","ai_avg_rank":3.0,
     "evidence":[{"title":"ClickUp - One app to replace them all","link":"https://clickup.com","query":"best project management tool","rank":4}]},
    {"brand":"Obsidian","query_coverage":"1/2","avg_rank":2.0,"share_of_voice":16.7,
     "cells":{"notion alternative":{"rank":2,"title":"Obsidian - Sharpen your thinking","link":"https://obsidian.md"}},
     "ai_cells":{"notion alternative":{"rank":2}},
     "ai_coverage":"1/2","ai_avg_rank":2.0,
     "evidence":[{"title":"Obsidian - Sharpen your thinking","link":"https://obsidian.md","query":"notion alternative","rank":2}]},
    {"brand":"Coda","query_coverage":"1/2","avg_rank":6.0,"share_of_voice":16.7,
     "cells":{"notion alternative":{"rank":6,"title":"Coda: Your all-in-one workspace","link":"https://coda.io"}},
     "ai_cells":{"notion alternative":{"rank":3}},
     "ai_coverage":"1/2","ai_avg_rank":3.0,
     "evidence":[{"title":"Coda: Your all-in-one workspace","link":"https://coda.io","query":"notion alternative","rank":6}]}
  ],
  "mode":"demo",
  # The sample must demo the WHOLE product, bounds included: a naked score in
  # the demo contradicts the "never a number without its margin" promise the
  # plan chips make before the click. 78 matches what the client-side
  # computeGeoScore derives from this ranking, so every surface agrees.
  "geo_score":78,
  "geo":{"point":78,"half_width":4,"low":74,"high":82,"n":3,"verdict":"STABLE"},
  # The rival's bounded score too: the anti-noise head-to-head ("the gap is not
  # noise") is the product's moat and must be IN the shop window, not only on
  # real runs. Disjoint from Notion's band, so the demo shows a real lead.
  "geo_rival":{"brand":"Asana","point":52,"half_width":6,"low":46,"high":58,"n":3,"verdict":"STABLE"},
  "ai_provider":"claude",
  "ai_provider_label":"Claude",
  # Landscape mirrors what analyze(return_landscape=True) yields on a real run:
  # who owns the floor beyond the tracked brands. The demo must show it too.
  # Landscape ranks live in the SAME SERP as the tracked cells: a landscape
  # rank may never collide with a tracked rank on the same query, and when no
  # tracked brand holds #1 the line must open on the #1 owner. Tracked here:
  # q1 Asana #2 / Notion #3 / ClickUp #4 (free: #1, #5, #7), q2 Notion #1 /
  # Obsidian #2 / Coda #6 (free: #3, #4).
  "serp_landscape":{
    "owners":[{"host":"zapier.com","hits":2,"best_rank":1},
              {"host":"reddit.com","hits":2,"best_rank":4},
              {"host":"pcmag.com","hits":1,"best_rank":5}],
    "queries":{
      "best project management tool":[
        {"rank":1,"host":"zapier.com","title":"The best project management software in 2026","link":"https://zapier.com/blog/best-project-management-software/"},
        {"rank":5,"host":"pcmag.com","title":"The Best Project Management Software for 2026","link":"https://www.pcmag.com/picks/the-best-project-management-software"},
        {"rank":7,"host":"reddit.com","title":"What project management tool do you actually use?","link":"https://www.reddit.com/r/projectmanagement/"}],
      "notion alternative":[
        {"rank":3,"host":"zapier.com","title":"The 8 best Notion alternatives","link":"https://zapier.com/blog/notion-alternatives/"},
        {"rank":4,"host":"reddit.com","title":"Best Notion alternative in 2026?","link":"https://www.reddit.com/r/Notion/"}]}},
  "cost":0.00312
}

# ---------------------------------------------------------------------------
# Resilient HTTP helper — retries transient failures (rate-limit / overload /
# server errors / network hiccups) with a short exponential backoff, so a
# single flaky upstream call doesn't tank an entire analysis. Non-transient
# errors (bad request, auth, not found) are never retried — they won't fix
# themselves and should surface immediately.
# ---------------------------------------------------------------------------
_TRANSIENT_HTTP_CODES = {429, 500, 502, 503, 529}


def _urlopen_json_with_retry(req, timeout, max_attempts=3, what="upstream API"):
    """POST/GET via urllib.request.urlopen(req, timeout=timeout) and return the
    parsed JSON body. Retries transient failures (HTTP 429/500/502/503/529,
    URLError, socket.timeout) up to max_attempts times with a short exponential
    backoff + jitter (0.5s, 1.5s, ...). Non-transient HTTPErrors (400/401/403/
    404/422/...) are raised immediately without retrying. After exhausting
    retries on a transient error, raises a clear RuntimeError.

    `what` is only used to label log lines / the final error message (e.g.
    "Claude API", "Bright Data")."""
    last_detail = ""
    last_code = None
    for attempt in range(1, max_attempts + 1):
        body = None
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = resp.read().decode()
        except urllib.error.HTTPError as he:
            code = he.code
            detail = he.read().decode(errors="replace")[:300]
            if code not in _TRANSIENT_HTTP_CODES:
                logger.error("%s HTTP %d (non-retryable): %s", what, code, detail)
                raise RuntimeError(what + " returned an error (HTTP " + str(code) + ")")
            last_code, last_detail = code, detail
        except (urllib.error.URLError, socket.timeout) as ue:
            reason = getattr(ue, "reason", ue)
            last_code, last_detail = None, str(reason)

        if body is not None:
            try:
                return json.loads(body)
            except (json.JSONDecodeError, ValueError):
                # An HTTP 200 whose body is not JSON (Bright Data sometimes
                # answers a block page or an empty body with a 200) is exactly
                # as transient as a 502, and used to kill a whole multi-query
                # audit on the FIRST occurrence with zero retries: json.loads
                # raised outside the retry clauses. It caused a prod outage on
                # 17 July 2026 (every audit fell back to the demo sample while
                # a direct call of the very same query succeeded seconds
                # later). Retry it like any other transient failure.
                last_code, last_detail = 200, "non-JSON 200 body: " + body[:200]

        if attempt < max_attempts:
            logger.warning(
                "%s transient error (attempt %d/%d, code=%s): %s — retrying",
                what, attempt, max_attempts, last_code, last_detail,
            )
            backoff = 0.5 * (3 ** (attempt - 1))  # 0.5s, 1.5s, 4.5s, ...
            time.sleep(backoff + random.uniform(0, 0.25))
        else:
            logger.error(
                "%s still failing after %d attempts (code=%s): %s",
                what, max_attempts, last_code, last_detail,
            )

    raise RuntimeError(what + " temporarily unavailable after " + str(max_attempts) + " attempts")


def _anthropic_message(model, max_tokens, prompt, api_key, timeout=40,
                       what="Claude API", temperature=None):
    """One NON-THINKING Anthropic Messages call. Returns (text, stop_reason).

    thinking is explicitly disabled because Claude 5 models reason ADAPTIVELY
    by default and the thinking block spends from max_tokens: on a 500-token
    budget the model could burn 400+ tokens thinking and return a JSON object
    cut mid-array, which surfaced to users as "Claude did not return valid
    JSON for this brand" (Carglass, 2026-07-09). Every call in this app wants
    a cheap, complete, machine-parseable reply — never visible reasoning."""
    payload = {
        "model": model,
        "max_tokens": max_tokens,
        "thinking": {"type": "disabled"},
        "messages": [{"role": "user", "content": prompt}],
    }
    if temperature is not None:
        payload["temperature"] = temperature
    req = urllib.request.Request(
        ANTHROPIC_ENDPOINT, data=json.dumps(payload).encode(),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    data = _urlopen_json_with_retry(req, timeout=timeout, what=what)
    text = "".join(b.get("text", "") for b in data.get("content", []))
    return text, data.get("stop_reason", "")


# ---------------------------------------------------------------------------
# Step 1: Claude infers sector, competitors, queries from a single brand
# ---------------------------------------------------------------------------
# Human-readable labels for the market presets the caller can force. Anything
# not in this map (or None) means "let the model infer the market".
_MARKET_PRESETS = {
    "fr": "France (French-speaking market)",
    "france": "France (French-speaking market)",
    "de": "DACH (German-speaking: Germany, Austria, Switzerland)",
    "dach": "DACH (German-speaking: Germany, Austria, Switzerland)",
    "uk": "United Kingdom (English)",
    "us": "US / Global (English)",
    "global": "US / Global (English)",
}

# Google locale parameters (gl = country, hl = interface language) per market
# key. Without these, Bright Data resolves the SERP from a US/English default,
# so a "France" audit was silently reading US Google ranks. Propagating gl/hl
# makes the market promise real: a French audit reads google.fr in French.
# Keys mirror _MARKET_PRESETS; anything unknown falls back to US/English so the
# behavior is never worse than before.
_MARKET_LOCALE = {
    "fr": ("fr", "fr"),
    "france": ("fr", "fr"),
    "de": ("de", "de"),
    "dach": ("de", "de"),
    "uk": ("gb", "en"),
    "us": ("us", "en"),
    "global": ("us", "en"),
}
_DEFAULT_LOCALE = ("us", "en")


def _market_locale(market):
    """Map a market key (or free-text market label) to (gl, hl) Google params."""
    key = (market or "").strip().lower()
    if key in _MARKET_LOCALE:
        return _MARKET_LOCALE[key]
    # Tolerate human labels ("France (French-speaking market)") by scanning for
    # a known market word, so a resolved/inferred label still geolocates.
    for word, loc in (("france", _MARKET_LOCALE["fr"]), ("french", _MARKET_LOCALE["fr"]),
                      ("german", _MARKET_LOCALE["de"]), ("dach", _MARKET_LOCALE["de"]),
                      ("kingdom", _MARKET_LOCALE["uk"]), ("britain", _MARKET_LOCALE["uk"])):
        if word in key:
            return loc
    return _DEFAULT_LOCALE


def _extract_json_object(text):
    """Pull the first valid JSON object out of an LLM reply, tolerant of the
    ways a chattier model (e.g. Sonnet vs Haiku) wraps it: a ```json fenced
    block, a sentence of preamble, or trailing prose. Returns the parsed dict
    or None.

    The old approach (a greedy \\{.*\\} regex fed straight to json.loads) broke
    whenever the reply had prose containing braces or a markdown fence, which
    surfaced to the user as "Claude did not return valid JSON" and a failed
    audit. Here we strip fences, try a direct parse, then walk the string to
    find the first brace-balanced object and parse that."""
    if not text:
        return None
    s = text.strip()
    # Strip a leading ```json / ``` fence and its closing fence if present.
    s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
    s = re.sub(r"\s*```$", "", s).strip()
    # Fast path: the whole thing is already a JSON object.
    try:
        obj = json.loads(s)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    # Walk to the first brace-balanced {...} (string-aware) and parse it.
    start = s.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(s)):
            c = s[i]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = s[start:i + 1]
                        try:
                            obj = json.loads(candidate)
                            if isinstance(obj, dict):
                                return obj
                        except (json.JSONDecodeError, ValueError):
                            break  # try the next opening brace
        start = s.find("{", start + 1)
    return None


def infer_strategy(brand, api_key, hint=None, market=None, max_queries=MAX_QUERIES_FREE, evidence=None):
    n = MAX_QUERIES_PAID if int(max_queries or MAX_QUERIES_FREE) >= MAX_QUERIES_PAID else MAX_QUERIES_FREE
    forced = _MARKET_PRESETS.get((market or "").strip().lower()) if market else None
    prompt = (
        "You are a competitive-intelligence analyst. Given a single brand or company name, "
        "infer its market and return STRICT JSON with this exact shape and nothing else:\n"
        '{"sector":"short sector label","market":"primary market label",'
        '"query_language":"ISO 639-1 code","competitors":["BrandA","BrandB","BrandC","BrandD"],'
        '"queries":["buyer-intent query 1","query 2"],'
        '"identified_as":"one sentence saying what this company really is, with its domain if known",'
        '"confidence":"high or low"}\n'
        "Rules: include the given brand as the FIRST competitor. List 4-5 real, well-known direct competitors. "
        "Queries must be the searches a real buyer would type when shopping in this category "
        "(e.g. 'best CRM for startups', 'salesforce alternative'). "
        "Exactly " + str(n) + " queries.\n\n"
        "LOCAL & NICHE BUSINESSES (critical): if the brand is a physical or local business (a shop, "
        "record store, restaurant, venue, studio, local agency) or a small niche independent brand, "
        "then (a) every competitor MUST compete in the brand's OWN market and country. Never list "
        "foreign category giants a local buyer would not actually compare against (for a Paris record "
        "shop, list other French/Paris record shops, not London or Amsterdam ones), and (b) queries "
        "MUST carry the qualifier a real local buyer types, usually the city or country (e.g. "
        "'disquaire techno Paris', not 'acheter vinyles en ligne'). Generic category queries that only "
        "global giants can win produce empty, useless audits for local brands.\n\n"
        "MARKET & LANGUAGE (important): determine the brand's PRIMARY market and the language "
        "its buyers actually search in, then write ALL queries in THAT language. Infer the market "
        "from the brand name, from any hint (e.g. a country TLD like .fr / .de signals a "
        "French / German market), and from your own knowledge of the company. Do NOT default to "
        "the US / English market for a brand whose buyers are elsewhere: a French SaaS should get "
        "French queries, a German one German queries. Set \"market\" to a short human label "
        "(e.g. \"US / Global EN\", \"France FR\", \"DACH DE\", \"UK EN\") and \"query_language\" to "
        "the matching ISO 639-1 code (e.g. \"en\", \"fr\", \"de\"). For a clearly global or "
        "US-centric brand (e.g. Notion, Stripe), keep the market English / Global and write "
        "English queries.\n\n"
        "Disambiguation: brand names are often shared by unrelated companies (e.g. a fintech "
        "and a consumer app with the same name). Identify the REAL company this name most likely "
        "refers to. Do NOT assume it is a B2B or SaaS company: it may be a record label, a shop, "
        "a restaurant, a media outlet, a consumer product — anything. Judge from the evidence and "
        "context, not from a category prior.\n\n"
        "Identity output: set \"identified_as\" to ONE factual sentence describing what this "
        "company actually is (include its domain if you know it, e.g. \"Yoyaku is a French techno "
        "record label and vinyl shop, yoyaku.io\"). Set \"confidence\" to \"high\" only if you are "
        "genuinely sure which company this is; otherwise \"low\".\n"
        "CRITICAL: If NO web evidence is provided below, you MUST return confidence \"low\" — you "
        "cannot be certain of an obscure brand from its name alone, and a famous namesake must "
        "never be assumed to be the company in question. A bare, unfamiliar name with no evidence "
        "is always \"low\".\n\n"
        "Brand: " + brand
    )
    if evidence:
        try:
            ev_text = json.dumps(evidence, ensure_ascii=False)[:2000]
        except (TypeError, ValueError):
            ev_text = str(evidence)[:2000]
        prompt += (
            "\n\nHere is what the web actually says about this brand (fetched from its site "
            "and/or search results). This web evidence OVERRIDES your prior knowledge: if it "
            "conflicts with a company you already know by this name, TRUST THE EVIDENCE, not your "
            "memory. Identify the company described in THIS evidence, not a famous namesake you "
            "recall. Do NOT guess from the name alone. If the evidence clearly identifies the "
            "company, set confidence to \"high\":\n" + ev_text
        )
    if forced:
        prompt += (
            "\n\nThe user has EXPLICITLY selected the target market: " + forced + ". "
            "Treat this as authoritative: set \"market\" and \"query_language\" to match it and "
            "write every query in that market's language, even if the brand is best known elsewhere."
        )
    if hint and hint.strip():
        prompt += (
            "\n\nAdditional context to disambiguate the brand (use this to identify the CORRECT "
            "company, especially if the name is ambiguous): " + hint.strip()
        )
    text, stop = _anthropic_message(INFER_MODEL, 900, prompt, api_key, what="Claude API")
    parsed = _extract_json_object(text)
    if parsed is None:
        # Identification replies are non-deterministic: one regenerate rescues
        # the audit far more often than not, and the call costs a fraction of a
        # cent. Only after a second unparseable reply do we fail the request.
        logger.warning("infer_strategy unparseable (stop_reason=%s), retrying once: %s",
                       stop, text[:200])
        text, stop = _anthropic_message(INFER_MODEL, 900, prompt, api_key, what="Claude API")
        parsed = _extract_json_object(text)
    if parsed is None:
        logger.error("Claude returned no parseable JSON (stop_reason=%s) in: %s", stop, text[:300])
        raise RuntimeError("The identification step failed on this run. "
                           "Running the measure again usually works.")
    return parsed

# ---------------------------------------------------------------------------
# Step 1b: Web-first recon (identity anchoring) + SSRF guard
# ---------------------------------------------------------------------------
# The identity bug ("Yoyaku is a B2B SaaS") came from inferring a company from
# its NAME alone. _recon gathers real web evidence FIRST, so infer_strategy can
# anchor on what the web actually says. It is fail-open: any error yields empty
# evidence and the pipeline degrades to the old name-only behavior rather than
# blocking the audit.
#
# SSRF: the URL field is user-supplied, so every fetch is guarded — http/https
# only, DNS-resolved, private/loopback/link-local IPs refused, redirects
# re-validated the same way, short timeout, capped body size.
# ---------------------------------------------------------------------------
_RECON_UA = "Mozilla/5.0 (compatible; NadelioBot/1.0; +%s)" % SITE_URL
_RECON_TIMEOUT = 6
_RECON_MAXBYTES = 200_000
_DOMAIN_RE = re.compile(r"^[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)+$", re.I)
_TLD_RE = re.compile(r"\.[a-z]{2,}$", re.I)

# Recon cache keyed on brand.lower(), and a light per-IP rate-limit for the
# non-quota-gated /api/infer endpoint (spam guard, not a billing gate).
_recon_cache = {}
_RECON_CACHE_MAX = 500
_infer_hits = {}  # {ip: [minute_bucket_int, count]}
_INFER_RATE_PER_MIN = int(os.environ.get("INFER_RATE_PER_MIN", "20"))
# Process-wide circuit breaker on /api/infer, INDEPENDENT of client IP.
# _infer_hits above is per-IP and therefore fully bypassable by rotating
# X-Forwarded-For (see _client_ip), even with that fixed, a botnet or a
# compromised proxy could still present many distinct real IPs. Every
# /api/infer call runs at least one INFER_MODEL (claude-sonnet-5, pricier
# than the Haiku used elsewhere) call with no payment or quota gate, so this
# is a real-money cost circuit-breaker of last resort: a global rolling
# per-minute cap, counted no matter which identity the caller claims.
# In-memory + per-worker, exactly like _live_runs (see the note at its
# definition), good enough for the current single-worker deploy.
_infer_global_hits = []  # list of call timestamps (seconds) within the window
_INFER_GLOBAL_RATE_PER_MIN = int(os.environ.get("INFER_GLOBAL_RATE_PER_MIN", "60"))

# Light per-IP rate-limit for the funnel-tracking endpoint (spam guard, not a
# billing gate). A single session can legitimately fire several events, so the
# limit is generous.
_event_hits = {}  # {ip: [minute_bucket_int, count]}
_EVENT_RATE_PER_MIN = int(os.environ.get("EVENT_RATE_PER_MIN", "60"))


def _looks_like_domain(brand):
    """True if `brand` looks like a bare domain or URL (has a dot + a 2+ letter
    TLD). Accepts 'yoyaku.io', 'https://yoyaku.io/path', 'www.yoyaku.io'."""
    if not brand:
        return False
    s = brand.strip()
    # Strip scheme + path so we test the host only.
    if "://" in s:
        try:
            s = urllib.parse.urlparse(s).netloc or s
        except ValueError:
            return False
    s = s.split("/")[0].strip().rstrip(".")
    if " " in s or "@" in s or not s:
        return False
    return bool(_DOMAIN_RE.match(s)) and bool(_TLD_RE.search(s))


def _resolve_public_ips(host):
    """Resolve `host` and return the list of resolved addresses if EVERY one is
    a public, routable IP (never private / loopback / link-local / reserved /
    multicast, so never a cloud metadata endpoint or an internal service
    either), else None. Shared by _is_public_host (a plain yes/no check) and
    _resolve_pinned_ip (the SSRF fetch, which also needs the actual address to
    pin the connection to, see below)."""
    if not host:
        return None
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return None
    import ipaddress
    ips = []
    for info in infos:
        addr = info[4][0]
        # Strip a scope id if present (e.g. fe80::1%eth0).
        addr = addr.split("%")[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return None
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return None
        ips.append(addr)
    return ips or None


def _is_public_host(host):
    """True only if EVERY address `host` resolves to is public/routable. This
    alone is NOT sufficient to safely fetch a URL: DNS can answer differently a
    few milliseconds later (DNS rebinding), see _resolve_pinned_ip and
    _fetch_page_meta, which pin the exact validated address instead of trusting
    the hostname a second time."""
    return _resolve_public_ips(host) is not None


def _resolve_pinned_ip(host):
    """One public IP to physically connect to for `host`, resolved and vetted
    ONCE, immediately before use. This is the actual DNS-rebinding fix: without
    it, _is_public_host validates the hostname, and then the HTTP client
    resolves the SAME hostname AGAIN when it opens the socket (urllib/http.client
    do their own getaddrinfo at connect() time), a 0-TTL DNS record can legally
    answer PUBLIC on the first lookup and INTERNAL/link-local/metadata on the
    second, and nothing in a plain urlopen() call would notice. Pinning means
    the address that was checked is the address that gets contacted (see
    _PinnedHTTPConnection / _PinnedHTTPSConnection)."""
    ips = _resolve_public_ips(host)
    return ips[0] if ips else None


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that connects to a pre-resolved, pre-vetted IP instead of
    letting http.client re-resolve self.host at connect() time (see
    _resolve_pinned_ip for why that second, unchecked resolution is the actual
    SSRF hole)."""

    def __init__(self, host, pinned_ip, **kwargs):
        super().__init__(host, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address)
        if self._tunnel_host:
            self._tunnel()


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Same DNS-rebinding fix for HTTPS. TLS certificate validation still runs
    against the ORIGINAL hostname (server_hostname=self.host below), so this
    only removes the second, unchecked DNS lookup, it never weakens
    certificate validation."""

    def __init__(self, host, pinned_ip, **kwargs):
        super().__init__(host, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection(
            (self._pinned_ip, self.port), self.timeout, self.source_address)
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
            sock = self.sock
        context = self._context or ssl.create_default_context()
        server_hostname = self._tunnel_host or self.host
        self.sock = context.wrap_socket(sock, server_hostname=server_hostname)


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    """Opener handler that hands every plain-HTTP connection the one IP address
    already vetted for this hop, instead of letting http.client re-resolve the
    hostname."""

    def __init__(self, pinned_ip):
        urllib.request.HTTPHandler.__init__(self)
        self._pinned_ip = pinned_ip

    def http_open(self, req):
        return self.do_open(
            lambda host, **kw: _PinnedHTTPConnection(host, self._pinned_ip, **kw), req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    """HTTPS counterpart of _PinnedHTTPHandler."""

    def __init__(self, pinned_ip):
        urllib.request.HTTPSHandler.__init__(self)
        self._pinned_ip = pinned_ip

    def https_open(self, req):
        return self.do_open(
            lambda host, **kw: _PinnedHTTPSConnection(host, self._pinned_ip, **kw),
            req, context=self._context)


def _safe_url(raw):
    """Normalize a user-supplied brand/URL into a safe http(s) URL, or return
    None if it fails the SSRF policy. No fetch happens here."""
    if not raw:
        return None
    s = raw.strip()
    if "://" not in s:
        s = "https://" + s
    try:
        p = urllib.parse.urlparse(s)
    except ValueError:
        return None
    if p.scheme not in ("http", "https"):
        return None
    host = p.hostname
    if not host or not _is_public_host(host):
        return None
    return s


def _fetch_page_meta(url):
    """Fetch a page under the SSRF policy and extract lightweight identity signals
    by regex (title, meta description, og:site_name, og:description, first h1).
    NO heavy parser. Manual redirect following (max 3), re-validating each hop's
    host against the SSRF policy so a redirect cannot pivot to an internal IP.
    Returns a dict of found fields (may be empty). Never raises."""
    safe = _safe_url(url)
    if not safe:
        return {}
    current = safe
    try:
        html = None
        final_url = current
        for _ in range(4):  # initial + up to 3 redirects
            host = urllib.parse.urlparse(current).hostname
            pinned_ip = _resolve_pinned_ip(host)
            if not host or not pinned_ip:
                return {}
            req = urllib.request.Request(
                current,
                headers={"User-Agent": _RECON_UA, "Accept": "text/html,*/*;q=0.8"},
                method="GET",
            )
            try:
                # No auto-redirect: we validate AND pin each hop ourselves.
                # Pinning (rather than just checking _is_public_host and then
                # letting urllib re-resolve the hostname at open()) is what
                # actually closes the DNS-rebinding TOCTOU: the IP just vetted
                # above is the IP this connection physically contacts.
                opener = urllib.request.build_opener(
                    _NoRedirect, _PinnedHTTPHandler(pinned_ip), _PinnedHTTPSHandler(pinned_ip))
                resp = opener.open(req, timeout=_RECON_TIMEOUT)
            except urllib.error.HTTPError as he:
                if he.code in (301, 302, 303, 307, 308):
                    loc = he.headers.get("Location")
                    if not loc:
                        return {}
                    current = urllib.parse.urljoin(current, loc)
                    nxt = _safe_url(current)
                    if not nxt:
                        return {}
                    current = nxt
                    continue
                return {}
            with resp:
                final_url = current
                raw = resp.read(_RECON_MAXBYTES)
                html = raw.decode("utf-8", errors="replace")
                break
        if html is None:
            return {}
    except (urllib.error.URLError, socket.timeout, ValueError, OSError):
        return {}

    def _grab(pattern):
        m = re.search(pattern, html, re.I | re.S)
        return re.sub(r"\s+", " ", m.group(1)).strip()[:300] if m else ""

    meta = {}
    title = _grab(r"<title[^>]*>(.*?)</title>")
    if title:
        meta["title"] = title
    desc = _grab(r'<meta[^>]+name=["\']description["\'][^>]+content=["\'](.*?)["\']') \
        or _grab(r'<meta[^>]+content=["\'](.*?)["\'][^>]+name=["\']description["\']')
    if desc:
        meta["description"] = desc
    site = _grab(r'<meta[^>]+property=["\']og:site_name["\'][^>]+content=["\'](.*?)["\']')
    if site:
        meta["og_site_name"] = site
    ogd = _grab(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\'](.*?)["\']')
    if ogd:
        meta["og_description"] = ogd
    h1 = _grab(r"<h1[^>]*>(.*?)</h1>")
    h1 = re.sub(r"<[^>]+>", "", h1).strip() if h1 else ""
    if h1:
        meta["h1"] = h1
    if meta:
        meta["url"] = final_url
    return meta


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Disable urllib's automatic redirect following so _fetch_page_meta can
    validate each hop's host against the SSRF policy before following it."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _recon(brand, serp_key):
    """Gather real web evidence about `brand` BEFORE inference, so identity is
    anchored on the web and not guessed from the name.

    (a) If `brand` looks like a domain/URL -> fetch its page meta (free, no SERP).
    (b) Else, ONLY if serp_key is provided (caller decides whether the paid SERP
        path is authorized) -> run_query(brand), take the top-3 organic results
        as evidence, and fetch meta of the first host whose domain contains the
        brand slug (its likely official site).

    Returns {"evidence": [...], "official_url": str}. Fail-open: on ANY error the
    evidence is whatever was gathered so far (possibly empty) and official_url is
    "" — never raises, never blocks the audit.

    CACHE-POISONING GUARD (needed for Correction D): the free /api/infer preview
    calls this with serp_key=None on a bare name and gets an EMPTY result. If that
    empty result were cached and served back, the later quota-gated /api/analyze —
    which DOES pass a real serp_key — would hit the empty cache entry and skip the
    SERP, silently defeating the web anchoring. So: never SERVE a cached empty
    result when a serp_key is now available (retry with the SERP), and never STORE
    an empty result produced without a serp_key (a no-SERP miss must not block a
    later real recon). Non-empty results (real evidence) are always cached and
    reused so the same brand is never re-paid."""
    key = (brand or "").strip().lower()
    if key:
        # _recon_cache is shared, in-memory, module-level state: guard every
        # access with _live_lock (the app's single module lock, see its
        # definition above) so a threaded gunicorn worker can never interleave
        # a read with a concurrent write/resize of the dict.
        with _live_lock:
            cached = _recon_cache.get(key)
        # Serve the cache unless it is an empty result AND we could now do better
        # with a real SERP key (i.e. the empty entry came from a no-SERP preview).
        if cached is not None and (cached.get("evidence") or not serp_key):
            return cached

    result = {"evidence": [], "official_url": ""}
    try:
        if _looks_like_domain(brand):
            meta = _fetch_page_meta(brand)
            if meta:
                result["official_url"] = meta.get("url", "")
                ev = {}
                if meta.get("og_site_name"):
                    ev["site_name"] = meta["og_site_name"]
                if meta.get("title"):
                    ev["title"] = meta["title"]
                desc = meta.get("description") or meta.get("og_description") or ""
                if desc:
                    ev["description"] = desc
                if meta.get("h1"):
                    ev["h1"] = meta["h1"]
                if ev:
                    ev["source"] = meta.get("url", "")
                    result["evidence"].append(ev)
        elif serp_key:
            try:
                organic = run_query(brand, serp_key)
            except Exception:
                organic = []
            slug = _brand_slug(brand)
            official = ""
            for r in organic[:3]:
                result["evidence"].append({
                    "title": str(r.get("title", ""))[:200],
                    "link": str(r.get("link", ""))[:300],
                    "description": str(r.get("description", ""))[:300],
                })
                if not official and slug and len(slug) >= 4:
                    host = urllib.parse.urlparse(str(r.get("link", ""))).netloc.lower()
                    if slug in host.replace("-", "").replace(".", ""):
                        official = str(r.get("link", ""))
            if official:
                meta = _fetch_page_meta(official)
                if meta:
                    result["official_url"] = meta.get("url", official)
                    ev = {"source": meta.get("url", official)}
                    if meta.get("og_site_name"):
                        ev["site_name"] = meta["og_site_name"]
                    if meta.get("title"):
                        ev["title"] = meta["title"]
                    d = meta.get("description") or meta.get("og_description") or ""
                    if d:
                        ev["description"] = d
                    if len(ev) > 1:
                        result["evidence"].append(ev)
                else:
                    result["official_url"] = official
    except Exception:
        logger.exception("recon failed for brand=%r (fail-open)", brand)

    # Cache real evidence always; cache an empty result ONLY if a serp_key was
    # available (a genuine "nothing found even with SERP" miss). An empty result
    # from a no-SERP call is NOT cached, so it can't block a later real recon.
    if key and (result["evidence"] or serp_key):
        with _live_lock:
            if len(_recon_cache) < _RECON_CACHE_MAX:
                _recon_cache[key] = result
    return result


# ---------------------------------------------------------------------------
# Step 2: Bright Data SERP
# ---------------------------------------------------------------------------
def run_query(query, api_key, gl=None, hl=None):
    url = "https://www.google.com/search?q=" + urllib.parse.quote(query) + "&brd_json=1"
    # Geolocate the SERP so a market-scoped audit reads the right Google. gl sets
    # the country, hl the interface language. Both are simple, well-supported
    # Google URL params that Bright Data forwards. Omitted -> Google's default
    # (US/English), preserving the previous behavior when no market is known.
    if gl:
        url += "&gl=" + urllib.parse.quote(gl)
    if hl:
        url += "&hl=" + urllib.parse.quote(hl)
    payload = json.dumps({"zone": ZONE, "url": url, "format": "raw"}).encode()
    req = urllib.request.Request(
        SERP_ENDPOINT, data=payload,
        headers={
            "Authorization": "Bearer " + api_key,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        parsed = _urlopen_json_with_retry(req, timeout=60, what="SERP API")
    except (json.JSONDecodeError, ValueError):
        logger.error("Bright Data returned non-JSON for query '%s'", query)
        raise RuntimeError("SERP API returned an unexpected response format")
    return parsed.get("organic", [])


def brand_in(brand, result):
    # 1) Word-boundary match of the brand name in title/description text.
    text_hay = " ".join(str(result.get(k, "")) for k in ("title", "description")).lower()
    if re.search(r"\b" + re.escape(brand.lower()) + r"\b", text_hay) is not None:
        return True
    slug = _brand_slug(brand)
    if len(slug) < 4:
        return False
    parsed = urllib.parse.urlparse(str(result.get("link", "")))
    # 2) Slug in the link HOST — recognizes domains like "montecarlodata.com"
    #    for a spaced brand name ("Monte Carlo Data") that never appears with
    #    word boundaries in the link. Substring is safe here: a host is a
    #    strong identifier and the min-length guard blocks short-slug noise.
    if slug in parsed.netloc.lower():
        return True
    # 3) Slug in the link PATH — recognizes third-party comparison URLs where
    #    the brand is named in the path. To avoid false positives on generic
    #    words (e.g. "soda" in "/soda-can-recycling"), only match when the slug
    #    is EITHER a complete path segment ("g2.com/products/aircall") OR the
    #    head of a segment immediately followed by a known SEO comparison suffix
    #    ("zapier.com/blog/notion-alternative", "/weglot-review", "/asana-vs-x").
    path = parsed.path.lower()
    seg = re.escape(slug)
    suffixes = r"alternative|alternatives|review|reviews|vs|pricing|competitors|comparison"
    pat = r"(?:^|/)" + seg + r"(?:/|$|-(?:" + suffixes + r")(?:$|[/\-_.]))"
    return re.search(pat, path) is not None


def _brand_slug(brand):
    return re.sub(r"[^a-z0-9]", "", brand.lower())


def _result_kind(brand, result):
    """'citation' if the brand's own domain ranked, else 'mention' (named by someone else)."""
    host = urllib.parse.urlparse(str(result.get("link", ""))).netloc.lower()
    return "citation" if _brand_slug(brand) in host.replace("-", "").replace(".", "") else "mention"


def analyze(brands, queries, api_key, gl=None, hl=None, return_landscape=False):
    stats = {b: {"mentions": 0, "appearances": 0, "ranks": [], "evidence": [], "cells": {}} for b in brands}
    # The SERP results are already paid for: everything that is NOT a tracked
    # brand is the "landscape" — who actually owns these answers. Without it, a
    # niche/local brand whose rivals are absent too yields an empty, useless
    # grid; with it, the same audit says WHO to displace. Collected per query
    # (top untracked results) and aggregated per host across queries.
    landscape_q = {}
    host_stats = {}
    for query in queries:
        results = run_query(query, api_key, gl=gl, hl=hl)
        hit = {b: False for b in brands}
        untracked = []
        for pos, result in enumerate(results, 1):
            matched = False
            for b in brands:
                if brand_in(b, result):
                    matched = True
                    if query not in stats[b]["cells"]:
                        stats[b]["appearances"] += 1
                        stats[b]["ranks"].append(pos)
                        hit[b] = True
                        stats[b]["cells"][query] = {
                            "rank": pos,
                            "title": result.get("title", ""),
                            "link": result.get("link", ""),
                            "kind": _result_kind(b, result),
                        }
            if not matched and len(untracked) < 3:
                host = urllib.parse.urlparse(str(result.get("link", ""))).netloc.lower()
                host = host[4:] if host.startswith("www.") else host
                if host:
                    untracked.append({"rank": pos, "host": host,
                                      "title": str(result.get("title", ""))[:120],
                                      "link": str(result.get("link", ""))[:300]})
            if not matched:
                host2 = urllib.parse.urlparse(str(result.get("link", ""))).netloc.lower()
                host2 = host2[4:] if host2.startswith("www.") else host2
                if host2:
                    st = host_stats.setdefault(host2, {"hits": 0, "best_rank": pos})
                    st["hits"] += 1
                    st["best_rank"] = min(st["best_rank"], pos)
        landscape_q[query] = untracked
        for b in brands:
            if hit[b]:
                stats[b]["mentions"] += 1
        time.sleep(1)
    owners = sorted(({"host": h, "hits": s["hits"], "best_rank": s["best_rank"]}
                     for h, s in host_stats.items()),
                    key=lambda o: (-o["hits"], o["best_rank"]))[:5]
    landscape = {"queries": landscape_q, "owners": owners}
    total = sum(s["appearances"] for s in stats.values()) or 1
    ranking = []
    for b, s in stats.items():
        avg = round(sum(s["ranks"]) / len(s["ranks"]), 1) if s["ranks"] else None
        ev = [dict(c, query=q) for q, c in s["cells"].items()]
        citations = sum(1 for c in s["cells"].values() if c.get("kind") == "citation")
        ranking.append({
            "brand": b,
            "query_coverage": str(s["mentions"]) + "/" + str(len(queries)),
            "avg_rank": avg,
            "share_of_voice": round(100 * s["appearances"] / total, 1),
            "evidence": ev,
            "cells": s["cells"],
            "citation_count": citations,
            "mention_count": len(s["cells"]) - citations,
        })
    ranking.sort(key=lambda r: (-int(r["query_coverage"].split("/")[0]),
                                 r["avg_rank"] if r["avg_rank"] else 999))
    if return_landscape:
        return ranking, landscape
    return ranking

# ---------------------------------------------------------------------------
# Step 3: AI Engine visibility (measured via repeated Claude Haiku calls)
# ---------------------------------------------------------------------------
# Claude is itself a public AI assistant, so asking it which brands it would
# recommend is a real measurement of Claude's recommendation behavior — not a
# simulation of some other engine. Because LLM output is non-deterministic,
# a single call is a noisy sample; we run it AI_RUNS times at a non-zero
# temperature and aggregate, which also yields a consistency score (how
# stable the brand's presence/rank is across runs).
# ---------------------------------------------------------------------------
AI_RUNS = int(os.environ.get("AI_RUNS", "3"))
AI_RUN_TEMPERATURE = 0.7

# Per-tier run counts. The number of AI runs directly drives cost (one Haiku
# call per run) AND the width of the bounded GEO score's confidence interval:
# more runs -> a tighter, more defensible interval. The free tier gets an
# honest but wider interval; the paid Deep Audit buys the tighter one. MAX is a
# hard ceiling protecting unit economics.
FREE_AI_RUNS = int(os.environ.get("FREE_AI_RUNS", "3"))
DEEP_AI_RUNS = int(os.environ.get("DEEP_AI_RUNS", "8"))
MAX_AI_RUNS = int(os.environ.get("MAX_AI_RUNS", "15"))

# Two-sided 95% Student-t critical values keyed by degrees of freedom (n-1),
# df 1..30. The bounded score's "95% confidence interval" must widen at small
# n: the free tier runs FREE_AI_RUNS=3 samples (df=2, occasionally fewer on a
# partial failure), where the normal quantile z=1.96 understates the true
# interval by 2.2x (t=4.303 at df=2) and by 6.5x at df=1 (n=2). Beyond df=30
# the t and normal quantiles already agree to within ~0.1%, so 1.96 is used
# unmodified past that point. Values are the standard two-tailed alpha=0.05
# critical values found in any statistics reference table; stdlib-only
# (no scipy dependency).
_T975 = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 13: 2.160, 14: 2.145, 15: 2.131,
    16: 2.120, 17: 2.110, 18: 2.101, 19: 2.093, 20: 2.086,
    21: 2.080, 22: 2.074, 23: 2.069, 24: 2.064, 25: 2.060,
    26: 2.056, 27: 2.052, 28: 2.048, 29: 2.045, 30: 2.042,
}


def _t975(df):
    """Two-sided 95% Student-t critical value for `df` degrees of freedom.
    Falls back to the normal z=1.96 once df > 30 (t and z already agree to
    within ~0.1% there), and clamps df < 1 to df=1 (the widest, most
    conservative value) rather than raising or silently using z."""
    if df in _T975:
        return _T975[df]
    if df < 1:
        return _T975[1]
    return 1.96


# Bounded-score verdict thresholds (kept as constants so they can be
# recalibrated without touching the logic). half_width is the +/- of the
# HONEST (Student-t corrected) 95% interval on the 0-100 score; ratio is
# half_width relative to the point estimate.
#
# These were originally calibrated (4 / 10 / 0.15 / 0.30) against a half_width
# computed with the WRONG large-sample z=1.96, i.e. implicitly against
# 1.96*se. Now that half_width honestly uses t975(n-1)*se, the same real
# per-run noise (the same se) produces a bigger half_width, mechanically
# recalibrating the cutoffs is required, or every free-tier read (n=3, the
# overwhelming majority of measurements: FREE_AI_RUNS=3) would drift toward
# MODERE/VOLATIL even when the underlying data is exactly as noisy as before.
#
# Chosen recalibration: rescale each cutoff by the correction factor at the
# free tier's fixed sample size, t975(FREE_AI_RUNS - 1) / 1.96 = 4.303 / 1.96
# ~= 2.195, the free tier is where these thresholds are hit on nearly every
# measurement, so anchoring there means a given level of RAW run-to-run noise
# (the same standard error, same sd) is judged exactly as before at n=3. This
# is a deliberate, disclosed simplification versus scaling per-n: at the paid
# Deep Audit's n=8 (df=7), the honest widening factor is only t975(7)/1.96 =
# 2.365/1.96 ~= 1.207, meaningfully smaller than the 2.195 anchor used here -
# so on paid runs these rescaled cutoffs are, if anything, MORE lenient than
# a perfectly n-specific recalibration would be (STABLE is slightly easier to
# reach). That is acceptable and never hides risk: a paid run with n=8
# genuinely IS more precise than a free run with the same sd, so treating it
# generously on the STABLE/VOLATIL cut never overstates certainty beyond what
# the wider free-tier band would already have granted the same data at n=3;
# it simply does not extract 100% of the extra precision n=8 buys. See the
# worked n=3 / n=8 examples in the fix report for concrete numbers.
STABLE_MAX_HALFWIDTH = 9      # was 4;  4  * (4.303/1.96) = 8.78 -> 9
VOLATIL_MIN_HALFWIDTH = 22    # was 10; 10 * (4.303/1.96) = 21.95 -> 22
STABLE_MAX_RATIO = 0.33       # was 0.15; 0.15 * (4.303/1.96) = 0.329 -> 0.33
VOLATIL_MIN_RATIO = 0.66      # was 0.30; 0.30 * (4.303/1.96) = 0.659 -> 0.66


# ---------------------------------------------------------------------------
# AI-assistant providers. The AI-visibility probe can be run against different
# assistants (Claude, ChatGPT, Gemini, ...). The PROMPT and the PARSING of the
# returned JSON are identical across assistants; only the HTTP call differs
# (endpoint, auth header, request/response envelope). So each assistant is a
# provider entry: an id, a human label, the env var holding its key, and a
# "call" function that takes the prompt and returns the raw text answer.
#
# FUTUREPROOF: adding an assistant is one entry in _AI_PROVIDERS plus one small
# _call_* function. GRACEFUL: an assistant whose API key is not set is simply
# absent from the choices (never an error). The default stays Claude, which is
# already configured.
# ---------------------------------------------------------------------------
OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions"
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")
GEMINI_ENDPOINT = ("https://generativelanguage.googleapis.com/v1beta/models/"
                   + GEMINI_MODEL + ":generateContent")


def _ai_visibility_prompt(brands, queries):
    """The single shared prompt every assistant answers, so results are
    comparable across assistants."""
    queries_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(queries))
    brands_list = ", ".join(brands)
    return (
        "You are a helpful AI assistant answering buyer questions. "
        "A user asks each of the following questions. For EACH question, "
        "list which of these brands you would mention in your answer, "
        "in the order you would mention them (first = most prominent). "
        "For each brand you list, say whether it is your 'primary' recommendation "
        "(the main answer to the question) or just 'mentioned' in passing.\n\n"
        f"Brands to consider: {brands_list}\n\n"
        f"Questions:\n{queries_block}\n\n"
        "Return STRICT JSON only, no other text:\n"
        '{"results":[{"query":"...","mentioned":[{"brand":"Brand1","kind":"primary"},'
        '{"brand":"Brand2","kind":"mentioned"}]}]}'
    )


def _call_claude(prompt, api_key):
    text, _ = _anthropic_message(ANTHROPIC_MODEL, 600, prompt, api_key,
                                 what="Claude API (AI visibility)",
                                 temperature=AI_RUN_TEMPERATURE)
    return text


def _call_openai(prompt, api_key):
    body = json.dumps({
        "model": OPENAI_MODEL,
        "max_tokens": 600,
        "temperature": AI_RUN_TEMPERATURE,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        OPENAI_ENDPOINT, data=body,
        headers={"Authorization": "Bearer " + api_key,
                 "content-type": "application/json"},
        method="POST")
    data = _urlopen_json_with_retry(req, timeout=40, what="OpenAI API (AI visibility)")
    choices = data.get("choices") or []
    return choices[0].get("message", {}).get("content", "") if choices else ""


def _call_gemini(prompt, api_key):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": AI_RUN_TEMPERATURE, "maxOutputTokens": 600},
    }).encode()
    # Gemini takes the key as a query param, not a header.
    req = urllib.request.Request(
        GEMINI_ENDPOINT + "?key=" + urllib.parse.quote(api_key), data=body,
        headers={"content-type": "application/json"}, method="POST")
    data = _urlopen_json_with_retry(req, timeout=40, what="Gemini API (AI visibility)")
    cands = data.get("candidates") or []
    if not cands:
        return ""
    parts = cands[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


# Provider registry. Order = display order. The first available one is default.
# "model" is the EXACT model id this provider's "call" function sends to its
# API (read here, never re-hardcoded at the call site) so the frontend can
# state plainly which model actually ran the AI-visibility reads, not just
# which company (see /api/analyze's "ai_model" field).
_AI_PROVIDERS = {
    "claude":  {"label": "Claude",  "env": "ANTHROPIC_API_KEY", "call": _call_claude,  "model": ANTHROPIC_MODEL},
    "chatgpt": {"label": "ChatGPT", "env": "OPENAI_API_KEY",    "call": _call_openai,  "model": OPENAI_MODEL},
    "gemini":  {"label": "Gemini",  "env": "GEMINI_API_KEY",    "call": _call_gemini,  "model": GEMINI_MODEL},
}
DEFAULT_AI_PROVIDER = "claude"


def _provider_key(provider_id):
    p = _AI_PROVIDERS.get(provider_id)
    return os.environ.get(p["env"]) if p else None


def _available_providers():
    """Ids of assistants whose API key is configured, in display order."""
    return [pid for pid in _AI_PROVIDERS if _provider_key(pid)]


def _resolve_provider(requested):
    """Pick the assistant to use: the requested one if available, else the
    default if available, else the first available, else None."""
    if requested in _AI_PROVIDERS and _provider_key(requested):
        return requested
    if _provider_key(DEFAULT_AI_PROVIDER):
        return DEFAULT_AI_PROVIDER
    avail = _available_providers()
    return avail[0] if avail else None


def _run_ai_visibility_once(brands, queries, api_key, provider_id=DEFAULT_AI_PROVIDER):
    """One sampled call to the chosen assistant. Returns
    {query: {brand: {"rank": int, "kind": "primary"|"mentioned"}}}."""
    prompt = _ai_visibility_prompt(brands, queries)
    call = _AI_PROVIDERS.get(provider_id, _AI_PROVIDERS[DEFAULT_AI_PROVIDER])["call"]
    try:
        text = call(prompt, api_key)
    except Exception:
        logger.exception("AI visibility run failed (provider=%s)", provider_id)
        return {}  # graceful degradation — SERP data still works (after retries)

    parsed = _extract_json_object(text or "")
    if parsed is None:
        return {}

    def _norm_q(s):
        return re.sub(r"\s+", " ", str(s).strip().lower()).rstrip("?.!")

    norm_to_real = {_norm_q(real_q): real_q for real_q in queries}

    ai_map = {}
    for i, entry in enumerate(parsed.get("results", [])):
        q = entry.get("query", "")
        # Exact match on normalized text first: two queries where one is a
        # substring of the other (e.g. "notion" / "notion alternative") must
        # never collide, so this is equality on the FULL normalized string,
        # never containment. If the model paraphrased the question instead of
        # echoing it, fall back to positional order (the prompt numbers the
        # questions 1..n and the model answers in that order), which is still
        # unambiguous and never mismatches on shared substrings.
        matched_q = norm_to_real.get(_norm_q(q))
        if matched_q is None and i < len(queries):
            matched_q = queries[i]
        if matched_q is None and queries:
            matched_q = queries[0]  # last-resort fallback
        if matched_q is None or matched_q in ai_map:
            continue  # never overwrite an already-filled query
        mentioned = entry.get("mentioned", [])
        ai_map[matched_q] = {}
        for pos, item in enumerate(mentioned, 1):
            if isinstance(item, dict):
                b, kind = item.get("brand", ""), item.get("kind", "mentioned")
            else:
                b, kind = str(item), "mentioned"  # tolerate older/simpler model output
            kind = "primary" if str(kind).lower() == "primary" else "mentioned"
            for real_b in brands:
                if real_b.lower() == b.lower():
                    ai_map[matched_q][real_b] = {"rank": pos, "kind": kind}
                    break
    return ai_map


def check_ai_visibility(brands, queries, api_key, n_runs=None, return_runs=False,
                        provider_id=DEFAULT_AI_PROVIDER):
    """Run the AI-visibility probe n_runs times against the chosen assistant and
    aggregate into per-brand per-query stats: average rank, mention rate
    (consistency), and whether the brand was ever the primary recommendation.

    n_runs defaults to AI_RUNS. A higher n_runs (paid Deep Audit) tightens the
    confidence interval of the bounded GEO score; the free tier uses fewer runs
    to keep cost low. return_runs=True additionally returns the raw list of
    per-run maps so the caller can compute the per-run GEO score distribution
    (the confidence interval) without a second pass. The aggregated ai_map shape
    is unchanged, so every existing caller keeps working (return_runs defaults
    to False)."""
    if n_runs is None:
        n_runs = AI_RUNS
    n_runs = max(1, min(MAX_AI_RUNS, int(n_runs)))
    runs = [_run_ai_visibility_once(brands, queries, api_key, provider_id) for _ in range(n_runs)]
    runs = [r for r in runs if r]  # drop failed runs
    if not runs:
        return ({}, []) if return_runs else {}

    agg = {q: {b: {"ranks": [], "hits": 0, "primary_hits": 0} for b in brands} for q in queries}
    for run in runs:
        for q in queries:
            for b in brands:
                cell = run.get(q, {}).get(b)
                if cell:
                    agg[q][b]["ranks"].append(cell["rank"])
                    agg[q][b]["hits"] += 1
                    if cell["kind"] == "primary":
                        agg[q][b]["primary_hits"] += 1

    n_ok = len(runs)
    ai_map = {}
    for q in queries:
        ai_map[q] = {}
        for b in brands:
            s = agg[q][b]
            if not s["ranks"]:
                continue
            ai_map[q][b] = {
                "rank": round(sum(s["ranks"]) / len(s["ranks"]), 1),
                # "consistency" is a PRESENCE rate (how many of n_ok runs the
                # brand appeared in at all, primary or merely mentioned) -
                # never rename/repurpose this as a primacy count.
                "consistency": round(100 * s["hits"] / n_ok),
                # "kind" is the aggregate majority across runs (primary iff
                # primary in at least half the runs it appeared in).
                "kind": "primary" if s["primary_hits"] * 2 >= s["hits"] else "mentioned",
                # "primary_hits" is the true PRIMACY count: how many of the
                # n_ok runs the brand was specifically the PRIMARY answer (not
                # merely present/mentioned). The frontend must attach THIS
                # count, never "consistency", to any "featured answer" /
                # "primary" / "réponse mise en avant" claim.
                "primary_hits": s["primary_hits"],
                "runs": n_ok,
            }
    return (ai_map, runs) if return_runs else ai_map


# ---------------------------------------------------------------------------
# Step 4 (paid Deep Audit only): GEO score + written remediation
# ---------------------------------------------------------------------------
def _geo_score(ranking, queries, brand):
    """In-process 0-100 GEO score for `brand`, computed ONLY from data already in
    `ranking` (share of voice + AI coverage + AI average rank). ZERO API calls.

    Three equally-weighted components, each 0-100, then averaged:
      - SERP share of voice (share_of_voice, already a %).
      - AI coverage (fraction of queries where the brand appears in AI answers).
      - AI rank quality (avg AI rank mapped: #1 -> 100, fading to 0 by rank ~10).
    A defensible, re-measurable number — not a claim, just arithmetic."""
    you = next((r for r in ranking if r["brand"].lower() == str(brand).lower()), None)
    if not you or not queries:
        return 0
    sov = float(you.get("share_of_voice") or 0)
    sov_c = max(0.0, min(100.0, sov))

    cov_str = str(you.get("ai_coverage") or "0/0")
    try:
        num = int(cov_str.split("/")[0])
    except (ValueError, IndexError):
        num = 0
    cov_c = max(0.0, min(100.0, 100.0 * num / len(queries)))

    ai_rank = you.get("ai_avg_rank")
    if ai_rank is None:
        rank_c = 0.0
    else:
        rank_c = max(0.0, min(100.0, (10.0 - float(ai_rank)) / 9.0 * 100.0))

    return int(round((sov_c + cov_c + rank_c) / 3.0))


def _score_from_components(sov_c, cov_c, rank_c):
    """The GEO arithmetic in one place: three 0-100 components averaged. Kept as a
    helper so the point score and the per-run distribution use the SAME formula."""
    return int(round((sov_c + cov_c + rank_c) / 3.0))


def _geo_bounded(ranking, queries, brand, per_run_maps):
    """Bounded GEO score: the point estimate plus a 95% confidence interval and a
    STABLE/MODERE/VOLATIL verdict, derived from the per-run AI-visibility maps.

    Rationale: the SERP component (share of voice) is deterministic within one
    audit, so all run-to-run variance comes from the stochastic AI component
    (coverage + AI rank). We therefore hold the SERP part constant and recompute
    the AI part for EACH run, giving a distribution of n scores. The interval is
    a plain 95% Wald interval on the mean (1.96 * standard error), which is
    honest, cheap, and explainable to a board in one sentence. With a single run
    we refuse to fabricate a bound (verdict SINGLE_RUN): a bound on n=1 would be a
    lie. Returns a dict, or None when the brand is absent / no runs exist."""
    you = next((r for r in ranking if r["brand"].lower() == str(brand).lower()), None)
    if not you or not queries or not per_run_maps:
        return None

    sov = float(you.get("share_of_voice") or 0)
    sov_c = max(0.0, min(100.0, sov))
    nq = len(queries)
    bl = str(brand).lower()

    scores = []
    for run in per_run_maps:
        hits, ranks = 0, []
        for q in queries:
            cell = None
            qmap = run.get(q, {})
            for b, c in qmap.items():
                if b.lower() == bl:
                    cell = c
                    break
            if cell:
                hits += 1
                ranks.append(cell.get("rank", 10))
        cov_c = max(0.0, min(100.0, 100.0 * hits / nq)) if nq else 0.0
        if ranks:
            avg_rank = sum(ranks) / len(ranks)
            rank_c = max(0.0, min(100.0, (10.0 - avg_rank) / 9.0 * 100.0))
        else:
            rank_c = 0.0
        scores.append(_score_from_components(sov_c, cov_c, rank_c))

    if not scores:
        return None
    n = len(scores)
    mean = sum(scores) / n
    point = int(round(mean))

    if n < 2:
        # Never bound a single sample. Report the point with an explicit caveat.
        return {"point": point, "half_width": None, "low": point, "high": point,
                "n": n, "verdict": "SINGLE_RUN", "scores": scores}

    # Sample standard deviation -> standard error -> 95% interval half-width.
    # Student-t (df=n-1), NOT the normal z=1.96: at the free tier's small n
    # (3, sometimes 2) the normal quantile is badly optimistic (t/z = 2.2x at
    # n=3, 6.5x at n=2), see _t975's docstring and the STABLE/... threshold
    # comment above for why this matters and how the verdict cutoffs were
    # re-derived to match.
    var = sum((s - mean) ** 2 for s in scores) / (n - 1)
    sd = math.sqrt(var)
    se = sd / math.sqrt(n)
    half_width = max(1, int(round(_t975(n - 1) * se)))  # never show +/- 0 on a stochastic measure
    low = max(0, point - half_width)
    high = min(100, point + half_width)

    ratio = half_width / max(point, 1)
    if sd == 0:
        # Every run produced the same score: the read IS stable, whatever the
        # level. A brand measured absent 3 times out of 3 is stably absent —
        # calling that VOLATIL (as the ratio test did at point=0) is nonsense.
        verdict = "STABLE"
    elif point < 10:
        # Near zero the relative ratio is meaningless (hw 1 / point 1 = 100%):
        # judge the band on its absolute width only.
        verdict = ("STABLE" if half_width <= STABLE_MAX_HALFWIDTH
                   else "VOLATIL" if half_width >= VOLATIL_MIN_HALFWIDTH
                   else "MODERE")
    elif half_width <= STABLE_MAX_HALFWIDTH and ratio <= STABLE_MAX_RATIO:
        verdict = "STABLE"
    elif half_width >= VOLATIL_MIN_HALFWIDTH or ratio >= VOLATIL_MIN_RATIO:
        verdict = "VOLATIL"
    else:
        verdict = "MODERE"

    return {"point": point, "half_width": half_width, "low": low, "high": high,
            "n": n, "verdict": verdict, "scores": scores}


def _build_remediation(ranking, queries, identified_as, evidence, brand, llm_key):
    """ONE paid-only LLM call. Produces a written verdict + blind spots + a
    concrete action plan, anchored STRICTLY on the already-computed ranking and
    the real query/competitor names (the model is told NOT to invent any).

    Blind spots are pre-computed IN PYTHON from the ranking (queries where the
    brand is absent but a named competitor is present) and handed to the model,
    so the surfaced gaps are factual. Returns
    {verdict, blind_spots:[...], actions:[...]} or None on any failure (the deep
    audit still renders its heatmap + score without the written report)."""
    you = next((r for r in ranking if r["brand"].lower() == str(brand).lower()), None)
    if not you:
        return None

    you_cells = you.get("cells") or {}
    you_ai = you.get("ai_cells") or {}
    # Factual blind spots: queries where the brand is absent (SERP + AI) but at
    # least one OTHER named competitor shows up.
    blind = []
    for q in queries:
        brand_here = q in you_cells or q in you_ai
        if brand_here:
            continue
        rivals = []
        for r in ranking:
            if r["brand"].lower() == str(brand).lower():
                continue
            if q in (r.get("cells") or {}) or q in (r.get("ai_cells") or {}):
                rivals.append(r["brand"])
        if rivals:
            blind.append({"query": q, "dominated_by": rivals[:3]})
    blind = blind[:3]

    comp_names = [r["brand"] for r in ranking]
    prompt = (
        "You are a GEO (generative engine optimization) consultant writing a short, factual "
        "remediation section for a brand visibility audit. Use ONLY the data given below. Do NOT "
        "invent competitors, queries, or metrics that are not listed. Return STRICT JSON only:\n"
        '{"verdict":"2-3 sentence honest assessment of this brand visibility",'
        '"actions":["concrete action 1","action 2","action 3","action 4"]}\n\n'
        "Brand: " + str(brand) + "\n"
        "What this brand is: " + (identified_as or "(not identified)") + "\n"
        "Buyer queries analyzed: " + json.dumps(queries, ensure_ascii=False) + "\n"
        "Brands tracked (competitors): " + json.dumps(comp_names, ensure_ascii=False) + "\n"
        "This brand SERP share of voice: " + str(you.get("share_of_voice")) + "%\n"
        "This brand SERP coverage: " + str(you.get("query_coverage")) + "\n"
        "This brand AI coverage: " + str(you.get("ai_coverage")) + "\n"
        "Blind spots (queries where this brand is ABSENT but a named competitor ranks): "
        + json.dumps(blind, ensure_ascii=False) + "\n\n"
        "Write 4-6 concrete, specific actions the brand can take to improve its visibility for "
        "the EXACT queries above (reference the real query text and the real competitors named). "
        "Keep every action grounded in the data; no generic filler."
    )
    try:
        text, _ = _anthropic_message(INFER_MODEL, 900, prompt, llm_key,
                                     what="Claude API (remediation)")
    except Exception:
        logger.exception("remediation call failed")
        return None
    parsed = _extract_json_object(text)
    if parsed is None:
        return None
    verdict = str(parsed.get("verdict", "") or "").strip()[:800]
    actions = [str(a).strip()[:300] for a in parsed.get("actions", []) if str(a).strip()][:6]
    if not verdict and not actions:
        return None
    return {"verdict": verdict, "blind_spots": blind, "actions": actions}


# ---------------------------------------------------------------------------
# Durable audit history (the longitudinal moat).
#
# Render's free tier has an ephemeral disk wiped on every deploy/sleep, so the
# in-memory/file cache is NOT a durable record. To accumulate a proprietary,
# non-backfillable timeline of AI-visibility measurements (the one advantage a
# late competitor can never reconstruct), each real audit is appended to an
# EXTERNAL store: Cloudflare D1 (managed SQLite), reached over plain HTTPS with
# the stdlib — no driver, no new dependency.
#
# SECURITY: D1_TOKEN must be a Cloudflare token scoped strictly to D1:Edit on a
# SINGLE database, with ZERO Zone/DNS permission (it shares the account that
# holds the nadelio.com domain). It lives only in a Render env var, never in
# code. Every write is parameterized (never string-formatted SQL).
#
# FAIL-OPEN: logging is best-effort. If the store is unset, unreachable, over
# quota, or errors for any reason, the audit response is UNAFFECTED. History is
# never in the critical path of what the user paid for or waited for.
#
# Table: self-created by _log_audit_history on first write (CREATE TABLE IF
# NOT EXISTS, same pattern as every other D1 table below), no manual D1
# console step required:
#   CREATE TABLE IF NOT EXISTS audit_history (
#     id INTEGER PRIMARY KEY AUTOINCREMENT,
#     ts TEXT NOT NULL, brand TEXT NOT NULL, sector TEXT, market TEXT,
#     query_language TEXT, tier TEXT, geo_point INTEGER, geo_half_width INTEGER,
#     geo_verdict TEXT, n_runs INTEGER, share_of_voice REAL, ai_avg_rank REAL,
#     n_queries INTEGER, n_brands INTEGER);
# ---------------------------------------------------------------------------
_CF_ACCOUNT_ID = os.environ.get("CF_ACCOUNT_ID")
_CF_D1_DB_ID = os.environ.get("CF_D1_DB_ID")
_CF_D1_TOKEN = os.environ.get("CF_D1_TOKEN")


def _history_enabled():
    return bool(_CF_ACCOUNT_ID and _CF_D1_DB_ID and _CF_D1_TOKEN)


def _d1_query(sql, params=None, timeout=6):
    """POST one parameterized SQL statement to Cloudflare D1 over HTTPS (stdlib).
    Returns the list of result rows (dicts). Raises on transport/API error; the
    caller decides whether to swallow it."""
    url = ("https://api.cloudflare.com/client/v4/accounts/"
           + urllib.parse.quote(_CF_ACCOUNT_ID) + "/d1/database/"
           + urllib.parse.quote(_CF_D1_DB_ID) + "/query")
    body = json.dumps({"sql": sql, "params": params or []}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body, method="POST",
        headers={
            "Authorization": "Bearer " + _CF_D1_TOKEN,
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    if not payload.get("success"):
        raise RuntimeError("D1 error: %s" % (payload.get("errors"),))
    res = payload.get("result") or []
    return (res[0].get("results") if res else []) or []


def _log_audit_history(result):
    """Append one audit measurement to the durable store. BEST-EFFORT: never
    raises, never blocks the audit. No-op when history storage is not configured
    (so local dev and unconfigured deploys behave exactly as before)."""
    if not _history_enabled():
        return
    try:
        you = next((r for r in (result.get("ranking") or [])
                    if r.get("brand", "").lower() == str(result.get("brand", "")).lower()), None)
        geo = result.get("geo") or {}
        # Self-create on first write, exactly like every OTHER D1 table in this
        # file (subscribers, shares, funnel_events, pageviews, ui_events,
        # analyze_failures). audit_history used to be the one table that
        # required a manual "create once in the D1 console" step (see the
        # comment above); if that step was ever skipped, or the table dropped,
        # every write here failed silently and both the longitudinal moat and
        # every paid-monitoring swing/drop alert were permanently dead with no
        # visible signal. CREATE TABLE IF NOT EXISTS makes that impossible.
        _d1_query(
            "CREATE TABLE IF NOT EXISTS audit_history ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, brand TEXT NOT NULL, "
            "sector TEXT, market TEXT, query_language TEXT, tier TEXT, geo_point INTEGER, "
            "geo_half_width INTEGER, geo_verdict TEXT, n_runs INTEGER, share_of_voice REAL, "
            "ai_avg_rank REAL, n_queries INTEGER, n_brands INTEGER)")
        _d1_query(
            "INSERT INTO audit_history (ts, brand, sector, market, query_language, "
            "tier, geo_point, geo_half_width, geo_verdict, n_runs, share_of_voice, "
            "ai_avg_rank, n_queries, n_brands) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                datetime.datetime.now(datetime.timezone.utc).isoformat(),
                str(result.get("brand", ""))[:200],
                str(result.get("sector", ""))[:200],
                str(result.get("market", ""))[:120],
                str(result.get("query_language", ""))[:60],
                str(result.get("tier", ""))[:20],
                geo.get("point"),
                geo.get("half_width"),
                geo.get("verdict"),
                geo.get("n"),
                (you or {}).get("share_of_voice"),
                (you or {}).get("ai_avg_rank"),
                len(result.get("queries") or []),
                len(result.get("ranking") or []),
            ],
        )
    except Exception:
        # Swallow everything: a history failure must never surface to the user.
        logger.warning("audit history log failed (non-fatal)", exc_info=True)


def _last_bounded_score(brand):
    """The most recent bounded score logged for `brand`, from D1. Returns
    {point, verdict, ts} or None (no history, or history not configured).
    Used to detect a week-over-week swing worth alerting on."""
    if not _history_enabled():
        return None
    try:
        rows = _d1_query(
            "SELECT ts, geo_point, geo_verdict FROM audit_history "
            "WHERE brand = ? ORDER BY ts DESC LIMIT 1",
            [brand])
    except Exception:
        return None
    if not rows:
        return None
    r = rows[0]
    return {"ts": r.get("ts"), "point": r.get("geo_point"), "verdict": r.get("geo_verdict")}


def _run_full_audit(brand, hint="", market="", n_runs=None, ai_provider=DEFAULT_AI_PROVIDER):
    """The measurement pipeline shared by a live user audit and the monitoring
    cron: identify -> geolocated SERP -> bounded AI visibility -> bounded GEO
    score. Returns a result dict shaped like api_analyze's, or None if either
    API key is missing or inference fails. No quota/payment gate here — the
    caller (cron) already gates on an active paid subscription."""
    serp_key = os.environ.get("BRIGHTDATA_API_KEY")
    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not serp_key or not llm_key:
        return None
    ai_key = _provider_key(ai_provider) or llm_key

    recon = _recon(brand, serp_key)
    try:
        strat = infer_strategy(brand, llm_key, hint or None, market=market or None,
                               max_queries=MAX_QUERIES_FREE, evidence=recon["evidence"] or None)
    except RuntimeError:
        return None
    competitors, queries, market_out, query_language, identified_as, confidence = \
        _sanitize_strategy(brand, strat, MAX_QUERIES_FREE, has_evidence=bool(recon.get("evidence")))
    if not competitors or not queries:
        return None

    gl, hl = _market_locale(market or market_out)
    ranking = analyze(competitors, queries, serp_key, gl=gl, hl=hl)
    ai_vis, ai_runs = check_ai_visibility(competitors, queries, ai_key,
                                          n_runs=n_runs or FREE_AI_RUNS, return_runs=True,
                                          provider_id=ai_provider)
    for entry in ranking:
        b = entry["brand"]
        entry["ai_cells"] = {}
        for q in queries:
            cell = ai_vis.get(q, {}).get(b)
            if cell:
                entry["ai_cells"][q] = cell
        ai_mentioned = sum(1 for q in queries if q in ai_vis and b in ai_vis[q])
        entry["ai_coverage"] = f"{ai_mentioned}/{len(queries)}"
        ai_ranks = [ai_vis[q][b]["rank"] for q in queries if q in ai_vis and b in ai_vis[q]]
        entry["ai_avg_rank"] = round(sum(ai_ranks) / len(ai_ranks), 1) if ai_ranks else None

    geo = _geo_bounded(ranking, queries, brand, ai_runs)
    return {
        "brand": brand, "sector": strat.get("sector", ""), "market": market_out,
        "query_language": query_language, "queries": queries, "ranking": ranking,
        "mode": "live", "tier": "monitor", "identified_as": identified_as,
        "confidence": confidence, "geo": geo, "geo_score": (geo or {}).get("point"),
        "ai_provider": ai_provider,
    }


# ---------------------------------------------------------------------------
# Monitoring cron (the recurring product's engine).
#
# Runs weekly, triggered by an external scheduler (GitHub Actions) hitting
# /api/cron/monitor with a shared secret — no scheduler lives inside this
# process (Render free dynos sleep, an in-process scheduler would not fire
# reliably). Stripe is the registry: list active subscriptions, read
# tier/brand/market from their metadata, no local subscriber list needed.
#
# COST DISCIPLINE: n_runs is capped per tier (SUB_TIERS), and the whole run
# stops early if BEST-EFFORT budget signals look off — this is the one place
# identified as able to turn cash-negative if left unbounded.
# ---------------------------------------------------------------------------
CRON_SECRET = os.environ.get("CRON_SECRET")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY")
ALERT_FROM_EMAIL = os.environ.get("ALERT_FROM_EMAIL", "alerts@nadelio.com")


def _send_email(to_email, subject, html):
    """POST to the Resend API (stdlib urllib, no dependency). Best-effort: never
    raises. No-op when RESEND_API_KEY is unset."""
    if not RESEND_API_KEY or not to_email or "@" not in to_email:
        return False
    try:
        body = json.dumps({
            "from": "Nadelio <" + ALERT_FROM_EMAIL + ">",
            "to": [to_email], "subject": subject, "html": html,
        }).encode("utf-8")
        req = urllib.request.Request(
            "https://api.resend.com/emails", data=body, method="POST",
            headers={"Authorization": "Bearer " + RESEND_API_KEY,
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            resp.read()
        return True
    except Exception:
        logger.warning("alert email failed for %s (non-fatal)", to_email, exc_info=True)
        return False


# ---------------------------------------------------------------------------
# Live-audit failure observability (owner alerting).
#
# Every /api/analyze fallback to SAMPLE (missing API key, could-not-infer, or
# a live exception) means a visitor received a demo dossier of a different
# brand instead of a real measurement, and the whole product's premise
# (bounded, honest, third-party measurement) silently broke for that request.
# Before this, the only trace was a logger.exception line nobody was watching
# (exactly the 17 July 2026 BrightData/Anthropic outage ran unnoticed for a
# while). This makes each failure durable (D1, survives a restart, gated on
# _history_enabled so it is a clean no-op when D1 is unconfigured), countable
# (surfaced on /analytics), and ALERTS the owner by email, throttled hard so a
# sustained outage sends one summary email per hour, never one per request.
#
# Thread-safety: reuses _live_lock, the app's single module lock for shared
# in-memory state (see its definition above), instead of adding a second lock,
# so there is exactly one lock to reason about once the deploy moves to a
# threaded gunicorn worker (see the render.yaml note near the bottom).
# ---------------------------------------------------------------------------
OWNER_ALERT_EMAIL = os.environ.get("OWNER_ALERT_EMAIL", "adam.chabbi94@gmail.com")
ALERT_THROTTLE_SECONDS = 3600  # at most one failure-summary email per hour

_recent_analyze_failures = []  # [(unix_ts, brand, reason), ...] last hour, guarded by _live_lock
_last_failure_alert_ts = 0.0   # unix ts the last alert email was actually sent, guarded by _live_lock


def _store_analyze_failure(row):
    """Fire-and-forget D1 write of one live-audit failure. Runs on a daemon
    thread, exactly like _store_pageview / _store_ui_event below, so an
    outage that is ALREADY the reason for the fallback never gets slower
    because of this. Creates its table on first write. Never raises."""
    try:
        _d1_query(
            "CREATE TABLE IF NOT EXISTS analyze_failures ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, brand TEXT, reason TEXT)")
        _d1_query(
            "INSERT INTO analyze_failures (ts, brand, reason) VALUES (?,?,?)",
            list(row))
    except Exception:
        logger.warning("analyze failure D1 write failed (non-fatal)", exc_info=True)


def _send_failure_alert_email(brand, reason, count_last_hour):
    """Best-effort, throttled owner alert. Runs on a daemon thread. French
    copy, correct accents, straight ASCII apostrophes, no dashes."""
    try:
        subject = "Nadelio : echecs d'audit en direct (%d en une heure)" % count_last_hour
        html = (
            "<p>%d echec(s) d'audit en direct au cours de la derniere heure. "
            "Chaque visiteur touche a recu l'echantillon de demonstration a la place "
            "d'une vraie mesure, sans le savoir.</p>"
            "<p>Dernier echec : marque <b>%s</b>, raison <b>%s</b>.</p>"
            "<p>Verifie les fournisseurs (BrightData, Anthropic) et les logs Render "
            "des que possible.</p>"
        ) % (count_last_hour, _html.escape(str(brand) or "(inconnue)"),
             _html.escape(str(reason)))
        _send_email(OWNER_ALERT_EMAIL, subject, html)
    except Exception:
        logger.warning("failure alert email failed (non-fatal)", exc_info=True)


def _record_analyze_failure(brand, reason):
    """Called from EVERY /api/analyze path that falls back to SAMPLE (missing
    key, could-not-infer, or a live exception). Logs at error level with the
    brand and the underlying reason, durably counts the failure (D1,
    best-effort), and fires a throttled owner alert email summarizing the
    recent failures (at most one email per hour, never one per request).
    Never raises, never slows the response it is called from: the D1 write
    and the email are both dispatched on daemon threads."""
    global _last_failure_alert_ts
    logger.error("ANALYZE FAILURE brand=%r reason=%s", brand, reason)
    now = time.time()
    send_alert = False
    count_last_hour = 0
    with _live_lock:
        _recent_analyze_failures.append((now, str(brand)[:200], str(reason)[:200]))
        cutoff = now - ALERT_THROTTLE_SECONDS
        while _recent_analyze_failures and _recent_analyze_failures[0][0] < cutoff:
            _recent_analyze_failures.pop(0)
        count_last_hour = len(_recent_analyze_failures)
        if now - _last_failure_alert_ts >= ALERT_THROTTLE_SECONDS:
            _last_failure_alert_ts = now
            send_alert = True

    if _history_enabled():
        threading.Thread(
            target=_store_analyze_failure,
            args=((datetime.datetime.now(datetime.timezone.utc).isoformat(),
                   str(brand)[:200], str(reason)[:200]),),
            daemon=True,
        ).start()

    if send_alert:
        threading.Thread(
            target=_send_failure_alert_email,
            args=(brand, reason, count_last_hour),
            daemon=True,
        ).start()


def _list_active_subscriptions(secret_key):
    """All active/trialing Stripe subscriptions with our tier/brand metadata,
    paginated. Stripe caps list results at 100/page; monitoring volume is far
    below that for the foreseeable future, but pagination is handled anyway."""
    out, starting_after = [], None
    for _ in range(20):  # hard ceiling: never loop unboundedly on a Stripe glitch
        path = "/subscriptions?status=active&limit=100"
        if starting_after:
            path += "&starting_after=" + urllib.parse.quote(starting_after)
        try:
            page = _stripe_request("GET", path, secret_key)
        except RuntimeError:
            break
        data = page.get("data") or []
        out.extend(data)
        if not page.get("has_more") or not data:
            break
        starting_after = data[-1].get("id")
    return out


def _verdict_word(v, fr=False):
    if fr:
        return {"STABLE": "stable", "MODERE": "modéré", "VOLATIL": "volatil",
                "SINGLE_RUN": "non borné"}.get(v, v or "")
    return {"STABLE": "stable", "MODERE": "moderate", "VOLATIL": "volatile",
            "SINGLE_RUN": "unbounded"}.get(v, v or "")


@app.route("/api/cron/monitor", methods=["POST"])
def api_cron_monitor():
    """Weekly monitoring run. Auth: header X-Cron-Secret must match CRON_SECRET
    (constant-time compare). Best-effort per subscriber: one failure never
    blocks the rest. Returns a summary, never subscriber PII beyond counts."""
    if not CRON_SECRET or not hmac.compare_digest(
            request.headers.get("X-Cron-Secret", ""), CRON_SECRET):
        return jsonify({"error": "unauthorized"}), 401

    secret_key, _ = _stripe_config()
    if not secret_key:
        return jsonify({"error": "stripe not configured"}), 502

    subs = _list_active_subscriptions(secret_key)
    measured, alerted, errors = 0, 0, 0
    for sub in subs:
        meta = sub.get("metadata") or {}
        tier = meta.get("tier", "")
        brand = (meta.get("brand") or "").strip()
        market = meta.get("market", "")
        tier_cfg = SUB_TIERS.get(tier)
        if not brand or not tier_cfg:
            continue
        try:
            before = _last_bounded_score(brand)
            result = _run_full_audit(brand, market=market, n_runs=tier_cfg["n_runs"])
            if result is None:
                errors += 1
                continue
            _log_audit_history(result)
            measured += 1

            geo = result.get("geo") or {}
            verdict = geo.get("verdict")
            point = geo.get("point")
            swing = (before and before.get("verdict") == "STABLE"
                     and verdict in ("VOLATIL", "MODERE"))
            drop = (before and isinstance(before.get("point"), (int, float))
                    and isinstance(point, (int, float))
                    and (before["point"] - point) >= 10)
            if (swing or drop):
                customer_email = ""
                try:
                    cust = sub.get("customer")
                    if cust:
                        c = _stripe_request("GET", "/customers/" + urllib.parse.quote(str(cust)), secret_key)
                        customer_email = c.get("email") or ""
                except RuntimeError:
                    pass
                if customer_email:
                    # The weekly alert is the only thing a paying subscriber
                    # receives between audits, so it must arrive in the
                    # language the audit itself was measured in (the same
                    # signal the /r/<token> share page already uses), not
                    # hardcoded English.
                    fr = _share_is_fr(result)
                    half_width_txt = ("&plusmn;" + str(geo.get("half_width"))) if geo.get("half_width") is not None else ""
                    if fr:
                        reason = "vient de devenir volatil" if swing else ("a perdu %s points" % round(before["point"] - point))
                        subject = "Alerte Nadelio : %s %s" % (brand, reason)
                        body = (
                            "<p><b>%s</b> %s.</p><p>Nouveau score : <b>%s</b>%s, verdict <b>%s</b>.</p>"
                            "<p><a href=\"%s/brand/%s\">Voir la lecture complète</a></p>" % (
                                _html.escape(brand), _html.escape(reason), point, half_width_txt,
                                _verdict_word(verdict, fr=True), SITE_URL, _brand_key(brand)))
                    else:
                        reason = "turned volatile" if swing else "dropped %s points" % round(before["point"] - point)
                        subject = "Nadelio alert: %s %s" % (brand, reason)
                        body = (
                            "<p><b>%s</b> just %s.</p><p>New score: <b>%s</b>%s, verdict <b>%s</b>.</p>"
                            "<p><a href=\"%s/brand/%s\">See the full read</a></p>" % (
                                _html.escape(brand), _html.escape(reason), point, half_width_txt,
                                _verdict_word(verdict), SITE_URL, _brand_key(brand)))
                    _send_email(customer_email, subject, body)
                    alerted += 1
        except Exception:
            errors += 1
            logger.warning("monitoring run failed for brand=%r (non-fatal)", brand, exc_info=True)

    return jsonify({"subscriptions": len(subs), "measured": measured,
                     "alerted": alerted, "errors": errors})


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    """The homepage is the bounded-measurement instrument (web/v2.html).

    Served from the same stamped copy as /v2, so a returning visitor can never
    pair a fresh HTML with a stale script (see _ASSET_VERSION), and no-cache so
    the pairing is always the current deploy's.

    Stripe returns land here (/?paid=<session>&brand=..., /?sub=<session>) and
    the page's bootstrap resumes them; that path is the reason this route must
    never serve anything that cannot handle those params.

    The previous homepage stays reachable at /index.html (Flask serves web/ at
    the root), so reverting this switch is this one function.
    """
    if _V2_HTML is None:
        # Only on a broken deploy where the file could not be read at import.
        return send_from_directory("web", "v2.html")
    resp = app.make_response(_V2_HTML)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/compare", strict_slashes=False)
def compare():
    resp = send_from_directory("web", "compare.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/methodology", strict_slashes=False)
def methodology():
    resp = send_from_directory("web", "methodology.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/roadmap", strict_slashes=False)
def roadmap():
    resp = send_from_directory("web", "roadmap.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/guide", strict_slashes=False)
def guide():
    # The print-first onboarding guide (French). Served so it has a real URL
    # to link from outreach, and so a browser can print it to PDF directly.
    resp = send_from_directory("web", "guide.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/arbitration-agreement", strict_slashes=False)
def arbitration_agreement():
    resp = send_from_directory("web", "arbitration-agreement.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/settlement", strict_slashes=False)
def settlement():
    resp = send_from_directory("web", "settlement.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


# Deploy-consistency fix (wave 2b): v2.html referenced /assets/v2/nadelio.js
# and nadelio.css by a bare, unversioned path, while v2.html itself carried a
# 1-hour Cache-Control below and the two assets got Flask's default static
# handling (no explicit Cache-Control, conditional ETag caching only). Those
# two facts combine badly: a returning visitor's browser can hold a FRESH
# v2.html (from a new deploy) while still serving a STALE cached nadelio.js
# or nadelio.css from before it (or the reverse, a cached old HTML fetching
# assets that have since changed shape) - a silent pairing mismatch with no
# error, since the two files are never versioned together.
#
# Fix: stamp both asset refs with a "?v=<build stamp>" query string that
# changes on every deploy (Render restarts this process on every deploy, so a
# time-of-import stamp is sufficient, no git lookup needed), and stop letting
# v2.html itself be cached for an hour so a returning visitor's next request
# always gets the current HTML/stamp pairing. This intentionally leaves the
# three.js vendor script and the self-hosted fonts untouched (they are not
# re-referenced here), so their existing default caching is unaffected.
_ASSET_VERSION = str(int(time.time()))


def _load_v2_html():
    try:
        with open(os.path.join(app.static_folder, "v2.html"), "r", encoding="utf-8") as f:
            html = f.read()
    except OSError:
        return None
    html = html.replace(
        '"/assets/v2/nadelio.css"', '"/assets/v2/nadelio.css?v=' + _ASSET_VERSION + '"'
    ).replace(
        '"/assets/v2/nadelio.js"', '"/assets/v2/nadelio.js?v=' + _ASSET_VERSION + '"'
    )
    return html


# Read and stamped once at import time (one Render process = one deploy, so
# this never goes stale within a running process); recomputed on every
# restart, i.e. every deploy.
_V2_HTML = _load_v2_html()


@app.route("/v2", strict_slashes=False)
def v2():
    # Studio-grade one-pager (dark instrument world, WebGL measurement).
    # Served self-hosted: /assets/site.js and /assets/fonts are static, zero CDN.
    if _V2_HTML is None:
        # Should not happen outside a broken deploy (the file always ships in
        # web/) - fall back to the plain static file rather than a 500.
        return send_from_directory("web", "v2.html")
    resp = app.make_response(_V2_HTML)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    # no-cache (not no-store): still allows a fast conditional revalidation,
    # but a returning visitor's browser must always check back with the
    # server instead of serving a possibly-stale copy from a previous deploy -
    # see _ASSET_VERSION above for why that pairing matters.
    resp.headers["Cache-Control"] = "no-cache, must-revalidate"
    return resp


@app.route("/api/providers")
def api_providers():
    """The AI assistants currently available to measure against (only those with
    a configured key), so the UI can build the selector dynamically and never
    offer an assistant that would fail. Default is the resolved provider."""
    avail = [{"id": pid, "label": _AI_PROVIDERS[pid]["label"]}
             for pid in _available_providers()]
    return jsonify({"providers": avail, "default": _resolve_provider(None)})


# ---------------------------------------------------------------------------
# Waitlist (Pro launch email capture)
# ---------------------------------------------------------------------------
_WAITLIST_FILE = pathlib.Path(os.environ.get("WAITLIST_FILE", "waitlist.json"))


def _load_waitlist():
    try:
        return json.loads(_WAITLIST_FILE.read_text())
    except Exception:
        return []


def _save_waitlist(wl):
    try:
        tmp = _WAITLIST_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(wl))
        os.replace(str(tmp), str(_WAITLIST_FILE))
    except Exception:
        logger.exception("Failed to write waitlist file")


_waitlist = _load_waitlist()


WAITLIST_WEBHOOK_URL = os.environ.get("WAITLIST_WEBHOOK_URL")


def _notify_waitlist_webhook(email):
    if not WAITLIST_WEBHOOK_URL:
        return
    try:
        body = json.dumps({"email": email, "source": "nadelio-waitlist"}).encode()
        req = urllib.request.Request(
            WAITLIST_WEBHOOK_URL, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:
        logger.exception("Waitlist webhook notification failed for %s", email)


def _read_json():
    """Parse the request body as JSON, decoding it as UTF-8 explicitly.

    Flask's request.get_json(force=True) can silently return None on a body
    that carries raw UTF-8 bytes (e.g. an accented brand name like
    "Intermarche" with an e-acute) when the client's Content-Type omits a
    charset — which then reads as an empty brand and a bogus "Type a brand
    name" 400. Reading the raw bytes and decoding UTF-8 ourselves fixes
    accented input for every endpoint. Falls back to Flask's parser, then to
    an empty dict, so a malformed body never raises."""
    try:
        raw = request.get_data(cache=True)
        if raw:
            parsed = json.loads(raw.decode("utf-8"))
            if isinstance(parsed, dict):
                return parsed
    except Exception:
        pass
    try:
        return request.get_json(force=True, silent=True) or {}
    except Exception:
        return {}


@app.route("/api/waitlist", methods=["POST"])
def api_waitlist():
    data = _read_json()
    email = (data.get("email") or "").strip().lower()
    if not email or "@" not in email or len(email) > 200:
        return jsonify({"error": "Invalid email"}), 400
    with _live_lock:
        if email not in _waitlist and len(_waitlist) < 10000:
            _waitlist.append(email)
            _save_waitlist(_waitlist)
    app.logger.warning("WAITLIST SIGNUP: %s", email)
    _notify_waitlist_webhook(email)
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Stripe Checkout endpoints (Deep Audit paywall)
# ---------------------------------------------------------------------------
@app.route("/api/checkout", methods=["POST"])
def api_checkout():
    """Create a Stripe Checkout session for a one-time Deep Audit and return
    {url} for the frontend to redirect to. The brand to audit is stored in the
    session metadata so it can be recovered (and trusted) at verification time."""
    secret_key, price_id = _stripe_config()
    if not secret_key or not price_id:
        return jsonify({"error": "payments not configured"}), 502

    data = _read_json()
    brand = (data.get("brand") or "").strip()
    hint = (data.get("hint") or "").strip()
    market = (data.get("market") or "").strip()
    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    site = _site_base()
    # success_url MUST carry the literal {CHECKOUT_SESSION_ID} placeholder —
    # Stripe substitutes the real session id on redirect. We also pass the brand
    # back (url-encoded) so the home page can resume the audit after payment.
    success_url = (site + "/?paid={CHECKOUT_SESSION_ID}&brand="
                   + urllib.parse.quote(brand))
    cancel_url = site + "/"

    form = {
        "mode": "payment",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": success_url,
        "cancel_url": cancel_url,
        # Trust the brand from metadata at verify time, not from the client.
        "metadata[brand]": brand[:MAX_BRAND_LEN],
    }
    # Carry hint/market so the resumed audit can reproduce the same targeting.
    if hint:
        form["metadata[hint]"] = hint[:200]
    if market:
        form["metadata[market]"] = market[:40]

    try:
        session = _stripe_request("POST", "/checkout/sessions", secret_key, form)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    url = session.get("url")
    if not url:
        logger.error("Stripe checkout session created without a url")
        return jsonify({"error": "Stripe did not return a checkout URL"}), 502
    return jsonify({"url": url})


@app.route("/api/verify-payment", methods=["POST"])
def api_verify_payment():
    """Verify a returned Checkout session was actually paid. Returns
    {ok:true, brand} on success. Does NOT consume the session here — consumption
    happens atomically inside /api/analyze when the deep audit actually runs, so
    a verify call never burns the single-use unlock on its own."""
    secret_key, price_id = _stripe_config()
    if not secret_key or not price_id:
        return jsonify({"error": "payments not configured"}), 502

    data = _read_json()
    session_id = (data.get("session_id") or "").strip()
    if not session_id:
        return jsonify({"ok": False, "error": "Missing session_id"}), 400

    ok, brand, market = _verify_paid_session(session_id)
    if not ok:
        return jsonify({"ok": False})
    with _live_lock:
        already = session_id in _consumed_sessions
    # Report whether this paid session still has its (single) deep audit unused,
    # so the frontend can message clearly if the user refreshes an old link.
    # market: the FREE preview's market, stamped on checkout - so the resumed
    # paid deep audit can force the same market instead of re-inferring one.
    return jsonify({"ok": True, "brand": brand, "market": market, "consumed": already})


# ---------------------------------------------------------------------------
# Monitoring subscriptions (Étage 0 of the plan: the recurring floor).
#
# Three tiers, each capping how many brands are monitored and how many AI runs
# each weekly measurement spends (the per-tier cap is what keeps the API cost
# BOUNDED BY CONTRACT — the one identified way this product can go cash-negative).
#
# ARCHITECTURE: Stripe is the source of truth. The tier/brand/market metadata is
# stamped on the SUBSCRIPTION object itself (subscription_data[metadata]), so the
# monitoring cron can simply list active subscriptions from Stripe and needs no
# webhook and no local registry to survive restarts. The D1 insert below is a
# best-effort mirror for our own archive, never load-bearing.
# ---------------------------------------------------------------------------
SUB_TIERS = {
    # tier      display        env var holding the Stripe recurring price   caps
    "starter": {"label": "Starter", "env": "STRIPE_PRICE_MONITOR_STARTER", "brands": 1,  "n_runs": 3},
    "pro":     {"label": "Pro",     "env": "STRIPE_PRICE_MONITOR_PRO",     "brands": 3,  "n_runs": 5},
    "agency":  {"label": "Agency",  "env": "STRIPE_PRICE_MONITOR_AGENCY",  "brands": 10, "n_runs": 8},
}


def _sub_price(tier):
    t = SUB_TIERS.get(tier)
    return os.environ.get(t["env"]) if t else None


@app.route("/api/subscribe", methods=["POST"])
def api_subscribe():
    """Create a Stripe Checkout session in subscription mode for a monitoring
    tier. Returns {url}. Clean 502 when the tier's recurring price is not
    configured, so the free flow is never impacted."""
    secret_key, _ = _stripe_config()
    data = _read_json()
    tier = (data.get("tier") or "").strip().lower()
    brand = (data.get("brand") or "").strip()
    email = (data.get("email") or "").strip()
    market = (data.get("market") or "").strip()
    price_id = _sub_price(tier)
    if not secret_key or not price_id:
        return jsonify({"error": "subscriptions not configured"}), 502
    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    site = _site_base()
    form = {
        "mode": "subscription",
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "success_url": site + "/?sub={CHECKOUT_SESSION_ID}",
        "cancel_url": site + "/",
        # Stamp the operating metadata on the SUBSCRIPTION itself: the cron
        # lists active subscriptions and reads these to know what to monitor.
        "subscription_data[metadata][tier]": tier,
        "subscription_data[metadata][brand]": brand[:MAX_BRAND_LEN],
    }
    if market:
        form["subscription_data[metadata][market]"] = market[:40]
    if email and "@" in email:
        form["customer_email"] = email[:200]

    try:
        session = _stripe_request("POST", "/checkout/sessions", secret_key, form)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502
    url = session.get("url")
    if not url:
        logger.error("Stripe subscription session created without a url")
        return jsonify({"error": "Stripe did not return a checkout URL"}), 502
    return jsonify({"url": url})


@app.route("/api/verify-subscription", methods=["POST"])
def api_verify_subscription():
    """Confirm a returned subscription Checkout session is active/paid. Returns
    {ok, brand, tier} for the confirmation banner. Also mirrors the subscriber
    into D1 (best-effort, never load-bearing: Stripe stays the registry)."""
    secret_key, _ = _stripe_config()
    if not secret_key:
        return jsonify({"error": "subscriptions not configured"}), 502
    data = _read_json()
    session_id = (data.get("session_id") or "").strip()
    if not session_id or not re.fullmatch(r"[A-Za-z0-9_]+", session_id):
        return jsonify({"ok": False, "error": "Missing session_id"}), 400
    try:
        session = _stripe_request(
            "GET", "/checkout/sessions/" + urllib.parse.quote(session_id)
            + "?expand[]=subscription", secret_key)
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 502

    sub = session.get("subscription")
    paid = (session.get("mode") == "subscription"
            and session.get("status") == "complete"
            and isinstance(sub, dict)
            and sub.get("status") in ("active", "trialing"))
    if not paid:
        return jsonify({"ok": False})

    meta = sub.get("metadata") or {}
    brand = str(meta.get("brand") or "")[:MAX_BRAND_LEN]
    tier = str(meta.get("tier") or "")
    email = str((session.get("customer_details") or {}).get("email") or "")

    # Best-effort archive mirror (auto-creates its table; failure never surfaces).
    if _history_enabled():
        try:
            _d1_query("CREATE TABLE IF NOT EXISTS subscribers ("
                      "id INTEGER PRIMARY KEY AUTOINCREMENT, created TEXT, "
                      "stripe_subscription_id TEXT UNIQUE, email TEXT, tier TEXT, "
                      "brand TEXT, market TEXT, status TEXT)")
            _d1_query("INSERT OR IGNORE INTO subscribers "
                      "(created, stripe_subscription_id, email, tier, brand, market, status) "
                      "VALUES (?,?,?,?,?,?,?)",
                      [datetime.datetime.now(datetime.timezone.utc).isoformat(),
                       str(sub.get("id") or ""), email[:200], tier, brand,
                       str(meta.get("market") or "")[:40],
                       str(sub.get("status") or "")])
        except Exception:
            logger.warning("subscriber D1 mirror failed (non-fatal)", exc_info=True)

    return jsonify({"ok": True, "brand": brand, "tier": tier})


def _sanitize_strategy(brand, strat, max_queries=MAX_QUERIES_FREE, has_evidence=True):
    """Shared sanitation for a raw infer_strategy() result: strip stray
    characters from competitor names, cap list sizes, and make sure the
    queried brand itself is present as the first competitor.

    Returns (competitors, queries, market, query_language, identified_as,
    confidence). The market and query_language fields are preserved from the raw
    strategy (empty strings if the model omitted them) so the frontend can show
    which market/language an audit actually ran in. identified_as/confidence are
    the web-anchored identity verdict (empty / "low" if absent). `max_queries`
    caps the query list (2 free, 5 deep); it defaults to the free cap so existing
    callers are unchanged.

    CORRECTION A (deterministic, zero-cost anti-hallucination guard): `confidence`
    can never be "high" unless real web evidence backed the inference. When
    `has_evidence` is False (no evidence was fetched/injected), confidence is
    FORCED to "low" here, regardless of what the LLM claimed. This is the hard tie
    between the returned confidence and the existence of web proof: a bare obscure
    name with no evidence can no longer come back "high" on the strength of the
    model's memory (which may surface a famous homonym). "low" then triggers the
    existing UI confirmation guard-rail. Callers pass has_evidence=True when the
    strategy comes from confirmed/custom client data (already human-vetted)."""
    cap = MAX_QUERIES_PAID if int(max_queries or MAX_QUERIES_FREE) >= MAX_QUERIES_PAID else MAX_QUERIES_FREE
    competitors = [re.sub(r'[^\w\s\-\.\&]', '', c.strip())[:MAX_BRAND_LEN]
                   for c in strat.get("competitors", []) if c.strip()][:MAX_BRANDS]
    # When the model has no idea who the company is, it can emit PLACEHOLDER
    # competitors ("Company A", "Brand B", "Competitor 1"). Auditing those would
    # measure fictional brands against real SERPs. Drop them: an empty list then
    # makes the caller refuse ("Could not infer competitors"), which forces the
    # URL/hint path instead of a fake audit.
    _placeholder = re.compile(r"^(company|brand|competitor|business|example)\s*[a-z0-9]{0,2}$", re.I)
    competitors = [c for c in competitors if not _placeholder.match(c.strip())]
    queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:cap]
    if brand not in competitors:
        competitors = [brand] + competitors
    # An inferred strategy whose only "competitor" is the brand itself (every
    # rival was a placeholder) is a degenerate audit: refuse it so the UI asks
    # for the official site or a hint. Confirmed client strategies
    # (has_evidence=True) are human-vetted and pass through.
    if not has_evidence and len(competitors) <= 1:
        competitors = []
    market = str(strat.get("market", "") or "").strip()[:60]
    query_language = str(strat.get("query_language", "") or "").strip()[:10]
    identified_as = str(strat.get("identified_as", "") or "").strip()[:400]
    confidence = str(strat.get("confidence", "") or "").strip().lower()
    # High confidence REQUIRES web evidence — otherwise it is unfounded (the model
    # may be recalling a famous namesake, not identifying THIS brand). Force low.
    confidence = "high" if (confidence == "high" and has_evidence) else "low"
    return competitors, queries, market, query_language, identified_as, confidence


def _deep_requested(data):
    """True if the request body asks for a deep audit. Accepts either
    `deep` (bool-ish) or `tier` ("paid"/"free"). This is only an INTENT flag —
    it does NOT by itself grant the deeper (paid) query depth."""
    return bool(data.get("deep")) or str(data.get("tier", "")).strip().lower() == "paid"


def _resolve_depth(data):
    """Return the query cap for a request that does NOT require payment (e.g.
    the free inference preview). Deep intent here widens the *inferred* query
    list only; it never spends paid SERP budget. The paid SERP path in
    /api/analyze is gated separately by _resolve_paid_depth()."""
    return MAX_QUERIES_PAID if _deep_requested(data) else MAX_QUERIES_FREE


def _resolve_paid_depth(data):
    """Security gate for the paid Deep Audit in /api/analyze. DURABLE, restart-
    proof, zero-infra-cost. See the full anti-replay security model near the top
    of the Stripe section.

    A deep (5-query) SERP run is authorized ONLY when the request carries a
    `paid_session` that clears EVERY one of these checks (all fail closed):

      (0) FIRST-LINE CACHE — if this session_id was already redeemed in THIS
          process, refuse immediately (no Stripe call needed). Not authoritative:
          empty after a restart, so the durable checks below still apply.
      (1) PAID — a real Stripe Checkout session with payment_status == "paid".
      (2) FRESH (Defense 2 / time window) — presented within
          PAID_SESSION_MAX_AGE_S of session.created (a durable Stripe timestamp).
          Bounds any residual replay to minutes right after payment.
      (3) NOT ALREADY CONSUMED (Defense 1 / durable Stripe stamp) — the backing
          PaymentIntent must NOT already carry metadata[bp_consumed]. This stamp
          lives on Stripe and survives every restart/redeploy/sleep.
      (4) DURABLY STAMPABLE (Defense 1 write) — we then write bp_consumed onto
          the PaymentIntent BEFORE granting. If that durable write does not
          succeed, we REFUSE (a grant we cannot record is a replayable grant).

    On success returns (MAX_QUERIES_PAID, session_id, pi_id, True); the session is
    now durably marked on Stripe AND cached in-process. `pi_id` is the backing
    PaymentIntent that carries the durable bp_consumed stamp we just wrote — the
    caller keeps it so it can roll that stamp back via
    _unmark_session_consumed_on_stripe() if the paid audit then fails before
    producing a result. In every other case — no session, unconfigured Stripe,
    unpaid, stale, already consumed, unreachable Stripe, or the client merely
    sending {deep:true} without paying — it silently falls back and returns
    (MAX_QUERIES_FREE, "", "", False). The empty pi_id in the fallback case is
    deliberate: no stamp was written, so there is nothing to roll back. The
    client can never obtain a deep audit by sending deep=true alone.

    Why this survives a server restart (the whole point): the consumption record
    is the PaymentIntent's bp_consumed metadata on Stripe, not our process
    memory. After a redeploy the in-memory cache is empty, but re-inspecting the
    session still shows bp_consumed set, so a replay is refused. The time window
    is likewise anchored on Stripe's session.created, not on any local clock we
    lose at restart."""
    if not _deep_requested(data):
        return MAX_QUERIES_FREE, "", "", False
    session_id = (data.get("paid_session") or "").strip()
    if not session_id:
        return MAX_QUERIES_FREE, "", "", False

    # (0) First-line in-process cache: cheap short-circuit for same-process
    # replay. Never the source of truth (see Defense 1/2 for durability).
    with _live_lock:
        if session_id in _consumed_sessions:
            return MAX_QUERIES_FREE, "", "", False

    # Single Stripe round-trip: paid status + created ts + PaymentIntent + its
    # durable consumption stamp.
    info = _inspect_paid_session(session_id)

    # Fail closed if we could not reach/parse Stripe at all.
    if not info["inspectable"]:
        return MAX_QUERIES_FREE, "", "", False
    # (1) Must be paid.
    if not info["ok"]:
        return MAX_QUERIES_FREE, "", "", False
    # (3) Durable Stripe stamp already present -> already redeemed (survives
    # restart). Record it in the local cache too so we skip Stripe next time.
    if info["consumed"]:
        with _live_lock:
            _consumed_sessions.add(session_id)
        return MAX_QUERIES_FREE, "", "", False
    # (2) Time window: only accept within PAID_SESSION_MAX_AGE_S of creation.
    # created==0 means we could not read a trustworthy timestamp -> fail closed.
    now = int(time.time())
    if info["created"] <= 0 or (now - info["created"]) > PAID_SESSION_MAX_AGE_S:
        return MAX_QUERIES_FREE, "", "", False
    # We need a PaymentIntent to durably stamp; without one we cannot record
    # consumption durably -> fail closed rather than grant an unrecordable audit.
    if not info["pi_id"]:
        logger.error("Paid session %s has no PaymentIntent to stamp (fail-closed)", session_id)
        return MAX_QUERIES_FREE, "", "", False

    # (4) DURABLY claim the single-use unlock on Stripe BEFORE granting. Note on
    # concurrency: Stripe's update is last-write-wins, so two truly simultaneous
    # requests for the same fresh session could both pass step (3) before either
    # stamps. That window is (a) tiny, (b) further guarded by the in-process
    # cache add below which serializes same-process duplicates, and (c) bounded
    # to at most the few requests a single buyer can fire in that instant — not
    # an unbounded free-audit exploit. The durable stamp then permanently blocks
    # every later replay, including across restarts.
    if not _mark_session_consumed_on_stripe(info["pi_id"]):
        return MAX_QUERIES_FREE, "", "", False  # could not durably record -> refuse

    with _live_lock:
        _consumed_sessions.add(session_id)
    # Return the pi_id alongside the session so the caller can durably ROLL BACK
    # the bp_consumed stamp we just wrote if the paid audit then fails before
    # producing a result. It is only ever non-empty here, i.e. once the stamp is
    # actually on Stripe — so the caller never tries to unmark a stamp that was
    # never set.
    return MAX_QUERIES_PAID, session_id, info["pi_id"], True


@app.route("/api/infer", methods=["POST"])
def api_infer():
    """Inference-only endpoint: sector + competitors + queries for a brand,
    with no SERP calls and no AI-visibility calls. Lets the frontend show a
    confirmation preview before paying for the expensive part of the pipeline.
    Does NOT touch the live-run quota counters — a single Haiku call costs
    about $0.0001, and gating it behind the same daily quota as a full
    analysis would defeat the point of letting users cheaply refine a hint."""
    data = _read_json()
    brand = (data.get("brand") or "").strip()
    hint = (data.get("hint") or "").strip()
    official = (data.get("official_url") or "").strip()  # user-supplied source of truth
    market = (data.get("market") or "").strip()  # optional forced market ("fr", "us"…)
    force_web = bool(data.get("force_web"))       # "Not this? Refine" -> re-read the web
    max_queries = _resolve_depth(data)            # 2 (free) or 5 (deep)

    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400
    if official and len(official) > 300:
        return jsonify({"error": "The website URL is too long."}), 400

    # Light per-IP rate-limit: /api/infer is intentionally NOT quota-gated (it
    # must stay cheap for hint refinement), but it must not be spammable.
    # NOTE: this alone is bypassable by spoofing X-Forwarded-For (fixed
    # separately in _client_ip, which now reads the proxy-appended hop), the
    # global ceiling right after is the real circuit-breaker on cost.
    ip = _client_ip()
    minute = int(time.time() // 60)
    with _live_lock:
        entry = _infer_hits.get(ip)
        if not entry or entry[0] != minute:
            # Drop stale buckets to avoid unbounded growth.
            for stale in [k for k, v in _infer_hits.items() if v[0] != minute]:
                del _infer_hits[stale]
            _infer_hits[ip] = [minute, 1]
        elif entry[1] >= _INFER_RATE_PER_MIN:
            return jsonify({"error": "Too many requests — slow down a moment."}), 429
        else:
            entry[1] += 1

    # Global (process-wide) ceiling, independent of any client-claimed
    # identity: a rolling 60s window on the TOTAL number of /api/infer calls,
    # each of which spends real Anthropic budget on INFER_MODEL regardless of
    # who is asking. This is what actually stops an X-Forwarded-For-rotating
    # attacker (or any other way of presenting many distinct IPs) from
    # draining the owner's paid-inference budget: no identity, spoofed or
    # real, can push total call volume past this cap.
    with _live_lock:
        now_s = time.time()
        cutoff = now_s - 60
        while _infer_global_hits and _infer_global_hits[0] < cutoff:
            _infer_global_hits.pop(0)
        if len(_infer_global_hits) >= _INFER_GLOBAL_RATE_PER_MIN:
            return jsonify({"error": "infer_quota_global", "message": "Too many requests right now, try again shortly."}), 429
        _infer_global_hits.append(now_s)

    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not llm_key:
        return jsonify({"error": "Server missing an API key - cannot run inference."}), 502

    # COST GARDE: /api/infer is not quota-gated, so it must not trigger a paid
    # SERP recon on the free path. Recon fetches are gratuit ONLY for domains
    # (urllib) — so we pass serp_key to _recon ONLY when the recon target is a
    # domain/URL (the explicit official_url, or a brand that itself looks like a
    # domain). For a plain free brand name we pass serp_key=None: _recon then
    # returns empty evidence and inference falls back to LLM-only knowledge.
    #
    # BUG-3 (common-word names like "Figures"/"Mention"/"Pivot" typed with no
    # domain and no hint): a light SERP recon would anchor the guess, BUT this
    # endpoint is only per-IP rate-limited (not quota-gated), and every SERP query
    # is a real, unbounded paid cost. Deliberately NOT firing a free SERP recon
    # here is a cost-safety choice: pure common-word names fall back to LLM-only
    # inference, which returns empty/low-confidence evidence. The UI guard-rail
    # (index.html: empty evidence -> lowConfidence=true) then forces the URL/hint
    # field open and a mandatory Yes/No confirmation before any analysis or
    # payment — so the user is never billed on a silently-wrong diagnosis. Users
    # who need web anchoring on such a name supply an official_url or hint, which
    # IS reconned (domain fetch is free; a hint sharpens the LLM identification).
    # If a future paid/deep or quota-gated path wants SERP anchoring on bare
    # names, do it THERE (bounded by payment/quota), never on this free endpoint.
    serp_key = os.environ.get("BRIGHTDATA_API_KEY")
    recon_target = official or brand
    recon_allowed_key = serp_key if _looks_like_domain(recon_target) else None
    # An explicit official_url is the single source of truth: fetch THAT domain
    # only, bypassing the guess entirely.
    if official:
        if force_web:
            with _live_lock:
                _recon_cache.pop((brand or "").strip().lower(), None)
        recon = {"evidence": [], "official_url": ""}
        meta = _fetch_page_meta(official)
        if meta:
            recon["official_url"] = meta.get("url", official)
            ev = {"source": meta.get("url", official)}
            if meta.get("og_site_name"):
                ev["site_name"] = meta["og_site_name"]
            if meta.get("title"):
                ev["title"] = meta["title"]
            d = meta.get("description") or meta.get("og_description") or ""
            if d:
                ev["description"] = d
            if meta.get("h1"):
                ev["h1"] = meta["h1"]
            if len(ev) > 1:
                recon["evidence"].append(ev)
    else:
        if force_web:
            with _live_lock:
                _recon_cache.pop((brand or "").strip().lower(), None)
        recon = _recon(recon_target, recon_allowed_key)

    try:
        strat = infer_strategy(brand, llm_key, hint, market=market or None,
                               max_queries=max_queries, evidence=recon["evidence"] or None)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    # CORRECTION A: confidence can only be "high" if real web evidence was fetched.
    # On this free preview endpoint a bare obscure name yields empty evidence (no
    # SERP — see cost note above), so it is forced to "low" -> UI confirmation card.
    competitors, queries, inferred_market, query_language, identified_as, confidence = \
        _sanitize_strategy(brand, strat, max_queries,
                           has_evidence=bool(recon.get("evidence")))
    if not competitors or not queries:
        return jsonify({"error": "Could not infer competitors for this brand."}), 502

    # Hoist the first evidence item's clean display fields to the top level so the
    # front-end resolver card can show a proper site name / description without
    # digging into evidence[0]. Purely additive: both fields are already produced
    # by _fetch_page_meta / _recon; the front-end still works if they are empty.
    _first_ev = (recon.get("evidence") or [{}])[0]
    return jsonify({
        "brand": brand,
        "sector": strat.get("sector", ""),
        "market": inferred_market,
        "query_language": query_language,
        "competitors": competitors,
        "queries": queries,
        "identified_as": identified_as,
        "confidence": confidence,
        "official_url": recon.get("official_url", ""),
        "evidence": recon.get("evidence", []),
        "og_site_name": _first_ev.get("site_name", ""),
        "display_desc": _first_ev.get("description", ""),
    })


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    global _live_runs, _live_runs_date
    data = _read_json()
    live = bool(data.get("live"))
    brand = (data.get("brand") or "").strip()
    hint = (data.get("hint") or "").strip()
    market = (data.get("market") or "").strip()  # optional forced market
    # Chosen AI assistant (claude / chatgpt / gemini). Resolved to one whose key
    # is configured; unknown or unavailable falls back to the default.
    ai_provider = _resolve_provider((data.get("ai") or "").strip().lower())

    if not live:
        return jsonify(SAMPLE)

    # --- Input validation ---
    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    # Optional pre-validated competitors/queries (from a confirmed /api/infer
    # preview). When both are present and non-empty we skip infer_strategy
    # entirely and re-sanitize what the client sent, for safety.
    raw_competitors = data.get("competitors") or []
    raw_queries = data.get("queries") or []
    use_custom_strategy = bool(raw_competitors) and bool(raw_queries)

    serp_key = os.environ.get("BRIGHTDATA_API_KEY")
    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not serp_key or not llm_key:
        _record_analyze_failure(brand, "missing_api_key")
        return jsonify(dict(SAMPLE, notice="Server missing an API key - showing sample analysis."))

    # PAID GATE — resolved only now, after we know this is a valid live request
    # (so we never burn a paid session on an invalid/demo call). Deep (5-query)
    # depth is granted ONLY for a verified, paid, not-yet-consumed Stripe
    # session. Sending {deep:true} without a valid paid_session silently falls
    # back to the free 2-query cap. When paid_ok is True the session has been
    # atomically claimed (single-use); we roll that claim back on hard failure
    # in the except-block so a paying customer is never charged for nothing.
    max_queries, paid_session, paid_pi_id, paid_ok = _resolve_paid_depth(data)
    if paid_ok and paid_pi_id:
        # This is the ONLY trace written before the long synchronous pipeline
        # below runs. If gunicorn's worker is SIGKILLed on a timeout (the 17
        # July 2026 outage class, see the retry comment further down), NO
        # except/finally in this function ever runs, a SIGKILL cannot be
        # caught, so the durable bp_consumed stamp we just wrote would
        # otherwise be lost with zero server-side record. This log line is
        # not a fix (it cannot itself roll anything back), but it is what
        # lets support reconcile a burned unlock by hand: search the logs for
        # this pi_id, confirm no matching "PAID AUDIT" success/rollback line
        # follows it, and manually clear bp_consumed on Stripe / refund.
        logger.warning(
            "PAID AUDIT STARTING: pi=%s session=%s brand=%s, bp_consumed is "
            "now durably stamped; if this worker is killed before a success "
            "or rollback log line is written for this pi_id, the unlock must "
            "be reconciled manually.",
            paid_pi_id, paid_session, brand,
        )

    ip = _client_ip()
    today = _today_utc()
    # A verified paid deep audit bypasses the FREE per-IP / global daily quota
    # (the customer paid for it) but still runs under a sanity ceiling so a
    # single paid unlock can never fan out into an unbounded number of SERP
    # calls. paid_ok is only ever True for a single-use, already-consumed
    # session, so this authorizes exactly one deep run.
    if not paid_ok:
        with _live_lock:
            # Reset the global daily counter when the UTC date has rolled over.
            if _live_runs_date != today:
                _live_runs_date = today
                _live_runs = 0

            # Clean out any per-IP entries from previous days to avoid leaking memory.
            for stale_ip in [k for k, v in _ip_runs.items() if v[0] != today]:
                del _ip_runs[stale_ip]

            ip_entry = _ip_runs.get(ip)
            ip_count = ip_entry[1] if ip_entry else 0

            if ip_count >= LIVE_RUNS_PER_IP:
                return jsonify({
                    "error": "quota_ip",
                    "message": "Free daily limit reached (3 live analyses/day). Upgrade to Pro for unlimited analyses — join the waitlist below."
                }), 429
            if _live_runs >= MAX_LIVE_RUNS:
                return jsonify({
                    "error": "quota_global",
                    "message": "Today's free analysis pool is used up. Come back tomorrow, or join the Pro waitlist for priority access."
                }), 429

            _live_runs += 1
            _ip_runs[ip] = [today, ip_count + 1]

    # NOTE on caching custom runs: when the client supplies pre-validated
    # competitors/queries (from a confirmed /api/infer preview, possibly with
    # a disambiguation hint), the resulting analysis can legitimately differ
    # from an "auto" analysis of the same bare brand name. The cache is keyed
    # only on brand.lower(), so if we wrote a custom result there, a later
    # plain (non-hinted) analysis of the same brand would incorrectly be
    # served that custom data — and vice versa, a custom run could get served
    # a stale "auto" cache hit that doesn't match the confirmed strategy.
    # Simplest safe choice: custom runs neither read nor write the shared
    # brand cache; they always run fresh (still cost-bounded by MAX_QUERIES
    # SERP calls and the quota counters above).
    # A paid deep audit never uses the shared brand cache: the customer paid for
    # a fresh, wider (5-query) run, and the cache is keyed only on brand.lower()
    # with no notion of depth — serving a cached 2-query result would short-
    # change them. Treated like a custom run (no read, no write).
    cache_key = brand.lower()
    # Single locked block: the membership check, the read, and the counter
    # rollback all happen under _live_lock so a threaded worker can never read
    # a cache entry that a concurrent write is still mutating, nor race the
    # quota counters against another request's own rollback/claim.
    cached_hit = None
    if not use_custom_strategy and not paid_ok:
        with _live_lock:
            if cache_key in _cache:
                cached_hit = dict(_cache[cache_key], cached=True)
                _live_runs -= 1  # cached hit doesn't consume a slot
                if ip in _ip_runs and _ip_runs[ip][0] == today:
                    _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)
    if cached_hit is not None:
        return jsonify(_sign_share(cached_hit))

    # BUG-2 FIX: a FREE live run legitimately consumes one daily slot ONLY when it
    # actually produces a real analysis. The +=1 above provisionally claimed the
    # slot; we keep it (do NOT release in `finally`) only once we reach the
    # successful return below. Every other exit from the try/finally — a
    # "could not infer" SAMPLE fallback, or an exception — did NOT deliver an
    # analysis, so it releases the slot. Previously the `finally` released the
    # slot on ALL non-paid exits including the success return, which cancelled the
    # +=1 and made the free daily quota never accumulate (effectively unlimited
    # free analyses). `slot_consumed` distinguishes the one path that must keep it.
    slot_consumed = False

    def _rollback_paid_unlock(reason):
        """Release a claimed paid unlock on any post-gate exit that will NOT
        return a real deep dossier. The except-block below already does this
        for EXCEPTIONS; this is the same rollback for a NORMAL (non-exception)
        early return after the paid gate, e.g. the "could not infer
        competitors/queries" SAMPLE fallback, which, before this fix, skipped
        the except-block entirely and durably burned a customer's single-use
        79-euro unlock with no dossier delivered and no server-side log at
        all. Mirrors the except-block's two-layer release (durable Stripe
        stamp, then the in-process cache) so a retry is actually possible.
        A no-op when paid_ok is False (nothing was ever claimed)."""
        if not (paid_ok and paid_pi_id):
            return
        try:
            if not _unmark_session_consumed_on_stripe(paid_pi_id):
                logger.error(
                    "PAID AUDIT ROLLBACK FAILED: could not clear bp_consumed on "
                    "PaymentIntent %s after a non-exception early exit (%s, "
                    "session=%s, brand=%s). Customer may be blocked from "
                    "retrying, manual review needed.",
                    paid_pi_id, reason, paid_session, brand,
                )
        except Exception:
            logger.exception(
                "PAID AUDIT ROLLBACK ERROR: unexpected error unmarking bp_consumed "
                "on PaymentIntent %s (%s, session=%s, brand=%s), manual review needed.",
                paid_pi_id, reason, paid_session, brand,
            )
        if paid_session:
            with _live_lock:
                _consumed_sessions.discard(paid_session)
        logger.error(
            "PAID AUDIT UNLOCK ROLLED BACK: %s (session=%s, brand=%s, pi=%s), "
            "no dossier was produced; single-use unlock released for retry.",
            reason, paid_session, brand, paid_pi_id,
        )

    try:
        # CORRECTION D — web recon on EVERY live analysis (paid AND free), not just
        # the paid path. We run recon FIRST so the identity is anchored on the web
        # and not guessed from the name. Crucially we pass the REAL serp_key (never
        # None), so _recon's SERP branch fires on a bare obscure name (e.g. a small
        # French SME sharing a name with a famous US company) and fetches the true
        # official site instead of letting the LLM fall back to a homonym in memory.
        #
        # COST: this is bounded. A live analysis is quota-gated (3 audits/day/IP +
        # the MAX_LIVE_RUNS global ceiling), and _recon is memoized in _recon_cache
        # (keyed on brand.lower()) so the same brand is never re-paid. That is +1
        # SERP call (~$0.0015) per distinct brand analyzed. We deliberately do NOT
        # do this on /api/infer (the free preview is not quota-gated, so a SERP
        # there would be an unbounded paid cost); there a bare obscure name stays
        # "low" (Correction A) -> UI confirmation card. Web identification is paid
        # for and performed HERE, at analysis time, where the quota bounds it.
        # Recon is fail-open: on any error the evidence is empty and inference
        # degrades to the old name-only behavior rather than blocking the audit.
        # Run recon when it feeds a fresh inference (any non-custom live run —
        # Correction D covers the free path here) OR when it feeds the paid deep
        # audit's written report / evidence panel (paid runs always did recon,
        # even when resumed from a confirmed custom strategy — preserve that).
        recon = {"evidence": [], "official_url": ""}
        if not use_custom_strategy or paid_ok:
            recon = _recon(data.get("official_url") or brand, serp_key)
        if use_custom_strategy:
            # Confirmed/custom strategy already came from a human-vetted /api/infer
            # preview, so its confidence is trusted as-is (has_evidence=True).
            competitors, queries, market_out, query_language, identified_as, confidence = _sanitize_strategy(brand, {
                "competitors": raw_competitors,
                "queries": raw_queries,
                "market": data.get("market_label") or market,
                "query_language": data.get("query_language") or "",
                "identified_as": data.get("identified_as") or "",
                "confidence": data.get("confidence") or "",
            }, max_queries, has_evidence=True)
            sector = (data.get("sector") or "").strip() or "(confirmed by user)"
        else:
            strat = infer_strategy(brand, llm_key, hint, market=market or None,
                                   max_queries=max_queries, evidence=recon["evidence"] or None)
            # CORRECTION A: recalibrate confidence on the REAL evidence gathered
            # above. No evidence recovered -> confidence forced to "low".
            competitors, queries, market_out, query_language, identified_as, confidence = _sanitize_strategy(
                brand, strat, max_queries, has_evidence=bool(recon.get("evidence")))
            sector = strat.get("sector", "")
        if not competitors or not queries:
            _rollback_paid_unlock("could not infer competitors/queries")
            _record_analyze_failure(brand, "could_not_infer_competitors")
            return jsonify(dict(SAMPLE, notice="Could not infer competitors - showing sample analysis."))
        # Geolocate the SERP to the resolved market: a forced "fr" or an inferred
        # French market both map to google.fr in French. Falls back to US/English
        # when the market is unknown, so this never worsens the prior behavior.
        gl, hl = _market_locale(market or market_out)
        ranking, landscape = analyze(competitors, queries, serp_key, gl=gl, hl=hl,
                                     return_landscape=True)
        # Bounded score needs the per-run distribution: request return_runs. The
        # paid Deep Audit buys more runs (tighter interval); the free tier gets a
        # smaller n (honest but wider interval), protecting unit economics while
        # still showing the confidence bound everywhere.
        n_ai_runs = DEEP_AI_RUNS if paid_ok else FREE_AI_RUNS
        # The AI-visibility probe runs against the CHOSEN assistant, using that
        # assistant's own API key (which may differ from the Anthropic key used
        # for strategy inference). Falls back to Claude if the chosen one lost
        # its key between resolve and here.
        ai_key = _provider_key(ai_provider) or llm_key
        ai_vis, ai_runs = check_ai_visibility(competitors, queries, ai_key,
                                              n_runs=n_ai_runs, return_runs=True,
                                              provider_id=ai_provider)
        # Merge AI visibility into ranking data
        for entry in ranking:
            b = entry["brand"]
            entry["ai_cells"] = {}
            for q in queries:
                cell = ai_vis.get(q, {}).get(b)
                if cell:
                    entry["ai_cells"][q] = cell
            ai_mentioned = sum(1 for q in queries if q in ai_vis and b in ai_vis[q])
            entry["ai_coverage"] = f"{ai_mentioned}/{len(queries)}"
            ai_ranks = [ai_vis[q][b]["rank"] for q in queries if q in ai_vis and b in ai_vis[q]]
            entry["ai_avg_rank"] = round(sum(ai_ranks) / len(ai_ranks), 1) if ai_ranks else None
            ai_consist = [ai_vis[q][b]["consistency"] for q in queries if q in ai_vis and b in ai_vis[q]]
            entry["ai_consistency"] = round(sum(ai_consist) / len(ai_consist)) if ai_consist else None
        # Bounded GEO score (the Arme 1): the point estimate WITH its 95%
        # confidence interval and STABLE/MODERE/VOLATIL verdict, computed from the
        # per-run distribution. Shown on BOTH tiers (free = wider interval), so a
        # bare number is never displayed anywhere. Zero extra API cost (reuses the
        # runs already made). The written remediation report stays paid-only.
        geo = _geo_bounded(ranking, queries, brand, ai_runs)
        # Rival's bounded score, for the side-by-side "you STABLE vs rival VOLATIL"
        # comparison: pick the top-ranked brand that is NOT the audited one, and
        # compute the same bounded score from the same runs. This is the killer
        # demo, a claimed lead that is not real once the intervals overlap. Cheap
        # (reuses the runs) and only added when a distinct rival exists.
        geo_rival = None
        rival = next((r for r in ranking
                      if r.get("brand", "").lower() != str(brand).lower()), None)
        if rival is not None:
            gr = _geo_bounded(ranking, queries, rival["brand"], ai_runs)
            if gr is not None:
                gr["brand"] = rival["brand"]
                geo_rival = gr
        report = None
        n_llm_calls = 1 + len(ai_runs)  # strategy + the AI-visibility runs actually made
        if paid_ok:
            report = _build_remediation(ranking, queries, identified_as,
                                        recon.get("evidence", []), brand, llm_key)
            if report is not None:
                n_llm_calls += 1  # +1 remediation call
        # LLM calls + SERP queries. Recon adds at most one SERP call for a bare
        # (non-domain) brand name whenever recon actually ran (see the recon gate
        # above) — count it so the reported cost stays honest. Recon on a domain/URL
        # is a free page fetch (no SERP), and a cached recon hit re-pays nothing,
        # but we bill the worst case here.
        recon_ran = (not use_custom_strategy) or paid_ok
        n_recon_serp = 1 if (recon_ran and not _looks_like_domain(
            data.get("official_url") or brand)) else 0
        cost = round(LLM_COST_PER_CALL * n_llm_calls
                     + SERP_COST_PER_QUERY * (len(queries) + n_recon_serp), 5)
        result = {
            "brand": brand,
            "sector": sector,
            "market": market_out,
            "query_language": query_language,
            "queries": queries,
            "ranking": ranking,
            "mode": "live",
            "tier": "deep" if paid_ok else "free",
            "identified_as": identified_as,
            "confidence": confidence,
            "cost": cost,
            # Which assistant the AI-visibility side was measured on, so the UI
            # can state it plainly ("measured on ChatGPT") and the bounded score
            # is never mistaken for a cross-assistant average.
            "ai_provider": ai_provider,
            "ai_provider_label": (_AI_PROVIDERS.get(ai_provider) or {}).get("label", ""),
            # Real model transparency (additive, owner-requested): the EXACT
            # model id actually used for the AI-visibility runs above (read
            # from the provider registry, never hardcoded here) and the UTC
            # instant this measurement completed. Covers both tiers, since
            # free and paid share this one result-building path (tier is set
            # from paid_ok just above).
            "ai_model": (_AI_PROVIDERS.get(ai_provider) or {}).get("model", ""),
            "measured_at": _now_utc_iso(),
            # Who ACTUALLY owns these answers beyond the tracked brands: per-query
            # top untracked results + hosts aggregated across queries. Turns an
            # empty grid (niche/local brand) into an actionable SEO read.
            "serp_landscape": landscape,
        }
        # Bounded GEO score on BOTH tiers: the object carries point, half_width,
        # low/high, n, verdict. geo_score (the bare point) is kept alongside for
        # backward compatibility with any older client path; new rendering must
        # read result["geo"] and never show the point without its interval.
        if geo is not None:
            result["geo"] = geo
            result["geo_score"] = geo.get("point")
        if geo_rival is not None:
            result["geo_rival"] = geo_rival
        # Deep-audit-only fields: never present on a free result, so the frontend
        # can key its whole "deep vs free" rendering on d.tier / their presence.
        if paid_ok:
            result["evidence"] = recon.get("evidence", [])
            result["official_url"] = recon.get("official_url", "")
            if report is not None:
                result["report"] = report
            # Closes the reconciliation trail opened by the "PAID AUDIT
            # STARTING" log above: a support engineer grepping for this
            # pi_id who finds this line knows the dossier was actually
            # delivered, so bp_consumed staying stamped is correct, not a
            # burned unlock to investigate.
            logger.warning(
                "PAID AUDIT SUCCEEDED: pi=%s session=%s brand=%s, dossier delivered.",
                paid_pi_id, paid_session, brand,
            )
        # A paid deep run is never written to the shared brand cache (see the
        # cache-read note above): a later free run of the same brand must not be
        # served a 5-query deep result, and vice versa.
        if not use_custom_strategy and not paid_ok:
            with _live_lock:
                if len(_cache) < MAX_CACHE_ENTRIES:
                    _cache[cache_key] = result
                    _save_cache(_cache)
        # This free run delivered a real analysis: it legitimately consumes its
        # daily slot, so the `finally` must NOT release it (see BUG-2 FIX above).
        slot_consumed = True
        # Append this real measurement to the durable longitudinal store. Only
        # fresh live audits are logged (not cache re-serves), so each row is one
        # genuine timestamped measurement. Best-effort: never affects the response.
        _log_audit_history(result)
        # Sign AFTER logging (share_sig is not a measurement field, it must
        # never end up in audit_history) but on the exact dict about to be
        # sent. This is the one and only place a live result becomes
        # shareable. Returns a NEW dict, so the object already stored in
        # _cache above stays un-signed (re-signed fresh on every future
        # cache hit, see the cache-hit branch above).
        return jsonify(_sign_share(result))
    except Exception as e:
        logger.exception("Live analysis failed for brand='%s'", brand)
        _record_analyze_failure(brand, "exception: %s" % type(e).__name__)
        # A paid deep audit that failed before producing a result should NOT
        # burn the customer's single-use unlock — release the claimed session so
        # they can retry.
        #
        # Two layers must be released, in order:
        #   1) the DURABLE Stripe stamp (bp_consumed on the PaymentIntent), which
        #      is the restart-proof source of truth. If we only cleared the memory
        #      cache, the stamp would stay on Stripe and every retry would re-read
        #      it as "already consumed" -> the paying customer, having just seen a
        #      FAILED audit, would be permanently downgraded to a free (2-query)
        #      run and could NEVER obtain the deep audit they paid for. Removing
        #      the durable stamp is what actually lets them retry.
        #   2) the in-process cache, a same-process short-circuit only.
        # paid_pi_id is non-empty ONLY when _resolve_paid_depth actually wrote the
        # stamp in THIS run, so we never try to unmark a stamp that was never set.
        # (Replay safety is preserved: only an un-produced run rolls back.)
        if paid_ok and paid_pi_id:
            try:
                if not _unmark_session_consumed_on_stripe(paid_pi_id):
                    # Rollback did not persist on Stripe. We err toward NOT
                    # over-granting audits (see _unmark docstring): the customer
                    # may need to retry within the time window, but is never
                    # silently robbed without a trace — this is logged loudly so
                    # support can manually unset bp_consumed / refund if needed.
                    logger.error(
                        "PAID AUDIT ROLLBACK FAILED: could not clear bp_consumed on "
                        "PaymentIntent %s after a failed paid audit (session=%s). "
                        "Customer may be blocked from retrying — manual review needed.",
                        paid_pi_id, paid_session,
                    )
            except Exception:
                logger.exception(
                    "PAID AUDIT ROLLBACK ERROR: unexpected error unmarking bp_consumed "
                    "on PaymentIntent %s (session=%s) — manual review needed.",
                    paid_pi_id, paid_session,
                )
        if paid_ok and paid_session:
            with _live_lock:
                _consumed_sessions.discard(paid_session)
        # Return a safe, generic message — full error is logged server-side
        return jsonify(dict(SAMPLE, notice="Live analysis failed, showing sample."))
    finally:
        # Daily-quota accounting (FREE runs only — a paid deep run never
        # incremented the counters, so it must never touch them here).
        #
        # BUG-2 FIX: release the provisionally-claimed slot ONLY when this free run
        # did NOT deliver a real analysis (slot_consumed stays False on the
        # "could not infer" SAMPLE fallback and on the exception path). A free run
        # that DID produce an analysis sets slot_consumed=True and keeps its slot,
        # so the 3/day/IP quota actually accumulates. (Cache hits return before
        # this try/finally and rerelease their slot on their own dedicated path.)
        if not paid_ok and not slot_consumed:
            with _live_lock:
                _live_runs -= 1
                if ip in _ip_runs and _ip_runs[ip][0] == today:
                    _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)


# ---------------------------------------------------------------------------
# Public, server-rendered brand pages (the SEO / GEO flywheel).
#
# Every cached audit is also a public page at /brand/<key>, rendered as plain
# HTML with no JS required, so it is indexable by search engines AND citable by
# AI assistants. The tool that measures AI visibility becomes itself the canonical
# example of AI visibility: when someone asks "how visible is <brand> in AI",
# these pages are the answer. Each page shows the bounded score (never a bare
# number, same rule as the app) and links back to a live audit.
#
# Data source is the in-process cache (marks recently audited). It is deliberately
# read-only and defensive: an unknown key returns 404, never invents data. When
# the durable D1 store is wired for reads, this can source from there so pages
# survive a cold start; the render function already takes a plain result dict.
# ---------------------------------------------------------------------------
def _brand_key(name):
    """URL-safe key for a brand, matching the cache key convention (lowercased)."""
    return re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")


def _verdict_ui(v):
    """(label, css-ish color word) for a bounded verdict, for the public page."""
    return {
        "STABLE": ("Stable", "#2f7d63"),
        "MODERE": ("Moderate", "#b5722e"),
        "VOLATIL": ("Volatile", "#a4552f"),
        "SINGLE_RUN": ("Single run", "#6f6d64"),
    }.get(v, ("", "#6f6d64"))


def _render_brand_page(result):
    """Server-rendered, dependency-free HTML for one brand's AI-visibility read.
    Takes a cached audit result dict. No f-strings with user data unescaped: every
    brand/sector/query value goes through _html.escape."""
    e = _html.escape
    brand = str(result.get("brand", "")).strip()
    sector = str(result.get("sector", "")).strip()
    market = str(result.get("market", "")).strip()
    ranking = result.get("ranking") or []
    geo = result.get("geo") or {}
    point = geo.get("point")
    hw = geo.get("half_width")
    verdict = geo.get("verdict")
    vlabel, vcolor = _verdict_ui(verdict)
    you = next((r for r in ranking if r.get("brand", "").lower() == brand.lower()), None)

    score_line = ""
    if point is not None:
        pm = (' <span style="font-size:22px;color:#6f6d64">&plusmn;' + str(hw) + "</span>") if hw is not None else ""
        badge = ('<span style="display:inline-block;margin-left:10px;font:700 11px ui-monospace,monospace;'
                 'letter-spacing:.08em;text-transform:uppercase;padding:4px 10px;border-radius:6px;'
                 'color:' + vcolor + ';background:rgba(120,120,120,.1)">' + e(vlabel) + "</span>") if vlabel else ""
        score_line = ('<div style="font:600 56px ui-monospace,monospace;color:#15140f;letter-spacing:-2px;margin:6px 0 2px">'
                      + str(point) + pm + '<span style="font-size:22px;color:#918f84">/100</span></div>'
                      + '<div style="margin:8px 0 0">' + badge + "</div>")

    # Competitive table (SERP + AI), server-rendered so it is indexable.
    rows = ""
    for r in ranking[:8]:
        is_you = r.get("brand", "").lower() == brand.lower()
        rows += ("<tr" + (' style="background:rgba(91,140,126,.08);font-weight:600"' if is_you else "") + ">"
                 + "<td>" + e(str(r.get("brand", ""))) + (" (this brand)" if is_you else "") + "</td>"
                 + "<td>" + e(str(r.get("query_coverage", r.get("share_of_voice", "")) or "")) + "</td>"
                 + "<td>" + (str(r.get("share_of_voice")) + "%" if r.get("share_of_voice") is not None else "&mdash;") + "</td>"
                 + "<td>" + e(str(r.get("ai_coverage", "") or "")) + "</td>"
                 + "<td>" + (str(r.get("ai_avg_rank")) if r.get("ai_avg_rank") is not None else "&mdash;") + "</td>"
                 + "</tr>")

    ctx = (sector or "its market")
    market_bit = (" in " + e(market)) if market else ""
    title = e(brand) + " AI visibility, GEO score and competitive read"
    desc = ("How visible is " + brand + " in AI answers and Google" + (" in " + market if market else "")
            + "? A bounded GEO visibility score and the competitive set, measured by Nadelio.")
    canonical = SITE_URL + "/brand/" + _brand_key(brand)

    return ("<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
            "<title>" + title + "</title>"
            "<meta name=\"description\" content=\"" + e(desc) + "\">"
            "<link rel=\"canonical\" href=\"" + e(canonical) + "\">"
            "<meta property=\"og:title\" content=\"" + title + "\">"
            "<meta property=\"og:description\" content=\"" + e(desc) + "\">"
            "<meta property=\"og:url\" content=\"" + e(canonical) + "\">"
            "<meta name=\"theme-color\" content=\"#f4f2ec\">"
            "<link rel=\"icon\" href=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>N</text></svg>\">"
            "<style>*{margin:0;padding:0;box-sizing:border-box}"
            "body{font-family:'Inter','Segoe UI',-apple-system,sans-serif;color:#15140f;background:#f4f2ec;line-height:1.6;padding:56px 22px 90px}"
            ".wrap{max-width:680px;margin:0 auto}"
            "a{color:#5b8c7e;text-decoration:none}a:hover{opacity:.7}"
            ".back{font-size:13px;display:inline-block;margin-bottom:28px}"
            ".eyebrow{font:600 11px ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:#3d6b5c;margin-bottom:12px}"
            "h1{font-size:32px;font-weight:600;letter-spacing:-1px;line-height:1.1;margin-bottom:14px}"
            ".lede{font-size:16px;color:#6f6d64;margin-bottom:26px;max-width:60ch}"
            ".card{background:#fbfaf6;border:1px solid #e8e6dd;border-radius:18px;padding:28px;margin-bottom:22px}"
            "h2{font:600 13px 'Inter';letter-spacing:.05em;text-transform:uppercase;color:#3d6b5c;margin-bottom:14px}"
            "table{width:100%;border-collapse:collapse;font-size:14px}"
            "th{text-align:left;font:600 11px 'Inter';letter-spacing:.05em;text-transform:uppercase;color:#918f84;padding:0 10px 10px}"
            "td{padding:10px;border-top:1px solid #e8e6dd;font-variant-numeric:tabular-nums}"
            ".cta{display:inline-block;background:#15140f;color:#fff;font-weight:500;padding:14px 26px;border-radius:12px;margin-top:8px}"
            "footer{margin-top:40px;padding-top:18px;border-top:1px solid #e8e6dd;font-size:12px;color:#918f84}"
            ".twrap{overflow-x:auto}</style></head><body><div class=\"wrap\">"
            "<a class=\"back\" href=\"/\">&larr; Nadelio</a>"
            "<div class=\"eyebrow\">AI visibility read</div>"
            "<h1>" + e(brand) + " in AI answers and Google</h1>"
            "<p class=\"lede\">How visible " + e(brand) + " is across " + e(ctx) + market_bit
            + ", measured on Google and on AI assistants. The GEO score is reported with its "
            "confidence interval, so you can tell signal from noise.</p>"
            + ("<div class=\"card\"><h2>GEO visibility score</h2>" + score_line
               + "<p style=\"font-size:13px;color:#6f6d64;margin-top:12px\">A bounded score: the point estimate "
               "with its 95% confidence interval. <a href=\"/methodology\">How we measure</a>.</p></div>"
               if score_line else "")
            + ("<div class=\"card\"><h2>Competitive set</h2><div class=\"twrap\"><table>"
               "<thead><tr><th>Brand</th><th>SERP coverage</th><th>Share of voice</th>"
               "<th>AI coverage</th><th>AI avg rank</th></tr></thead><tbody>" + rows
               + "</tbody></table></div></div>" if rows else "")
            + "<a class=\"cta\" href=\"/\">Measure " + e(brand) + " live</a>"
            "<footer>Measured by Nadelio, the AI visibility score you can show your board. "
            "<a href=\"/methodology\">Methodology</a>. <a href=\"/roadmap\">Roadmap</a>.</footer>"
            "</div></body></html>")


@app.route("/brand/<key>", strict_slashes=False)
def brand_page(key):
    # Match the requested key against cached brands (cache keys are brand.lower()).
    wanted = _brand_key(key)
    for cache_key, result in list(_cache.items()):
        if _brand_key(cache_key) == wanted or _brand_key(result.get("brand", "")) == wanted:
            resp = app.make_response(_render_brand_page(result))
            resp.headers["Content-Type"] = "text/html; charset=utf-8"
            resp.headers["Cache-Control"] = "public, max-age=3600"
            return resp
    # Unknown brand: never fabricate. Point them at a live audit.
    resp = app.make_response(
        "<!DOCTYPE html><meta charset=utf-8><title>Not measured yet, Nadelio</title>"
        "<body style=\"font-family:'Inter',sans-serif;background:#f4f2ec;color:#15140f;"
        "max-width:560px;margin:80px auto;padding:0 22px;line-height:1.6\">"
        "<a href=\"/\" style=\"color:#5b8c7e;text-decoration:none;font-size:13px\">&larr; Nadelio</a>"
        "<h1 style=\"font-size:28px;font-weight:600;margin:20px 0 12px\">Not measured yet</h1>"
        "<p style=\"color:#6f6d64\">No one has run an AI visibility audit for "
        "“" + _html.escape(key) + "” yet. Run it live in about ten seconds, no signup.</p>"
        "<a href=\"/\" style=\"display:inline-block;margin-top:18px;background:#15140f;color:#fff;"
        "padding:13px 24px;border-radius:12px;text-decoration:none\">Measure it now</a></body>")
    resp.status_code = 404
    return resp


@app.route("/sitemap.xml")
def sitemap():
    """Sitemap of the static pages plus every cached brand page, so search engines
    discover the growing set of brand reads."""
    urls = [SITE_URL + p for p in ("/", "/compare", "/methodology", "/roadmap")]
    seen = set()
    for cache_key, result in list(_cache.items()):
        k = _brand_key(result.get("brand", "") or cache_key)
        if k and k not in seen:
            seen.add(k)
            urls.append(SITE_URL + "/brand/" + k)
    body = ("<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
            "<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">"
            + "".join("<url><loc>" + _html.escape(u) + "</loc></url>" for u in urls)
            + "</urlset>")
    resp = app.make_response(body)
    resp.headers["Content-Type"] = "application/xml; charset=utf-8"
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


@app.route("/robots.txt")
def robots():
    body = "User-agent: *\nAllow: /\nSitemap: " + SITE_URL + "/sitemap.xml\n"
    resp = app.make_response(body)
    resp.headers["Content-Type"] = "text/plain; charset=utf-8"
    return resp


# ===========================================================================
# Public share pages (POST /api/share -> GET /r/<token>).
#
# The growth loop: a visitor shares their own settled result, and every shared
# page is a real, bounded measurement advertising the product. THE rule this
# whole feature exists to protect: a share page may ONLY ever be built from a
# result THIS server produced and signed (see _sign_share above). /api/share
# re-verifies that signature over the EXACT raw text the browser held onto
# BEFORE it will ever write anything to the store. Never trusts a client-
# supplied brand/score, never re-derives the signature from request fields.
# ===========================================================================
_MAX_SHARE_RAW_BYTES = 200_000
_share_hits = {}  # {ip: [minute_bucket_int, count]}, same pattern as _event_hits
_SHARE_RATE_PER_MIN = int(os.environ.get("SHARE_RATE_PER_MIN", "10"))
# secrets.token_urlsafe(12) yields 16 URL-safe base64 chars with no padding;
# a little slack on both ends keeps this from breaking if that length ever
# changes, while still rejecting anything that is not a bare token (no path
# traversal, no injection, nothing SQL-parameter-shaped can even reach D1).
_SHARE_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{6,40}$")


def _store_share(token, brand, raw):
    """Synchronous D1 write (unlike the fire-and-forget /api/track pattern):
    the HTTP response IS the token, so it must exist before we can answer.
    Raises on failure; the caller decides what to tell the client."""
    _d1_query(
        "CREATE TABLE IF NOT EXISTS shares ("
        "token TEXT PRIMARY KEY, ts TEXT NOT NULL, brand TEXT, payload TEXT NOT NULL)")
    _d1_query(
        "INSERT INTO shares (token, ts, brand, payload) VALUES (?,?,?,?)",
        [token, datetime.datetime.now(datetime.timezone.utc).isoformat(),
         str(brand)[:200], raw])


@app.route("/api/share", methods=["POST"])
def api_share():
    """Mint a public share URL for a result THIS server measured and signed.
    Body: {raw: "<verbatim /api/analyze response text>"}. Verify-first: the
    signature is checked BEFORE the D1-configured gate, so an invalid
    signature always answers the same 403 regardless of backend
    configuration. Never a signal an attacker could use to tell "bad
    signature" apart from "sharing unavailable"."""
    ip = _client_ip()
    minute = int(time.time() // 60)
    with _live_lock:
        entry = _share_hits.get(ip)
        if not entry or entry[0] != minute:
            for stale in [k for k, v in _share_hits.items() if v[0] != minute]:
                del _share_hits[stale]
            _share_hits[ip] = [minute, 1]
        elif entry[1] >= _SHARE_RATE_PER_MIN:
            return jsonify({"error": "rate limited"}), 429
        else:
            entry[1] += 1

    data = _read_json()
    raw = data.get("raw")
    if not isinstance(raw, str) or not raw or len(raw.encode("utf-8")) > _MAX_SHARE_RAW_BYTES:
        return jsonify({"error": "invalid payload"}), 400
    try:
        parsed = json.loads(raw)
    except Exception:
        return jsonify({"error": "invalid payload"}), 400
    if not isinstance(parsed, dict) or parsed.get("mode") != "live":
        return jsonify({"error": "invalid payload"}), 400

    given_sig = parsed.get("share_sig")
    if not given_sig or not isinstance(given_sig, str):
        return jsonify({"error": "invalid signature"}), 403
    check = {k: v for k, v in parsed.items() if k != "share_sig"}
    expected_sig = hmac.new(_event_salt().encode("utf-8"),
                            _canonical_result_json(check).encode("utf-8"),
                            hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected_sig, given_sig):
        return jsonify({"error": "invalid signature"}), 403

    # Signature verified first. Only now do we check whether sharing is even
    # configured, so a forged payload is refused the exact same way whether
    # or not D1 happens to be wired up.
    if not _history_enabled():
        return jsonify({"error": "sharing not configured"}), 503

    token = secrets.token_urlsafe(12)
    brand = parsed.get("brand", "")
    try:
        _store_share(token, brand, raw)
    except Exception:
        logger.warning("share store failed (non-fatal to the visitor)", exc_info=True)
        return jsonify({"error": "sharing not configured"}), 503

    return jsonify({"url": "/r/" + token})


def _share_is_fr(result):
    """FR when the audit itself was run in French (query_language), matching
    the language the visitor who is about to read this page actually asked
    their questions in. Never the viewer's own browser locale, there is no
    client-side toggle on a server-rendered page."""
    return str(result.get("query_language") or "").strip().lower().startswith("fr")


def _share_ai_summary(entry, queries):
    """Best (lowest) AI rank for one brand across the measured questions, with
    its cited/runs count. Same reduction as nadelio.js's aiSummary().

    "cited" is a PRESENCE count (how many runs the brand showed up in this
    query at all); "primary_cited" is the true count of runs it was
    specifically the PRIMARY answer (best.primary_hits). These are different
    numbers and must never be swapped: presence can be higher than primacy,
    so a "primary" label must never be followed by the presence count."""
    best = None
    for q in queries:
        c = (entry.get("ai_cells") or {}).get(q) if entry else None
        if not c or c.get("rank") is None:
            continue
        if best is None or c["rank"] < best["rank"]:
            best = c
    if not best:
        return {"present": False}
    runs = best.get("runs") or 0
    cons = best.get("consistency") or 0
    cited = round(cons / 100.0 * runs) if runs else 0
    primary_hits = best.get("primary_hits")
    primary_cited = primary_hits if primary_hits is not None else cited
    return {"present": True, "rank": round(best["rank"]),
            "kind": "primary" if best.get("kind") == "primary" else "mentioned",
            "runs": runs, "cited": cited, "primary_cited": primary_cited}


def _share_serp_best(entry, queries):
    """Best (lowest) Google rank for one brand across the measured questions."""
    best = None
    for q in queries:
        c = (entry.get("cells") or {}).get(q) if entry else None
        if c and c.get("rank") is not None:
            if best is None or c["rank"] < best:
                best = c["rank"]
    return best


def _share_ai_label(ai, fr):
    if not ai.get("present"):
        return "absent de l'IA" if fr else "absent from AI"
    is_primary = ai.get("kind") == "primary"
    kind = ("principal" if fr else "primary") if is_primary else ("mentionné" if fr else "mentioned")
    # The count after the rank must match the claim before it: "primary" gets
    # the PRIMARY-run count, never the presence count (see _share_ai_summary).
    count = ai.get("primary_cited", ai.get("cited", 0)) if is_primary else ai.get("cited", 0)
    count_word = (", principal " if fr else ", primary ") if is_primary else (", cité " if fr else ", cited ")
    return kind + (" n" if fr else " #") + str(ai["rank"]) + count_word + str(count) + "/" + str(ai.get("runs", 0))


def _share_google_label(serp_rank, fr):
    if serp_rank is None:
        return "absent de Google" if fr else "absent from Google"
    return ("Google rang " if fr else "Google rank ") + str(serp_rank)


def _share_field_rows(result):
    """Every measured brand, ordered by real AI visibility (focus brand kept
    in its natural place, not forced first). Same reduction/sort as
    nadelio.js's buildResult fieldRows."""
    queries = result.get("queries") or []
    ranking = result.get("ranking") or []
    brand = str(result.get("brand", ""))
    lc = brand.lower()
    rows = []
    for r in ranking:
        ai = _share_ai_summary(r, queries)
        rows.append({
            "name": str(r.get("brand", "")),
            "is_focus": str(r.get("brand", "")).lower() == lc,
            "share": max(0.0, float(r.get("share_of_voice") or 0)),
            "ai": ai,
            "serp": _share_serp_best(r, queries),
        })

    def ai_score(x):
        a = x["ai"]
        if not a.get("present"):
            return 999.0
        return a["rank"] + (0.0 if a.get("kind") == "primary" else 0.5)

    rows.sort(key=lambda x: (ai_score(x), -x["share"]))
    return rows


def _share_window(rows):
    """Adaptive [lo, hi] projection window for the static axis, ported from
    nadelio.js's computeWindow (same rounding, same 25-point minimum span)."""
    if not rows:
        return (0, 100)
    lows = [r["s"] - r["m"] for r in rows]
    highs = [r["s"] + r["m"] for r in rows]
    data_lo, data_hi = min(lows), max(highs)
    margin = max(8, data_hi - data_lo)
    lo = max(0, math.floor((data_lo - margin) / 5) * 5)
    hi = min(100, math.ceil((data_hi + margin) / 5) * 5)
    if hi - lo < 25:
        need = 25 - (hi - lo)
        lo -= need / 2.0
        hi += need / 2.0
        if lo < 0:
            hi += -lo
            lo = 0
        if hi > 100:
            lo -= (hi - 100)
            hi = 100
        lo = max(0, math.floor(lo / 5) * 5)
        hi = min(100, math.ceil(hi / 5) * 5)
    return (lo, hi)


def _share_verdict(fr, focus_name, geo, rival):
    """Bounded head-to-head verdict, ported sentence-for-sentence from
    nadelio.js's computeVerdict (same thresholds, same refusal to compare two
    unbounded reads or invent a winner on overlapping intervals). Returns
    {title, color, text}; title/text are '' when there is nothing to say
    (no geo at all)."""
    SAGE, SIENNA, INK = "#93A06E", "#B57C5D", "#E8DFD2"
    if not geo or geo.get("point") is None:
        return {"title": "", "color": INK, "text": ""}
    p = geo["point"]
    if not rival:
        v = geo.get("verdict")
        if v == "SINGLE_RUN":
            title = "Première mesure." if fr else "First measurement."
            text = (focus_name + " obtient " + str(p) + " sur 100 sur cette première mesure." if fr
                    else focus_name + " scores " + str(p) + " out of 100 on this first read.")
        elif v == "STABLE":
            title = "Position tenue." if fr else "Position holds."
            text = (focus_name + " obtient " + str(p) + " sur 100, un niveau qui tient à chaque mesure." if fr
                    else focus_name + " scores " + str(p) + " out of 100, a level that holds across every measurement.")
        else:
            title = "Position mesurée." if fr else "Position measured."
            text = (focus_name + " obtient " + str(p) + " sur 100, une visibilité réelle dans les réponses IA." if fr
                    else focus_name + " scores " + str(p) + " out of 100, real visibility in AI answers.")
        return {"title": title, "color": SAGE, "text": text}

    rival_name = rival.get("brand", "")
    if geo.get("half_width") is None or rival.get("half_width") is None:
        title = "Trop tôt pour comparer." if fr else "Too early to compare."
        text = (focus_name + " et " + rival_name + " ne sont mesurés qu'une fois chacun sur cette lecture. "
                "On ne départage jamais deux marques sur une seule mesure." if fr
                else focus_name + " and " + rival_name + " are each measured only once on this read. "
                "Two brands are never separated on a single measurement.")
        return {"title": title, "color": INK, "text": text}

    g_low, g_high = geo["low"], geo["high"]
    r_low, r_high = rival["low"], rival["high"]
    diff = geo["point"] - rival["point"]
    if g_low > r_high:
        d1 = max(1, round(diff))
        s1 = "s" if d1 > 1 else ""
        title = "Avance réelle." if fr else "Real lead."
        text = (focus_name + " devance " + rival_name + " de " + str(d1) + " point" + s1
                + ", une avance nette qui tient à chaque mesure." if fr
                else focus_name + " is ahead of " + rival_name + " by " + str(d1) + " point" + s1
                + ", a clear lead that holds across every measurement.")
        return {"title": title, "color": SAGE, "text": text}
    if g_high < r_low:
        d2 = max(1, round(-diff))
        s2 = "s" if d2 > 1 else ""
        title = (rival_name + " devant, écart réel." if fr else rival_name + " ahead, real gap.")
        text = (rival_name + " domine " + focus_name + " de " + str(d2) + " point" + s2
                + ", un écart large et régulier. Le retard est réel, il faudra le combler." if fr
                else rival_name + " leads " + focus_name + " by " + str(d2) + " point" + s2
                + ", a wide and consistent gap. The gap is real, it will need closing.")
        return {"title": title, "color": SIENNA, "text": text}
    d3 = abs(round(diff))
    if fr:
        gap = "sont à égalité" if d3 == 0 else ("se tiennent à " + str(d3) + " point" + ("s" if d3 > 1 else ""))
        title = "Trop proche pour trancher."
        text = (focus_name + " et " + rival_name + " " + gap + ", trop proche pour les départager. "
                "On préfère le dire que d'inventer un gagnant.")
    else:
        gap = "are tied" if d3 == 0 else ("are within " + str(d3) + " point" + ("s" if d3 > 1 else ""))
        title = "Too close to call."
        text = (focus_name + " and " + rival_name + " " + gap + ", too close to call. "
                "We would rather say so than invent a winner.")
    return {"title": title, "color": INK, "text": text}


_SHARE_VERDICT_WORD = {
    "fr": {"STABLE": "stable", "MODERE": "modéré", "VOLATIL": "volatil", "SINGLE_RUN": "mesure unique"},
    "en": {"STABLE": "stable", "MODERE": "moderate", "VOLATIL": "volatile", "SINGLE_RUN": "single measure"},
}


def _share_axis_html(rows, fr):
    """Static (pure HTML/CSS, no JS) bracket axis: one row per bounded brand
    (focus first, then the rival if any), each bracket positioned on the same
    adaptive [lo, hi] window the live page projects the 3D cloud onto."""
    e = _html.escape
    lo, hi = _share_window(rows)
    span = (hi - lo) or 1
    out = ('<div style="display:flex;justify-content:space-between;font-family:\'IBM Plex Mono\',Menlo,monospace;'
           'font-size:9px;color:#958772;font-variant-numeric:tabular-nums;">'
           '<span>' + str(lo) + '</span><span>' + ("échelle" if fr else "scale") + '</span><span>' + str(hi) + '</span></div>')
    out += '<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px;">'
    for r in rows:
        color = "#C6A15B" if r["focus"] else "#958772"
        bounded = r["m"] is not None
        m = r["m"] or 0
        pct_lo = max(0.0, min(100.0, (r["s"] - m - lo) / span * 100))
        pct_hi = max(0.0, min(100.0, (r["s"] + m - lo) / span * 100))
        pct_mid = max(0.0, min(100.0, (r["s"] - lo) / span * 100))
        range_txt = (("entre " + str(max(0, r["s"] - m)) + " et " + str(min(100, r["s"] + m))) if (fr and bounded)
                     else ("between " + str(max(0, r["s"] - m)) + " and " + str(min(100, r["s"] + m))) if bounded
                     else ("mesure unique, non bornée" if fr else "single measurement, not bounded"))
        out += ('<div style="display:flex;align-items:center;gap:10px;">'
                '<span style="width:120px;flex:none;font-family:\'Archivo\',Helvetica,Arial,sans-serif;font-size:11.5px;'
                'color:' + ("#E8DFD2" if r["focus"] else "#B2A694") + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'
                + e(r["name"]) + '</span>'
                '<div style="position:relative;flex:1;height:12px;background:#2F261D;">'
                '<div style="position:absolute;left:' + ("%.2f" % pct_lo) + '%;width:' + ("%.2f" % max(0.0, pct_hi - pct_lo))
                + '%;top:0;bottom:0;border-left:2px solid ' + color + ';border-right:2px solid ' + color
                + ';box-sizing:border-box;background:' + color + '22;"></div>'
                '<div style="position:absolute;left:' + ("%.2f" % pct_mid) + '%;top:-3px;bottom:-3px;width:2px;background:' + color + ';"></div>'
                '</div>'
                '<span style="width:150px;flex:none;text-align:right;font-family:\'IBM Plex Mono\',Menlo,monospace;'
                'font-size:10px;color:#958772;font-variant-numeric:tabular-nums;">' + e(range_txt) + '</span>'
                '</div>')
    out += '</div>'
    return out


def _render_share_not_found(fr):
    body = ('Ce lien de partage est introuvable ou a expiré.' if fr
            else 'This share link could not be found or has expired.')
    cta = 'Mesurer une marque' if fr else 'Measure a brand'
    return ('<!doctype html><html lang="' + ("fr" if fr else "en") + '"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>Nadelio</title>'
            '<meta name="robots" content="noindex">'
            '<style>body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;'
            'background:#211A14;color:#E8DFD2;font-family:Helvetica,Arial,sans-serif;text-align:center;padding:24px;}'
            'a{color:#C6A15B;}</style></head><body><div>'
            '<p style="font-size:15px;line-height:1.5;max-width:44ch;">' + _html.escape(body) + '</p>'
            '<p><a href="/">' + _html.escape(cta) + ' &rsaquo;</a></p>'
            '</div></body></html>')


def _render_share_page(result, token):
    """Server-rendered, dependency-free HTML for one shared result, in the v2
    visual language (same palette/fonts as the live instrument). No three.js,
    no client JS needed: the bracket axis is pure HTML/CSS. Every interpolated
    value (brand names, queries, hosts) is escaped. All of it is user/API
    derived, never trusted as markup."""
    e = _html.escape
    fr = _share_is_fr(result)
    brand = str(result.get("brand", ""))
    market = str(result.get("market", ""))
    geo = result.get("geo") or {}
    geo_rival = result.get("geo_rival")
    point = geo.get("point")
    hw = geo.get("half_width")
    verdict_word = (_SHARE_VERDICT_WORD["fr" if fr else "en"].get(geo.get("verdict"), "")) if geo else ""
    v = _share_verdict(fr, brand, geo if geo.get("point") is not None else None, geo_rival)

    rows = []
    if point is not None:
        rows.append({"name": brand, "s": point, "m": hw, "focus": True})
        if geo_rival and geo_rival.get("point") is not None:
            rows.append({"name": geo_rival.get("brand", ""), "s": geo_rival["point"],
                         "m": geo_rival.get("half_width"), "focus": False})
    axis_html = _share_axis_html(rows, fr) if rows else ""

    field_rows = _share_field_rows(result)
    field_html = ""
    for f in field_rows:
        field_html += (
            '<tr' + (' style="background:rgba(198,161,91,0.08);"' if f["is_focus"] else '') + '>'
            + '<td style="padding:9px 12px;font-weight:' + ("600" if f["is_focus"] else "400") + ';color:'
            + ("#C6A15B" if f["is_focus"] else "#E8DFD2") + ';">' + e(f["name"])
            + ((" (" + ("vous" if fr else "you") + ")") if f["is_focus"] else "") + '</td>'
            + '<td style="padding:9px 12px;color:' + ("#93A06E" if f["ai"].get("present") else "#AE7A64")
            + ';font-variant-numeric:tabular-nums;">' + e(_share_ai_label(f["ai"], fr)) + '</td>'
            + '<td style="padding:9px 12px;color:' + ("#958772" if f["serp"] is not None else "#AE7A64")
            + ';font-variant-numeric:tabular-nums;">' + e(_share_google_label(f["serp"], fr)) + '</td>'
            + '<td style="padding:9px 12px;text-align:right;font-family:\'IBM Plex Mono\',Menlo,monospace;'
            + 'font-variant-numeric:tabular-nums;color:' + ("#C6A15B" if f["is_focus"] else "#958772") + ';">'
            + str(round(f["share"])) + '%</td></tr>'
        )

    measured_date = str(result.get("measured_at") or "")[:10]
    provider = str(result.get("ai_provider_label") or ("l'IA" if fr else "the AI"))
    model = str(result.get("ai_model") or "")
    n_runs = geo.get("n") or 0
    n_queries = len(result.get("queries") or [])
    s1 = "s" if n_queries > 1 else ""
    if fr:
        footnote = (
            ("Mesuré le " + measured_date + ". " if measured_date else "")
            + str(n_queries) + " question" + s1 + " sur Google" + (" (" + market + ")" if market else "")
            + " et 1 IA (" + provider + (", " + model if model else "") + "), "
            + str(n_runs) + (" passage" if n_runs <= 1 else " passages") + " par question."
        )
    else:
        footnote = (
            ("Measured on " + measured_date + ". " if measured_date else "")
            + str(n_queries) + " question" + s1 + " on Google" + (" (" + market + ")" if market else "")
            + " and 1 AI (" + provider + (", " + model if model else "") + "), "
            + str(n_runs) + (" pass " if n_runs <= 1 else " passes ") + "per question."
        )

    title = (e(brand) + ", " + str(point) + " sur 100 en visibilité IA") if (fr and point is not None) else \
            (e(brand) + " en visibilité IA") if fr else \
            (e(brand) + ", " + str(point) + " out of 100 in AI visibility") if point is not None else \
            (e(brand) + " in AI visibility")
    desc = e(v["text"] or (("Mesure de visibilité IA pour " + brand) if fr else ("AI visibility measurement for " + brand)))
    canonical = SITE_URL + "/r/" + token
    og_image = SITE_URL + "/demo-nadelio.gif"

    score_block = ""
    if point is not None:
        pm = (' <span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:16px;color:#A39784;'
              'font-variant-numeric:tabular-nums;">&plusmn;' + str(hw) + '</span>') if hw is not None else ""
        tag = ('<div style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:10.5px;letter-spacing:0.1em;'
               'text-transform:uppercase;color:#958772;margin-top:6px;">' + e(verdict_word) + '</div>') if verdict_word else ""
        score_block = (
            '<div style="display:flex;flex-direction:column;gap:2px;">'
            '<div style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:9.5px;letter-spacing:0.18em;'
            'text-transform:uppercase;color:#A39784;">' + ("score de visibilité IA" if fr else "AI visibility score") + '</div>'
            '<div style="display:flex;align-items:baseline;gap:4px;">'
            '<span style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:clamp(40px,7vw,64px);'
            'line-height:1;color:#C6A15B;font-variant-numeric:tabular-nums;">' + str(point) + '</span>' + pm
            + '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:13px;color:#958772;">/100</span>'
            '</div>' + tag + '</div>'
        )

    return (
        '<!doctype html><html lang="' + ("fr" if fr else "en") + '"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>' + title + '</title>'
        '<meta name="description" content="' + desc + '">'
        '<link rel="canonical" href="' + e(canonical) + '">'
        '<meta name="theme-color" content="#211A14">'
        '<meta property="og:type" content="article">'
        '<meta property="og:url" content="' + e(canonical) + '">'
        '<meta property="og:title" content="' + title + '">'
        '<meta property="og:description" content="' + desc + '">'
        '<meta property="og:image" content="' + e(og_image) + '">'
        '<meta name="twitter:card" content="summary_large_image">'
        '<meta name="twitter:title" content="' + title + '">'
        '<meta name="twitter:description" content="' + desc + '">'
        '<meta name="twitter:image" content="' + e(og_image) + '">'
        '<style>'
        "@font-face{font-family:'Archivo Black';font-style:normal;font-weight:400;font-display:swap;"
        "src:url('/assets/v2/fonts/archivo-black-400.woff2') format('woff2');}"
        "@font-face{font-family:'Archivo';font-style:normal;font-weight:400;font-display:swap;"
        "src:url('/assets/v2/fonts/archivo-400.woff2') format('woff2');}"
        "@font-face{font-family:'Archivo';font-style:normal;font-weight:600;font-display:swap;"
        "src:url('/assets/v2/fonts/archivo-600.woff2') format('woff2');}"
        "@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:400;font-display:swap;"
        "src:url('/assets/v2/fonts/ibm-plex-mono-400.woff2') format('woff2');}"
        "@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:500;font-display:swap;"
        "src:url('/assets/v2/fonts/ibm-plex-mono-500.woff2') format('woff2');}"
        '*{box-sizing:border-box;}'
        'html,body{margin:0;padding:0;background:#211A14;color:#E8DFD2;}'
        'body{font-family:Archivo,Helvetica,Arial,sans-serif;line-height:1.55;padding:clamp(24px,5vw,56px) clamp(16px,4vw,32px) 64px;}'
        'a{color:#B2A694;border-bottom:1px solid #564D3C;text-decoration:none;}a:hover{color:#C6A15B;border-bottom-color:#C6A15B;}'
        '.wrap{max-width:760px;margin:0 auto;display:flex;flex-direction:column;gap:26px;}'
        '.card{background:#231D18;border:1px solid #362E24;padding:clamp(18px,3vw,28px);}'
        'table{width:100%;border-collapse:collapse;font-size:12.5px;}'
        'th{text-align:left;padding:0 12px 8px;font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:9px;'
        'letter-spacing:0.12em;text-transform:uppercase;color:#958772;}'
        '.twrap{overflow-x:auto;}'
        '</style></head><body><div class="wrap">'
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;">'
        '<a href="/" style="font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-size:15px;'
        'letter-spacing:0.08em;color:#E8DFD2;border:none;">NADELIO</a>'
        '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:9.5px;letter-spacing:0.14em;'
        'text-transform:uppercase;color:#A39784;">' + ("mesuré par nadelio" if fr else "measured by nadelio") + '</span>'
        '</div>'
        '<div style="display:flex;flex-direction:column;gap:10px;">'
        '<div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;">'
        '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:9.5px;letter-spacing:0.2em;'
        'text-transform:uppercase;color:#A39784;">verdict</span>'
        '<span style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-weight:600;font-size:10px;'
        'color:#211A14;background:#C6A15B;padding:2px 8px;line-height:1.5;">' + e(brand) + '</span>'
        '</div>'
        '<h1 style="margin:0;font-family:\'Archivo Black\',\'Arial Black\',sans-serif;font-weight:400;'
        'font-size:clamp(26px,4.4vw,44px);line-height:1.02;letter-spacing:-0.01em;color:' + v["color"] + ';">'
        + e(v["title"] or (brand + (" mesuré" if fr else " measured"))) + '</h1>'
        '<div style="font-size:14px;line-height:1.5;color:#C9BEAC;max-width:60ch;">' + e(v["text"]) + '</div>'
        '</div>'
        + ('<div class="card">' + score_block + ('<div style="margin-top:20px;">' + axis_html + '</div>' if axis_html else '') + '</div>' if (score_block or axis_html) else '')
        + (
            '<div class="card">'
            '<div style="font-family:\'IBM Plex Mono\',Menlo,monospace;font-size:9.5px;letter-spacing:0.18em;'
            'text-transform:uppercase;color:#A39784;margin-bottom:12px;">' + ("le champ mesuré" if fr else "the measured field") + '</div>'
            '<div class="twrap"><table><thead><tr>'
            '<th>' + ("marque" if fr else "brand") + '</th>'
            '<th>' + ("en ia" if fr else "in ai") + '</th>'
            '<th>' + ("sur google" if fr else "on google") + '</th>'
            '<th style="text-align:right;">' + ("part de voix" if fr else "share of voice") + '</th>'
            '</tr></thead><tbody>' + field_html + '</tbody></table></div>'
            '</div>'
            if field_html else ''
        )
        + '<div style="font-size:11.5px;line-height:1.5;color:#958772;border-top:1px solid #362E24;padding-top:14px;">' + e(footnote) + '</div>'
        + '<div>'
        '<a href="/" style="display:inline-block;border:none;background:#E8DFD2;color:#211A14;'
        'font-family:Archivo,Helvetica,Arial,sans-serif;font-weight:600;font-size:11px;letter-spacing:0.08em;'
        'text-transform:uppercase;padding:12px 20px;">' + ("mesurer votre marque" if fr else "measure your brand") + '</a>'
        '</div>'
        '</div></body></html>'
    )


@app.route("/r/<token>", strict_slashes=False)
def share_page(token):
    """Public, server-rendered share page for one signed result. 404 (not a
    softer empty state) for anything that is not a real, known token: an
    unknown token, a malformed one, or history storage being unavailable all
    look identical from the outside. Never confirm or deny which."""
    fr_default = False
    if not _SHARE_TOKEN_RE.match(token or "") or not _history_enabled():
        resp = app.make_response(_render_share_not_found(fr_default))
        resp.status_code = 404
        return resp
    try:
        rows = _d1_query("SELECT payload FROM shares WHERE token = ?", [token])
    except Exception:
        logger.warning("share fetch failed (non-fatal)", exc_info=True)
        rows = []
    if not rows:
        resp = app.make_response(_render_share_not_found(fr_default))
        resp.status_code = 404
        return resp
    try:
        result = json.loads(rows[0].get("payload") or "")
        if not isinstance(result, dict):
            raise ValueError("bad payload shape")
    except Exception:
        resp = app.make_response(_render_share_not_found(fr_default))
        resp.status_code = 404
        return resp
    resp = app.make_response(_render_share_page(result, token))
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


# ---------------------------------------------------------------------------
# Funnel tracking (best-effort, fail-open, no third-party analytics)
# ---------------------------------------------------------------------------
_EVENT_ALLOWLIST = (
    "input_submitted", "result_seen", "sample_seen", "plan_shown",
    "deep_click", "monitor_click", "checkout_started",
)


def _event_salt():
    return (os.environ.get("EVENT_SALT") or os.environ.get("CRON_SECRET")
            or os.environ.get("ANTHROPIC_API_KEY") or "")


def _hash_ip(ip):
    digest = hashlib.sha256((str(ip) + _event_salt()).encode("utf-8")).hexdigest()
    return digest[:16]


# ---------------------------------------------------------------------------
# Share signature (THE trust anchor for /api/share and /r/<token>).
#
# If anyone could fabricate a "Nadelio measured" page with invented numbers,
# the whole product's trust asset would be dead. So a share page may ONLY
# ever be minted from a result THIS server produced: every /api/analyze
# response with mode=="live" carries a share_sig, an HMAC-SHA256 over the
# canonical JSON of every OTHER field, keyed with the same salt already used
# for _hash_ip / _visitor_day_hash. /api/share re-derives this signature from
# the verbatim raw response text the browser held onto and refuses anything
# that does not match byte-for-byte (hmac.compare_digest, constant time).
# Never signs the demo SAMPLE (mode=="demo") or any non-live shape.
# ---------------------------------------------------------------------------
def _canonical_result_json(d):
    """Deterministic JSON bytes for a result dict: sorted keys (recursively),
    no incidental whitespace. Two equal dicts ALWAYS canonicalize identically
    regardless of Python dict insertion order or how they were parsed, which
    is what lets the client round-trip a raw response back to us and still
    verify byte-for-byte against what we signed."""
    return json.dumps(d, sort_keys=True, separators=(",", ":"))


def _sign_share(result):
    """Return a NEW dict equal to `result` plus a fresh "share_sig", for a
    mode=="live" result only (the demo SAMPLE and any other shape pass through
    unchanged, un-signed). Never mutates the dict passed in, so callers can
    keep caching/logging the original object safely."""
    if not isinstance(result, dict) or result.get("mode") != "live":
        return result
    base = {k: v for k, v in result.items() if k != "share_sig"}
    sig = hmac.new(_event_salt().encode("utf-8"),
                    _canonical_result_json(base).encode("utf-8"),
                    hashlib.sha256).hexdigest()
    base["share_sig"] = sig
    return base


@app.route("/api/event", methods=["POST"])
def api_event():
    """Best-effort funnel event log. Always returns 200 to the client (the
    client never needs to know or care whether the write landed): a down or
    misconfigured D1, a bad payload, or a rate-limit hit all just skip the
    write silently. Never a load-bearing call, never 500."""
    data = _read_json()
    name = str(data.get("name") or "")
    if name not in _EVENT_ALLOWLIST:
        return jsonify({"error": "unknown event"}), 400

    # Light per-IP rate-limit, same bucket pattern as /api/infer.
    ip = _client_ip()
    minute = int(time.time() // 60)
    with _live_lock:
        entry = _event_hits.get(ip)
        if not entry or entry[0] != minute:
            for stale in [k for k, v in _event_hits.items() if v[0] != minute]:
                del _event_hits[stale]
            _event_hits[ip] = [minute, 1]
        elif entry[1] >= _EVENT_RATE_PER_MIN:
            return jsonify({"ok": True})
        else:
            entry[1] += 1

    if _history_enabled():
        try:
            _d1_query(
                "CREATE TABLE IF NOT EXISTS funnel_events ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, name TEXT, "
                "brand TEXT, market TEXT, tier TEXT, meta TEXT, ip_hash TEXT)")
            _d1_query(
                "INSERT INTO funnel_events (ts, name, brand, market, tier, meta, ip_hash) "
                "VALUES (?,?,?,?,?,?,?)",
                [
                    datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    name,
                    str(data.get("brand") or "")[:120],
                    str(data.get("market") or "")[:120],
                    str(data.get("tier") or "")[:120],
                    str(data.get("meta") or "")[:120],
                    _hash_ip(ip),
                ])
        except Exception:
            logger.warning("funnel event log failed (non-fatal)", exc_info=True)

    return jsonify({"ok": True})


@app.route("/api/admin/funnel", methods=["GET"])
def api_admin_funnel():
    """Owner-only funnel dashboard feed. Returns 404 (not 401) whenever the
    token is missing, wrong, or ADMIN_TOKEN is unset, so the endpoint's mere
    existence is never revealed to an unauthenticated caller."""
    admin_token = os.environ.get("ADMIN_TOKEN")
    given = request.args.get("token", "")
    if not admin_token or not hmac.compare_digest(given, admin_token):
        return jsonify({"error": "not found"}), 404

    if not _history_enabled():
        return jsonify({"error": "history store unavailable"})

    def _window(days):
        counts = {n: 0 for n in _EVENT_ALLOWLIST}
        try:
            since = (datetime.datetime.now(datetime.timezone.utc)
                     - datetime.timedelta(days=days)).isoformat()
            rows = _d1_query(
                "SELECT name, COUNT(*) AS n FROM funnel_events "
                "WHERE ts >= ? GROUP BY name", [since])
            for r in rows:
                n = r.get("name")
                if n in counts:
                    counts[n] = int(r.get("n") or 0)
        except Exception:
            logger.warning("admin funnel query failed (non-fatal)", exc_info=True)

        def _rate(numer, denom):
            a, b = counts.get(numer, 0), counts.get(denom, 0)
            return round(a / b, 4) if b else None

        conversions = {
            "result_seen_per_input_submitted": _rate("result_seen", "input_submitted"),
            "deep_click_per_result_seen": _rate("deep_click", "result_seen"),
            "checkout_started_per_deep_click": _rate("checkout_started", "deep_click"),
        }
        return {"counts": counts, "conversions": conversions}

    out = {"window_7d": _window(7), "window_30d": _window(30)}

    try:
        since_7d = (datetime.datetime.now(datetime.timezone.utc)
                    - datetime.timedelta(days=7)).isoformat()
        rows = _d1_query(
            "SELECT COUNT(DISTINCT ip_hash) AS n FROM funnel_events WHERE ts >= ?",
            [since_7d])
        out["distinct_visitors_7d"] = int((rows[0].get("n") if rows else 0) or 0)
    except Exception:
        logger.warning("admin funnel distinct-visitor query failed (non-fatal)", exc_info=True)
        out["distinct_visitors_7d"] = 0

    return jsonify(out)


# ===========================================================================
# First-party visitor analytics (STRICTLY ADDITIVE, RGPD-clean, fail-open).
#
# A light, cookieless, dependency-free analytics layer that lives ENTIRELY in
# new blocks below. It reuses the existing D1 store (_d1_query / _history_enabled),
# the existing IP hashing salt (_event_salt), the existing rate-limit pattern
# (_live_lock + per-IP minute buckets) and the existing ADMIN_TOKEN auth. It
# never modifies an existing function or route. No cookie is ever set, no raw IP
# is ever stored, no external network call is ever made, and every write is
# best-effort on a daemon thread so it can never block or break a response.
# ===========================================================================

# Bots we never count as human page views. Matched case-insensitively against
# the User-Agent string.
_BOT_UA_RE = re.compile(
    r"bot|crawl|spider|slurp|bing|headless|monitor|preview|"
    r"facebookexternalhit|python-requests|curl|wget",
    re.I,
)

# Static assets we never log as a page view (belt-and-braces on top of the
# text/html Content-Type gate). A trailing known-asset extension or the /assets
# prefix means "not a page".
_ASSET_EXT_RE = re.compile(
    r"\.(?:js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|bmp|"
    r"woff2?|ttf|otf|eot|mp4|webm|ogg|mp3|wav|pdf|wasm|json|xml|txt)$",
    re.I,
)


def _visitor_day_hash(ip, ua):
    """Cookieless, daily-rotating anonymous visitor id (the Plausible technique).

    sha256 of (ip + user-agent + today's UTC date + the shared event salt),
    truncated to 16 hex chars. Because the hashed input INCLUDES today's UTC
    date, the SAME visitor produces a DIFFERENT hash every day: they cannot be
    followed across days, and no raw IP is ever stored. RGPD-clean by
    construction, exactly like the funnel ip_hash but rotated daily."""
    raw = str(ip) + "|" + str(ua) + "|" + _today_utc() + "|" + _event_salt()
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def _parse_ua(ua):
    """Very light User-Agent parse with zero dependency. Returns
    {device, browser, os}. device is one of 'mobile', 'tablet', 'desktop',
    'bot'. Bots short-circuit to device 'bot' with empty browser/os so callers
    can drop them cheaply."""
    ua = str(ua or "")
    low = ua.lower()
    if not low or _BOT_UA_RE.search(low):
        return {"device": "bot", "browser": "", "os": ""}

    # Device: tablets first (an Android tablet has no 'mobile' token), then
    # phones, else desktop.
    if re.search(r"ipad|tablet|kindle|playbook|silk", low) or (
        "android" in low and "mobile" not in low
    ):
        device = "tablet"
    elif re.search(r"mobi|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone", low):
        device = "mobile"
    else:
        device = "desktop"

    # Browser: order matters (Edge/Opera masquerade as Chrome, Chrome as Safari).
    if "edg" in low:
        browser = "Edge"
    elif "opr" in low or "opera" in low:
        browser = "Opera"
    elif "firefox" in low or "fxios" in low:
        browser = "Firefox"
    elif "chrome" in low or "crios" in low or "chromium" in low:
        browser = "Chrome"
    elif "safari" in low:
        browser = "Safari"
    else:
        browser = "Other"

    # OS. Apple mobiles are checked BEFORE macOS: an iOS UA contains the literal
    # "like Mac OS X", so a naive "mac os" test would misclassify every iPhone.
    if "windows" in low:
        os_name = "Windows"
    elif re.search(r"iphone|ipad|ipod", low):
        os_name = "iOS"
    elif "android" in low:
        os_name = "Android"
    elif "mac os" in low or "macintosh" in low:
        os_name = "macOS"
    elif "linux" in low:
        os_name = "Linux"
    else:
        os_name = "Other"

    return {"device": device, "browser": browser, "os": os_name}


def _geo_country(req):
    """Best-effort ISO 3166 country code, from a CDN/proxy header if the deploy
    sits behind one, else 'ZZ' (unknown). NO network call, NO dependency: this
    only reads headers already on the request. A local GeoLite2 lookup could be
    wired in here later without changing a single caller."""
    for header in ("CF-IPCountry", "X-Vercel-IP-Country", "X-Country-Code", "Fastly-Geo-Country"):
        val = (req.headers.get(header) or "").strip().upper()
        # Cloudflare uses 'XX' (unknown) and 'T1' (Tor); treat both as unknown.
        if val and val not in ("XX", "T1") and re.fullmatch(r"[A-Z]{2}", val):
            return val
    return "ZZ"


def _store_pageview(row):
    """Fire-and-forget D1 write of one page view. Runs on a daemon thread so the
    HTTP round-trip to D1 never blocks the user's response. Best-effort: creates
    the table on first write (same pattern as funnel_events) and swallows every
    error."""
    try:
        _d1_query(
            "CREATE TABLE IF NOT EXISTS pageviews ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, path TEXT, "
            "ref_host TEXT, country TEXT, device TEXT, browser TEXT, os TEXT, "
            "visitor TEXT)")
        _d1_query(
            "INSERT INTO pageviews (ts, path, ref_host, country, device, browser, os, visitor) "
            "VALUES (?,?,?,?,?,?,?,?)",
            list(row))
    except Exception:
        logger.warning("pageview D1 write failed (non-fatal)", exc_info=True)


@app.after_request
def _log_pageview(response):
    """Additive page-view logger. A SEPARATE after_request from
    set_security_headers (Flask runs every registered after_request), so the
    existing header logic is untouched.

    Logs one page view only when ALL hold: GET, HTTP 200, Content-Type is
    text/html, the path is a real page (not /api, not /analytics, not a static
    asset), and the visitor is not a bot. The D1 write is dispatched on a daemon
    thread and NEVER blocks the response. The whole body is wrapped so any error
    returns the response intact. Page views are deliberately NOT rate-limited
    (only bot-filtered)."""
    try:
        if request.method != "GET" or response.status_code != 200:
            return response
        ctype = response.headers.get("Content-Type") or ""
        if not ctype.startswith("text/html"):
            return response
        path = request.path or "/"
        if (path.startswith("/api") or path == "/analytics"
                or path.startswith("/assets") or _ASSET_EXT_RE.search(path)):
            return response

        ua = request.headers.get("User-Agent", "")
        dev = _parse_ua(ua)
        if dev["device"] == "bot":
            return response
        if not _history_enabled():
            return response

        # Referrer host: 'direct' when absent or when it is our own host.
        ref_host = "direct"
        ref = request.referrer or ""
        if ref:
            try:
                rh = urllib.parse.urlparse(ref).netloc.lower()
                rh = rh[4:] if rh.startswith("www.") else rh
                own = urllib.parse.urlparse(request.host_url).netloc.lower()
                own = own[4:] if own.startswith("www.") else own
                if rh and rh != own:
                    ref_host = rh
            except ValueError:
                pass

        row = (
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
            path[:300],
            ref_host[:120],
            _geo_country(request)[:2],
            dev["device"][:12],
            dev["browser"][:20],
            dev["os"][:20],
            _visitor_day_hash(_client_ip(), ua),
        )
        threading.Thread(target=_store_pageview, args=(row,), daemon=True).start()
    except Exception:
        logger.warning("pageview log skipped (non-fatal)", exc_info=True)
    return response


# Light per-IP rate-limit for the click endpoint (spam guard, not a billing
# gate), same bucket pattern as _event_hits / _infer_hits.
_track_hits = {}  # {ip: [minute_bucket_int, count]}
_TRACK_RATE_PER_MIN = int(os.environ.get("TRACK_RATE_PER_MIN", "120"))


def _store_ui_event(row):
    """Fire-and-forget D1 write of one UI click. Daemon thread, best-effort,
    creates its table on first write. Never raises."""
    try:
        _d1_query(
            "CREATE TABLE IF NOT EXISTS ui_events ("
            "id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, label TEXT, "
            "path TEXT, visitor TEXT)")
        _d1_query(
            "INSERT INTO ui_events (ts, label, path, visitor) VALUES (?,?,?,?)",
            list(row))
    except Exception:
        logger.warning("ui event D1 write failed (non-fatal)", exc_info=True)


@app.route("/api/track", methods=["POST"])
def api_track():
    """Best-effort first-party UI click log. Always returns 200 (like /api/event):
    a bad payload, a rate-limit hit, or a down/misconfigured D1 all just skip the
    write silently. Never load-bearing, never 500."""
    data = _read_json()
    label = str(data.get("label") or "").strip()[:80]
    path = str(data.get("path") or "")[:200]
    if not label:
        return jsonify({"ok": True})

    ip = _client_ip()
    minute = int(time.time() // 60)
    with _live_lock:
        entry = _track_hits.get(ip)
        if not entry or entry[0] != minute:
            for stale in [k for k, v in _track_hits.items() if v[0] != minute]:
                del _track_hits[stale]
            _track_hits[ip] = [minute, 1]
        elif entry[1] >= _TRACK_RATE_PER_MIN:
            return jsonify({"ok": True})
        else:
            entry[1] += 1

    if _history_enabled():
        row = (
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
            label,
            path,
            _visitor_day_hash(ip, request.headers.get("User-Agent", "")),
        )
        threading.Thread(target=_store_ui_event, args=(row,), daemon=True).start()

    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Owner-only visitor analytics dashboard at /analytics?token=ADMIN_TOKEN.
# Same auth pattern as /api/admin/funnel: 404 (never 401) when the token is
# missing, wrong, or ADMIN_TOKEN is unset, so the route's existence is never
# revealed. Every D1 query is wrapped so one failing query never breaks the page.
# ---------------------------------------------------------------------------
def _analytics_q(sql, params=None):
    """One analytics D1 read, returning rows or [] on any error (so a single bad
    query never brings down the whole dashboard)."""
    try:
        return _d1_query(sql, params or [])
    except Exception:
        logger.warning("analytics query failed (non-fatal)", exc_info=True)
        return []


def _analytics_pv_stats(since):
    """(views, unique_visitors) from pageviews since an ISO timestamp."""
    rows = _analytics_q(
        "SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS uniq "
        "FROM pageviews WHERE ts >= ?", [since])
    r = rows[0] if rows else {}
    return int(r.get("views") or 0), int(r.get("uniq") or 0)


def _analytics_top(select_expr, table, since, limit=10):
    """Generic top-N GROUP BY over one analytics table. select_expr and table are
    hard-coded literals from this module (never user input), so building the SQL
    from them is safe; the time bound is always parameterized."""
    rows = _analytics_q(
        "SELECT " + select_expr + " AS k, COUNT(*) AS n FROM " + table
        + " WHERE ts >= ? GROUP BY k ORDER BY n DESC LIMIT " + str(int(limit)),
        [since])
    return [(str(r.get("k") or ""), int(r.get("n") or 0)) for r in rows]


def _analytics_failures(since):
    """(count in the last 24h, last failure row or None) from analyze_failures.
    Wrapped through _analytics_q so a missing table (no failure ever recorded
    yet, since the table self-creates on first write) or any D1 error just
    reads as zero/none instead of breaking the dashboard."""
    count_rows = _analytics_q(
        "SELECT COUNT(*) AS n FROM analyze_failures WHERE ts >= ?", [since])
    count = int((count_rows[0].get("n") if count_rows else 0) or 0)
    last_rows = _analytics_q(
        "SELECT ts, brand, reason FROM analyze_failures ORDER BY ts DESC LIMIT 1")
    last = last_rows[0] if last_rows else None
    return count, last


def _render_analytics_dashboard():
    """Self-contained dark dashboard HTML. CSS inline, no external asset, no JS
    required. Warm dark instrument world consistent with the site."""
    e = _html.escape
    SHELL_HEAD = (
        "<!DOCTYPE html><html lang=\"fr\"><head><meta charset=\"UTF-8\">"
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">"
        "<title>Analytics, Nadelio</title>"
        "<meta name=\"robots\" content=\"noindex, nofollow\">"
        "<style>"
        "*{margin:0;padding:0;box-sizing:border-box}"
        ":root{--bg:#14100C;--ink:#E8DFD2;--muted:#8A8172;--accent:#C6A15B;"
        "--card:#1C1710;--line:#2A2118}"
        "html{-webkit-text-size-adjust:100%}"
        "body{font-family:'Inter','Segoe UI',-apple-system,sans-serif;background:var(--bg);"
        "color:var(--ink);line-height:1.55;padding:44px 22px 90px}"
        ".wrap{max-width:940px;margin:0 auto}"
        ".num{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;"
        "font-variant-numeric:tabular-nums}"
        "h1{font-size:24px;font-weight:600;letter-spacing:-.4px}"
        ".sub{color:var(--muted);font-size:13px;margin-top:4px}"
        ".eyebrow{font:600 11px ui-monospace,monospace;letter-spacing:.14em;"
        "text-transform:uppercase;color:var(--accent);margin-bottom:10px}"
        ".kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:26px 0}"
        ".kpi{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px}"
        ".kpi .lab{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}"
        ".kpi .big{font-size:34px;font-weight:600;letter-spacing:-1px;margin-top:8px;color:var(--ink)}"
        ".kpi .small{font-size:13px;color:var(--accent);margin-top:6px}"
        ".card{background:var(--card);border:1px solid var(--line);border-radius:14px;"
        "padding:22px;margin-bottom:16px}"
        ".card h2{font:600 12px 'Inter';letter-spacing:.06em;text-transform:uppercase;"
        "color:var(--accent);margin-bottom:16px}"
        ".grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}"
        "table{width:100%;border-collapse:collapse;font-size:14px}"
        "th{text-align:left;font:600 10px 'Inter';letter-spacing:.06em;text-transform:uppercase;"
        "color:var(--muted);padding:0 8px 9px}"
        "td{padding:9px 8px;border-top:1px solid var(--line)}"
        "td.n{text-align:right;color:var(--accent)}"
        ".chart{display:flex;align-items:flex-end;gap:6px;height:150px;padding-top:20px}"
        ".col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%}"
        ".cn{font:600 10px ui-monospace,monospace;color:var(--muted);margin-bottom:5px}"
        ".bar{width:100%;max-width:34px;background:linear-gradient(180deg,#C6A15B,#8A6E34);"
        "border-radius:4px 4px 0 0;min-height:2px}"
        ".cl{font:500 10px ui-monospace,monospace;color:var(--muted);margin-top:7px}"
        ".empty{color:var(--muted);font-size:13px;font-style:italic}"
        "a{color:var(--accent);text-decoration:none}a:hover{opacity:.75}"
        "footer{margin-top:30px;font-size:12px;color:var(--muted)}"
        ".twrap{overflow-x:auto}"
        "@media(max-width:680px){.kpis{grid-template-columns:1fr}.grid2{grid-template-columns:1fr}}"
        "</style></head><body><div class=\"wrap\">"
    )

    if not _history_enabled():
        return (SHELL_HEAD
                + "<div class=\"eyebrow\">Nadelio analytics</div>"
                + "<h1>Analytics visiteurs</h1>"
                + "<div class=\"card\" style=\"margin-top:22px\"><p class=\"empty\">"
                + "Store D1 non configure (variables d'environnement manquantes). "
                + "Renseigne CF_ACCOUNT_ID, CF_D1_DB_ID et CF_D1_TOKEN pour activer "
                + "la collecte.</p></div></div></body></html>")

    now = datetime.datetime.now(datetime.timezone.utc)

    def since_days(n):
        return (now - datetime.timedelta(days=n)).isoformat()

    today_start = _today_utc() + "T00:00:00"
    since_7 = since_days(7)
    since_30 = since_days(30)

    v_today, u_today = _analytics_pv_stats(today_start)
    v_7, u_7 = _analytics_pv_stats(since_7)
    v_30, u_30 = _analytics_pv_stats(since_30)

    def kpi(lab, views, uniq):
        return ("<div class=\"kpi\"><div class=\"lab\">" + lab + "</div>"
                "<div class=\"big num\">" + str(views) + "</div>"
                "<div class=\"small num\">" + str(uniq) + " visiteurs uniques</div></div>")

    kpis = ("<div class=\"kpis\">"
            + kpi("Aujourd'hui", v_today, u_today)
            + kpi("7 jours", v_7, u_7)
            + kpi("30 jours", v_30, u_30)
            + "</div>")

    # Audit-failure observability (missing key, could-not-infer, or a live
    # exception falling back to the demo SAMPLE, see _record_analyze_failure).
    # This is the one number on this dashboard that matters more than
    # traffic: it is how the owner finds out the product is silently failing
    # instead of reading Render stderr no one watches.
    fail_count_24h, last_fail = _analytics_failures(since_days(1))
    if last_fail:
        last_fail_txt = ("Dernier : marque " + e(str(last_fail.get("brand") or "(inconnue)"))
                          + ", raison " + e(str(last_fail.get("reason") or ""))
                          + ", " + e(str(last_fail.get("ts") or ""))[:19].replace("T", " "))
    else:
        last_fail_txt = "Aucun echec enregistre."
    failures_html = ("<div class=\"card\"><h2>Echecs d'audit</h2>"
                      "<p><span class=\"big num\" style=\"font-size:28px\">"
                      + str(fail_count_24h) + "</span> "
                      "<span class=\"sub\">echec(s) sur 24h, retombes sur l'echantillon de "
                      "demonstration au lieu d'une vraie mesure.</span></p>"
                      "<p class=\"sub\" style=\"margin-top:8px\">" + last_fail_txt + "</p></div>")

    # 14-day timeline (bar height proportional to page views per day).
    tl = {}
    for r in _analytics_q(
            "SELECT substr(ts,1,10) AS d, COUNT(*) AS n FROM pageviews "
            "WHERE ts >= ? GROUP BY d", [since_days(14)]):
        tl[str(r.get("d") or "")] = int(r.get("n") or 0)
    days = [(now.date() - datetime.timedelta(days=i)).isoformat() for i in range(13, -1, -1)]
    max_n = max([tl.get(d, 0) for d in days] + [1])
    bars = ""
    for d in days:
        n = tl.get(d, 0)
        bh = int(round(140.0 * n / max_n)) if max_n else 0
        if n and bh < 3:
            bh = 3
        bars += ("<div class=\"col\"><div class=\"cn num\">" + (str(n) if n else "")
                 + "</div><div class=\"bar\" style=\"height:" + str(bh) + "px\"></div>"
                 "<div class=\"cl\">" + e(d[5:]) + "</div></div>")
    timeline = ("<div class=\"card\"><h2>Pages vues, 14 jours</h2>"
                "<div class=\"chart\">" + bars + "</div></div>")

    def top_table(title, rows, first_col):
        if not rows:
            body = "<p class=\"empty\">Aucune donnee sur 30 jours.</p>"
        else:
            trs = ""
            for label, count in rows:
                shown = e(label) if label else "<span class=\"empty\">(vide)</span>"
                trs += ("<tr><td>" + shown + "</td><td class=\"n num\">" + str(count) + "</td></tr>")
            body = ("<div class=\"twrap\"><table><thead><tr><th>" + first_col
                    + "</th><th style=\"text-align:right\">Vues</th></tr></thead>"
                    "<tbody>" + trs + "</tbody></table></div>")
        return "<div class=\"card\"><h2>" + title + "</h2>" + body + "</div>"

    top_pages = _analytics_top("path", "pageviews", since_30)
    top_refs = _analytics_top("ref_host", "pageviews", since_30)
    top_countries = _analytics_top("country", "pageviews", since_30)
    top_devices = _analytics_top("device || ' / ' || browser", "pageviews", since_30)
    top_clicks = _analytics_top("label", "ui_events", since_30)

    top_html = (
        "<div class=\"grid2\">"
        + top_table("Top pages", top_pages, "Page")
        + top_table("Referents", top_refs, "Source")
        + "</div><div class=\"grid2\">"
        + top_table("Pays", top_countries, "Pays")
        + top_table("Appareils", top_devices, "Appareil / navigateur")
        + "</div>"
        + top_table("Clics UI", top_clicks, "Libelle")
    )

    # Funnel recall from the existing funnel_events table (best-effort).
    def funnel_counts(since):
        c = {}
        for r in _analytics_q(
                "SELECT name, COUNT(*) AS n FROM funnel_events WHERE ts >= ? GROUP BY name",
                [since]):
            c[str(r.get("name") or "")] = int(r.get("n") or 0)
        return c

    f7 = funnel_counts(since_7)
    f30 = funnel_counts(since_30)
    frows = ""
    for name in _EVENT_ALLOWLIST:
        frows += ("<tr><td>" + e(name) + "</td>"
                  "<td class=\"n num\">" + str(f7.get(name, 0)) + "</td>"
                  "<td class=\"n num\">" + str(f30.get(name, 0)) + "</td></tr>")
    token = request.args.get("token", "")
    funnel_link = ("<a href=\"/api/admin/funnel?token="
                   + urllib.parse.quote(token, safe="") + "\">Flux funnel JSON complet</a>")
    funnel_html = ("<div class=\"card\"><h2>Funnel</h2>"
                   "<div class=\"twrap\"><table><thead><tr><th>Evenement</th>"
                   "<th style=\"text-align:right\">7 jours</th>"
                   "<th style=\"text-align:right\">30 jours</th></tr></thead>"
                   "<tbody>" + frows + "</tbody></table></div>"
                   "<p class=\"sub\" style=\"margin-top:14px\">" + funnel_link + "</p></div>")

    return (SHELL_HEAD
            + "<div class=\"eyebrow\">Nadelio analytics</div>"
            + "<h1>Analytics visiteurs</h1>"
            + "<p class=\"sub\">Mesure first-party, cookieless, RGPD-clean. "
              "Visiteur anonyme a rotation quotidienne, aucune IP brute stockee.</p>"
            + kpis
            + failures_html
            + timeline
            + top_html
            + funnel_html
            + "<footer>Collecte first-party servie par l'app, sans analytics tiers.</footer>"
            + "</div></body></html>")


@app.route("/analytics", strict_slashes=False)
def analytics_dashboard():
    """Owner-only visitor analytics dashboard. Auth mirrors /api/admin/funnel:
    404 (not 401) whenever the token is missing, wrong, or ADMIN_TOKEN is unset,
    so the route's existence is never revealed to an unauthenticated caller."""
    admin_token = os.environ.get("ADMIN_TOKEN")
    given = request.args.get("token", "")
    if not admin_token or not hmac.compare_digest(given, admin_token):
        return jsonify({"error": "not found"}), 404
    resp = app.make_response(_render_analytics_dashboard())
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Cache-Control"] = "no-store"
    return resp


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
