# BrandPulse AI — AI Visibility Checker

> **Type one brand. See who you're really up against.**
> Claude infers your sector, competitors and buyer queries — then live Google data shows who wins each search.

### → [**Try the live app**](https://brandpulse-app.onrender.com) · [Source](https://github.com/arochab/brandpulse-app)

![BrandPulse AI demo](demo.gif)

When a buyer searches *"best tool for X"*, who shows up — you, or your competitors? BrandPulse answers that with data. You type a single brand; the app does the rest and maps visibility across the searches that actually drive purchases. This is the measurable side of **GEO / AI-search optimization** — one of the defining marketing problems of 2026.

*(Free tier — the live app may take ~50s to wake on first visit.)*

---

## How it works

A two-stage AI + data pipeline:

```
  "Notion"  ─►  Claude (Haiku)  ─►  competitors + buyer queries
                                          │
                                          ▼
                                  Bright Data SERP API  ─►  live Google results
                                          │
                                          ▼
                              visibility heatmap · share of voice · evidence
```

1. **Claude reasons.** A single brand name goes to Claude Haiku, which infers the sector, 4–5 real competitors, and the buyer-intent queries a customer would search.
2. **Bright Data measures.** Each query runs live against Google; the app finds where every brand ranks.
3. **The result is a heatmap** — brands × queries — plus share of voice, average rank, a one-line auto-insight, and clickable evidence (the real pages each brand appears on).

## Built for cost-efficiency

- Uses **Claude Haiku** (the cheapest model) — ~$0.0001 per analysis.
- Only **2 SERP queries** per run.
- **Persistent cache** — a brand analyzed once is served free forever after.
- A live cost meter shows exactly what each analysis cost.

## Run it locally

```bash
git clone https://github.com/arochab/brandpulse-app.git
cd brandpulse-app
pip install -r requirements.txt

export BRIGHTDATA_API_KEY="your_bright_data_key"
export ANTHROPIC_API_KEY="your_anthropic_key"
python app.py
# open http://localhost:5000
```

Without keys, the app runs in **sample mode** — instant, free, fully clickable.

## Also in this repo

The web app is built on reusable command-line tools:

```bash
# Single Google query → structured JSON / CSV
python serp_scraper.py "your keyword" --csv

# Multi-brand visibility report from the terminal
python ai_visibility.py --config visibility_config.example.json
```

## Tech & skills demonstrated

- **LLM orchestration** — using Claude to turn one input into a full analysis strategy (structured JSON output).
- **Live web data** — Bright Data SERP API integration (auth, POST, parsing, bot-detection bypass).
- **Full-stack** — Flask backend + vanilla-JS front end, deployed on Render with gunicorn.
- **Production concerns** — secret management (env vars, never in code), cost guardrails, persistent caching, rate limiting, graceful fallback.
- **Data visualization** — an animated brand × query heatmap with hover-to-evidence.

## License

[MIT](LICENSE) · Built by [Adam Chabbi](https://github.com/arochab) · [☕ Buy me a coffee](https://buymeacoffee.com/arochab)
