# agent-ledger

> See exactly where your Claude Code budget goes — per subagent, per task, per day.

[![status](https://img.shields.io/badge/status-pre--alpha-orange)](#status)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Why

Claude Code's invoice at month-end tells you one number. It doesn't tell you:

- Which of your subagents burned most of it
- Which tasks cost $5 and which cost $0.05
- Whether last week's refactor was 10× more expensive than it should have been
- Whether your "cheap" Haiku agent is actually quietly expensive

If you run **one** Claude Code session, this is fine — you already know.
If you run **seven** subagents daily (reliability, release, review, iOS factory, docs, ...), you're flying blind.

`agent-ledger` reads Claude Code's local session logs and gives you a per-subagent ledger. That's it.

## What it is

A single-file CLI. No server. No account. No data leaves your machine.

```bash
# Install
npm install -g claude-agent-ledger
# or: bun install -g claude-agent-ledger

# Today's spend, grouped by subagent
agent-ledger today

# Last 7 days
agent-ledger week

# Last 30 days + markdown export
agent-ledger month --md > month-report.md
```

## Example output

```
agent-ledger week · 2026-04-14 → 2026-04-21

  subagent              sess      tokens(in/out)          cache tokens (1h/5m/read)        cost
  ────────────────────────────────────────────────────────────────────────────────────────────
  (main)                  27       513K / 15.15M   1h:111.06M 5m:     0  r:4892.68M  $11814.53
  general-purpose        145         112K / 876K   1h:     0  5m:19.47M  r: 168.34M    $548.25
  Swift Developer         13           4K / 574K   1h:     0  5m: 1.61M  r:  47.55M     $28.93
  Market Researcher       10          107K / 74K   1h:     0  5m:  863K  r:   8.61M      $7.26
  Explore                 13          176K / 77K   1h:     0  5m: 2.60M  r:  22.38M      $6.47
  zstackws                 3           232 / 20K   1h:     0  5m:  829K  r:   3.52M      $4.47
  claude-code-guide        1             2K / 2K   1h:     0  5m:   56K  r:    223K      $0.08
  ────────────────────────────────────────────────────────────────────────────────────────────
  total                  212        915K / 16.77M  1h:111.06M 5m:25.43M  r:5143.30M  $12409.98
```

Yes those are real numbers. Yes it's a lot. See [Shadow cost vs actual bill](#shadow-cost-vs-actual-bill).

## Shadow cost vs actual bill

The `cost` column shows what you **would** pay at Anthropic's pay-as-you-go API rates.

If you're on a fixed-price subscription (Claude Pro / Max / Claude Code plan), your actual bill is capped — the shadow cost is what the same usage **would** have cost through the raw API. It's useful for:

- Understanding where time-and-token budget goes, regardless of how you pay
- Spotting runaway agents (a 10× spike is still a 10× spike, capped or not)
- Deciding when to downshift to Haiku or up to Opus per task

If you're on pay-as-you-go, the `cost` column is roughly your bill (±5% depending on tier / geography).

## How it works

Claude Code writes every conversation turn to `~/.claude/projects/<encoded-path>/*.jsonl`.
Each turn records input/output tokens, cache tokens (with TTL split), and the model used.
Subagent invocations live under a nested `<session>/subagents/agent-*.jsonl`, with a sidecar
`.meta.json` that carries the real subagent name (e.g. `Reality Checker`, `ios-factory`).

`agent-ledger` walks the tree, resolves subagent types from the sidecar metadata, and
aggregates by subagent. Pricing is applied locally from `src/pricing.ts`. Nothing is sent
anywhere — the tool never touches the network after install.

### Cache accounting

Anthropic's prompt caching has two TTLs in current logs:

| Bucket | Multiplier | Notes |
|---|---|---|
| `ephemeral_5m_input_tokens` | 1.25× base input | 5-minute TTL (default) |
| `ephemeral_1h_input_tokens` | 2.00× base input | 1-hour TTL (long-lived sessions) |
| `cache_read_input_tokens` | 0.10× base input | Read price (90% discount, TTL-agnostic) |

Naive trackers lump these together as "input" and either overstate (by counting all creation as 1.25×) or understate (by ignoring the 1-hour writes entirely). `agent-ledger` breaks them out explicitly — see `src/pricing.ts`.

## What it's not

- Not a real-time dashboard (post-hoc log reader)
- Not a tracker for direct Anthropic API calls (those logs live elsewhere)
- Not a cost-limiter or kill-switch (read-only, by design)
- Not affiliated with Anthropic

## Who this is for

- You run ≥ 2 Claude Code subagents and genuinely don't know the per-agent split
- You're about to have a "wait, I spent *what*?" moment at invoice time
- You're building AI Agent systems and want observability primitives, not vendor dashboards

## Status

Pre-alpha. Validated on ~200K turns of real Claude Code logs on the author's machine.
Pricing model matches Anthropic published rates as of 2026-04-21. Shadow cost values
may drift ±5-10% from Anthropic's actual invoice in edge cases (retries, tier bumps,
server_tool_use which is not yet accounted for).

- [x] Log parser (JSONL streaming, recursive subagent discovery)
- [x] Per-subagent aggregation (from `<session>/subagents/*.meta.json`)
- [x] Terminal table output
- [x] Markdown export (`--md`)
- [x] Cache 1h/5m TTL split pricing
- [ ] `--plan pro|max` mode (mask shadow cost, show utilization only)
- [ ] `--json` output mode
- [ ] Per-model breakdown (`agent-ledger week --by model`)
- [ ] Cost forecasting (trailing 7-day burn rate)
- [ ] `server_tool_use` pricing (web search, file fetch)
- [ ] Homebrew tap

First tagged release: **2026-05-05**.

## Install from source

```bash
git clone https://github.com/XJM-free/agent-ledger.git
cd agent-ledger
bun install
bun link
agent-ledger today
```

## Development

```bash
bun test
bun run typecheck
```

## Author

Built by [@XJM-free](https://jiexiang.dev) while running seven production Claude Code
subagents for infrastructure work. More context: [How I run 7 production AI agents with
Claude Code](https://jiexiang.dev).

## License

MIT.
