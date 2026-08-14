import { costForTimestamp } from './pricing.ts';
import type { AggregatedRow, LedgerReport, SessionTurn, SubagentTreeNode } from './types.ts';

const MAIN_AGENT_LABEL = '(main)';
const UNKNOWN_MODEL_LABEL = '(no-model)';
const UNKNOWN_PROJECT_LABEL = '(no-project)';
const UNKNOWN_TOOL_LABEL = '(no-tool)';

export type GroupKey = 'subagent' | 'model' | 'day' | 'project' | 'session' | 'tool';

// Decode Claude Code's project directory name to something readable.
//   "-Users-xiangjie-clawbot" → "~/clawbot"
export function decodeProjectId(encoded: string): string {
	if (!encoded.startsWith('-')) return encoded;
	const parts = encoded.slice(1).split('-');
	if (parts.length >= 3 && parts[0] === 'Users') {
		return '~/' + parts.slice(2).join('-');
	}
	return '/' + parts.join('/');
}

function emptyRow(label: string): AggregatedRow {
	return {
		subagent: label,
		sessionCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheCreation5mTokens: 0,
		cacheCreation1hTokens: 0,
		cacheReadTokens: 0,
		webSearchRequests: 0,
		webFetchRequests: 0,
		cost: {
			inputCost: 0,
			outputCost: 0,
			cacheCreation5mCost: 0,
			cacheCreation1hCost: 0,
			cacheReadCost: 0,
			serverToolUseCost: 0,
			totalCost: 0,
		},
	};
}

function splitCache(turn: SessionTurn): { fiveMin: number; oneHour: number } {
	const usage = turn.usage;
	if (!usage) return { fiveMin: 0, oneHour: 0 };
	if (usage.cache_creation) {
		return {
			fiveMin: usage.cache_creation.ephemeral_5m_input_tokens ?? 0,
			oneHour: usage.cache_creation.ephemeral_1h_input_tokens ?? 0,
		};
	}
	return { fiveMin: usage.cache_creation_input_tokens ?? 0, oneHour: 0 };
}

// Returns the keys this turn contributes to. Most groupings yield a single key,
// but 'tool' yields one key per tool_use block (so a turn that reads + greps
// counts toward both Read and Grep).
function keysOf(turn: SessionTurn, group: GroupKey): string[] {
	if (group === 'model') return [turn.model ?? UNKNOWN_MODEL_LABEL];
	if (group === 'day') return [turn.timestamp.slice(0, 10)];
	if (group === 'project') return [decodeProjectId(turn.projectId ?? UNKNOWN_PROJECT_LABEL)];
	if (group === 'session') return [turn.sessionId.slice(0, 8)];
	if (group === 'tool') {
		// Attribute the assistant turn's cost equally across every tool it invoked.
		// If the turn invoked no tools, attribute to (no-tool).
		return turn.toolUses && turn.toolUses.length > 0 ? turn.toolUses : [UNKNOWN_TOOL_LABEL];
	}
	return [turn.subagentType ?? MAIN_AGENT_LABEL];
}

function sortKey(group: GroupKey): (a: AggregatedRow, b: AggregatedRow) => number {
	if (group === 'day') return (a, b) => (a.subagent < b.subagent ? -1 : a.subagent > b.subagent ? 1 : 0);
	return (a, b) => b.cost.totalCost - a.cost.totalCost;
}

// Streaming aggregator. add() per turn, finalize() at end.
// Suitable for fan-out: one parser stream → N aggregators in parallel.
export class Aggregator {
	private rowsByKey = new Map<string, AggregatedRow>();
	private sessionsByKey = new Map<string, Set<string>>();
	private readonly pricingFallback = new Date();

	constructor(
		private readonly group: GroupKey,
		private readonly from: Date,
		private readonly to: Date,
	) {}

	add(turn: SessionTurn): void {
		if (turn.type !== 'assistant' || !turn.usage) return;

		const cost = costForTimestamp(
			turn.usage,
			turn.model,
			turn.timestamp,
			this.pricingFallback,
		);
		const { fiveMin, oneHour } = splitCache(turn);
		const usage = turn.usage;
		const keys = keysOf(turn, this.group);
		// Distribute the turn's contributions evenly across all keys (relevant only for 'tool').
		const share = 1 / keys.length;

		for (const key of keys) {
			let row = this.rowsByKey.get(key);
			if (!row) {
				row = emptyRow(key);
				this.rowsByKey.set(key, row);
			}
			row.inputTokens += usage.input_tokens * share;
			row.outputTokens += usage.output_tokens * share;
			row.cacheCreation5mTokens += fiveMin * share;
			row.cacheCreation1hTokens += oneHour * share;
			row.cacheReadTokens += (usage.cache_read_input_tokens ?? 0) * share;
			row.webSearchRequests += (usage.server_tool_use?.web_search_requests ?? 0) * share;
			row.webFetchRequests += (usage.server_tool_use?.web_fetch_requests ?? 0) * share;
			row.cost.inputCost += cost.inputCost * share;
			row.cost.outputCost += cost.outputCost * share;
			row.cost.cacheCreation5mCost += cost.cacheCreation5mCost * share;
			row.cost.cacheCreation1hCost += cost.cacheCreation1hCost * share;
			row.cost.cacheReadCost += cost.cacheReadCost * share;
			row.cost.serverToolUseCost += cost.serverToolUseCost * share;
			row.cost.totalCost += cost.totalCost * share;

			let sessions = this.sessionsByKey.get(key);
			if (!sessions) {
				sessions = new Set<string>();
				this.sessionsByKey.set(key, sessions);
			}
			sessions.add(turn.sessionId);
		}
	}

	finalize(): LedgerReport {
		for (const [key, row] of this.rowsByKey) {
			row.sessionCount = this.sessionsByKey.get(key)?.size ?? 0;
		}
		const rows = [...this.rowsByKey.values()].sort(sortKey(this.group));
		const total = rows.reduce<AggregatedRow>((acc, row) => {
			acc.sessionCount += row.sessionCount;
			acc.inputTokens += row.inputTokens;
			acc.outputTokens += row.outputTokens;
			acc.cacheCreation5mTokens += row.cacheCreation5mTokens;
			acc.cacheCreation1hTokens += row.cacheCreation1hTokens;
			acc.cacheReadTokens += row.cacheReadTokens;
			acc.webSearchRequests += row.webSearchRequests;
			acc.webFetchRequests += row.webFetchRequests;
			acc.cost.inputCost += row.cost.inputCost;
			acc.cost.outputCost += row.cost.outputCost;
			acc.cost.cacheCreation5mCost += row.cost.cacheCreation5mCost;
			acc.cost.cacheCreation1hCost += row.cost.cacheCreation1hCost;
			acc.cost.cacheReadCost += row.cost.cacheReadCost;
			acc.cost.serverToolUseCost += row.cost.serverToolUseCost;
			acc.cost.totalCost += row.cost.totalCost;
			return acc;
		}, emptyRow('total'));
		return { period: { from: this.from, to: this.to }, rows, total };
	}
}

// Backwards-compat: the old async function-based API.
export async function aggregate(
	turns: AsyncIterable<SessionTurn>,
	from: Date,
	to: Date,
	group: GroupKey = 'subagent',
): Promise<LedgerReport> {
	const agg = new Aggregator(group, from, to);
	for await (const turn of turns) agg.add(turn);
	return agg.finalize();
}

// MOAT feature: subagent-graph cost attribution.
// Walks every parent session and recursively sums children to produce a tree
// rooted at the orchestrator. Helicone/Langfuse cannot do this — they observe
// API calls, not Claude Code's orchestration tree.
interface SessionAccum {
	sessionId: string;
	label: string;
	selfCost: number;
	turnCount: number;
	parentSessionId?: string | undefined;
}

export class SubagentGraph {
	private accums = new Map<string, SessionAccum>();
	private readonly pricingFallback = new Date();

	add(turn: SessionTurn): void {
		if (turn.type !== 'assistant' || !turn.usage) return;
		const cost = costForTimestamp(
			turn.usage,
			turn.model,
			turn.timestamp,
			this.pricingFallback,
		).totalCost;
		let acc = this.accums.get(turn.sessionId);
		if (!acc) {
			acc = {
				sessionId: turn.sessionId,
				label: turn.subagentType ?? '(orchestrator)',
				selfCost: 0,
				turnCount: 0,
				parentSessionId: turn.parentSessionId,
			};
			this.accums.set(turn.sessionId, acc);
		}
		acc.selfCost += cost;
		acc.turnCount += 1;
		// Children's parentSessionId may not appear until after the parent;
		// keep the earliest non-undefined seen.
		if (turn.parentSessionId && !acc.parentSessionId) {
			acc.parentSessionId = turn.parentSessionId;
		}
	}

	// Build the trees. Each root has parentSessionId === undefined.
	// Returns roots sorted by total cost (descending), top N only by default.
	finalize(topN = 20): SubagentTreeNode[] {
		const childrenOf = new Map<string, string[]>();
		for (const acc of this.accums.values()) {
			if (acc.parentSessionId) {
				const list = childrenOf.get(acc.parentSessionId) ?? [];
				list.push(acc.sessionId);
				childrenOf.set(acc.parentSessionId, list);
			}
		}
		const buildNode = (sessionId: string): SubagentTreeNode => {
			const acc = this.accums.get(sessionId);
			if (!acc) {
				return { sessionId, label: '(missing)', selfCost: 0, totalCost: 0, children: [], turnCount: 0 };
			}
			const childIds = childrenOf.get(sessionId) ?? [];
			const children = childIds.map((id) => buildNode(id));
			children.sort((a, b) => b.totalCost - a.totalCost);
			const childTotal = children.reduce((s, c) => s + c.totalCost, 0);
			return {
				sessionId,
				label: acc.label,
				selfCost: acc.selfCost,
				totalCost: acc.selfCost + childTotal,
				children,
				turnCount: acc.turnCount,
			};
		};
		const roots = [...this.accums.values()]
			.filter((a) => !a.parentSessionId)
			.map((a) => buildNode(a.sessionId))
			.sort((a, b) => b.totalCost - a.totalCost)
			.slice(0, topN);
		return roots;
	}
}
