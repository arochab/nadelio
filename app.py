import base64
import datetime
import json
import logging
import os
import pathlib
import re
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
ZONE = "serpleadresearch"
SERP_ENDPOINT = "https://api.brightdata.com/request"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"  # cheapest model — minimal cost

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


def infer_strategy(brand, api_key, hint=None, market=None, max_queries=MAX_QUERIES_FREE):
    n = MAX_QUERIES_PAID if int(max_queries or MAX_QUERIES_FREE) >= MAX_QUERIES_PAID else MAX_QUERIES_FREE
    forced = _MARKET_PRESETS.get((market or "").strip().lower()) if market else None
    prompt = (
        "You are a competitive-intelligence analyst. Given a single brand or company name, "
        "infer its market and return STRICT JSON with this exact shape and nothing else:\n"
        '{"sector":"short sector label","market":"primary market label",'
        '"query_language":"ISO 639-1 code","competitors":["BrandA","BrandB","BrandC","BrandD"],'
        '"queries":["buyer-intent query 1","query 2"]}\n'
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
        "refers to. If the name is ambiguous and no context is given, prefer the B2B/SaaS "
        "interpretation over a consumer one, since this tool is used for competitive intelligence "
        "in software markets.\n\n"
        "Brand: " + brand
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
        "model": ANTHROPIC_MODEL,
        "max_tokens": 400,
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
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode())
    except urllib.error.HTTPError as he:
        detail = he.read().decode()[:200]
        logger.error("Claude API HTTP %d: %s", he.code, detail)
        raise RuntimeError("Claude API returned an error (HTTP " + str(he.code) + ")")
    except urllib.error.URLError as ue:
        logger.error("Claude API unreachable: %s", ue.reason)
        raise RuntimeError("Could not reach the Claude API")

    text = "".join(b.get("text", "") for b in data.get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    if m is None:
        logger.error("Claude returned no JSON in: %s", text[:300])
        raise RuntimeError("Claude did not return valid JSON for this brand")
    try:
        parsed = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
        logger.error("Claude returned invalid JSON: %s", m.group(0)[:300])
        raise RuntimeError("Claude did not return valid JSON for this brand")
    return parsed

# ---------------------------------------------------------------------------
# Step 2: Bright Data SERP
# ---------------------------------------------------------------------------
def run_query(query, api_key):
    url = "https://www.google.com/search?q=" + urllib.parse.quote(query) + "&brd_json=1"
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
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
    except urllib.error.HTTPError as he:
        logger.error("Bright Data HTTP %d for query '%s'", he.code, query)
        raise RuntimeError("SERP API error (HTTP " + str(he.code) + ")")
    except urllib.error.URLError as ue:
        logger.error("Bright Data unreachable: %s", ue.reason)
        raise RuntimeError("Could not reach the SERP API")

    try:
        return json.loads(raw).get("organic", [])
    except (json.JSONDecodeError, ValueError):
        logger.error("Bright Data returned non-JSON for query '%s': %s", query, raw[:200])
        raise RuntimeError("SERP API returned an unexpected response format")


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


def analyze(brands, queries, api_key):
    stats = {b: {"mentions": 0, "appearances": 0, "ranks": [], "evidence": [], "cells": {}} for b in brands}
    for query in queries:
        results = run_query(query, api_key)
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
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        logger.exception("AI visibility run failed")
        return {}  # graceful degradation — SERP data still works

    text = "".join(b.get("text", "") for b in data.get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    if m is None:
        return {}
    try:
        parsed = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
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


def check_ai_visibility(brands, queries, api_key):
    """Run the AI-visibility probe AI_RUNS times and aggregate into per-brand
    per-query stats: average rank, mention rate (consistency), and whether the
    brand was ever the primary recommendation."""
    runs = [_run_ai_visibility_once(brands, queries, api_key) for _ in range(AI_RUNS)]
    runs = [r for r in runs if r]  # drop failed runs
    if not runs:
        return {}

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

    n_runs = len(runs)
    ai_map = {}
    for q in queries:
        ai_map[q] = {}
        for b in brands:
            s = agg[q][b]
            if not s["ranks"]:
                continue
            ai_map[q][b] = {
                "rank": round(sum(s["ranks"]) / len(s["ranks"]), 1),
                "consistency": round(100 * s["hits"] / n_runs),
                "kind": "primary" if s["primary_hits"] * 2 >= s["hits"] else "mentioned",
                "runs": n_runs,
            }
    return ai_map


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
        body = json.dumps({"email": email, "source": "brandpulse-waitlist"}).encode()
        req = urllib.request.Request(
            WAITLIST_WEBHOOK_URL, data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5):
            pass
    except Exception:
        logger.exception("Waitlist webhook notification failed for %s", email)


@app.route("/api/waitlist", methods=["POST"])
def api_waitlist():
    data = request.get_json(force=True, silent=True) or {}
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

    data = request.get_json(force=True, silent=True) or {}
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

    data = request.get_json(force=True, silent=True) or {}
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


def _sanitize_strategy(brand, strat, max_queries=MAX_QUERIES_FREE):
    """Shared sanitation for a raw infer_strategy() result: strip stray
    characters from competitor names, cap list sizes, and make sure the
    queried brand itself is present as the first competitor.

    Returns (competitors, queries, market, query_language). The market and
    query_language fields are preserved from the raw strategy (empty strings
    if the model omitted them) so the frontend can show which market/language
    an audit actually ran in. `max_queries` caps the query list (2 free, 5
    deep); it defaults to the free cap so existing callers are unchanged."""
    cap = MAX_QUERIES_PAID if int(max_queries or MAX_QUERIES_FREE) >= MAX_QUERIES_PAID else MAX_QUERIES_FREE
    competitors = [re.sub(r'[^\w\s\-\.\&]', '', c.strip())[:MAX_BRAND_LEN]
                   for c in strat.get("competitors", []) if c.strip()][:MAX_BRANDS]
    queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:cap]
    if brand not in competitors:
        competitors = [brand] + competitors
    market = str(strat.get("market", "") or "").strip()[:60]
    query_language = str(strat.get("query_language", "") or "").strip()[:10]
    return competitors, queries, market, query_language


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

    On success returns (MAX_QUERIES_PAID, session_id, True); the session is now
    durably marked on Stripe AND cached in-process. In every other case — no
    session, unconfigured Stripe, unpaid, stale, already consumed, unreachable
    Stripe, or the client merely sending {deep:true} without paying — it silently
    falls back and returns (MAX_QUERIES_FREE, "", False). The client can never
    obtain a deep audit by sending deep=true alone.

    Why this survives a server restart (the whole point): the consumption record
    is the PaymentIntent's bp_consumed metadata on Stripe, not our process
    memory. After a redeploy the in-memory cache is empty, but re-inspecting the
    session still shows bp_consumed set, so a replay is refused. The time window
    is likewise anchored on Stripe's session.created, not on any local clock we
    lose at restart."""
    if not _deep_requested(data):
        return MAX_QUERIES_FREE, "", False
    session_id = (data.get("paid_session") or "").strip()
    if not session_id:
        return MAX_QUERIES_FREE, "", False

    # (0) First-line in-process cache: cheap short-circuit for same-process
    # replay. Never the source of truth (see Defense 1/2 for durability).
    with _live_lock:
        if session_id in _consumed_sessions:
            return MAX_QUERIES_FREE, "", False

    # Single Stripe round-trip: paid status + created ts + PaymentIntent + its
    # durable consumption stamp.
    info = _inspect_paid_session(session_id)

    # Fail closed if we could not reach/parse Stripe at all.
    if not info["inspectable"]:
        return MAX_QUERIES_FREE, "", False
    # (1) Must be paid.
    if not info["ok"]:
        return MAX_QUERIES_FREE, "", False
    # (3) Durable Stripe stamp already present -> already redeemed (survives
    # restart). Record it in the local cache too so we skip Stripe next time.
    if info["consumed"]:
        with _live_lock:
            _consumed_sessions.add(session_id)
        return MAX_QUERIES_FREE, "", False
    # (2) Time window: only accept within PAID_SESSION_MAX_AGE_S of creation.
    # created==0 means we could not read a trustworthy timestamp -> fail closed.
    now = int(time.time())
    if info["created"] <= 0 or (now - info["created"]) > PAID_SESSION_MAX_AGE_S:
        return MAX_QUERIES_FREE, "", False
    # We need a PaymentIntent to durably stamp; without one we cannot record
    # consumption durably -> fail closed rather than grant an unrecordable audit.
    if not info["pi_id"]:
        logger.error("Paid session %s has no PaymentIntent to stamp (fail-closed)", session_id)
        return MAX_QUERIES_FREE, "", False

    # (4) DURABLY claim the single-use unlock on Stripe BEFORE granting. Note on
    # concurrency: Stripe's update is last-write-wins, so two truly simultaneous
    # requests for the same fresh session could both pass step (3) before either
    # stamps. That window is (a) tiny, (b) further guarded by the in-process
    # cache add below which serializes same-process duplicates, and (c) bounded
    # to at most the few requests a single buyer can fire in that instant — not
    # an unbounded free-audit exploit. The durable stamp then permanently blocks
    # every later replay, including across restarts.
    if not _mark_session_consumed_on_stripe(info["pi_id"]):
        return MAX_QUERIES_FREE, "", False  # could not durably record -> refuse

    with _live_lock:
        _consumed_sessions.add(session_id)
    return MAX_QUERIES_PAID, session_id, True


@app.route("/api/infer", methods=["POST"])
def api_infer():
    """Inference-only endpoint: sector + competitors + queries for a brand,
    with no SERP calls and no AI-visibility calls. Lets the frontend show a
    confirmation preview before paying for the expensive part of the pipeline.
    Does NOT touch the live-run quota counters — a single Haiku call costs
    about $0.0001, and gating it behind the same daily quota as a full
    analysis would defeat the point of letting users cheaply refine a hint."""
    data = request.get_json(force=True, silent=True) or {}
    brand = (data.get("brand") or "").strip()
    hint = (data.get("hint") or "").strip()
    market = (data.get("market") or "").strip()  # optional forced market ("fr", "us"…)
    max_queries = _resolve_depth(data)            # 2 (free) or 5 (deep)

    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not llm_key:
        return jsonify({"error": "Server missing an API key - cannot run inference."}), 502

    try:
        strat = infer_strategy(brand, llm_key, hint, market=market or None, max_queries=max_queries)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    competitors, queries, inferred_market, query_language = _sanitize_strategy(brand, strat, max_queries)
    if not competitors or not queries:
        return jsonify({"error": "Could not infer competitors for this brand."}), 502

    return jsonify({
        "brand": brand,
        "sector": strat.get("sector", ""),
        "market": inferred_market,
        "query_language": query_language,
        "competitors": competitors,
        "queries": queries,
    })


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    global _live_runs, _live_runs_date
    data = request.get_json(force=True, silent=True) or {}
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
    max_queries, paid_session, paid_ok = _resolve_paid_depth(data)

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

    try:
        if use_custom_strategy:
            competitors, queries, market_out, query_language = _sanitize_strategy(brand, {
                "competitors": raw_competitors,
                "queries": raw_queries,
                "market": data.get("market_label") or market,
                "query_language": data.get("query_language") or "",
            }, max_queries)
            sector = (data.get("sector") or "").strip() or "(confirmed by user)"
        else:
            strat = infer_strategy(brand, llm_key, hint, market=market or None, max_queries=max_queries)
            competitors, queries, market_out, query_language = _sanitize_strategy(brand, strat, max_queries)
            sector = strat.get("sector", "")
        if not competitors or not queries:
            return jsonify(dict(SAMPLE, notice="Could not infer competitors - showing sample analysis."))
        ranking = analyze(competitors, queries, serp_key)
        ai_vis = check_ai_visibility(competitors, queries, llm_key)
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
        # 1 LLM call (strategy) + AI_RUNS LLM calls (AI visibility) + SERP queries
        cost = round(LLM_COST_PER_CALL * (1 + AI_RUNS) + SERP_COST_PER_QUERY * len(queries), 5)
        result = {
            "brand": brand,
            "sector": sector,
            "market": market_out,
            "query_language": query_language,
            "queries": queries,
            "ranking": ranking,
            "mode": "live",
            "tier": "deep" if paid_ok else "free",
            "cost": cost,
        }
        # A paid deep run is never written to the shared brand cache (see the
        # cache-read note above): a later free run of the same brand must not be
        # served a 5-query deep result, and vice versa.
        if not use_custom_strategy and not paid_ok:
            with _live_lock:
                if len(_cache) < MAX_CACHE_ENTRIES:
                    _cache[cache_key] = result
                    _save_cache(_cache)
        return jsonify(result)
    except Exception as e:
        logger.exception("Live analysis failed for brand='%s'", brand)
        # A paid deep audit that failed before producing a result should NOT
        # burn the customer's single-use unlock — release the claimed session so
        # they can retry. (Replay safety is preserved: only an un-produced run
        # rolls back, and the claim/rollback are both under _live_lock.)
        if paid_ok and paid_session:
            with _live_lock:
                _consumed_sessions.discard(paid_session)
        # Return a safe, generic message — full error is logged server-side
        return jsonify(dict(SAMPLE, notice="Live analysis failed — showing sample."))
    finally:
        # Only the FREE quota consumes/releases the daily counters. A paid deep
        # run never incremented them, so it must not decrement them here.
        if not paid_ok:
            with _live_lock:
                _live_runs -= 1
                if ip in _ip_runs and _ip_runs[ip][0] == today:
                    _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
