# PaperFate API リファレンス

`https://paperfate.com/api/*` にデプロイされている公開エンドポイントを一枚にまとめたリファレンスです。すべてのエンドポイントは Vercel Node サーバーレス関数（`runtime: 'nodejs'`）として動作します。

## 共通仕様

- **Base URL** — 本番環境は `https://paperfate.com`、ローカルの Vite 開発環境は `http://localhost:5180`（注意：`npm run dev` では API は起動しません。`vercel dev` を使うか、ローカルから本番を直接叩いてください）。
- **CORS** — `Access-Control-Allow-Origin` は `PAPERFATE_ALLOWED_ORIGINS` でホワイトリスト管理されます（デフォルトは `https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180`）。プリフライト `OPTIONS` は `Vary: Origin` 付きで `204` を返します。
- **Content-Type** — POST エンドポイントはリクエスト・レスポンスとも `application/json` です。
- **レート制限** — アプリ層には独自のリミッターは置いていません。Vercel プラットフォーム側の上限のみが適用されます。レスポンスが安定しているエンドポイント（ジャーナル参照系：`s-maxage=86400, stale-while-revalidate=604800`）にはエンドポイントごとにキャッシュヘッダを設定しています。
- **エラー** — `{ error, detail?, request_id? }` 形式の JSON で返します。よくある形は `method_not_allowed (405)`、`invalid_json (400)`、`payload_too_large (413)`、`request_timeout (408)` です。
- **サーバーバージョン** — 現行 forecast サーバーは `0.4.0`、abstract-quality は `0.3.1` です。該当する場合はレスポンスボディにも返却されます。
- **request_id** — `/api/forecast` と `/api/abstract-quality` のすべてのレスポンスには、ログ突合用の UUID が含まれます。

---

## POST /api/forecast

エンドツーエンドの Q500 原稿スコアリング + FateCore 推論 + サジェストエンジン。

- **メソッド**：`POST`
- **URL**：`/api/forecast`
- **レイテンシバジェット**：最大 300 秒（`maxDuration: 300`）。Gemini 有料枠での Q500 典型値は約 110 秒。Q100 ショートボディ経路は約 15-25 秒。
- **ボディ上限**：256 KB（`MAX_BODY_BYTES`）。ストリーム読み取りタイムアウトは 10 秒。
- **CORS 対象**：ホワイトリスト Origin に対して `POST, OPTIONS`。

### リクエストボディ

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥200 chars, required)",
  "methods": "string?",            // capped at 8 000 chars
  "results": "string?",            // capped at 8 000 chars
  "discussion": "string?",         // capped at 8 000 chars
  "full_text": "string?",          // capped at 24 000 chars
  "authors": "string[] | string?",
  "year": "number?",
  "first_affiliation": "string?",
  "funder": "string?",
  "funding": "string?",
  "is_preprint": "boolean?",
  "author_features": {
    "first_author_h_index": "number?",
    "last_author_h_index": "number?",
    "max_team_h_index": "number?",
    "median_team_h_index": "number?",
    "team_size_with_id": "number?",
    "international_collab": "0|1?"
  },
  "article_type": "string? (default '*')",
  "mode": "'Q100' | 'Q500' | 'auto' (default 'auto')",
  "target_journal": "object?"
}
```

`mode: 'auto'` のとき、`methods+results+discussion+full_text` の合計文字数が 1 500 未満であれば強制的に `Q100` 経路となります（レスポンスに `auto_decision: 'Q100_short_body'` が付きます）。

### レスポンス（200）

```jsonc
{
  // From the extraction layer:
  "overall_score": 3.42,
  "domain_rollup": { "NOVEL": 3.1, "DESIGN": 3.8, /* ... */ },
  "key_weaknesses": [ /* item objects */ ],
  "items": [ /* per-question scores */ ],
  "items_attempted": 487,
  "items_scored": 487,
  "extractor_used": "llm" | "deterministic" | "rule_fallback",

  // Graceful-degradation telemetry (LLM path only):
  "llm_health": {
    "status": "ok" | "degraded",
    "failed": 0,
    "attempted": 487,
    "reason": "gemini_400_invalid_key" | "rate_limited" | "unknown"
  },
  "llm_errors": ["..."],                // ≤10 deduped error strings
  "extraction_fallback_reason": "llm_batch_failures",

  // FateCore inference + journey:
  "jif_point": 14.2,
  "jif_ci_low":  8.1,
  "jif_ci_high": 23.4,
  "tier": "Q1",
  "desk_reject_risk": 0.18,
  "review_days_point": 142,
  "citations_5yr_low": 12,
  "citations_5yr_high": 84,
  "confidence": 0.68,                   // ≤0.30 when extractor_used='rule_fallback'
  "journey": [ /* 5 ordered target steps */ ],

  // Suggestions:
  "counterfactual_suggestions": [ /* per-item lift suggestions */ ],
  "joint_counterfactual": { /* multi-item joint lift */ },

  // Meta:
  "auto_decision": "Q100_short_body" | null,
  "wall_ms": 24813,
  "server_version": "0.4.0",
  "request_id": "9f1c..."
}
```

### `rule_fallback` の挙動

LLM 項目の 50% を超えて失敗した場合（あるいは採点項目数がゼロの場合）、ハンドラは決定論的なルール事前パスを再実行し、以下を付けて返します。

- `extractor_used: "rule_fallback"`
- `extraction_fallback_reason: "llm_batch_failures"`
- `llm_health.status: "degraded"`（`reason` 付き）
- `confidence ≤ 0.30`（UI 側で表示 confidence に上限を掛けます）

クライアント側では「degraded（縮退運転）」バナーを表示してください（`ResultPanel` に既に組み込み済みです）。

### エラー

| ステータス | `error`                       | 発生条件 |
|--------|-------------------------------|------|
| 400    | `missing_or_short_title`      | title が無いか 5 文字未満 |
| 400    | `missing_or_short_abstract`   | abstract が無いか 200 文字未満 |
| 400    | `invalid_json`                | ボディがパースできない |
| 405    | `method_not_allowed`          | POST/OPTIONS 以外 |
| 408    | `request_timeout`             | ボディのストリーム読み取りが 10 秒超 |
| 413    | `payload_too_large`           | ボディが 256 KB 超 |
| 500    | `extraction_failed`           | パイプライン内部で想定外の throw |

すべてのエラーレスポンスに `request_id` が含まれます。

### サンプル

```bash
curl -X POST https://paperfate.com/api/forecast \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Empagliflozin and Cardiovascular Outcomes in T2D",
    "abstract": "We conducted a randomized double-blind trial of empagliflozin...",
    "mode": "Q100"
  }'
```

---

## POST /api/abstract-quality

抄録のみを対象とした純粋な Q100 ルーブリック評価エンドポイントです。`mode='Q100'` を強制し、FateCore／journey／suggestions は除外して、ルーブリック集計だけを返します。

- **メソッド**：`POST`
- **URL**：`/api/abstract-quality`
- **レイテンシバジェット**：60 秒（`maxDuration: 60`）。典型値は約 12-20 秒。
- **CORS 対象**：`POST, OPTIONS`。

### リクエストボディ

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥200 chars, required)",
  "article_type": "string? (default '*')"
}
```

### レスポンス（200）

```jsonc
{
  "overall_score": 3.1,
  "domain_rollup": { /* ... */ },
  "key_weaknesses": [ /* ... */ ],
  "items": [ /* ~100 Q100 items */ ],
  "items_attempted": 100,
  "items_scored": 100,
  "elapsed_ms": 18342,
  "server_version": "0.3.1",
  "request_id": "..."
}
```

### エラー

| ステータス | `error`                       |
|--------|-------------------------------|
| 400    | `missing_or_short_title`      |
| 400    | `missing_or_short_abstract`   |
| 400    | `invalid_json`                |
| 405    | `method_not_allowed`          |
| 500    | `extraction_failed`           |

### サンプル

```bash
curl -X POST https://paperfate.com/api/abstract-quality \
  -H "Content-Type: application/json" \
  -d '{"title":"Empagliflozin in T2D","abstract":"We randomly assigned..."}'
```

---

## POST /api/similar

OpenAlex を使った類似論文検索。タイトル検索と抄録検索を並行で投げます。最大 5 件の候補を返し、デプロイ時同梱の 800 誌ショートリストに対して ISSN→JIF で結合します。

- **メソッド**：`POST`
- **URL**：`/api/similar`
- **レイテンシバジェット**：30 秒（`maxDuration: 30`）。ハンドラ内部のデッドラインは 22 秒。
- **CORS 対象**：`POST, OPTIONS`。

### リクエストボディ

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥100 chars, required)"
}
```

### レスポンス（200）

```jsonc
{
  "similars": [
    {
      "title": "...",
      "venue": "New England Journal of Medicine",
      "issn": "0028-4793",
      "if": 158.5,
      "jif": 158.5,
      "year": 2024,
      "citations": 412,
      "doi": "10.1056/nejmoa...",
      "openalex_id": "https://openalex.org/W...",
      "score": 41.3
    }
  ],
  "query_used": "Empagliflozin Cardiovascular T2D ..."
}
```

ハンドラは 2 つのクエリを並列で投げます。

1. タイトルのみで検索し、`relevance_score:desc` でランク付け（それらを引用したレビューよりも、ランドマーク的な原著論文が上位に来ます）。
2. 抄録テキストによる広めの検索。

結果は正規化したタイトルで重複排除し、元の論文タイトル自身は除外します。

### エラー

| ステータス | `error`                         |
|--------|---------------------------------|
| 400    | `missing_or_short_title`        |
| 400    | `missing_or_short_abstract`     |
| 400    | `invalid_json`                  |
| 405    | `method_not_allowed`            |
| 502    | `openalex_search_failed`        |

---

## GET /api/journal-info

800 誌ショートリストに対する単一ジャーナル検索。リーク懸念のある v0.3-pub モデルをデプロイせずに、ターゲットジャーナルカードの根拠データを供給するために使います。

- **メソッド**：`GET`（タスク仕様には `POST/GET` と書かれていますが、現行ハンドラは GET のみです。POST 化はまだ未着手）
- **URL**：`/api/journal-info?issn=...` または `?name=...`
- **レイテンシバジェット**：10 秒。
- **CORS 対象**：`GET, OPTIONS`。
- **キャッシュ**：`s-maxage=86400, stale-while-revalidate=604800`。

### マッチ優先順位

1. `?issn=` 完全一致（ハイフン差異・大文字小文字を許容）。
2. `?name=` 完全一致（小文字化して比較）。
3. `?name=` 前方一致（JIF 降順）— `match_score=700`。
4. `?name=` 部分一致（6 文字以上、JIF 降順）— `match_score=500`。

### レスポンス（200）

```jsonc
{
  "journal": {
    "name": "New England Journal of Medicine",
    "issn": "0028-4793",
    "jif": 158.5,
    "jif_5yr": 121.7,
    "tier": "TOP",
    "category": "MEDICINE, GENERAL & INTERNAL",
    "quartile": "Q1",
    "publisher": "Massachusetts Medical Society",
    "country": "United States",
    "is_oa": false,
    "is_in_doaj": false,
    "apc": null,
    "h_index": 1224
  },
  "match_type": "exact" | "startsWith" | "substring",
  "match_score": 1000
}
```

### エラー

| ステータス | `error`                |
|--------|------------------------|
| 404    | `journal_not_found`    |
| 405    | `method_not_allowed`   |

### サンプル

```bash
curl 'https://paperfate.com/api/journal-info?issn=0028-4793'
curl 'https://paperfate.com/api/journal-info?name=Lancet'
```

---

## GET /api/journals-search

オンメモリのあいまい補完検索。ティアブレンド（上位帯と中位帯の混在）に対応し、最大 20 件返します。

- **メソッド**：`GET`（タスク仕様には POST/GET と書かれていますが、現行ハンドラは GET のみ）
- **URL**：`/api/journals-search?q=<query>&limit=10&tier=Q1`
- **レイテンシバジェット**：10 秒。
- **CORS 対象**：`GET, OPTIONS`。
- **キャッシュ**：`s-maxage=86400, stale-while-revalidate=604800`。

### クエリパラメータ

| パラメータ | デフォルト | 説明 |
|---------|---------|-------|
| `q`     | —       | 必須、2 文字以上。空なら `{ results: [] }` を返す |
| `limit` | 10      | 1〜20 にクランプ |
| `tier`  | —       | 任意の大文字フィルタ（例：`Q1`、`TOP`）。指定するとブレンドは無効化 |

### ティアブレンド

`tier` が未指定のときは、生スコア上位 7 件をまず確保し、残りの枠（`limit` まで）を、上位 7 件のフロアを超えた Q2/Q3 ジャーナルに割り当てます。これにより、フラッグシップ誌と並んで現実的な中堅誌のターゲットも目に入るようになります。中堅プールが足りない場合は、未掲載のものをスコア順に補充します。

マッチスコアの内訳：

- ISSN 完全一致：1000
- 名称完全一致：900
- 名称前方一致：700
- 名称部分一致：500
- カテゴリ部分一致：100
- タイブレーク：`+min(199, round(JIF*10)/10)`

### レスポンス（200）

```jsonc
{
  "results": [
    {
      "name": "Lancet, The",
      "issn": "0140-6736",
      "jif": 168.9,
      "tier": "TOP",
      "category": "MEDICINE, GENERAL & INTERNAL",
      "publisher": "Elsevier",
      "is_oa": false
    }
  ]
}
```

### サンプル

```bash
curl 'https://paperfate.com/api/journals-search?q=lancet&limit=5'
```

---

## POST /api/journal-compare

最大 5 誌のターゲットジャーナルを 1 リクエストで解決します。`/journal-info` を N 回直列で叩かずに、横並び比較を行えます。

- **メソッド**：`POST`
- **URL**：`/api/journal-compare`
- **レイテンシバジェット**：10 秒。
- **CORS 対象**：`POST, OPTIONS`。

### リクエストボディ

```jsonc
{
  "issns": ["0028-4793", "0140-6736"],
  "names": ["JAMA"]
}
```

`issns.length + names.length` は合計 5 までに制限されます。解決の優先順位は `/journal-info` と同じです（ISSN 完全一致 → 名称完全一致 → 名称部分一致を JIF 降順）。解決できなかった項目は静かに落とされます。

### レスポンス（200）

```jsonc
{
  "journals": [
    { /* same shape as /journal-info `journal` object */ }
  ]
}
```

### エラー

| ステータス | `error`              |
|--------|----------------------|
| 400    | `no_targets`         |
| 400    | `too_many_targets`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

### サンプル

```bash
curl -X POST https://paperfate.com/api/journal-compare \
  -H "Content-Type: application/json" \
  -d '{"issns":["0028-4793","0140-6736"],"names":["JAMA"]}'
```

---

## POST /api/references

DOI を OpenAlex 経由で一括解決し、出版社の整合性チェックを行います。さらにショートリストから ISSN-L → JIF を結合し、参考文献の記述統計サマリを返します。

- **メソッド**：`POST`
- **URL**：`/api/references`
- **レイテンシバジェット**：60 秒。OpenAlex 検索の並列プールは 6 件。DOI ごとのリクエストタイムアウトは 8 秒で、429 のときは 1 回だけリトライします。
- **CORS 対象**：`POST, OPTIONS`。

### リクエストボディ

```jsonc
{
  "dois": ["10.1056/nejmoa1504720", "10.1016/s0140-6736(15)..."]
}
```

`dois` は正規化（小文字化、`doi.org/` プレフィックス除去）と重複排除を行います。1 リクエストあたり最大 50 件まで。

### 出版社整合性チェック

DOI プレフィックスが既知の出版社（NEJM、Lancet、JAMA、Nature、Science）を指しているにもかかわらず OpenAlex が別の媒体を返してきた場合、その項目の `venue/issn/jif` は null に倒し、`warning: 'doi_metadata_mismatch'` を付けます。同時に `n_venue_mismatch` をインクリメントします。

### レスポンス（200）

```jsonc
{
  "n_input": 12,
  "n_resolved": 11,
  "n_with_jif": 9,
  "n_not_found": 1,
  "n_lookup_errors": 0,
  "n_venue_mismatch": 0,
  "mean_jif": 28.4,
  "median_jif": 14.2,
  "top_journals": [
    { "name": "NEJM", "count": 3, "issn": "0028-4793", "jif": 158.5 }
  ],
  "top_categories": [
    { "category": "MEDICINE, GENERAL & INTERNAL", "count": 7 }
  ],
  "year_median": 2022,
  "year_min": 2015,
  "year_max": 2024,
  "references": [
    { "doi": "10.1056/...", "title": "...", "venue": "...", "issn": "...",
      "jif": 158.5, "category": "...", "year": 2015, "citations": 1234 },
    { "doi": "10.1234/missing", "_missing": true,
      "error_code": "404" | "timeout" | "network" | "http_500" }
  ]
}
```

### エラー

| ステータス | `error`              |
|--------|----------------------|
| 400    | `no_valid_dois`      |
| 400    | `too_many_dois`      |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/author-features

OpenAlex `/authors?search=`（relevance トップヒット）を介して著者の h-index を解決し、FateCore の著者特徴ベクトルに集計します。

- **メソッド**：`POST`
- **URL**：`/api/author-features`
- **レイテンシバジェット**：30 秒。並列プールは 5 件。著者ごとのタイムアウトは 8 秒。
- **CORS 対象**：`POST, OPTIONS`。

### リクエストボディ

```jsonc
{ "authors": ["Bernard Zinman", "Christoph Wanner", "..."] }
```

著者名はトリム＋空白の正規化を施し、重複排除します。1 リクエストあたり最大 25 名まで。

### レスポンス（200）

```jsonc
{
  "first_author_h_index": 78,
  "last_author_h_index":  null,        // null when single_author=true
  "single_author":        false,
  "max_team_h_index":     112,
  "median_team_h_index":  84,
  "team_size_with_id":    8,           // count with resolvable h_index
  "resolved": [
    { "name": "Bernard Zinman", "matched": "Bernard Zinman",
      "h_index": 78, "works_count": 412,
      "openalex_id": "https://openalex.org/A...",
      "institution": "University of Toronto" },
    { "name": "Unknown Author", "matched": null, "h_index": null }
  ]
}
```

`single_author=true` のときは、単著にはシニア枠が存在しないため `last_author_h_index` をゼロに倒します（Codex Round 7 仕様）。

### エラー

| ステータス | `error`              |
|--------|----------------------|
| 400    | `no_authors`         |
| 400    | `too_many_authors`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/telemetry-beacon（内部用）

最小限のワンショット beacon 受け口です。イベントは `[telemetry]` プレフィックス付きで Vercel ログに流すだけ。DB やアナリティクス依存はありません。

- **メソッド**：`POST`
- **URL**：`/api/telemetry-beacon`
- **レイテンシバジェット**：5 秒。
- **CORS 対象**：`POST, OPTIONS`。
- **ボディ上限**：4 KB。
- **使い方**：`src/lib/telemetry.js` の `trackEvent()` とペアで使います（利用可能なら `navigator.sendBeacon` 経由）。

### リクエストボディ

```jsonc
{
  "name":       "string (≤64 chars, required)",
  "props":      { /* arbitrary serialisable */ },
  "ts":         1717000000000,
  "url":        "https://paperfate.com/simulator",
  "ua_summary": "Chrome 124"
}
```

### レスポンス

| ステータス | ボディ                  |
|--------|-----------------------|
| 204    | 空（受領済み）          |
| 400    | `invalid_json` / `invalid_shape` |
| 405    | `method_not_allowed`  |
| 413    | `payload_too_large`   |

### サンプル

```bash
curl -X POST https://paperfate.com/api/telemetry-beacon \
  -H "Content-Type: application/json" \
  -d '{"name":"forecast_view","props":{"tier":"Q1"},"ts":1717000000000,"url":"https://paperfate.com/","ua_summary":"Chrome"}'
```

---

## クイックリファレンス

| エンドポイント              | メソッド | バジェット | 備考                              |
|---------------------------|--------|--------|-----------------------------------|
| `/api/forecast`           | POST   | 300 秒 | Q500 + FateCore + journey         |
| `/api/abstract-quality`   | POST   | 60 秒  | Q100 ルーブリックのみ              |
| `/api/similar`            | POST   | 30 秒  | OpenAlex の二系統並列検索          |
| `/api/journal-info`       | GET    | 10 秒  | ショートリスト参照、キャッシュ有   |
| `/api/journals-search`    | GET    | 10 秒  | オートコンプリート、ティアブレンド |
| `/api/journal-compare`    | POST   | 10 秒  | 最大 5 誌をバッチ解決              |
| `/api/references`         | POST   | 60 秒  | 最大 50 DOI、OpenAlex で解決       |
| `/api/author-features`    | POST   | 30 秒  | 最大 25 著者、h-index 集計         |
| `/api/telemetry-beacon`   | POST   | 5 秒   | beacon 受け口（内部用）            |
