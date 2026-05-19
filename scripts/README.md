# PaperFate data pipeline

Local scripts that collect a biomedical corpus PaperFate's forecast engine will run on.

## Quick start

```bash
# All seed queries (≈20–30 min without API key, ≈5–10 min with one)
npm run collect

# A single seed
node scripts/collect-pubmed.mjs hepatology_hcc

# Stats over what you've collected so far
npm run stats:pubmed
```

## NCBI API key (recommended)

Without a key, NCBI caps you to ~3 requests/second. A free key bumps that to 10/s.

1. Sign in at https://www.ncbi.nlm.nih.gov/account/
2. Account settings → API Key Management → Create
3. Add to a local `.env` (gitignored):
   ```
   NCBI_API_KEY=your_key_here
   NCBI_EMAIL=yhstella@gmail.com
   ```
4. Or just `set NCBI_API_KEY=...` in your shell.

> The collector reads `process.env.NCBI_API_KEY` directly — no `dotenv` dependency. If you want it loaded from `.env` automatically, either prepend `node --env-file=.env scripts/collect-pubmed.mjs` (Node 20+) or run from a shell that has the var set.

## Output

JSONL, one PubMed record per line, at `data/pubmed/<seed>-<YYYY-MM-DD>.jsonl`:

```json
{
  "seed": "hepatology_hcc",
  "pmid": "37123456",
  "doi": "10.1016/j.jhep.2023.04.001",
  "title": "External validation of a deep-learning HCC risk model …",
  "abstract": "Background: … Methods: … Results: … Conclusions: …",
  "journal": "J Hepatol",
  "issn": "1600-0641",
  "year": 2023,
  "publicationTypes": ["Journal Article", "Multicenter Study"],
  "meshTerms": ["Carcinoma, Hepatocellular", "Risk Assessment", "…"],
  "authors": ["Kim J", "Park S", "Lee H", "…"],
  "firstAffiliation": "Department of Internal Medicine, Seoul National University …"
}
```

`data/` is gitignored — keep it local. We'll upload to Vercel Blob / Postgres in a later step.

## Tuning seeds

`scripts/seeds.json` controls what gets queried. Each value is a literal PubMed query string — the same syntax you'd type into the web UI.

- `_retmaxPerSeed` caps how many PMIDs each seed pulls (default 2000).
- Add new seeds by adding a new key under `seeds`.

## Next layers (planned)

| Step | Source | Adds |
|---|---|---|
| 1. PubMed esearch+efetch | NCBI E-utilities | title, abstract, journal, MeSH, authors |
| 2. OpenAlex by DOI | OpenAlex API | citation counts, FWCI, concepts, venue ID, OA status |
| 3. Semantic Scholar by DOI | S2 API | influential citations, embedding (SPECTER2), cited-by graph |
| 4. Embeddings | OpenAI/local | 1536-d vector for similarity search |
| 5. Index | DuckDB / SQLite + sqlite-vec | local query in <50ms |

Each layer is a separate script that reads JSONL from the previous one and writes the next.
