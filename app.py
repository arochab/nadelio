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
MAX_QUERIES = 2            # absolute minimum SERP calls — lowest cost
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
def infer_strategy(brand, api_key, hint=None):
    prompt = (
        "You are a competitive-intelligence analyst. Given a single brand or company name, "
        "infer its market and return STRICT JSON with this exact shape and nothing else:\n"
        '{"sector":"short sector label","competitors":["BrandA","BrandB","BrandC","BrandD"],'
        '"queries":["buyer-intent query 1","query 2","query 3"]}\n'
        "Rules: include the given brand as the FIRST competitor. List 4-5 real, well-known direct competitors. "
        "Queries must be the searches a real buyer would type when shopping in this category "
        "(e.g. 'best CRM for startups', 'salesforce alternative'). Exactly 2 queries.\n\n"
        "Disambiguation: brand names are often shared by unrelated companies (e.g. a fintech "
        "and a consumer app with the same name). Identify the REAL company this name most likely "
        "refers to. If the name is ambiguous and no context is given, prefer the B2B/SaaS "
        "interpretation over a consumer one, since this tool is used for competitive intelligence "
        "in software markets.\n\n"
        "Brand: " + brand
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


def _sanitize_strategy(brand, strat):
    """Shared sanitation for a raw infer_strategy() result: strip stray
    characters from competitor names, cap list sizes, and make sure the
    queried brand itself is present as the first competitor."""
    competitors = [re.sub(r'[^\w\s\-\.\&]', '', c.strip())[:MAX_BRAND_LEN]
                   for c in strat.get("competitors", []) if c.strip()][:MAX_BRANDS]
    queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:MAX_QUERIES]
    if brand not in competitors:
        competitors = [brand] + competitors
    return competitors, queries


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

    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not llm_key:
        return jsonify({"error": "Server missing an API key - cannot run inference."}), 502

    try:
        strat = infer_strategy(brand, llm_key, hint)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    competitors, queries = _sanitize_strategy(brand, strat)
    if not competitors or not queries:
        return jsonify({"error": "Could not infer competitors for this brand."}), 502

    return jsonify({
        "brand": brand,
        "sector": strat.get("sector", ""),
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

    ip = _client_ip()
    today = _today_utc()
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
    cache_key = brand.lower()
    if not use_custom_strategy and cache_key in _cache:
        with _live_lock:
            _live_runs -= 1  # cached hit doesn't consume a slot
            if ip in _ip_runs and _ip_runs[ip][0] == today:
                _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)
        return jsonify(dict(_cache[cache_key], cached=True))

    try:
        if use_custom_strategy:
            competitors, queries = _sanitize_strategy(brand, {
                "competitors": raw_competitors,
                "queries": raw_queries,
            })
            sector = (data.get("sector") or "").strip() or "(confirmed by user)"
        else:
            strat = infer_strategy(brand, llm_key, hint)
            competitors, queries = _sanitize_strategy(brand, strat)
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
            "queries": queries,
            "ranking": ranking,
            "mode": "live",
            "cost": cost,
        }
        if not use_custom_strategy:
            with _live_lock:
                if len(_cache) < MAX_CACHE_ENTRIES:
                    _cache[cache_key] = result
                    _save_cache(_cache)
        return jsonify(result)
    except Exception as e:
        logger.exception("Live analysis failed for brand='%s'", brand)
        # Return a safe, generic message — full error is logged server-side
        return jsonify(dict(SAMPLE, notice="Live analysis failed — showing sample."))
    finally:
        with _live_lock:
            _live_runs -= 1
            if ip in _ip_runs and _ip_runs[ip][0] == today:
                _ip_runs[ip][1] = max(0, _ip_runs[ip][1] - 1)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
