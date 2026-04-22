import type { AggregatedRow, LedgerReport } from './types.ts';

const PAD_LABEL = 22;
const PAD_LABEL_WIDE = 40; // for project paths
const BAR_WIDTH = 40;
const PLAN_MAX_PRICE = 200; // monthly USD reference for shadow-cost leverage

// Detect when we should give labels more room (project paths can be long).
function widestLabel(rows: { subagent: string }[]): number {
	let w = 0;
	for (const r of rows) if (r.subagent.length > w) w = r.subagent.length;
	return w;
}

// Color helpers — TTY-aware, NO_COLOR-respecting (https://no-color.org/).
const USE_COLOR = (() => {
	if (process.env.NO_COLOR) return false;
	if (process.env.FORCE_COLOR) return true;
	return Boolean(process.stdout.isTTY);
})();

const c = {
	dim: USE_COLOR ? '\x1b[2m' : '',
	bold: USE_COLOR ? '\x1b[1m' : '',
	green: USE_COLOR ? '\x1b[32m' : '',
	cyan: USE_COLOR ? '\x1b[36m' : '',
	cyanBright: USE_COLOR ? '\x1b[96m' : '',
	yellow: USE_COLOR ? '\x1b[33m' : '',
	red: USE_COLOR ? '\x1b[31m' : '',
	magenta: USE_COLOR ? '\x1b[35m' : '',
	gray: USE_COLOR ? '\x1b[90m' : '',
	reset: USE_COLOR ? '\x1b[0m' : '',
};

function fmtTokens(n: number): string {
	if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
	return String(n);
}

function fmtUsd(n: number): string {
	return `$${n.toFixed(2)}`;
}

function fmtUsdComma(n: number): string {
	return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function colorCost(n: number, padded: string): string {
	if (!USE_COLOR) return padded;
	if (n >= 1000) return `${c.bold}${c.red}${padded}${c.reset}`;
	if (n >= 100) return `${c.yellow}${padded}${c.reset}`;
	if (n >= 1) return `${c.green}${padded}${c.reset}`;
	return `${c.dim}${padded}${c.reset}`;
}

function pct(part: number, whole: number): string {
	if (whole === 0) return '0%';
	return `${((part / whole) * 100).toFixed(0)}%`;
}

function formatRow(row: AggregatedRow, padWidth: number, isTotal = false): string {
	const labelText = row.subagent.padEnd(padWidth);
	const label = isTotal
		? `${c.bold}${labelText}${c.reset}`
		: `${c.cyan}${labelText}${c.reset}`;
	const sessions = `${c.gray}${String(row.sessionCount).padStart(4)}${c.reset}`;
	const io = `${fmtTokens(row.inputTokens)} / ${fmtTokens(row.outputTokens)}`.padStart(18);
	const cached1h = fmtTokens(row.cacheCreation1hTokens).padStart(7);
	const cached5m = fmtTokens(row.cacheCreation5mTokens).padStart(7);
	const cacheRead = fmtTokens(row.cacheReadTokens).padStart(8);
	const costStr = fmtUsd(row.cost.totalCost).padStart(9);
	const cost = colorCost(row.cost.totalCost, costStr);
	return `  ${label}${sessions}  ${io}  ${c.dim}1h:${c.reset}${cached1h} ${c.dim}5m:${c.reset}${cached5m} ${c.dim}r:${c.reset}${cacheRead}  ${cost}`;
}

// Auto-derived insights. The whole point of installing the tool over /cost.
function deriveInsights(report: LedgerReport): string[] {
	const lines: string[] = [];
	const total = report.total.cost.totalCost;
	if (total === 0) return lines;

	// Top contributor with %
	const top = report.rows[0];
	if (top && top.cost.totalCost > 0) {
		lines.push(
			`  ${c.cyanBright}⚡${c.reset} top: ${c.cyan}${top.subagent}${c.reset} drives ${c.bold}${pct(top.cost.totalCost, total)}${c.reset} of spend  ${c.dim}(${fmtUsd(top.cost.totalCost)} of ${fmtUsd(total)})${c.reset}`,
		);
	}

	// 1h cache call-out (if non-trivial)
	const oneHourCost =
		report.total.cost.cacheCreation1hCost ?? 0;
	if (oneHourCost >= total * 0.05) {
		lines.push(
			`  ${c.yellow}💾${c.reset} 1h cache writes: ${fmtTokens(report.total.cacheCreation1hTokens)} tokens · ${fmtUsd(oneHourCost)} ${c.dim}(${pct(oneHourCost, total)} of total)${c.reset}`,
		);
	}

	// Cache reuse ratio — read vs write
	const writeTokens =
		report.total.cacheCreation1hTokens + report.total.cacheCreation5mTokens;
	if (writeTokens > 0) {
		const ratio = report.total.cacheReadTokens / writeTokens;
		const verdict =
			ratio >= 20
				? `${c.green}excellent reuse${c.reset}`
				: ratio >= 5
					? `${c.yellow}OK reuse${c.reset}`
					: `${c.red}low reuse${c.reset}`;
		lines.push(
			`  ${c.cyanBright}📥${c.reset} cache reuse: ${fmtTokens(report.total.cacheReadTokens)} reads / ${fmtTokens(writeTokens)} writes = ${c.bold}${ratio.toFixed(0)}×${c.reset} ${c.dim}(${verdict}${c.dim})${c.reset}`,
		);
	}

	// Plan leverage
	const dayCount =
		Math.max(
			1,
			Math.round(
				(report.period.to.getTime() - report.period.from.getTime()) /
					(1000 * 60 * 60 * 24),
			),
		);
	const monthlyEquivalent = (total / dayCount) * 30;
	const leverage = monthlyEquivalent / PLAN_MAX_PRICE;
	if (leverage >= 1) {
		lines.push(
			`  ${c.magenta}💸${c.reset} ${fmtUsdComma(monthlyEquivalent)}/mo equivalent  ${c.dim}vs $${PLAN_MAX_PRICE}/mo plan = ${c.reset}${c.bold}${leverage.toFixed(0)}×${c.reset} ${c.dim}leverage${c.reset}`,
		);
	}

	return lines;
}

export function formatTable(report: LedgerReport, label: string, groupName: string = 'subagent'): string {
	const padWidth = Math.max(PAD_LABEL, Math.min(PAD_LABEL_WIDE, widestLabel(report.rows) + 2));
	const summaryLine =
		`${c.gray}${report.period.from.toISOString().slice(0, 10)} → ${report.period.to.toISOString().slice(0, 10)}${c.reset}` +
		`  ${c.dim}·${c.reset}  ` +
		`${c.bold}${fmtUsdComma(report.total.cost.totalCost)}${c.reset} ${c.dim}shadow${c.reset}` +
		`  ${c.dim}·${c.reset}  ${report.total.sessionCount} sessions` +
		`  ${c.dim}·${c.reset}  ${report.rows.length} ${groupName}s`;

	const header = `${c.bold}agent-ledger ${label}${c.reset}  ${summaryLine}`;

	const colsRaw =
		'  ' +
		groupName.padEnd(padWidth) +
		'sess'.padStart(4) +
		'  ' +
		'tokens(in/out)'.padStart(18) +
		'  ' +
		'cache tokens (1h/5m/read)'.padStart(32) +
		'  ' +
		'cost'.padStart(9);
	const cols = `${c.gray}${colsRaw}${c.reset}`;

	const sepRaw = '  ' + '─'.repeat(padWidth + 4 + 2 + 18 + 2 + 32 + 2 + 9);
	const sep = `${c.gray}${sepRaw}${c.reset}`;

	const lines = [
		header,
		'',
		cols,
		sep,
		...report.rows.map((r) => formatRow(r, padWidth)),
		sep,
		formatRow({ ...report.total, subagent: 'total' }, padWidth, true),
	];

	// Server tool footer (only when present, since most rows have 0)
	if (report.total.webSearchRequests + report.total.webFetchRequests > 0) {
		lines.push('');
		lines.push(
			`  ${c.gray}server tools:${c.reset} ` +
				`web_search ×${report.total.webSearchRequests}, ` +
				`web_fetch ×${report.total.webFetchRequests}  ` +
				`(${fmtUsd(report.total.cost.serverToolUseCost)})`,
		);
	}

	// Insights
	const insights = deriveInsights(report);
	if (insights.length) {
		lines.push('');
		lines.push(...insights);
	}

	return lines.join('\n');
}

// Daily trend chart with fixed-width bars.
export function formatTrend(report: LedgerReport, label: string): string {
	const max = report.rows.reduce((m, r) => Math.max(m, r.cost.totalCost), 0);

	const summaryLine =
		`${c.gray}${report.period.from.toISOString().slice(0, 10)} → ${report.period.to.toISOString().slice(0, 10)}${c.reset}` +
		`  ${c.dim}·${c.reset}  ` +
		`${c.bold}${fmtUsdComma(report.total.cost.totalCost)}${c.reset} ${c.dim}shadow${c.reset}` +
		`  ${c.dim}·${c.reset}  ${report.total.sessionCount} sessions across ${report.rows.length} days`;

	const header = `${c.bold}agent-ledger ${label} (daily)${c.reset}  ${summaryLine}`;

	const lines = [header, ''];
	for (const row of report.rows) {
		const bars = Math.round((row.cost.totalCost / Math.max(max, 0.01)) * BAR_WIDTH);
		const barFilled = '█'.repeat(bars);
		const barPadding = ' '.repeat(BAR_WIDTH - bars);
		const bar = `${USE_COLOR ? c.cyanBright : ''}${barFilled}${USE_COLOR ? c.reset : ''}${barPadding}`;
		const dateLabel = `${c.gray}${row.subagent}${c.reset}`;
		const cost = colorCost(row.cost.totalCost, fmtUsd(row.cost.totalCost).padStart(10));
		const sessionsRaw = `${row.sessionCount} sess`;
		const sessions = `${c.dim}·  ${sessionsRaw}${c.reset}`;
		lines.push(`  ${dateLabel}  ${cost}  ${bar}  ${sessions}`);
	}
	const sepWidth = 12 + 2 + 10 + 2 + BAR_WIDTH + 2 + 10;
	lines.push(`  ${c.gray}${'─'.repeat(sepWidth)}${c.reset}`);
	const totalLabel = `${c.bold}total${c.reset}`.padEnd(12 + (USE_COLOR ? c.bold.length + c.reset.length : 0));
	const totalCost = colorCost(
		report.total.cost.totalCost,
		fmtUsd(report.total.cost.totalCost).padStart(10),
	);
	lines.push(`  ${totalLabel}       ${totalCost}`);

	// Daily-mode insights
	const insights = deriveDailyInsights(report);
	if (insights.length) {
		lines.push('');
		lines.push(...insights);
	}

	return lines.join('\n');
}

function deriveDailyInsights(report: LedgerReport): string[] {
	if (report.rows.length === 0) return [];
	const lines: string[] = [];
	const peak = [...report.rows].sort((a, b) => b.cost.totalCost - a.cost.totalCost)[0]!;
	const trough = [...report.rows]
		.filter((r) => r.cost.totalCost > 0)
		.sort((a, b) => a.cost.totalCost - b.cost.totalCost)[0];
	const avg = report.total.cost.totalCost / report.rows.length;

	lines.push(
		`  ${c.cyanBright}⚡${c.reset} peak: ${c.cyan}${peak.subagent}${c.reset} ${c.bold}${fmtUsd(peak.cost.totalCost)}${c.reset} ${c.dim}(${peak.sessionCount} sess)${c.reset}`,
	);
	lines.push(
		`  ${c.gray}📊${c.reset} avg/day: ${fmtUsd(avg)}`,
	);
	if (trough && trough.cost.totalCost > 0) {
		const variance = peak.cost.totalCost / trough.cost.totalCost;
		if (variance >= 3) {
			lines.push(
				`  ${c.yellow}🌪${c.reset} variance: ${c.bold}${variance.toFixed(0)}×${c.reset} ${c.dim}between peak (${peak.subagent}) and trough (${trough.subagent})${c.reset}`,
			);
		}
	}
	return lines;
}

// Single-screen dashboard. Aggregates the same period across 4 dimensions.
export function formatSummary(
	bySubagent: LedgerReport,
	byModel: LedgerReport,
	byDay: LedgerReport,
	byProject: LedgerReport,
	label: string,
): string {
	const total = bySubagent.total.cost.totalCost;
	const dayCount = Math.max(1, byDay.rows.length);
	const monthlyEquivalent = (total / dayCount) * 30;
	const leverage = monthlyEquivalent / PLAN_MAX_PRICE;

	const top = (rows: AggregatedRow[]) => rows[0];
	const tSub = top(bySubagent.rows);
	const tMod = top(byModel.rows);
	const tDay = [...byDay.rows].sort((a, b) => b.cost.totalCost - a.cost.totalCost)[0];
	const tProj = top(byProject.rows);
	// Top 3 projects for quick distribution view
	const topProjects = byProject.rows.slice(0, 3);

	const k = (label: string, value: string) =>
		`  ${c.gray}${label.padEnd(20)}${c.reset}  ${value}`;
	const dollar = (n: number) => `${c.bold}${fmtUsdComma(n)}${c.reset}`;

	const writeTokens =
		bySubagent.total.cacheCreation1hTokens + bySubagent.total.cacheCreation5mTokens;
	const reuseRatio = writeTokens > 0 ? bySubagent.total.cacheReadTokens / writeTokens : 0;

	const lines = [
		`${c.bold}agent-ledger ${label} summary${c.reset}  ${c.gray}${bySubagent.period.from.toISOString().slice(0, 10)} → ${bySubagent.period.to.toISOString().slice(0, 10)}${c.reset}`,
		'',
		k('Shadow cost', dollar(total)),
		k('Sessions', `${bySubagent.total.sessionCount}`),
		k('Projects', `${byProject.rows.length}`),
		k('Plan reference', `$${PLAN_MAX_PRICE}/mo (Max)`),
		k('Multiplier', `${c.bold}${leverage.toFixed(0)}×${c.reset} ${c.dim}vs Max plan${c.reset}`),
		'',
		k('Top subagent', tSub ? `${c.cyan}${tSub.subagent}${c.reset}  ${dollar(tSub.cost.totalCost)} ${c.dim}(${pct(tSub.cost.totalCost, total)})${c.reset}` : '—'),
		k('Top model', tMod ? `${c.cyan}${tMod.subagent}${c.reset}  ${dollar(tMod.cost.totalCost)} ${c.dim}(${pct(tMod.cost.totalCost, total)})${c.reset}` : '—'),
		k('Top project', tProj ? `${c.cyan}${tProj.subagent}${c.reset}  ${dollar(tProj.cost.totalCost)} ${c.dim}(${pct(tProj.cost.totalCost, total)})${c.reset}` : '—'),
		k('Peak day', tDay ? `${c.cyan}${tDay.subagent}${c.reset}  ${dollar(tDay.cost.totalCost)}` : '—'),
	];

	// If multiple projects, list top 3 as a small breakdown
	if (topProjects.length > 1) {
		lines.push('');
		lines.push(`  ${c.gray}Project mix${c.reset}`);
		for (const p of topProjects) {
			lines.push(
				`    ${c.cyan}${p.subagent.padEnd(36)}${c.reset} ${dollar(p.cost.totalCost)} ${c.dim}(${pct(p.cost.totalCost, total)})${c.reset}`,
			);
		}
	}

	lines.push('');
	lines.push(k('Cache 1h writes', `${fmtTokens(bySubagent.total.cacheCreation1hTokens)} tokens · ${fmtUsd(bySubagent.total.cost.cacheCreation1hCost)}`));
	lines.push(k('Cache reads', `${fmtTokens(bySubagent.total.cacheReadTokens)} tokens · ${fmtUsd(bySubagent.total.cost.cacheReadCost)}`));
	lines.push(k(
		'Cache reuse',
		writeTokens > 0
			? `${c.bold}${reuseRatio.toFixed(0)}×${c.reset} ${c.dim}reads/writes${c.reset}`
			: 'n/a',
	));
	lines.push(k(
		'Server tools',
		bySubagent.total.webSearchRequests + bySubagent.total.webFetchRequests > 0
			? `web_search ×${bySubagent.total.webSearchRequests}, web_fetch ×${bySubagent.total.webFetchRequests} (${fmtUsd(bySubagent.total.cost.serverToolUseCost)})`
			: `${c.dim}none${c.reset}`,
	));

	return lines.join('\n');
}

export function formatMarkdown(report: LedgerReport, label: string): string {
	const header = '| group | sessions | input | output | cache 1h | cache 5m | cache read | cost |';
	const sep = '|---|---:|---:|---:|---:|---:|---:|---:|';
	const rows = report.rows.map(
		(r) =>
			`| ${r.subagent} | ${r.sessionCount} | ${fmtTokens(r.inputTokens)} | ${fmtTokens(
				r.outputTokens,
			)} | ${fmtTokens(r.cacheCreation1hTokens)} | ${fmtTokens(r.cacheCreation5mTokens)} | ${fmtTokens(
				r.cacheReadTokens,
			)} | ${fmtUsd(r.cost.totalCost)} |`,
	);
	const totalRow = `| **total** | ${report.total.sessionCount} | ${fmtTokens(
		report.total.inputTokens,
	)} | ${fmtTokens(report.total.outputTokens)} | ${fmtTokens(
		report.total.cacheCreation1hTokens,
	)} | ${fmtTokens(report.total.cacheCreation5mTokens)} | ${fmtTokens(
		report.total.cacheReadTokens,
	)} | **${fmtUsd(report.total.cost.totalCost)}** |`;

	const lines = [
		`# agent-ledger · ${label}`,
		`_${report.period.from.toISOString().slice(0, 10)} → ${report.period.to.toISOString().slice(0, 10)}_`,
		'',
		header,
		sep,
		...rows,
		totalRow,
	];

	if (report.total.webSearchRequests + report.total.webFetchRequests > 0) {
		lines.push('');
		lines.push(
			`_Server tools: web_search ×${report.total.webSearchRequests}, web_fetch ×${report.total.webFetchRequests} (${fmtUsd(report.total.cost.serverToolUseCost)})_`,
		);
	}

	return lines.join('\n');
}
