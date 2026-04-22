# claude-agent-ledger

> See exactly where your Claude Code budget goes — per subagent, per model, per day.

[![npm](https://img.shields.io/npm/v/claude-agent-ledger.svg)](https://www.npmjs.com/package/claude-agent-ledger)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Why

Claude Code's invoice at month-end tells you one number. It doesn't tell you:

- Which of your subagents burned most of it
- Which model (Opus / Sonnet / Haiku) ate the budget
- Which day of last week was the expensive one
- Whether your "cheap" Haiku agent is actually quietly expensive

If you run **one** Claude Code session, this is fine — you already know.
If you run **seven** subagents daily (reliability, release, review, iOS factory, docs, ...), you're flying blind.

`claude-agent-ledger` reads Claude Code's local session logs and gives you a per-subagent ledger. That's it.

## Install

```bash
npm install -g claude-agent-ledger
# or: bun install -g claude-agent-ledger

agent-ledger week --summary        # the dashboard (start here)
agent-ledger week --by model       # which Claude model burned the budget
agent-ledger week --by project     # which project ate your tokens
agent-ledger week --by session     # which single sessions went sideways
agent-ledger week --by day         # daily bar chart with peak/avg/variance
agent-ledger month --md > report.md
```

No server. No account. No data leaves your machine.

## Why this and not `/cost`?

Claude Code's built-in `/cost` shows the **current session** cost. That's it.

`claude-agent-ledger` answers questions `/cost` can't:

- Which of my **10+ subagents** burned the budget? (default)
- Which **Claude model** burned the budget — Opus vs Sonnet vs Haiku? (`--by model`)
- Which **project** in `~/.claude/projects/` ate the tokens? (`--by project`)
- Which **single sessions** went sideways and burned $X? (`--by session`)
- Which **day** of last week was the expensive one? (`--by day`)
- What would my Claude Max usage have cost on **pay-as-you-go**? (the "shadow cost" framing)
- Is my **cache reuse ratio** healthy? (auto-derived insight)
- What's the **leverage** I'm getting from my $200/mo subscription? (e.g. 250×)

Run `agent-ledger week --summary` once and decide.

## Example output (real, from the author's machine)

### `--summary` (the dashboard)

```
agent-ledger week summary  2026-04-15 → 2026-04-22

  Shadow cost           $13,450.05
  Sessions              219
  Projects              9
  Plan reference        $200/mo (Max)
  Multiplier            252× vs Max plan

  Top subagent          (main)            $12,787.19 (95%)
  Top model             claude-opus-4-7   $7,278.87 (54%)
  Top project           ~/clawbot         $6,657.93 (50%)
  Peak day              2026-04-15        $3,679.16

  Project mix
    ~/clawbot                      $6,657.93 (50%)
    ~/clawbot-work                 $4,433.32 (33%)
    ~/ZStack-zstack-workspace      $1,890.02 (14%)

  Cache 1h writes       119.65M tokens · $3589.46
  Cache reads           5.59B tokens · $8236.15
  Cache reuse           38× reads/writes
  Server tools          none
```

### Default — by subagent

```
agent-ledger week · 2026-04-14 → 2026-04-21

  subagent              sess      tokens(in/out)         cache tokens (1h/5m/read)       cost
  ───────────────────────────────────────────────────────────────────────────────────────────
  (main)                  28       514K / 15.87M  1h:116.10M 5m:      0 r:5229.48M  $12524.97
  general-purpose        148         113K / 955K  1h:      0 5m: 20.67M r: 183.94M    $599.97
  Swift Developer         13           4K / 574K  1h:      0 5m:  1.61M r:  47.55M     $28.93
  Market Researcher       10          107K / 74K  1h:      0 5m:   863K r:   8.61M      $7.26
  Explore                 13          176K / 77K  1h:      0 5m:  2.60M r:  22.38M      $6.47
  zstackws                 3           232 / 20K  1h:      0 5m:   829K r:   3.52M      $4.47
  claude-code-guide        1             2K / 2K  1h:      0 5m:    56K r:    223K      $0.08
  ───────────────────────────────────────────────────────────────────────────────────────────
  total                  216       916K / 17.57M  1h:116.10M 5m: 26.62M r:5495.71M  $13172.14
```

### `--by model`

```
  subagent              sess      tokens(in/out)         cache tokens (1h/5m/read)       cost
  ───────────────────────────────────────────────────────────────────────────────────────────
  claude-opus-4-7         16        59K / 8.35M   1h: 61.15M 5m:  2.32M r:2974.59M   $6967.29
  claude-opus-4-6        127       544K / 8.25M   1h: 55.02M 5m: 13.30M r:2422.18M   $6160.46
  claude-sonnet-4-6       65        135K / 946K   1h:      0 5m:  8.81M r:  98.12M     $77.07
  claude-haiku-4-5        13        178K /  67K   1h:      0 5m:  2.19M r:  21.57M      $4.33
```

### `--by day` (ASCII bar chart)

```
  2026-04-15   $3749.84  ████████████████████████████████████ (18 sess)
  2026-04-16   $2492.99  ████████████████████████             (175 sess)
  2026-04-17   $2111.63  ████████████████████                 (9 sess)
  2026-04-18   $1840.02  ██████████████████                   (18 sess)
  2026-04-19    $644.97  ██████                               (5 sess)
  2026-04-20   $1095.58  ███████████                          (6 sess)
  2026-04-21   $1273.55  ████████████                         (9 sess)
```

Yes those are real numbers. Yes it's a lot. See [Shadow cost vs actual bill](#shadow-cost-vs-actual-bill).

## Shadow cost vs actual bill

The `cost` column shows what you **would** pay at Anthropic's pay-as-you-go API rates.

If you're on a fixed-price subscription (Claude Pro / Max / Claude Code plan), your actual bill is capped — the shadow cost is what the same usage **would** have cost through the raw API. Useful for:

- Understanding where time-and-token budget goes, regardless of how you pay
- Spotting runaway agents (a 10× spike is still a 10× spike, capped or not)
- Deciding when to downshift to Haiku or up to Opus per task
- Justifying a Max subscription internally ("our shadow cost is $13K/wk, Max is $200/mo — that's a 65× discount")

If you're on pay-as-you-go, the `cost` column is roughly your bill (±5–10% depending on tier / geography / `server_tool_use` calibration).

## How it works

Claude Code writes every conversation turn to `~/.claude/projects/<encoded-path>/*.jsonl`.
Each turn records input/output tokens, cache tokens (with TTL split), the model used,
and any `server_tool_use` (web_search / web_fetch) requests. Subagent invocations live
under `<session>/subagents/agent-*.jsonl`, with a sidecar `.meta.json` carrying the real
subagent name (e.g. `Reality Checker`, `ios-factory`).

`claude-agent-ledger` walks the tree, resolves subagent types from the sidecar metadata,
and aggregates by your chosen key (subagent, model, or day). Pricing is applied locally
from `src/pricing.ts`. Nothing is sent anywhere — the tool never touches the network
after install.

### Cache accounting

Anthropic's prompt caching has two TTLs in current logs:

| Bucket | Multiplier | Notes |
|---|---|---|
| `ephemeral_5m_input_tokens` | 1.25× base input | 5-minute TTL (default) |
| `ephemeral_1h_input_tokens` | 2.00× base input | 1-hour TTL (long-lived sessions) |
| `cache_read_input_tokens` | 0.10× base input | Read price (90% discount, TTL-agnostic) |

Naive trackers lump these together as "input" and either overstate (by counting all creation as 1.25×) or understate (by ignoring the 1-hour writes entirely). `claude-agent-ledger` breaks them out explicitly — see `src/pricing.ts`.

### Server tool pricing

`web_search_requests` and `web_fetch_requests` are counted at $0.01/request and shown in a footer when present:

```
  server tools: web_search ×7, web_fetch ×0  ($0.07)
```

If Anthropic's actual rate differs (or web_fetch has its own price), open an issue.

## Flags

| Flag | What it does |
|---|---|
| `--summary` | One-screen dashboard with all the headline numbers |
| `--by <subagent\|model\|day\|project\|session>` | Group rows. Default: `subagent`. `day` renders as ASCII bar chart. |
| `--md` | Markdown table output (good for committing or sharing) |
| `--json` | Raw JSON output (pipe into jq) |
| `--plan pro\|max` | Hide dollar columns; show token utilization only |

| Env | What it does |
|---|---|
| `NO_COLOR=1` | Disable ANSI colors |
| `FORCE_COLOR=1` | Force ANSI colors when piping |

## What it's not

- Not a real-time dashboard (post-hoc log reader)
- Not a tracker for direct Anthropic API calls (those logs live server-side)
- Not a cost-limiter or kill-switch (read-only, by design)
- Not affiliated with Anthropic

## Who this is for

- You run ≥ 2 Claude Code subagents and genuinely don't know the per-agent split
- You're on Claude Max and want to know what your "free" usage is worth
- You're building AI Agent systems and want observability primitives, not vendor dashboards

## Status

`v0.2.0` shipped 2026-04-21. Validated on ~200K turns of real Claude Code logs.
Pricing matches Anthropic published rates as of 2026-04-21. Shadow cost values
may drift ±5-10% from Anthropic's actual invoice in edge cases (retries, tier
bumps, `server_tool_use` calibration). Calibration PRs welcome — see issue
templates.

- [x] Log parser (JSONL streaming, recursive subagent discovery)
- [x] Per-subagent aggregation
- [x] Per-model aggregation (`--by model`)
- [x] Per-day aggregation with bar chart (`--by day`)
- [x] Terminal table + Markdown + JSON output
- [x] ANSI color, TTY-aware
- [x] Cache 1h/5m TTL split pricing
- [x] `--plan pro|max` to mask shadow cost
- [x] `server_tool_use` pricing (web_search, web_fetch)
- [ ] Cost forecasting (trailing 7-day burn rate)
- [ ] Calibration against real Anthropic invoices
- [ ] Homebrew tap

## Install from source

```bash
git clone https://github.com/XJM-free/claude-agent-ledger.git
cd claude-agent-ledger
bun install
bun link
agent-ledger today
```

## Development

```bash
bun test           # 22 pass, 0 fail
bun run typecheck
```

## Author

Built by [@XJM-free](https://jiexiang.dev) while running seven production Claude Code
subagents for infrastructure work. More context coming on the blog.

## License

MIT.
