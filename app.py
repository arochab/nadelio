import json, os, re, time, urllib.parse, urllib.request
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="web", static_url_path="")
ZONE = "serpleadresearch"
SERP_ENDPOINT = "https://api.brightdata.com/request"
ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"  # cheapest model — minimal cost

MAX_LIVE_RUNS = int(os.environ.get("MAX_LIVE_RUNS", "15"))
_live_runs = 0
import pathlib
_CACHE_FILE = pathlib.Path(os.environ.get("CACHE_FILE", "cache.json"))
def _load_cache():
    try: return json.loads(_CACHE_FILE.read_text())
    except Exception: return {}
def _save_cache(c):
    try: _CACHE_FILE.write_text(json.dumps(c))
    except Exception: pass
_cache = _load_cache()  # persists across restarts — never re-pay for a brand
MAX_BRANDS = 6
MAX_QUERIES = 2  # absolute minimum SERP calls — lowest cost
# Cost model (USD). Haiku is ~$1/M input, $5/M output; SERP ~ $0.0015/query.
LLM_COST = 0.00012   # ~tiny: short prompt + short JSON on Haiku
SERP_COST_PER_QUERY = 0.0015

# --- Demo data: what the pipeline produces for "Notion", precomputed ---
SAMPLE = {
  "brand": "Notion",
  "sector": "Productivity & project management software",
  "queries": ["best project management tool", "notion alternative"],
  "ranking": [
    {"brand":"Notion","query_coverage":"2/2","avg_rank":2.0,"share_of_voice":33.3,
     "cells":{"best project management tool":{"rank":3,"title":"Notion - The all-in-one workspace","link":"https://notion.so"},
              "notion alternative":{"rank":1,"title":"Notion vs the rest","link":"https://notion.so/compare"}},
     "evidence":[{"title":"Notion - The all-in-one workspace","link":"https://notion.so","query":"best project management tool","rank":3}]},
    {"brand":"Asana","query_coverage":"1/2","avg_rank":2.0,"share_of_voice":16.7,
     "cells":{"best project management tool":{"rank":2,"title":"Asana: Manage your team's work","link":"https://asana.com"}},
     "evidence":[{"title":"Asana: Manage your team's work","link":"https://asana.com","query":"best project management tool","rank":2}]},
    {"brand":"ClickUp","query_coverage":"1/2","avg_rank":4.0,"share_of_voice":16.7,
     "cells":{"best project management tool":{"rank":4,"title":"ClickUp - One app to replace them all","link":"https://clickup.com"}},
     "evidence":[{"title":"ClickUp - One app to replace them all","link":"https://clickup.com","query":"best project management tool","rank":4}]},
    {"brand":"Obsidian","query_coverage":"1/2","avg_rank":2.0,"share_of_voice":16.7,
     "cells":{"notion alternative":{"rank":2,"title":"Obsidian - Sharpen your thinking","link":"https://obsidian.md"}},
     "evidence":[{"title":"Obsidian - Sharpen your thinking","link":"https://obsidian.md","query":"notion alternative","rank":2}]},
    {"brand":"Coda","query_coverage":"1/2","avg_rank":6.0,"share_of_voice":16.7,
     "cells":{"notion alternative":{"rank":6,"title":"Coda: Your all-in-one workspace","link":"https://coda.io"}},
     "evidence":[{"title":"Coda: Your all-in-one workspace","link":"https://coda.io","query":"notion alternative","rank":6}]}
  ],
  "mode":"demo",
  "cost":0.00312
}

# --- Step 1: Claude infers sector, competitors, queries from a single brand ---
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
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=40) as resp:
        data = json.loads(resp.read().decode())
    text = "".join(b.get("text", "") for b in data.get("content", []))
    m = re.search(r"\{.*\}", text, re.S)
    parsed = json.loads(m.group(0))
    return parsed

# --- Step 2: Bright Data SERP ---
def run_query(query, api_key):
    url = "https://www.google.com/search?q=" + urllib.parse.quote(query) + "&brd_json=1"
    payload = json.dumps({"zone": ZONE, "url": url, "format": "raw"}).encode()
    req = urllib.request.Request(SERP_ENDPOINT, data=payload,
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode()).get("organic", [])

def brand_in(brand, result):
    hay = " ".join(str(result.get(k, "")) for k in ("title","link","description")).lower()
    return re.search(r"\b" + re.escape(brand.lower()) + r"\b", hay) is not None

def analyze(brands, queries, api_key):
    stats = {b: {"mentions":0,"appearances":0,"ranks":[],"evidence":[],"cells":{}} for b in brands}
    for query in queries:
        results = run_query(query, api_key)
        hit = {b: False for b in brands}
        for pos, result in enumerate(results, 1):
            for b in brands:
                if brand_in(b, result) and query not in stats[b]["cells"]:
                    stats[b]["appearances"] += 1
                    stats[b]["ranks"].append(pos)
                    hit[b] = True
                    stats[b]["cells"][query] = {"rank": pos, "title": result.get("title",""), "link": result.get("link","")}
        for b in brands:
            if hit[b]:
                stats[b]["mentions"] += 1
        time.sleep(1)
    total = sum(s["appearances"] for s in stats.values()) or 1
    ranking = []
    for b, s in stats.items():
        avg = round(sum(s["ranks"]) / len(s["ranks"]), 1) if s["ranks"] else None
        ev = [dict(c, query=q) for q, c in s["cells"].items()]
        ranking.append({"brand":b,"query_coverage":str(s["mentions"])+"/"+str(len(queries)),"avg_rank":avg,
                        "share_of_voice":round(100*s["appearances"]/total,1),"evidence":ev,"cells":s["cells"]})
    ranking.sort(key=lambda r: (-int(r["query_coverage"].split("/")[0]), r["avg_rank"] if r["avg_rank"] else 999))
    return ranking

@app.route("/")
def index():
    return send_from_directory("web", "index.html")

@app.route("/api/analyze", methods=["POST"])
def api_analyze():
    global _live_runs
    data = request.get_json(force=True, silent=True) or {}
    live = bool(data.get("live"))
    brand = (data.get("brand") or "").strip()

    if not live:
        return jsonify(SAMPLE)
    if not brand:
        return jsonify({"error": "Type a brand name."}), 400

    serp_key = os.environ.get("BRIGHTDATA_API_KEY")
    llm_key = os.environ.get("ANTHROPIC_API_KEY")
    if not serp_key or not llm_key:
        return jsonify(dict(SAMPLE, notice="Server missing an API key - showing sample analysis."))
    if _live_runs >= MAX_LIVE_RUNS:
        return jsonify(dict(SAMPLE, notice="Live quota reached for this demo - showing sample analysis."))

    cache_key = brand.lower()
    if cache_key in _cache:
        return jsonify(dict(_cache[cache_key], cached=True))

    _live_runs += 1
    try:
        strat = infer_strategy(brand, llm_key)
        competitors = [c.strip() for c in strat.get("competitors", []) if c.strip()][:MAX_BRANDS]
        queries = [q.strip() for q in strat.get("queries", []) if q.strip()][:MAX_QUERIES]
        if brand not in competitors:
            competitors = [brand] + competitors
        if not competitors or not queries:
            return jsonify(dict(SAMPLE, notice="Could not infer competitors - showing sample analysis."))
        ranking = analyze(competitors, queries, serp_key)
        cost = round(LLM_COST + SERP_COST_PER_QUERY * len(queries), 5)
        result = {"brand": brand, "sector": strat.get("sector", ""), "queries": queries,
                  "ranking": ranking, "mode": "live", "cost": cost}
        _cache[cache_key] = result
        _save_cache(_cache)
        return jsonify(result)
    except Exception as e:
        return jsonify(dict(SAMPLE, notice="Live request failed (" + type(e).__name__ + ") - showing sample analysis."))

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT","5000")), debug=False)
