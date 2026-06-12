"""
SERP Scraper — collects structured Google search results via the Bright Data SERP API.

Usage:
    export BRIGHTDATA_API_KEY="your_key"
    python serp_scraper.py "search query"
    python serp_scraper.py "python automation freelance" --output results.json --csv

The script queries the Bright Data SERP API, retrieves Google's organic results in a
structured form (title, link, description, rank) and saves them as JSON and/or CSV.
"""

import argparse
import csv
import json
import os
import sys
import urllib.parse
import urllib.request


# Name of the SERP zone created in the Bright Data dashboard.
ZONE = "serpleadresearch"
API_ENDPOINT = "https://api.brightdata.com/request"


def get_api_key() -> str:
    """Read the API key from the environment variable (never hard-coded in the source)."""
    key = os.environ.get("BRIGHTDATA_API_KEY")
    if not key:
        print(
            "Error: the BRIGHTDATA_API_KEY environment variable is not set.\n"
            'Set it with:  export BRIGHTDATA_API_KEY="your_key"',
            file=sys.stderr,
        )
        sys.exit(1)
    return key


def search(query: str, api_key: str) -> list[dict]:
    """Run a Google search through Bright Data and return the list of organic results."""
    # brd_json=1 tells Bright Data to parse the Google page into clean JSON.
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


def save_json(results: list[dict], path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"  -> JSON saved: {path}")


def save_csv(results: list[dict], path: str) -> None:
    fields = ["global_rank", "title", "link", "description"]
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        for row in results:
            writer.writerow(row)
    print(f"  -> CSV saved: {path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Collect structured Google search results via the Bright Data SERP API."
    )
    parser.add_argument("query", help="The keyword or phrase to search for")
    parser.add_argument(
        "--output", default="results.json", help="Output JSON file"
    )
    parser.add_argument(
        "--csv", action="store_true", help="Also export to CSV"
    )
    args = parser.parse_args()

    api_key = get_api_key()

    print(f"Searching: \"{args.query}\" ...")
    results = search(args.query, api_key)
    print(f"{len(results)} results found.\n")

    # Preview the first 5 results in the terminal.
    for r in results[:5]:
        print(f"  [{r.get('global_rank', '?')}] {r.get('title', '')}")
        print(f"      {r.get('link', '')}")

    print()
    save_json(results, args.output)
    if args.csv:
        save_csv(results, args.output.replace(".json", ".csv"))


if __name__ == "__main__":
    main()
