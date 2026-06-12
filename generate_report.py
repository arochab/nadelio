"""
Generate a polished, self-contained HTML report from a visibility_report.json file.

Design: calm, flat, editorial. A single sage accent expressed in intensities that
encode performance (dark = leader, pale = invisible). One typeface (Inter).

Usage:
    python generate_report.py                       # reads visibility_report.json
    python generate_report.py --input my_report.json --output report.html
"""

import argparse
import json
from datetime import datetime
from html import escape


# Sage accent, stepped by rank position so colour encodes performance.
SAGE_STEPS = ["#5b8c7e", "#6b9c8e", "#84ada0", "#9cbcb0", "#b8d0c7", "#cbdbd4"]


def shade_for(index: int, invisible: bool) -> str:
    if invisible:
        return "#dfe6e2"
    return SAGE_STEPS[min(index, len(SAGE_STEPS) - 1)]


def build_html(report: dict) -> str:
    ranking = report["ranking"]
    queries = report["queries"]
    leader = ranking[0] if ranking else None
    max_sov = max((r["share_of_voice"] for r in ranking), default=1) or 1

    # Derived insights.
    best_rank = min(
        (r for r in ranking if r["avg_rank"] is not None),
        key=lambda r: r["avg_rank"],
        default=None,
    )
    blind = min(ranking, key=lambda r: r["mentions"], default=None)

    rows = []
    for i, r in enumerate(ranking):
        sov = r["share_of_voice"]
        width = round(100 * sov / max_sov, 1)
        invisible = sov == 0
        color = shade_for(i, invisible)
        name_color = "#b4b2a8" if invisible else ("#1c1b18" if i < 2 else "#3a3a34")
        val_weight = "600" if i < 2 else "500"
        rows.append(f"""
      <div class="row">
        <span class="brand" style="color:{name_color}">{escape(r['brand'])}</span>
        <div class="track">
          <div class="track-bg"></div>
          <div class="fill" style="width:{width}%;background:{color}"></div>
        </div>
        <span class="val" style="color:{name_color};font-weight:{val_weight}">{sov}</span>
      </div>""")
    rows_html = "".join(rows)

    chips = "".join(f'<span class="chip">{escape(q)}</span>' for q in queries)
    date_str = datetime.now().strftime("%B %Y")

    leader_name = escape(leader["brand"]) if leader else "—"
    leader_sov = leader["share_of_voice"] if leader else 0
    leader_cov = escape(leader["query_coverage"]) if leader else "—"
    br_name = escape(best_rank["brand"]) if best_rank else "—"
    br_val = best_rank["avg_rank"] if best_rank else "—"
    blind_name = escape(blind["brand"]) if blind else "—"
    blind_cov = escape(blind["query_coverage"]) if blind else "—"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI Visibility Report</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  body {{
    font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;
    background:#f3f2ed; color:#1c1b18; -webkit-font-smoothing:antialiased;
    padding:56px 20px 80px; line-height:1.5;
  }}
  .card {{
    max-width:720px; margin:0 auto; background:#faf9f6;
    border:1px solid #ecebe4; border-radius:22px;
    padding:48px 44px; position:relative; overflow:hidden;
  }}
  .glow {{
    position:absolute; top:-90px; right:-70px; width:340px; height:340px; border-radius:50%;
    background:radial-gradient(circle, rgba(91,140,126,.09) 0%, rgba(91,140,126,0) 70%);
    pointer-events:none;
  }}
  .inner {{ position:relative; }}
  .eyebrow {{
    display:flex; align-items:center; gap:8px; font-size:11px; letter-spacing:.14em;
    text-transform:uppercase; color:#9a988e; margin-bottom:30px;
  }}
  .eyebrow .dot {{ width:5px; height:5px; border-radius:50%; background:#5b8c7e; }}
  .top {{ display:flex; align-items:flex-end; justify-content:space-between; gap:18px; flex-wrap:wrap; margin-bottom:40px; }}
  h1 {{ font-size:33px; font-weight:600; letter-spacing:-1px; line-height:1.08; color:#1c1b18; }}
  .sub {{ font-size:14px; color:#9a988e; margin-top:10px; }}
  .hero-num {{ text-align:right; }}
  .hero-num .n {{ font-size:50px; font-weight:600; letter-spacing:-2px; color:#5b8c7e; line-height:1; }}
  .hero-num .n .p {{ font-size:21px; color:#a8c4b8; }}
  .hero-num .cap {{ font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:#9a988e; margin-top:5px; }}
  .rows {{ display:flex; flex-direction:column; }}
  .row {{
    display:grid; grid-template-columns:96px 1fr 56px; gap:18px; align-items:center;
    padding:15px 0; border-top:1px solid #ecebe4;
  }}
  .row:last-child {{ border-bottom:1px solid #ecebe4; }}
  .brand {{ font-size:15px; font-weight:500; }}
  .track {{ position:relative; height:32px; }}
  .track-bg {{ position:absolute; inset:0; background:#f0efe9; border-radius:8px; }}
  .fill {{ position:absolute; top:0; left:0; bottom:0; border-radius:8px; transform-origin:left;
    animation:grow .9s cubic-bezier(.2,.7,.3,1) both; }}
  @keyframes grow {{ from{{transform:scaleX(0);}} to{{transform:scaleX(1);}} }}
  .val {{ font-size:17px; text-align:right; }}
  .insights {{ display:flex; gap:30px; margin-top:30px; flex-wrap:wrap; }}
  .insights .k {{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#b4b2a8; margin-bottom:4px; }}
  .insights .v {{ font-size:15px; color:#1c1b18; }}
  .queries {{ margin-top:34px; padding-top:26px; border-top:1px solid #ecebe4; }}
  .queries .lbl {{ font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#b4b2a8; margin-bottom:12px; }}
  .chips {{ display:flex; flex-wrap:wrap; gap:8px; }}
  .chip {{ font-size:13px; color:#6a6a63; background:#f0efe9; border:1px solid #e6e5dd; padding:7px 12px; border-radius:8px; }}
  footer {{ max-width:720px; margin:22px auto 0; text-align:center; font-size:12px; color:#a8a69c; }}
  footer a {{ color:#5b8c7e; text-decoration:none; }}
  @media (max-width:540px) {{
    .card {{ padding:34px 24px; }}
    h1 {{ font-size:27px; }}
    .hero-num .n {{ font-size:40px; }}
    .insights {{ gap:20px; }}
  }}
</style>
</head>
<body>
<div class="card">
  <div class="glow"></div>
  <div class="inner">
    <div class="eyebrow"><span class="dot"></span> AI Visibility · {date_str}</div>

    <div class="top">
      <div>
        <h1>{leader_name} owns<br>the conversation</h1>
        <div class="sub">Across {len(queries)} buyer-intent queries · {len(ranking)} brands tracked</div>
      </div>
      <div class="hero-num">
        <div class="n">{leader_sov}<span class="p">%</span></div>
        <div class="cap">share of voice</div>
      </div>
    </div>

    <div class="rows">{rows_html}</div>

    <div class="insights">
      <div>
        <div class="k">Coverage leader</div>
        <div class="v">{leader_name} · {leader_cov}</div>
      </div>
      <div>
        <div class="k">Best avg. rank</div>
        <div class="v">{br_name} · {br_val}</div>
      </div>
      <div>
        <div class="k">Blind spot</div>
        <div class="v">{blind_name} · {blind_cov}</div>
      </div>
    </div>

    <div class="queries">
      <div class="lbl">Queries analyzed</div>
      <div class="chips">{chips}</div>
    </div>
  </div>
</div>
<footer>Built by <a href="https://github.com/arochab">Adam Chabbi</a> · <a href="https://github.com/arochab/serp-scraper">source on GitHub</a> · data via Bright Data SERP API</footer>
</body>
</html>"""


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate an HTML report from a visibility JSON file.")
    parser.add_argument("--input", default="visibility_report.json", help="Input JSON file")
    parser.add_argument("--output", default="report.html", help="Output HTML file")
    args = parser.parse_args()

    with open(args.input, encoding="utf-8") as f:
        report = json.load(f)

    html = build_html(report)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(html)
    print(f"Report generated: {args.output}")


if __name__ == "__main__":
    main()
