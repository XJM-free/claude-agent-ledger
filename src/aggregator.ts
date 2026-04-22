import { costFor } from './pricing.ts';
import type { AggregatedRow, LedgerReport, SessionTurn } from './types.ts';

const MAIN_AGENT_LABEL = '(main)';
const UNKNOWN_MODEL_LABEL = '(no-model)';
const UNKNOWN_PROJECT_LABEL = '(no-project)';

export type GroupKey = 'subagent' | 'model' | 'day' | 'project' | 'session';

// Decode Claude Code's project directory name to something readable.
// Encoding rule: absolute path with `/` replaced by `-` (leading `-` for root).
//   "-Users-xiangjie-clawbot"             → "~/clawbot"
//   "-Users-xiangjie-newlive-agent-ledger" → "~/newlive/agent-ledger"  (best-effort; ambiguous on dirs containing '-')
// We special-case the "$HOME" prefix (`-Users-<user>-`) to render `~` and skip the rest of the
// "-" → "/" conversion, since that's the only place we can be sure of segment boundaries.
export function decodeProjectId(encoded: string): string {
	if (!encoded.startsWith('-')) return encoded;
	const parts = encoded.slice(1).split('-'); // drop leading '-'
	// Match common $HOME pattern: ['Users', '<user>', ...rest]
	if (parts.length >= 3 && parts[0] === 'Users') {
		return '~/' + parts.slice(2).join('-');
	}
	// Fallback: just convert all - to /
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

function keyOf(turn: SessionTurn, group: GroupKey): string {
	if (group === 'model') return turn.model ?? UNKNOWN_MODEL_LABEL;
	if (group === 'day') return turn.timestamp.slice(0, 10);
	if (group === 'project') return decodeProjectId(turn.projectId ?? UNKNOWN_PROJECT_LABEL);
	if (group === 'session') return turn.sessionId.slice(0, 8);
	return turn.subagentType ?? MAIN_AGENT_LABEL;
}

function sortKey(group: GroupKey): (a: AggregatedRow, b: AggregatedRow) => number {
	// For day groupings users want chronological; otherwise descend by cost.
	if (group === 'day') return (a, b) => (a.subagent < b.subagent ? -1 : a.subagent > b.subagent ? 1 : 0);
	return (a, b) => b.cost.totalCost - a.cost.totalCost;
}

export async function aggregate(
	turns: AsyncIterable<SessionTurn>,
	from: Date,
	to: Date,
	group: GroupKey = 'subagent',
): Promise<LedgerReport> {
	const rowsByKey = new Map<string, AggregatedRow>();
	const sessionsByKey = new Map<string, Set<string>>();

	for await (const turn of turns) {
		if (turn.type !== 'assistant' || !turn.usage) continue;

		const key = keyOf(turn, group);
		const row = rowsByKey.get(key) ?? emptyRow(key);

		const cost = costFor(turn.usage, turn.model);
		const { fiveMin, oneHour } = splitCache(turn);

		row.inputTokens += turn.usage.input_tokens;
		row.outputTokens += turn.usage.output_tokens;
		row.cacheCreation5mTokens += fiveMin;
		row.cacheCreation1hTokens += oneHour;
		row.cacheReadTokens += turn.usage.cache_read_input_tokens ?? 0;
		row.webSearchRequests += turn.usage.server_tool_use?.web_search_requests ?? 0;
		row.webFetchRequests += turn.usage.server_tool_use?.web_fetch_requests ?? 0;
		row.cost.inputCost += cost.inputCost;
		row.cost.outputCost += cost.outputCost;
		row.cost.cacheCreation5mCost += cost.cacheCreation5mCost;
		row.cost.cacheCreation1hCost += cost.cacheCreation1hCost;
		row.cost.cacheReadCost += cost.cacheReadCost;
		row.cost.serverToolUseCost += cost.serverToolUseCost;
		row.cost.totalCost += cost.totalCost;

		const sessions = sessionsByKey.get(key) ?? new Set<string>();
		sessions.add(turn.sessionId);
		sessionsByKey.set(key, sessions);

		rowsByKey.set(key, row);
	}

	for (const [key, row] of rowsByKey) {
		row.sessionCount = sessionsByKey.get(key)?.size ?? 0;
	}

	const rows = [...rowsByKey.values()].sort(sortKey(group));
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

	return { period: { from, to }, rows, total };
}
