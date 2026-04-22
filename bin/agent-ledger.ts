#!/usr/bin/env bun
import { aggregate, type GroupKey } from '../src/aggregator.ts';
import { formatMarkdown, formatSummary, formatTable, formatTrend } from '../src/format.ts';
import { parseAll } from '../src/parser.ts';
import type { LedgerReport, SessionTurn } from '../src/types.ts';

type Period = 'today' | 'week' | 'month';
type Plan = 'payg' | 'pro' | 'max';

interface Args {
	period: Period;
	markdown: boolean;
	json: boolean;
	plan: Plan;
	by: GroupKey;
	summary: boolean;
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
	console.error(`Usage: agent-ledger <today|week|month> [flags]

Flags:
  --summary                   One-screen dashboard: total + top subagent + top
                              model + peak day + cache reuse + leverage vs $200/mo plan
  --by <subagent|model|day|project|session>
                              Group rows by:
                                subagent  (default) — agent attribution
                                model     — opus vs sonnet vs haiku
                                day       — daily ASCII bar chart
                                project   — by Claude Code project (decoded path)
                                session   — by session id (top spenders)
  --md                        Markdown table output (good for sharing / commits)
  --json                      Raw JSON output (for piping into jq)
  --plan pro|max              Suppress dollar columns (token utilization only)

Environment:
  NO_COLOR=1                  Disable ANSI colors
  FORCE_COLOR=1               Force colors when piping

Examples:
  agent-ledger week --summary           # the dashboard
  agent-ledger week --by day            # daily bar chart
  agent-ledger week --by model          # which Claude model burned the budget
  agent-ledger month --md > month.md
  agent-ledger week --json | jq '.total.cost.totalCost'
`);
	process.exit(1);
}

function parseArgs(argv: string[]): Args {
	const [period, ...rest] = argv;
	if (!period || !['today', 'week', 'month'].includes(period)) usage();

	let plan: Plan = 'payg';
	let by: GroupKey = 'subagent';
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
				next === 'session'
			) {
				by = next;
				i++;
			} else {
				usage();
			}
		}
	}
	return {
		period: period as Period,
		markdown: rest.includes('--md'),
		json: rest.includes('--json'),
		plan,
		by,
		summary: rest.includes('--summary'),
	};
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

// Materialize once so --summary can re-aggregate by 3 dimensions cheaply.
async function collectTurns(opts: { from: Date; to: Date }): Promise<SessionTurn[]> {
	const out: SessionTurn[] = [];
	for await (const t of parseAll(opts)) out.push(t);
	return out;
}

async function* iterTurns(turns: SessionTurn[]): AsyncGenerator<SessionTurn> {
	for (const t of turns) yield t;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const { from, to } = periodRange(args.period);
	const turns = await collectTurns({ from, to });

	if (args.summary) {
		const [bySub, byMod, byDay, byProj] = await Promise.all([
			aggregate(iterTurns(turns), from, to, 'subagent'),
			aggregate(iterTurns(turns), from, to, 'model'),
			aggregate(iterTurns(turns), from, to, 'day'),
			aggregate(iterTurns(turns), from, to, 'project'),
		]);
		console.log(formatSummary(bySub, byMod, byDay, byProj, args.period));
		return;
	}

	let report = await aggregate(iterTurns(turns), from, to, args.by);
	report = planMask(report, args.plan);

	let output: string;
	if (args.json) {
		output = JSON.stringify(report, null, 2);
	} else if (args.markdown) {
		output = formatMarkdown(report, args.period);
	} else if (args.by === 'day') {
		output = formatTrend(report, args.period);
	} else {
		output = formatTable(report, args.period, args.by);
	}
	console.log(output);
}

main().catch((err) => {
	console.error('agent-ledger: fatal error');
	console.error(err);
	process.exit(1);
});
