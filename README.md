# AI Visibility Checker

> Measure how visible a brand is — versus its competitors — across the searches real buyers actually type. Powered by the [Bright Data](https://brightdata.com) SERP API.

When a customer searches "best tool for X", who shows up — you, or your competitors? This tool answers that question with data. It runs a set of buyer-intent queries, scans the results, and ranks every brand by **search visibility**: query coverage, average rank, and share of voice.

This is the measurable side of **GEO / SEO** — one of the defining marketing problems of 2026. It is built on top of a reusable SERP scraper (`serp_scraper.py`), included in this repo.

## Example

```bash
$ python ai_visibility.py \
    --brands "Notion,Asana,Monday,ClickUp,Trello" \
    --queries "best project management tool,asana alternative,team collaboration software"

============================================================
AI VISIBILITY REPORT
============================================================
Queries analyzed: 3

#  Brand             Coverage  Avg rank  Share of voice
-------------------------------------------------------
1  Notion            3/3       1.3       24.0%
2  Asana             3/3       1.7       28.0%
3  ClickUp           3/3       2.4       22.0%
4  Monday            2/3       2.8       18.0%
5  Trello            0/3       —         0.0%

Most visible: Notion (appears in 3/3 queries, 24.0% share of voice)
```

## Usage

```bash
export BRIGHTDATA_API_KEY="your_key"

# Inline brands + queries
python ai_visibility.py --brands "BrandA,BrandB" --queries "best X,X alternative"

# Or from a config file
python ai_visibility.py --config visibility_config.example.json
```

Metrics per brand: **query coverage** (how many queries surface it), **average rank** (position when it appears, lower is better), and **share of voice** (its slice of all tracked-brand appearances). Full results are saved to `visibility_report.json`.

---

## What else is in this repo

`serp_scraper.py` — the foundation: turns any single Google query into structured JSON / CSV (title, link, description, rank). Useful on its own for lead research and data pipelines.

```bash
python serp_scraper.py "your keyword" --csv
```

---

## Table of contents

- [Features](#features)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Skills demonstrated](#skills-demonstrated)
- [License](#license)

---

## Demo

```bash
$ python serp_scraper.py "python automation freelance" --csv

Searching: "python automation freelance" ...
8 results found.

  [5] What's the best python projects for freelancing?
      https://www.reddit.com/r/Python/comments/10qhkrc/...
  [6] Python Freelance Jobs: Work Remote & Earn Online
      https://www.upwork.com/freelance-jobs/python/

  -> JSON saved: results.json
  -> CSV saved: results.csv
```

## Features

- Google search -> **structured** organic results (title, link, description, rank).
- **JSON** and **CSV** export.
- **Zero dependencies**: Python standard library only.
- API key kept **out of the source code** (environment variable + `.gitignore`).
- Clean command-line interface with an in-terminal preview of results.

## Installation

Requires Python 3.9+. No external dependencies.

```bash
git clone https://github.com/arochab/serp-scraper.git
cd serp-scraper
```

## Configuration

The API key is read from an environment variable — it is **never** written in the source code.

```bash
# macOS / Linux
export BRIGHTDATA_API_KEY="your_bright_data_key"
```

```powershell
# Windows (PowerShell)
$env:BRIGHTDATA_API_KEY="your_bright_data_key"
```

## Usage

```bash
# Simple search -> results.json
python serp_scraper.py "your keyword"

# Choose the output file
python serp_scraper.py "python freelance paris" --output jobs.json

# Also export to CSV
python serp_scraper.py "automation agencies lyon" --csv
```

| Option      | Description                       | Default        |
|-------------|-----------------------------------|----------------|
| `query`     | Keyword or phrase to search for   | *(required)*   |
| `--output`  | Output JSON file name             | `results.json` |
| `--csv`     | Also export a CSV file            | disabled       |

## How it works

1. The script builds a Google search URL and appends `brd_json=1`.
2. It sends that URL to the Bright Data API, which handles proxies, CAPTCHAs, and JavaScript rendering.
3. Bright Data returns the organic results already parsed as JSON.
4. The script prints a preview and saves the data (JSON, and CSV if requested).

```
  query  ──►  serp_scraper.py  ──►  Bright Data API  ──►  JSON / CSV
```

## Skills demonstrated

This project implements, end to end:

- **Third-party REST API integration** (token authentication, POST requests, response parsing).
- **Secure secret management**: no hard-coded keys, environment variable, dedicated `.gitignore`.
- **CLI design** with `argparse` (arguments, options, defaults).
- **Data processing and export** to structured JSON and CSV.
- **Readable, documented code**: single-responsibility functions, docstrings, complete README.

## License

[MIT](LICENSE)

## Aperçu

```bash
$ python serp_scraper.py "freelance automatisation python" --csv

Recherche : « freelance automatisation python » …
8 résultats trouvés.

  [5] What's the best python projects for freelancing?
      https://www.reddit.com/r/Python/comments/10qhkrc/...
  [6] Python Freelance Jobs: Work Remote & Earn Online
      https://www.upwork.com/freelance-jobs/python/
  ...

  → JSON enregistré : resultats.json
  → CSV enregistré : resultats.csv
```

## Installation

Aucune dépendance externe — le script n'utilise que la bibliothèque standard de Python (3.9+).

```bash
git clone https://github.com/<votre-compte>/serp-scraper.git
cd serp-scraper
```

## Configuration

Le script lit votre clé API depuis une variable d'environnement (elle n'est **jamais** écrite dans le code) :

```bash
export BRIGHTDATA_API_KEY="votre_cle_bright_data"
```

Sous Windows (PowerShell) :

```powershell
$env:BRIGHTDATA_API_KEY="votre_cle_bright_data"
```

## Utilisation

```bash
# Recherche simple → resultats.json
python serp_scraper.py "votre mot clé"

# Choisir le fichier de sortie
python serp_scraper.py "freelance python paris" --output missions.json

# Exporter aussi en CSV
python serp_scraper.py "agences automatisation lyon" --csv
```

| Option       | Description                              | Défaut           |
|--------------|------------------------------------------|------------------|
| `query`      | Le mot-clé ou la phrase à rechercher     | *(obligatoire)*  |
| `--output`   | Nom du fichier JSON de sortie            | `resultats.json` |
| `--csv`      | Exporte également un fichier CSV         | désactivé        |

## Comment ça marche

1. Le script construit une URL de recherche Google et y ajoute `brd_json=1`.
2. Il envoie cette URL à l'API de Bright Data, qui gère à votre place les proxies, les CAPTCHA et le rendu JavaScript.
3. Bright Data renvoie les résultats organiques déjà parsés en JSON.
4. Le script affiche un aperçu et enregistre les données en JSON (et CSV en option).

## Notes

- Compatible avec le **free tier** de Bright Data (crédits gratuits, sans carte bancaire).
- La clé API reste hors du code grâce à la variable d'environnement et au `.gitignore`.

## Licence

MIT
