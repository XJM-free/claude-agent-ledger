export type ModelId =
	| 'claude-opus-4-7'
	| 'claude-sonnet-4-6'
	| 'claude-haiku-4-5-20251001'
	| string;

export type TurnType = 'user' | 'assistant' | 'summary' | 'system';

export interface CacheCreationDetail {
	ephemeral_5m_input_tokens?: number;
	ephemeral_1h_input_tokens?: number;
}

export interface ServerToolUse {
	web_search_requests?: number;
	web_fetch_requests?: number;
}

export interface TokenUsage {
	input_tokens: number;
	output_tokens: number;
	// Legacy flat counter. Real logs also carry `cache_creation` with TTL split; if present,
	// prefer that for accurate pricing.
	cache_creation_input_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation?: CacheCreationDetail;
	// Anthropic server-side tool use (web_search, web_fetch). Priced per request, not per token.
	server_tool_use?: ServerToolUse;
}

export interface SessionTurn {
	type: TurnType;
	timestamp: string;
	sessionId: string;
	projectId?: string | undefined;
	subagentType?: string | undefined;
	model?: ModelId | undefined;
	usage?: TokenUsage | undefined;
	raw: unknown;
}

export interface CostBreakdown {
	inputCost: number;
	outputCost: number;
	cacheCreation5mCost: number;
	cacheCreation1hCost: number;
	cacheReadCost: number;
	serverToolUseCost: number;
	totalCost: number;
}

export interface AggregatedRow {
	subagent: string;
	sessionCount: number;
	inputTokens: number;
	outputTokens: number;
	cacheCreation5mTokens: number;
	cacheCreation1hTokens: number;
	cacheReadTokens: number;
	webSearchRequests: number;
	webFetchRequests: number;
	cost: CostBreakdown;
}

export interface LedgerReport {
	period: { from: Date; to: Date };
	rows: AggregatedRow[];
	total: AggregatedRow;
}
