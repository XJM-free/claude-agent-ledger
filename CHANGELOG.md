# Changelog

All notable changes to `claude-agent-ledger` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-04-23

### Added — `agent-ledger explain <sessionId>` (the LLM-native move)

A new subcommand that answers **"why was this single session expensive?"**
This is the question Helicone / Langfuse / OpenLLMetry physically cannot
answer — they observe API calls, not Claude Code's prompts and tool calls.

Two modes:

- **Heuristic mode** (default, no API key needed) — analyzes the session
  JSONL and prints:
  - Subagent + total cost + turn count
  - Model breakdown (which model dominated)
  - Tool invocation count (Read/Bash/Grep/Edit/MCP — top 8)
  - Top 3 most expensive turns with full token + tool breakdown
  - Cache reuse ratio + verdict (`<5×` warning, `>20×` good)

- **LLM mode** (set `ANTHROPIC_API_KEY`) — pipes the heuristic evidence into
  Haiku 4.5 with a tightly-scoped prompt: "identify the SPECIFIC root cause
  + ONE concrete action to cut this session's cost by 50%+." Costs about
  $0.001/run. Cite turn numbers from the breakdown.

```bash
agent-ledger explain 63063a38
agent-ledger explain b988bd89-803a-4c78    # full uuid or 8-char prefix both work
```

## [0.5.0] — 2026-04-23

### Added — performance + production-readiness foundation

- **Streaming JSONL parser** — replaces `await file.text()` (which OOM'd on
  10GB+ logs). Now reads via `Bun.file().stream()` + `TextDecoder` line-by-line.
  Memory profile is constant regardless of log size.
- **Concurrent file walk** — `findSessionLogs` parallelizes per-project
  `readdir` (`Promise.all`), and `parseAll` reads up to 8 JSONL files
  concurrently. ~5–10× cold-start speedup on multi-project setups.
- **Zero materialization** — bin no longer collects every turn into an array
  before aggregating. Instead one parser stream fans out to N `Aggregator`
  instances in parallel. Memory is now O(unique-keys) not O(turns).
- **`--by tool`** — new GroupKey. Attribute spend per tool call (`Read`,
  `Bash`, `Grep`, `Write`, MCP tool names). Answers "which tool is eating my
  budget" — the most actionable lens for a Claude Code user.
- **`--tree` (the MOAT)** — subagent-graph cost attribution. Walks the
  parent→child orchestration tree and shows
  `orchestrator → 3×researcher + 6×swift-dev = $312`. Helicone / Langfuse /
  OpenLLMetry can't do this — they observe API calls, not Claude Code's
  multi-agent runtime.
- **`--budget <USD>`** — exit code `2` if total cost exceeds budget. Wire it
  into your CI / shell startup / `pre-commit` to gate spend.
- **`--json` works for `--summary`** — previously summary was text-only.
  Now pipe-friendly: `agent-ledger week --summary --json | jq`.
- **`--verbose`** — print parse stats (turns / elapsed) to stderr.

### Changed

- `Aggregator` is now a class (`add()` / `finalize()`) instead of an async
  function. Enables single-pass fan-out and live-tail in v0.6.
- `parseAll` and `parseFile` no longer block on full file reads.
- `SessionTurn` adds `parentSessionId` and `toolUses[]` fields.

### Internal

- Backwards-compatible: the old `aggregate(turns, from, to, group)` async
  function still exists and wraps the new `Aggregator` class. All v0.4.x
  tests pass without modification (22/22).

## [0.4.1] — 2026-04-22

### Added
- `--anonymize` flag — replaces project paths with `~/repo-A`, `~/repo-B`,
  ... and session ids with `sess-A`, `sess-B`, ... ordered by spend descending.
  Use this when you want to share your output publicly (HN / Bluesky /
  presentation) without leaking employer names or internal repo names.
  Subagent / model / day labels stay untouched (those are public info).

## [0.4.0] — 2026-04-22

### Added
- `--by project` — group spend by Claude Code project directory.
  Decodes `~/.claude/projects/-Users-xiangjie-clawbot` → `~/clawbot` so you can
  see which project is burning budget.
- `--by session` — group by session ID. Surfaces the single most expensive
  conversations (useful for hunting the one that went sideways).
- Summary dashboard now shows:
  - `Projects` count
  - `Top project` line
  - `Project mix` block — top 3 projects with $ and %
- `decodeProjectId()` exported for reuse. Special-cases the `~/` home prefix,
  falls back to slash-joined path for other roots.
- Row label column now auto-widens up to 40 chars for project paths.

### Changed
- `formatTable` takes an optional `groupName` arg so the header column matches
  the group (e.g. "project", "session").

## [0.3.0] — 2026-04-22

### Added
- `--summary` flag — single-screen dashboard with shadow cost, top subagent /
  model / day, cache reuse ratio, and **leverage vs $200/mo Max plan**.
  This is the killer view for "why install over /cost?"
- Auto-derived insights footer on the default table:
  - Top contributor with %
  - 1h cache spend call-out (when ≥5% of total)
  - Cache reuse ratio (read/write) with verdict
  - Monthly $ equivalent + leverage vs Max plan
- Daily-mode insights: peak day, avg/day, peak/trough variance

### Changed
- `--by day` polish:
  - Bar fixed to 40-char width so session counts align in their own column
  - Brighter cyan (`\x1b[96m`) bar character
  - Total row separated by horizontal rule, properly aligned
- Header line now shows period + total + sessions + group count at a glance:
  `agent-ledger week  2026-04-15 → 2026-04-22  ·  $13,356.27 shadow  ·  217 sessions  ·  7 agents`

## [0.2.0] — 2026-04-21

### Added
- `--by <subagent|model|day>` flag — group rows by subagent (default), by
  Claude model, or by date. The `day` mode renders an ASCII bar chart of
  daily spend, useful for spotting "expensive Tuesdays."
- Server-tool pricing: `web_search_requests` and `web_fetch_requests` from
  the `server_tool_use` block are now counted at $0.01/request and surface
  in a footer row when present.
- ANSI color output, TTY-aware (NO_COLOR / FORCE_COLOR respected).
  - Subagent / model / day labels in cyan
  - Cost amounts color-coded by magnitude (red ≥$1000, yellow ≥$100,
    green ≥$1, dim <$1)
  - Total row bolded
- New tests for server-tool pricing, `--by model`, and `--by day`
  (22 tests, up from 17).

### Changed
- `aggregate(turns, from, to)` accepts an optional 4th arg `group: GroupKey`
  (`'subagent' | 'model' | 'day'`). Default behavior unchanged.
- `AggregatedRow` now carries `webSearchRequests` and `webFetchRequests`
  counters; `CostBreakdown` adds `serverToolUseCost`.

### Not yet
- Calibration against real Anthropic invoices (need volunteers — see
  `.github/ISSUE_TEMPLATE/`)
- Cost forecasting (trailing 7-day burn rate)
- Homebrew tap

## [0.1.0] — 2026-04-21

Initial public release.

### Added
- JSONL parser with recursive walk of `~/.claude/projects/**`, including nested
  `subagents/` directories
- Per-subagent attribution via sidecar `agent-<hash>.meta.json` files
- Pricing with cache TTL split: `ephemeral_5m_input_tokens` (1.25×) vs
  `ephemeral_1h_input_tokens` (2×)
- Terminal table output (default) and Markdown export (`--md`)
- JSON output (`--json`) for piping into other tools
- `--plan pro|max` to suppress dollar columns on fixed-price subscriptions
- Support for current and prior-generation model IDs (Opus 4.6/4.7,
  Sonnet 4.5/4.6, Haiku 4.0/4.5)
- Family-prefix fallback for unknown future models (e.g. `claude-opus-5-*`
  resolves to Opus pricing)
- `<synthetic>` turns (Claude Code context compaction) correctly priced at $0
- Published to npm as `claude-agent-ledger`
