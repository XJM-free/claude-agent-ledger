// `agent-ledger explain <sessionId>` — root-cause why a session was expensive.
//
// Two-mode design:
// 1. Heuristic mode (always works, no API key): top-3 most expensive turns +
//    tool-call breakdown + cache-reuse stats.
// 2. LLM mode (set ANTHROPIC_API_KEY): pipes the same evidence into
//    Haiku 4.5 for a 4-bullet verdict ("prompt bloat", "Opus mis-selection",
//    "no cache reuse", "tool output overflow"). Costs ~$0.001/run.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { parseFile } from './parser.ts';
import { costFor } from './pricing.ts';
import type { SessionTurn } from './types.ts';

interface TurnAnalysis {
	turnIndex: number;
	timestamp: string;
	model: string | undefined;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreate5m: number;
	cacheCreate1h: number;
	cacheRead: number;
	tools: string[];
}

interface SessionAnalysis {
	sessionId: string;
	subagentType: string | undefined;
	totalCost: number;
	turnCount: number;
	models: Map<string, number>; // model → cost
	tools: Map<string, number>; // tool → invocation count
	cacheReuseRatio: number; // reads / writes
	topTurns: TurnAnalysis[];
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

async function findSessionFile(sessionPrefix: string): Promise<string | undefined> {
	// Sessions are named `<uuid>.jsonl`. Match either full id or 8-char prefix.
	const pattern = new Glob(`**/${sessionPrefix}*.jsonl`);
	for await (const path of pattern.scan({ cwd: CLAUDE_PROJECTS_DIR, absolute: true })) {
		return path;
	}
	return undefined;
}

export async function analyzeSession(sessionPrefix: string): Promise<SessionAnalysis | undefined> {
	const path = await findSessionFile(sessionPrefix);
	if (!path) return undefined;
	const turns: SessionTurn[] = [];
	for await (const t of parseFile(path)) turns.push(t);
	return analyze(turns, sessionPrefix);
}

function analyze(turns: SessionTurn[], sessionPrefix: string): SessionAnalysis {
	const analyses: TurnAnalysis[] = [];
	const models = new Map<string, number>();
	const tools = new Map<string, number>();
	let totalCost = 0;
	let totalCacheRead = 0;
	let totalCacheWrite = 0;
	let subagentType: string | undefined;

	turns.forEach((turn, i) => {
		if (turn.subagentType && !subagentType) subagentType = turn.subagentType;
		if (turn.type !== 'assistant' || !turn.usage) return;
		const c = costFor(turn.usage, turn.model).totalCost;
		totalCost += c;
		const m = turn.model ?? '(no-model)';
		models.set(m, (models.get(m) ?? 0) + c);
		for (const t of turn.toolUses ?? []) {
			tools.set(t, (tools.get(t) ?? 0) + 1);
		}
		const fiveMin = turn.usage.cache_creation?.ephemeral_5m_input_tokens ?? turn.usage.cache_creation_input_tokens ?? 0;
		const oneH = turn.usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
		totalCacheRead += turn.usage.cache_read_input_tokens ?? 0;
		totalCacheWrite += fiveMin + oneH;
		analyses.push({
			turnIndex: i,
			timestamp: turn.timestamp,
			model: turn.model,
			cost: c,
			inputTokens: turn.usage.input_tokens,
			outputTokens: turn.usage.output_tokens,
			cacheCreate5m: fiveMin,
			cacheCreate1h: oneH,
			cacheRead: turn.usage.cache_read_input_tokens ?? 0,
			tools: turn.toolUses ?? [],
		});
	});

	analyses.sort((a, b) => b.cost - a.cost);
	const cacheReuseRatio = totalCacheWrite > 0 ? totalCacheRead / totalCacheWrite : 0;

	return {
		sessionId: sessionPrefix,
		subagentType,
		totalCost,
		turnCount: analyses.length,
		models,
		tools,
		cacheReuseRatio,
		topTurns: analyses.slice(0, 3),
	};
}

const fmtUsd = (n: number): string => '$' + n.toFixed(n < 0.01 ? 4 : 2);
const fmtToken = (n: number): string => {
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return String(Math.round(n));
};

export function formatHeuristic(s: SessionAnalysis): string {
	const lines: string[] = [];
	lines.push(`# Session ${s.sessionId} — heuristic root-cause`);
	lines.push('');
	lines.push(`- Subagent: \`${s.subagentType ?? '(orchestrator)'}\``);
	lines.push(`- Total cost: **${fmtUsd(s.totalCost)}** across ${s.turnCount} assistant turns`);
	lines.push(`- Models used:`);
	[...s.models.entries()]
		.sort((a, b) => b[1] - a[1])
		.forEach(([m, c]) => lines.push(`    - \`${m}\` — ${fmtUsd(c)}`));
	lines.push('');
	lines.push(`## Top tools by invocation count`);
	const topTools = [...s.tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	if (topTools.length === 0) {
		lines.push('  _(no tool_use blocks found in this session)_');
	} else {
		for (const [t, n] of topTools) lines.push(`  - \`${t}\` × ${n}`);
	}
	lines.push('');
	lines.push(`## Top 3 most expensive turns`);
	for (const t of s.topTurns) {
		lines.push(
			`- **Turn ${t.turnIndex}** at ${t.timestamp} — ${fmtUsd(t.cost)}\n  - model: \`${t.model ?? '(no-model)'}\`\n  - input: ${fmtToken(t.inputTokens)}, output: ${fmtToken(t.outputTokens)}, cache 5m: ${fmtToken(t.cacheCreate5m)}, cache 1h: ${fmtToken(t.cacheCreate1h)}, cache read: ${fmtToken(t.cacheRead)}\n  - tools: ${t.tools.join(', ') || '(none)'}`,
		);
	}
	lines.push('');
	lines.push(
		`## Cache reuse — ${s.cacheReuseRatio.toFixed(1)}× (reads/writes)`,
	);
	if (s.cacheReuseRatio < 5) {
		lines.push(
			`  ⚠️  **Below 5×.** This session creates cache faster than it reuses. Consider: shorter system prompt, fewer dynamic context injections per turn.`,
		);
	} else if (s.cacheReuseRatio < 20) {
		lines.push(`  ✅ Acceptable but could be higher. Aim for >20× on long sessions.`);
	} else {
		lines.push(`  ✅ Good — cache is doing its job.`);
	}

	return lines.join('\n');
}

interface AnthropicMsgRes {
	content: Array<{ type: string; text?: string }>;
	usage?: { input_tokens: number; output_tokens: number };
}

export async function llmExplain(s: SessionAnalysis): Promise<string | undefined> {
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) return undefined;
	const evidence = formatHeuristic(s);
	const prompt = `You are a Claude Code cost-optimization expert. A user's session burned ${fmtUsd(s.totalCost)} across ${s.turnCount} turns. Below is the per-turn breakdown:

${evidence}

In ≤4 bullets, identify the SPECIFIC root cause (not generic advice) and ONE concrete action the user can take to cut this session's cost by 50%+. Be terse. Cite turn numbers from the breakdown.`;
	try {
		const res = await fetch('https://api.anthropic.com/v1/messages', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: 'claude-haiku-4-5-20251001',
				max_tokens: 600,
				messages: [{ role: 'user', content: prompt }],
			}),
		});
		if (!res.ok) {
			console.error(`agent-ledger explain: API ${res.status} — falling back to heuristic`);
			return undefined;
		}
		const data = (await res.json()) as AnthropicMsgRes;
		const text = data.content.find((b) => b.type === 'text')?.text;
		if (!text) return undefined;
		const cost = data.usage
			? costFor(
					{ input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
					'claude-haiku-4-5-20251001',
				).totalCost
			: 0;
		return `## LLM root-cause analysis (Haiku 4.5, ${fmtUsd(cost)})\n\n${text.trim()}`;
	} catch (err) {
		console.error('agent-ledger explain: LLM call failed —', err);
		return undefined;
	}
}
