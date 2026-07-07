import base64
import datetime
import json
import logging
import math
import os
import pathlib
import random
import re
import socket
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


def _client_ip():
    fwd = request.headers.get("X-Forwarded-For")
    if fwd:
        return fwd.split(",")[0].strip()
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
    result = {"ok": False, "brand": "", "created": 0, "pi_id": "",
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
    """Back-compat wrapper: return (ok, brand) for a real, fully-paid session.
    Used by /api/verify-payment, which only reports payment status and does NOT
    consume the unlock. Deep-audit authorization/consumption goes through
    _resolve_paid_depth(), which uses the richer _inspect_paid_session()."""
    info = _inspect_paid_session(session_id)
    return info["ok"], info["brand"]


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
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
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
    body = json.dumps({
        "model": INFER_MODEL,
        "max_tokens": 500,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_ENDPOINT, data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    data = _urlopen_json_with_retry(req, timeout=40, what="Claude API")

    text = "".join(b.get("text", "") for b in data.get("content", []))
    parsed = _extract_json_object(text)
    if parsed is None:
        logger.error("Claude returned no parseable JSON in: %s", text[:300])
        raise RuntimeError("Claude did not return valid JSON for this brand")
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


def _is_public_host(host):
    """Resolve `host` and return True only if EVERY resolved address is a
    public, routable IP. Refuses private / loopback / link-local / reserved /
    multicast addresses — the core SSRF defense."""
    if not host:
        return False
    try:
        infos = socket.getaddrinfo(host, None)
    except (socket.gaierror, UnicodeError, OSError):
        return False
    import ipaddress
    for info in infos:
        addr = info[4][0]
        # Strip a scope id if present (e.g. fe80::1%eth0).
        addr = addr.split("%")[0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_multicast or ip.is_reserved or ip.is_unspecified):
            return False
    return True


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
            if not host or not _is_public_host(host):
                return {}
            req = urllib.request.Request(
                current,
                headers={"User-Agent": _RECON_UA, "Accept": "text/html,*/*;q=0.8"},
                method="GET",
            )
            try:
                # No auto-redirect: we validate each hop ourselves.
                opener = urllib.request.build_opener(_NoRedirect)
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
    if key and key in _recon_cache:
        cached = _recon_cache[key]
        # Serve the cache unless it is an empty result AND we could now do better
        # with a real SERP key (i.e. the empty entry came from a no-SERP preview).
        if cached.get("evidence") or not serp_key:
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
    if key and len(_recon_cache) < _RECON_CACHE_MAX and (result["evidence"] or serp_key):
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


def analyze(brands, queries, api_key, gl=None, hl=None):
    stats = {b: {"mentions": 0, "appearances": 0, "ranks": [], "evidence": [], "cells": {}} for b in brands}
    for query in queries:
        results = run_query(query, api_key, gl=gl, hl=hl)
        hit = {b: False for b in brands}
        for pos, result in enumerate(results, 1):
            for b in brands:
                if brand_in(b, result) and query not in stats[b]["cells"]:
                    stats[b]["appearances"] += 1
                    stats[b]["ranks"].append(pos)
                    hit[b] = True
                    stats[b]["cells"][query] = {
                        "rank": pos,
                        "title": result.get("title", ""),
                        "link": result.get("link", ""),
                        "kind": _result_kind(b, result),
                    }
        for b in brands:
            if hit[b]:
                stats[b]["mentions"] += 1
        time.sleep(1)
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

# Bounded-score verdict thresholds (kept as constants so they can be recalibrated
# without touching the logic). half_width is the +/- of the 95% interval on the
# 0-100 score; ratio is half_width relative to the point estimate.
STABLE_MAX_HALFWIDTH = 4
VOLATIL_MIN_HALFWIDTH = 10
STABLE_MAX_RATIO = 0.15
VOLATIL_MIN_RATIO = 0.30


def _run_ai_visibility_once(brands, queries, api_key):
    """One sampled call. Returns {query: {brand: {"rank": int, "kind": "primary"|"mentioned"}}}."""
    queries_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(queries))
    brands_list = ", ".join(brands)
    prompt = (
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
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
        "max_tokens": 600,
        "temperature": AI_RUN_TEMPERATURE,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_ENDPOINT, data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        data = _urlopen_json_with_retry(req, timeout=40, what="Claude API (AI visibility)")
    except Exception:
        logger.exception("AI visibility run failed")
        return {}  # graceful degradation — SERP data still works (after retries)

    text = "".join(b.get("text", "") for b in data.get("content", []))
    parsed = _extract_json_object(text)
    if parsed is None:
        return {}

    ai_map = {}
    for entry in parsed.get("results", []):
        q = entry.get("query", "")
        matched_q = None
        for real_q in queries:
            if real_q.lower() in q.lower() or q.lower() in real_q.lower():
                matched_q = real_q
                break
        if not matched_q and queries:
            matched_q = queries[0]  # fallback
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


def check_ai_visibility(brands, queries, api_key, n_runs=None, return_runs=False):
    """Run the AI-visibility probe n_runs times and aggregate into per-brand
    per-query stats: average rank, mention rate (consistency), and whether the
    brand was ever the primary recommendation.

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
    runs = [_run_ai_visibility_once(brands, queries, api_key) for _ in range(n_runs)]
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
                "consistency": round(100 * s["hits"] / n_ok),
                "kind": "primary" if s["primary_hits"] * 2 >= s["hits"] else "mentioned",
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

    # Sample standard deviation -> standard error -> 95% Wald half-width.
    var = sum((s - mean) ** 2 for s in scores) / (n - 1)
    sd = math.sqrt(var)
    se = sd / math.sqrt(n)
    half_width = max(1, int(round(1.96 * se)))  # never show +/- 0 on a stochastic measure
    low = max(0, point - half_width)
    high = min(100, point + half_width)

    ratio = half_width / max(point, 1)
    if half_width <= STABLE_MAX_HALFWIDTH and ratio <= STABLE_MAX_RATIO:
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
    body = json.dumps({
        "model": INFER_MODEL,
        "max_tokens": 700,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(
        ANTHROPIC_ENDPOINT, data=body,
        headers={
            "x-api-key": llm_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )
    try:
        data = _urlopen_json_with_retry(req, timeout=40, what="Claude API (remediation)")
    except Exception:
        logger.exception("remediation call failed")
        return None
    text = "".join(b.get("text", "") for b in data.get("content", []))
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
# Table (create once in the D1 console):
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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory("web", "index.html")


@app.route("/compare", strict_slashes=False)
def compare():
    resp = send_from_directory("web", "compare.html")
    resp.headers["Cache-Control"] = "public, max-age=3600"
    return resp


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

    ok, brand = _verify_paid_session(session_id)
    if not ok:
        return jsonify({"ok": False})
    with _live_lock:
        already = session_id in _consumed_sessions
    # Report whether this paid session still has its (single) deep audit unused,
    # so the frontend can message clearly if the user refreshes an old link.
    return jsonify({"ok": True, "brand": brand, "consumed": already})


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
    queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:cap]
    if brand not in competitors:
        competitors = [brand] + competitors
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
        return jsonify(dict(SAMPLE, notice="Server missing an API key - showing sample analysis."))

    # PAID GATE — resolved only now, after we know this is a valid live request
    # (so we never burn a paid session on an invalid/demo call). Deep (5-query)
    # depth is granted ONLY for a verified, paid, not-yet-consumed Stripe
    # session. Sending {deep:true} without a valid paid_session silently falls
    # back to the free 2-query cap. When paid_ok is True the session has been
    # atomically claimed (single-use); we roll that claim back on hard failure
    # in the except-block so a paying customer is never charged for nothing.
    max_queries, paid_session, paid_pi_id, paid_ok = _resolve_paid_depth(data)

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
    if not use_custom_strategy and not paid_ok and cache_key in _cache:
        with _live_lock:
            _live_runs -= 1  # cached hit doesn't consume a slot
            if ip in _ip_runs and _ip_runs[ip][0] == today:
                _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)
        return jsonify(dict(_cache[cache_key], cached=True))

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
            return jsonify(dict(SAMPLE, notice="Could not infer competitors - showing sample analysis."))
        # Geolocate the SERP to the resolved market: a forced "fr" or an inferred
        # French market both map to google.fr in French. Falls back to US/English
        # when the market is unknown, so this never worsens the prior behavior.
        gl, hl = _market_locale(market or market_out)
        ranking = analyze(competitors, queries, serp_key, gl=gl, hl=hl)
        # Bounded score needs the per-run distribution: request return_runs. The
        # paid Deep Audit buys more runs (tighter interval); the free tier gets a
        # smaller n (honest but wider interval), protecting unit economics while
        # still showing the confidence bound everywhere.
        n_ai_runs = DEEP_AI_RUNS if paid_ok else FREE_AI_RUNS
        ai_vis, ai_runs = check_ai_visibility(competitors, queries, llm_key,
                                              n_runs=n_ai_runs, return_runs=True)
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
        }
        # Bounded GEO score on BOTH tiers: the object carries point, half_width,
        # low/high, n, verdict. geo_score (the bare point) is kept alongside for
        # backward compatibility with any older client path; new rendering must
        # read result["geo"] and never show the point without its interval.
        if geo is not None:
            result["geo"] = geo
            result["geo_score"] = geo.get("point")
        # Deep-audit-only fields: never present on a free result, so the frontend
        # can key its whole "deep vs free" rendering on d.tier / their presence.
        if paid_ok:
            result["evidence"] = recon.get("evidence", [])
            result["official_url"] = recon.get("official_url", "")
            if report is not None:
                result["report"] = report
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
        return jsonify(result)
    except Exception as e:
        logger.exception("Live analysis failed for brand='%s'", brand)
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
        return jsonify(dict(SAMPLE, notice="Live analysis failed — showing sample."))
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
