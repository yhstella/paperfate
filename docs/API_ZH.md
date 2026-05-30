# PaperFate API 参考文档

部署在 `https://paperfate.com/api/*` 的所有公开端点的单页参考文档。所有端点均以 Vercel Node Serverless 函数运行（`runtime: 'nodejs'`）。

## 通用约定

- **Base URL** — 生产环境为 `https://paperfate.com`；本地 Vite 开发环境为 `http://localhost:5180`（注意：`npm run dev` 并*不会*启动 API，请使用 `vercel dev`，或直接从本地访问生产环境）。
- **CORS** — `Access-Control-Allow-Origin` 通过 `PAPERFATE_ALLOWED_ORIGINS` 设置白名单（默认值为 `https://paperfate.com,http://localhost:5180,http://127.0.0.1:5180`）。预检请求 `OPTIONS` 返回 `204`，并附带 `Vary: Origin`。
- **Content-Type** — POST 端点的请求与响应均使用 `application/json`。
- **限流** — 应用层未设置限流器，仅受 Vercel 平台限制。对响应稳定的端点（如期刊查询：`s-maxage=86400, stale-while-revalidate=604800`），会按端点设置缓存头。
- **错误** — 错误以 JSON 形式返回：`{ error, detail?, request_id? }`。常见错误形态包括：`method_not_allowed (405)`、`invalid_json (400)`、`payload_too_large (413)`、`request_timeout (408)`。
- **服务端版本** — 当前 forecast 服务版本为 `0.4.0`；abstract-quality 服务版本为 `0.3.1`。适用时会在响应体中返回。
- **request_id** — 每个 `/api/forecast` 和 `/api/abstract-quality` 响应都会携带一个用于日志关联的 UUID。

---

## POST /api/forecast

端到端的 Q500 稿件评分 + FateCore 推理 + 改进建议引擎。

- **方法**：`POST`
- **URL**：`/api/forecast`
- **延迟预算**：最长 300 秒（`maxDuration: 300`）。使用 Gemini 付费层的典型 Q500 用时约 110 秒；Q100 短正文路径约 15-25 秒。
- **请求体上限**：256 KB（`MAX_BODY_BYTES`），流读取超时为 10 秒。
- **CORS 范围**：对白名单来源开放 `POST, OPTIONS`。

### 请求体

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

当 `mode: 'auto'` 且 `methods+results+discussion+full_text` 总字符数小于 1 500 时，将强制使用 `Q100`（响应中会带上 `auto_decision: 'Q100_short_body'`）。

### 响应（200）

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

### `rule_fallback` 语义

当超过 50% 的 LLM 条目失败（或评分条目数为零）时，处理程序会重新跑一遍确定性的规则预处理，并以如下形式返回：

- `extractor_used: "rule_fallback"`
- `extraction_fallback_reason: "llm_batch_failures"`
- `llm_health.status: "degraded"`，并附上对应的 `reason`
- `confidence ≤ 0.30`（UI 会对显示的 confidence 设上限）

客户端应在 UI 上展示一个"降级运行"的提示横幅（`ResultPanel` 中已经接好）。

### 错误

| 状态码 | `error`                       | 触发条件 |
|--------|-------------------------------|------|
| 400    | `missing_or_short_title`      | title 缺失或小于 5 字符 |
| 400    | `missing_or_short_abstract`   | abstract 缺失或小于 200 字符 |
| 400    | `invalid_json`                | 请求体无法解析 |
| 405    | `method_not_allowed`          | 非 POST/OPTIONS 方法 |
| 408    | `request_timeout`             | 请求体流读取超过 10 秒 |
| 413    | `payload_too_large`           | 请求体超过 256 KB |
| 500    | `extraction_failed`           | 处理流水线内部抛出未预期异常 |

所有错误响应体均包含 `request_id`。

### 示例

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

仅针对摘要的纯 Q100 评分器。强制使用 `mode='Q100'`，去除 FateCore/journey/suggestions，只返回评分汇总。

- **方法**：`POST`
- **URL**：`/api/abstract-quality`
- **延迟预算**：60 秒（`maxDuration: 60`），典型用时约 12-20 秒。
- **CORS 范围**：`POST, OPTIONS`。

### 请求体

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥200 chars, required)",
  "article_type": "string? (default '*')"
}
```

### 响应（200）

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

### 错误

| 状态码 | `error`                       |
|--------|-------------------------------|
| 400    | `missing_or_short_title`      |
| 400    | `missing_or_short_abstract`   |
| 400    | `invalid_json`                |
| 405    | `method_not_allowed`          |
| 500    | `extraction_failed`           |

### 示例

```bash
curl -X POST https://paperfate.com/api/abstract-quality \
  -H "Content-Type: application/json" \
  -d '{"title":"Empagliflozin in T2D","abstract":"We randomly assigned..."}'
```

---

## POST /api/similar

基于 OpenAlex 的相似论文检索，并行执行标题与摘要两路查询。最多返回 5 个候选，并从部署时打包的 800 本期刊短名单中按 ISSN→JIF 进行关联。

- **方法**：`POST`
- **URL**：`/api/similar`
- **延迟预算**：30 秒（`maxDuration: 30`），处理程序内部 deadline 为 22 秒。
- **CORS 范围**：`POST, OPTIONS`。

### 请求体

```jsonc
{
  "title": "string (≥5 chars, required)",
  "abstract": "string (≥100 chars, required)"
}
```

### 响应（200）

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

处理程序会并行发起两次查询：

1. 仅按标题检索，按 `relevance_score:desc` 排序（让标志性原始论文排在引用它们的综述之上）。
2. 基于摘要文本的宽泛检索。

结果按归一化后的标题去重，并过滤掉原始论文本身。

### 错误

| 状态码 | `error`                         |
|--------|---------------------------------|
| 400    | `missing_or_short_title`        |
| 400    | `missing_or_short_abstract`     |
| 400    | `invalid_json`                  |
| 405    | `method_not_allowed`            |
| 502    | `openalex_search_failed`        |

---

## GET /api/journal-info

针对 800 本期刊短名单的单期刊查询。用于为目标期刊卡片提供锚定数据，避免使用容易泄漏的 v0.3-pub 模型。

- **方法**：`GET`（任务文档中列为 `POST/GET`，但当前线上的处理程序仅支持 GET，尚未切换至 POST）
- **URL**：`/api/journal-info?issn=...` 或 `?name=...`
- **延迟预算**：10 秒。
- **CORS 范围**：`GET, OPTIONS`。
- **缓存**：`s-maxage=86400, stale-while-revalidate=604800`。

### 匹配优先级

1. `?issn=` 精确匹配（容忍连字符，大小写不敏感）。
2. `?name=` 精确匹配（按小写比较）。
3. `?name=` 前缀匹配（按 JIF 降序）— `match_score=700`。
4. `?name=` 子串匹配（≥6 字符，按 JIF 降序）— `match_score=500`。

### 响应（200）

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

### 错误

| 状态码 | `error`                |
|--------|------------------------|
| 404    | `journal_not_found`    |
| 405    | `method_not_allowed`   |

### 示例

```bash
curl 'https://paperfate.com/api/journal-info?issn=0028-4793'
curl 'https://paperfate.com/api/journal-info?name=Lancet'
```

---

## GET /api/journals-search

内存中的模糊自动补全查询，支持档次混排。最多返回 20 个候选。

- **方法**：`GET`（任务文档中列为 POST/GET，但当前线上的处理程序仅支持 GET）
- **URL**：`/api/journals-search?q=<query>&limit=10&tier=Q1`
- **延迟预算**：10 秒。
- **CORS 范围**：`GET, OPTIONS`。
- **缓存**：`s-maxage=86400, stale-while-revalidate=604800`。

### 查询参数

| 参数    | 默认值 | 说明 |
|---------|---------|-------|
| `q`     | —       | 必填，长度 ≥2 字符；为空时返回 `{ results: [] }` |
| `limit` | 10      | 限制在 1-20 之间 |
| `tier`  | —       | 可选，大写过滤（如 `Q1`、`TOP`）；启用后不再混排 |

### 档次混排

未指定 `tier` 时，会保留原始评分最高的前 7 条匹配；剩余的位置（最多到 `limit`）会留给 Q2/Q3 期刊中得分高于前 7 条最低分的项目——这样用户在看到旗舰期刊的同时，也能看到现实可行的中档目标。若中档池不够填，则按得分顺序补上其余未使用的候选。

匹配评分规则：

- ISSN 精确：1000
- 名称精确：900
- 名称前缀：700
- 名称子串：500
- 类别子串：100
- 同分加权：`+min(199, round(JIF*10)/10)`

### 响应（200）

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

### 示例

```bash
curl 'https://paperfate.com/api/journals-search?q=lancet&limit=5'
```

---

## POST /api/journal-compare

在单次请求中解析最多 5 个目标期刊——并排对比，无需发起 N 次连续的 `/journal-info` 请求。

- **方法**：`POST`
- **URL**：`/api/journal-compare`
- **延迟预算**：10 秒。
- **CORS 范围**：`POST, OPTIONS`。

### 请求体

```jsonc
{
  "issns": ["0028-4793", "0140-6736"],
  "names": ["JAMA"]
}
```

`issns.length + names.length` 总数上限为 5。解析使用与 `/journal-info` 相同的优先级（ISSN 精确、名称精确、按 JIF 降序的名称子串）。未能解析的条目会被静默丢弃。

### 响应（200）

```jsonc
{
  "journals": [
    { /* same shape as /journal-info `journal` object */ }
  ]
}
```

### 错误

| 状态码 | `error`              |
|--------|----------------------|
| 400    | `no_targets`         |
| 400    | `too_many_targets`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

### 示例

```bash
curl -X POST https://paperfate.com/api/journal-compare \
  -H "Content-Type: application/json" \
  -d '{"issns":["0028-4793","0140-6736"],"names":["JAMA"]}'
```

---

## POST /api/references

通过 OpenAlex 批量解析 DOI，并附带出版方一致性校验。再从短名单中按 ISSN-L → JIF 进行关联，返回参考文献的描述性汇总统计。

- **方法**：`POST`
- **URL**：`/api/references`
- **延迟预算**：60 秒。OpenAlex 查询并发池大小为 6；单个 DOI 请求超时 8 秒，遇到 429 重试一次。
- **CORS 范围**：`POST, OPTIONS`。

### 请求体

```jsonc
{
  "dois": ["10.1056/nejmoa1504720", "10.1016/s0140-6736(15)..."]
}
```

`dois` 会被规范化（转小写、去除 `doi.org/` 前缀）并去重。单次请求最多 50 个 DOI。

### 出版方一致性校验

如果某个 DOI 的前缀指向已知出版方（NEJM、Lancet、JAMA、Nature、Science），但 OpenAlex 返回了不同的载体期刊，则该条目的 `venue/issn/jif` 会被置空，并标记 `warning: 'doi_metadata_mismatch'`。同时 `n_venue_mismatch` 计数加一。

### 响应（200）

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

### 错误

| 状态码 | `error`              |
|--------|----------------------|
| 400    | `no_valid_dois`      |
| 400    | `too_many_dois`      |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/author-features

通过 OpenAlex `/authors?search=`（取相关度最高的第一条结果）解析作者 h-index，并汇总为 FateCore 的作者特征向量。

- **方法**：`POST`
- **URL**：`/api/author-features`
- **延迟预算**：30 秒。并发池大小为 5；单个作者查询超时 8 秒。
- **CORS 范围**：`POST, OPTIONS`。

### 请求体

```jsonc
{ "authors": ["Bernard Zinman", "Christoph Wanner", "..."] }
```

名字会去除首尾空白、合并多余空格并去重。单次请求最多 25 个名字。

### 响应（200）

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

当 `single_author=true` 时，`last_author_h_index` 会被置零，因为单作者论文没有独立的资深作者位（Codex Round 7 规范）。

### 错误

| 状态码 | `error`              |
|--------|----------------------|
| 400    | `no_authors`         |
| 400    | `too_many_authors`   |
| 400    | `invalid_json`       |
| 405    | `method_not_allowed` |

---

## POST /api/telemetry-beacon（内部使用）

极简的一次性 beacon 接收端。事件以 `[telemetry]` 前缀写入 Vercel 日志。无数据库、无第三方分析依赖。

- **方法**：`POST`
- **URL**：`/api/telemetry-beacon`
- **延迟预算**：5 秒。
- **CORS 范围**：`POST, OPTIONS`。
- **请求体上限**：4 KB。
- **用途**：与 `src/lib/telemetry.js` 中的 `trackEvent()` 搭配使用（在浏览器支持时优先使用 `navigator.sendBeacon`）。

### 请求体

```jsonc
{
  "name":       "string (≤64 chars, required)",
  "props":      { /* arbitrary serialisable */ },
  "ts":         1717000000000,
  "url":        "https://paperfate.com/simulator",
  "ua_summary": "Chrome 124"
}
```

### 响应

| 状态码 | 响应体                |
|--------|-----------------------|
| 204    | 空（已接收）          |
| 400    | `invalid_json` / `invalid_shape` |
| 405    | `method_not_allowed`  |
| 413    | `payload_too_large`   |

### 示例

```bash
curl -X POST https://paperfate.com/api/telemetry-beacon \
  -H "Content-Type: application/json" \
  -d '{"name":"forecast_view","props":{"tier":"Q1"},"ts":1717000000000,"url":"https://paperfate.com/","ua_summary":"Chrome"}'
```

---

## 快速参考

| 端点                       | 方法   | 预算   | 备注                              |
|---------------------------|--------|--------|-----------------------------------|
| `/api/forecast`           | POST   | 300 秒 | Q500 + FateCore + journey         |
| `/api/abstract-quality`   | POST   | 60 秒  | 仅 Q100 评分                      |
| `/api/similar`            | POST   | 30 秒  | OpenAlex 双路检索                 |
| `/api/journal-info`       | GET    | 10 秒  | 短名单查询，带缓存                 |
| `/api/journals-search`    | GET    | 10 秒  | 自动补全，档次混排                 |
| `/api/journal-compare`    | POST   | 10 秒  | 单次最多 5 本期刊批量              |
| `/api/references`         | POST   | 60 秒  | 单次最多 50 个 DOI，OpenAlex 解析  |
| `/api/author-features`    | POST   | 30 秒  | 单次最多 25 位作者，h-index 汇总   |
| `/api/telemetry-beacon`   | POST   | 5 秒   | beacon 接收端（内部使用）          |
