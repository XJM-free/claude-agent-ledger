# Contributing

Thanks for looking. This project is pre-alpha and in active shape — I'm still learning
what people actually need from a Claude Code ledger.

## Quick help

The most useful contributions right now:

1. **Run it on your own logs and tell me what it got wrong.** Open an issue with
   the shadow cost number `agent-ledger month` reports, and the actual Anthropic
   invoice if you're on pay-as-you-go. I want to calibrate.
2. **Add a model I missed.** `src/pricing.ts` has the table. Open a PR with the
   model ID and the published rates, plus a test in `test/pricing.test.ts`.
3. **Report a log format surprise.** If `agent-ledger` skips usage records or
   attributes them to `(main)` when they should be a subagent, paste a redacted
   log snippet into an issue.

## Running locally

```bash
bun install
bun test
bun run typecheck
bun run build
bun run bin/agent-ledger.ts today
```

## Style

- TypeScript strict. `noUncheckedIndexedAccess` is on.
- Short functions. If a function needs a comment to explain what it does, the
  function is probably doing too much.
- No runtime dependencies except Bun built-ins (we want a small install surface).
- Tests use `bun:test`. Fixtures live in `test/fixtures/`.

## Out of scope (for now)

- Real-time dashboards / web UIs
- Sending data anywhere (the tool is read-only by design)
- Tracking API keys or authenticating to Anthropic

If you want those, that's a different tool — and that's fine, just not this one.
