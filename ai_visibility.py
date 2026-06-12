"""
AI Visibility Checker — measures how visible a set of brands are across the search
results that real buyers type, using the Bright Data SERP API.

Given a list of brands and a list of buyer-intent queries, the tool runs each query,
scans the organic results, and scores every brand on:
  - mentions      : how many of the queries surface the brand at all
  - appearances   : total number of result rows mentioning the brand
  - avg_rank      : average position when it does appear (lower is better)
  - share_of_voice: brand appearances / all tracked-brand appearances (%)

Usage:
    export BRIGHTDATA_API_KEY="your_key"

    # Inline:
    python ai_visibility.py \
        --brands "Notion,Asana,Monday,ClickUp" \
        --queries "best project management tool,best tool for startups,asana alternative"

    # Or from a config file (see visibility_config.example.json):
    python ai_visibility.py --config my_config.json
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request


ZONE = "serpleadresearch"
API_ENDPOINT = "https://api.brightdata.com/request"


def get_api_key() -> str:
    key = os.environ.get("BRIGHTDATA_API_KEY")
    if not key:
        print(
            "Error: BRIGHTDATA_API_KEY environment variable is not set.\n"
            'Set it with:  export BRIGHTDATA_API_KEY="your_key"',
            file=sys.stderr,
        )
        sys.exit(1)
    return key


def run_query(query: str, api_key: str) -> list[dict]:
    """Run one Google search through Bright Data and return organic results."""
    google_url = (
        "https://www.google.com/search?q="
        + urllib.parse.quote(query)
        + "&brd_json=1"
    )
    payload = json.dumps({"zone": ZONE, "url": google_url, "format": "raw"}).encode()
    request = urllib.request.Request(
        API_ENDPOINT,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        data = json.loads(response.read().decode())
    return data.get("organic", [])


def brand_in_result(brand: str, result: dict) -> bool:
    """True if the brand is mentioned in a result's title, link, or description."""
    haystack = " ".join(
        str(result.get(k, "")) for k in ("title", "link", "description")
    ).lower()
    # Word-boundary match so "Monday" doesn't match inside "Mondays".
    return re.search(rf"\b{re.escape(brand.lower())}\b", haystack) is not None


def analyze(brands: list[str], queries: list[str], api_key: str) -> dict:
    """Run every query and aggregate per-brand visibility stats."""
    stats = {
        b: {"mentions": 0, "appearances": 0, "ranks": [], "queries_hit": []}
        for b in brands
    }
    per_query = []

    for i, query in enumerate(queries, 1):
        print(f"  [{i}/{len(queries)}] \"{query}\" ...")
        results = run_query(query, api_key)
        hits_this_query = {b: [] for b in brands}

        for pos, result in enumerate(results, 1):
            for brand in brands:
                if brand_in_result(brand, result):
                    stats[brand]["appearances"] += 1
                    stats[brand]["ranks"].append(pos)
                    hits_this_query[brand].append(pos)

        for brand in brands:
            if hits_this_query[brand]:
                stats[brand]["mentions"] += 1
                stats[brand]["queries_hit"].append(query)

        per_query.append({"query": query, "hits": hits_this_query})
        time.sleep(1)  # be gentle on the API

    total_appearances = sum(s["appearances"] for s in stats.values()) or 1

    ranking = []
    for brand, s in stats.items():
        avg_rank = round(sum(s["ranks"]) / len(s["ranks"]), 1) if s["ranks"] else None
        ranking.append({
            "brand": brand,
            "mentions": s["mentions"],
            "query_coverage": f"{s['mentions']}/{len(queries)}",
            "appearances": s["appearances"],
            "avg_rank": avg_rank,
            "share_of_voice": round(100 * s["appearances"] / total_appearances, 1),
        })

    # Sort: most query coverage first, then best (lowest) avg rank.
    ranking.sort(key=lambda r: (-r["mentions"], r["avg_rank"] if r["avg_rank"] else 999))
    return {"queries": queries, "ranking": ranking, "detail": per_query}


def print_report(report: dict) -> None:
    print("\n" + "=" * 60)
    print("AI VISIBILITY REPORT")
    print("=" * 60)
    print(f"Queries analyzed: {len(report['queries'])}\n")
    header = f"{'#':<3}{'Brand':<18}{'Coverage':<10}{'Avg rank':<10}{'Share of voice'}"
    print(header)
    print("-" * len(header))
    for i, r in enumerate(report["ranking"], 1):
        avg = r["avg_rank"] if r["avg_rank"] is not None else "—"
        print(
            f"{i:<3}{r['brand']:<18}{r['query_coverage']:<10}"
            f"{str(avg):<10}{r['share_of_voice']}%"
        )
    print()
    winner = report["ranking"][0]
    print(f"Most visible: {winner['brand']} "
          f"(appears in {winner['query_coverage']} queries, "
          f"{winner['share_of_voice']}% share of voice)")


def load_config(path: str) -> tuple[list[str], list[str]]:
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg["brands"], cfg["queries"]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Measure brand visibility across buyer-intent search queries."
    )
    parser.add_argument("--brands", help="Comma-separated list of brands")
    parser.add_argument("--queries", help="Comma-separated list of search queries")
    parser.add_argument("--config", help="JSON config file with 'brands' and 'queries'")
    parser.add_argument("--output", default="visibility_report.json", help="Output JSON file")
    args = parser.parse_args()

    if args.config:
        brands, queries = load_config(args.config)
    elif args.brands and args.queries:
        brands = [b.strip() for b in args.brands.split(",") if b.strip()]
        queries = [q.strip() for q in args.queries.split(",") if q.strip()]
    else:
        parser.error("provide either --config, or both --brands and --queries")

    api_key = get_api_key()

    print(f"Tracking {len(brands)} brands across {len(queries)} queries...\n")
    report = analyze(brands, queries, api_key)
    print_report(report)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\nFull report saved: {args.output}")


if __name__ == "__main__":
    main()
