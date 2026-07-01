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
# ---------------------------------------------------------------------------
_live_lock = threading.Lock()
_live_runs = 0

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
def infer_strategy(brand, api_key):
    prompt = (
        "You are a competitive-intelligence analyst. Given a single brand or company name, "
        "infer its market and return STRICT JSON with this exact shape and nothing else:\n"
        '{"sector":"short sector label","competitors":["BrandA","BrandB","BrandC","BrandD"],'
        '"queries":["buyer-intent query 1","query 2","query 3"]}\n'
        "Rules: include the given brand as the FIRST competitor. List 4-5 real, well-known direct competitors. "
        "Queries must be the searches a real buyer would type when shopping in this category "
        "(e.g. 'best CRM for startups', 'salesforce alternative'). Exactly 2 queries.\n\n"
        "Brand: " + brand
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
    hay = " ".join(str(result.get(k, "")) for k in ("title", "link", "description")).lower()
    return re.search(r"\b" + re.escape(brand.lower()) + r"\b", hay) is not None


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
        ranking.append({
            "brand": b,
            "query_coverage": str(s["mentions"]) + "/" + str(len(queries)),
            "avg_rank": avg,
            "share_of_voice": round(100 * s["appearances"] / total, 1),
            "evidence": ev,
            "cells": s["cells"],
        })
    ranking.sort(key=lambda r: (-int(r["query_coverage"].split("/")[0]),
                                 r["avg_rank"] if r["avg_rank"] else 999))
    return ranking

# ---------------------------------------------------------------------------
# Step 3: AI Engine visibility (simulated via Claude Haiku)
# ---------------------------------------------------------------------------
# Instead of paying for Perplexity/OpenAI APIs, we ask Claude to role-play as
# an AI assistant answering buyer-intent queries.  One call covers ALL queries
# at once → cost = ~$0.00012 total regardless of query count.
# ---------------------------------------------------------------------------
def check_ai_visibility(brands, queries, api_key):
    """Ask Claude which brands it would recommend for each buyer query."""
    queries_block = "\n".join(f"{i+1}. {q}" for i, q in enumerate(queries))
    brands_list = ", ".join(brands)
    prompt = (
        "You are a helpful AI assistant answering buyer questions. "
        "A user asks each of the following questions. For EACH question, "
        "list which of these brands you would mention in your answer, "
        "in the order you would mention them (first = most prominent).\n\n"
        f"Brands to consider: {brands_list}\n\n"
        f"Questions:\n{queries_block}\n\n"
        "Return STRICT JSON only, no other text:\n"
        '{"results":[{"query":"...","mentioned":["Brand1","Brand2"]}]}'
    )
    body = json.dumps({
        "model": ANTHROPIC_MODEL,
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
    try:
        with urllib.request.urlopen(req, timeout=40) as resp:
            data = json.loads(resp.read().decode())
    except Exception:
        logger.exception("AI visibility check failed")
        return {}  # graceful degradation — SERP data still works

    text = "".join(b.get("text", "") for b in data.get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    if m is None:
        return {}
    try:
        parsed = json.loads(m.group(0))
    except (json.JSONDecodeError, ValueError):
        return {}

    # Build a dict: {query: {brand: rank_position}}
    ai_map = {}
    for entry in parsed.get("results", []):
        q = entry.get("query", "")
        # Match to our actual query strings (fuzzy: find best match)
        matched_q = None
        for real_q in queries:
            if real_q.lower() in q.lower() or q.lower() in real_q.lower():
                matched_q = real_q
                break
        if not matched_q and queries:
            matched_q = queries[0]  # fallback
        mentioned = entry.get("mentioned", [])
        ai_map[matched_q] = {}
        for pos, b in enumerate(mentioned, 1):
            # Match brand names case-insensitively
            for real_b in brands:
                if real_b.lower() == b.lower():
                    ai_map[matched_q][real_b] = pos
                    break
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


@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    global _live_runs
    data = request.get_json(force=True, silent=True) or {}
    live = bool(data.get("live"))
    brand = (data.get("brand") or "").strip()

    if not live:
        return jsonify(SAMPLE)

    # --- Input validation ---
    if not brand:
        return jsonify({"error": "Type a brand name."}), 400
    if len(brand) > MAX_BRAND_LEN:
        return jsonify({"error": "Brand name is too long (max " + str(MAX_BRAND_LEN) + " chars)."}), 400

    serp_key = os.environ.get("BRIGHTDATA_API_KEY")
    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not serp_key or not llm_key:
        return jsonify(dict(SAMPLE, notice="Server missing an API key - showing sample analysis."))

    with _live_lock:
        if _live_runs >= MAX_LIVE_RUNS:
            return jsonify(dict(SAMPLE, notice="Live quota reached for this demo - showing sample analysis."))
        _live_runs += 1

    cache_key = brand.lower()
    if cache_key in _cache:
        with _live_lock:
            _live_runs -= 1  # cached hit doesn't consume a slot
        return jsonify(dict(_cache[cache_key], cached=True))

    try:
        strat = infer_strategy(brand, llm_key)
        competitors = [re.sub(r'[^\w\s\-\.\&]', '', c.strip())[:MAX_BRAND_LEN]
                       for c in strat.get("competitors", []) if c.strip()][:MAX_BRANDS]
        queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:MAX_QUERIES]
        if brand not in competitors:
            competitors = [brand] + competitors
        if not competitors or not queries:
            return jsonify(dict(SAMPLE, notice="Could not infer competitors - showing sample analysis."))
        ranking = analyze(competitors, queries, serp_key)
        ai_vis = check_ai_visibility(competitors, queries, llm_key)
        # Merge AI visibility into ranking data
        for entry in ranking:
            b = entry["brand"]
            entry["ai_cells"] = {}
            for q in queries:
                if q in ai_vis and b in ai_vis[q]:
                    entry["ai_cells"][q] = {"rank": ai_vis[q][b]}
            ai_mentioned = sum(1 for q in queries if q in ai_vis and b in ai_vis[q])
            entry["ai_coverage"] = f"{ai_mentioned}/{len(queries)}"
            ai_ranks = [ai_vis[q][b] for q in queries if q in ai_vis and b in ai_vis[q]]
            entry["ai_avg_rank"] = round(sum(ai_ranks) / len(ai_ranks), 1) if ai_ranks else None
        # 2 LLM calls (strategy + AI vis) + SERP queries
        cost = round(LLM_COST_PER_CALL * 2 + SERP_COST_PER_QUERY * len(queries), 5)
        result = {
            "brand": brand,
            "sector": strat.get("sector", ""),
            "queries": queries,
            "ranking": ranking,
            "mode": "live",
            "cost": cost,
        }
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


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
