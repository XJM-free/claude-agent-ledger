#!/usr/bin/env bun
import { Aggregator, type GroupKey, SubagentGraph } from '../src/aggregator.ts';
import { analyzeSession, formatHeuristic, llmExplain } from '../src/explain.ts';
import { formatMarkdown, formatSummary, formatTable, formatTrend } from '../src/format.ts';
import { parseAll } from '../src/parser.ts';
import { formatTree, formatTreeMarkdown } from '../src/tree.ts';
import type { LedgerReport } from '../src/types.ts';

type Period = 'today' | 'week' | 'month';
type Plan = 'payg' | 'pro' | 'max';

interface Args {
	period: Period;
	markdown: boolean;
	json: boolean;
	plan: Plan;
	by: GroupKey;
	summary: boolean;
	tree: boolean;
	anonymize: boolean;
	budget?: number; // USD threshold; non-zero exit if exceeded
	verbose: boolean;
}

function periodRange(period: Period): { from: Date; to: Date } {
	const now = new Date();
	const to = new Date(now);
	const from = new Date(now);

	if (period === 'today') {
		from.setHours(0, 0, 0, 0);
	} else if (period === 'week') {
		from.setDate(from.getDate() - 7);
	} else {
		from.setDate(from.getDate() - 30);
	}
	return { from, to };
}

function usage(): never {
	console.error(`Usage:
  agent-ledger <today|week|month> [flags]    — aggregate views
  agent-ledger explain <sessionId>           — root-cause why one session was expensive (new in 0.6)

Flags:
  --summary                   One-screen dashboard (start here).
  --by <subagent|model|day|project|session|tool>
                              Group rows by:
                                subagent  (default) — agent attribution
                                model     — opus vs sonnet vs haiku
                                day       — daily ASCII bar chart
                                project   — by Claude Code project (decoded path)
                                session   — by session id (top spenders)
                                tool      — by Read/Bash/Write/Grep — what your turns burn on
  --tree                      Subagent graph: parent→child cost attribution.
                              The MOAT view: orchestrator → 3×researcher + 6×swift-dev = $312.
  --budget <USD>              Exit non-zero (code 2) if total cost > USD. Pipe-friendly.
  --md                        Markdown table output (good for sharing / commits)
  --json                      Raw JSON output (also works with --summary now)
  --plan pro|max              Suppress dollar columns (token utilization only)
  --anonymize                 Replace project paths and session ids with safe placeholders.
  --verbose                   Print parse stats (files, turns, elapsed) to stderr.

Environment:
  NO_COLOR=1                  Disable ANSI colors
  FORCE_COLOR=1               Force colors when piping

Examples:
  agent-ledger week --summary               # the dashboard
  agent-ledger week --tree                  # subagent fan-out tree
  agent-ledger week --by tool               # which Claude tool ate the budget
  agent-ledger week --json | jq '.total.cost.totalCost'
  agent-ledger today --budget 50            # CI gate: fail if today > $50
`);
	process.exit(1);
}

function parseArgs(argv: string[]): Args {
	const [period, ...rest] = argv;
	if (!period || !['today', 'week', 'month'].includes(period)) usage();

	let plan: Plan = 'payg';
	let by: GroupKey = 'subagent';
	let budget: number | undefined;
	for (let i = 0; i < rest.length; i++) {
		const flag = rest[i];
		if (flag === '--plan') {
			const next = rest[i + 1];
			if (next === 'pro' || next === 'max') {
				plan = next;
				i++;
			} else {
				usage();
			}
		} else if (flag === '--by') {
			const next = rest[i + 1];
			if (
				next === 'subagent' ||
				next === 'model' ||
				next === 'day' ||
				next === 'project' ||
				next === 'session' ||
				next === 'tool'
			) {
				by = next;
				i++;
			} else {
				console.error(`agent-ledger: unknown --by value '${next}'`);
				usage();
			}
		} else if (flag === '--budget') {
			const next = rest[i + 1];
			const n = Number(next);
			if (!Number.isFinite(n) || n <= 0) {
				console.error(`agent-ledger: --budget requires a positive number (got '${next}')`);
				usage();
			}
			budget = n;
			i++;
		}
	}
	return {
		period: period as Period,
		markdown: rest.includes('--md'),
		json: rest.includes('--json'),
		plan,
		by,
		summary: rest.includes('--summary'),
		tree: rest.includes('--tree'),
		anonymize: rest.includes('--anonymize'),
		budget,
		verbose: rest.includes('--verbose'),
	};
}

function anonymizeReport(report: LedgerReport, group: GroupKey): LedgerReport {
	if (group !== 'project' && group !== 'session') return report;
	const prefix = group === 'project' ? '~/repo-' : 'sess-';
	const labelFor = (i: number): string => {
		if (i < 26) return prefix + String.fromCharCode(65 + i);
		return prefix + String.fromCharCode(65 + Math.floor(i / 26) - 1) + String.fromCharCode(65 + (i % 26));
	};
	const newRows = report.rows.map((r, i) => ({ ...r, subagent: labelFor(i) }));
	return { ...report, rows: newRows };
}

function planMask(report: LedgerReport, plan: Plan): LedgerReport {
	if (plan === 'payg') return report;
	const zero = () => ({
		inputCost: 0,
		outputCost: 0,
		cacheCreation5mCost: 0,
		cacheCreation1hCost: 0,
		cacheReadCost: 0,
		serverToolUseCost: 0,
		totalCost: 0,
	});
	return {
		period: report.period,
		rows: report.rows.map((r) => ({ ...r, cost: zero() })),
		total: { ...report.total, cost: zero() },
	};
}

// `--watch` live-tail mode. Re-aggregates "today" every N seconds and
// prints a clean delta meter. Polling-based (no inotify) so it works on
// any platform Bun runs on. Ctrl-C to exit.
async function watchCmd(intervalSec: number): Promise<void> {
	const interval = Math.max(2, intervalSec);
	let prevCost = 0;
	let prevTurnCount = 0;
	const t0 = Date.now();
	console.log(`agent-ledger watch — refreshing every ${interval}s · Ctrl-C to exit`);
	console.log('');
	const tick = async () => {
		const { from, to } = periodRange('today');
		const agg = new Aggregator('subagent', from, to);
		let turns = 0;
		for await (const turn of parseAll({ from, to })) {
			turns++;
			agg.add(turn);
		}
		const report = agg.finalize();
		const cost = report.total.cost.totalCost;
		const dCost = cost - prevCost;
		const dTurns = turns - prevTurnCount;
		const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
		const arrow = dCost > 0 ? '↑' : dCost < 0 ? '↓' : '·';
		const ts = new Date().toISOString().slice(11, 19);
		const top = report.rows[0];
		const topLabel = top ? `top: ${top.subagent} ${fmtUsdInline(top.cost.totalCost)}` : 'no data';
		console.log(
			`[${ts}] today $${cost.toFixed(2)}  ${arrow} +$${dCost.toFixed(2)}  · ${turns} turns (Δ${dTurns}) · ${topLabel} · live ${elapsedMin}m`,
		);
		prevCost = cost;
		prevTurnCount = turns;
	};
	await tick();
	const id = setInterval(() => {
		tick().catch((e) => console.error('watch tick error:', e));
	}, interval * 1000);
	process.on('SIGINT', () => {
		clearInterval(id);
		console.log('\nagent-ledger watch — exiting');
		process.exit(0);
	});
	// Keep process alive
	await new Promise(() => {});
}

const fmtUsdInline = (n: number): string => '$' + n.toFixed(n < 0.01 ? 4 : 2);

async function explainCmd(sessionPrefix: string | undefined): Promise<void> {
	if (!sessionPrefix) {
		console.error('agent-ledger explain: missing sessionId argument');
		console.error('Usage: agent-ledger explain <sessionId>');
		console.error('       (sessionId can be a full uuid or 8-char prefix)');
		process.exit(1);
	}
	const analysis = await analyzeSession(sessionPrefix);
	if (!analysis) {
		console.error(`agent-ledger explain: no session found matching '${sessionPrefix}'`);
		console.error('  (try the 8-char prefix from `agent-ledger week --by session`)');
		process.exit(1);
	}
	const heuristic = formatHeuristic(analysis);
	console.log(heuristic);
	const llm = await llmExplain(analysis);
	if (llm) {
		console.log('');
		console.log(llm);
	} else if (!process.env.ANTHROPIC_API_KEY) {
		console.log('');
		console.log('💡 Set ANTHROPIC_API_KEY to enable LLM root-cause analysis (~$0.001/run via Haiku 4.5)');
	}
}

async function main(): Promise<void> {
	// Subcommand dispatch.
	if (process.argv[2] === 'explain') {
		return explainCmd(process.argv[3]);
	}
	if (process.argv[2] === 'watch') {
		const interval = Number(process.argv[3]) || 10;
		return watchCmd(interval);
	}
	const args = parseArgs(process.argv.slice(2));
	const { from, to } = periodRange(args.period);
	const t0 = Date.now();

	// Determine which aggregators we need based on flags.
	// Single parser pass dispatches to all in parallel — no buffering.
	const aggBySub = new Aggregator('subagent', from, to);
	const aggByMod = args.summary ? new Aggregator('model', from, to) : undefined;
	const aggByDay = args.summary ? new Aggregator('day', from, to) : undefined;
	const aggByProj = args.summary ? new Aggregator('project', from, to) : undefined;
	const aggUser = !args.summary && !args.tree ? new Aggregator(args.by, from, to) : undefined;
	const graph = args.tree ? new SubagentGraph() : undefined;

	let turnCount = 0;
	for await (const turn of parseAll({ from, to })) {
		turnCount++;
		aggBySub.add(turn);
		aggByMod?.add(turn);
		aggByDay?.add(turn);
		aggByProj?.add(turn);
		aggUser?.add(turn);
		graph?.add(turn);
	}

	if (args.verbose) {
		const elapsed = Date.now() - t0;
		console.error(
			`agent-ledger: parsed ${turnCount} turns from ~/.claude/projects in ${elapsed}ms`,
		);
	}

	let totalCost = aggBySub.finalize().total.cost.totalCost;

	if (args.tree) {
		const roots = graph!.finalize(20);
		totalCost = roots.reduce((s, r) => s + r.totalCost, 0);
		const out =
			args.json
				? JSON.stringify({ roots, totalCost }, null, 2)
				: args.markdown
					? formatTreeMarkdown(roots, totalCost)
					: formatTree(roots, totalCost);
		console.log(out);
	} else if (args.summary) {
		const bySubR = aggBySub.finalize();
		const byModR = aggByMod!.finalize();
		const byDayR = aggByDay!.finalize();
		let byProjR = aggByProj!.finalize();
		if (args.anonymize) byProjR = anonymizeReport(byProjR, 'project');
		totalCost = bySubR.total.cost.totalCost;
		if (args.json) {
			console.log(
				JSON.stringify(
					{ subagent: bySubR, model: byModR, day: byDayR, project: byProjR, totalCost },
					null,
					2,
				),
			);
		} else {
			console.log(formatSummary(bySubR, byModR, byDayR, byProjR, args.period));
		}
	} else {
		let report = aggUser!.finalize();
		if (args.anonymize) report = anonymizeReport(report, args.by);
		report = planMask(report, args.plan);
		totalCost = report.total.cost.totalCost;
		const output =
			args.json
				? JSON.stringify(report, null, 2)
				: args.markdown
					? formatMarkdown(report, args.period)
					: args.by === 'day'
						? formatTrend(report, args.period)
						: formatTable(report, args.period, args.by);
		console.log(output);
	}

	// Budget gate — non-zero exit code so this can be a CI/shell hook.
	if (args.budget !== undefined && totalCost > args.budget) {
		console.error(
			`agent-ledger: BUDGET EXCEEDED — total $${totalCost.toFixed(2)} > budget $${args.budget.toFixed(2)}`,
		);
		process.exit(2);
	}
}

main().catch((err) => {
	console.error('agent-ledger: fatal error');
	console.error(err);
	process.exit(1);
});
