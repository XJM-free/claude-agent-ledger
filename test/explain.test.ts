import { expect, test } from 'bun:test';
import { analyzeTurns, llmExplain } from '../src/explain.ts';
import type { SessionTurn } from '../src/types.ts';

function sonnet5Turn(timestamp: string): SessionTurn {
	return {
		type: 'assistant',
		timestamp,
		sessionId: 'pricing-boundary-session',
		model: 'claude-sonnet-5',
		usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
		raw: {},
	};
}

test('historical explain prices each turn at its own timestamp', () => {
	const analysis = analyzeTurns(
		[
			sonnet5Turn('2026-08-31T23:59:59Z'),
			sonnet5Turn('2026-09-01T00:00:00Z'),
		],
		'pricing-boundary',
	);

	expect(analysis.totalCost).toBe(30);
	expect(analysis.models.get('claude-sonnet-5')).toBe(30);
	expect(analysis.topTurns.map((turn) => turn.cost)).toEqual([18, 12]);
});

test('LLM explain redacts the session identifier before the API request', async () => {
	const originalFetch = globalThis.fetch;
	const originalKey = process.env.ANTHROPIC_API_KEY;
	let requestBody: Record<string, unknown> | undefined;

	process.env.ANTHROPIC_API_KEY = 'test-key';
	globalThis.fetch = (async (_input, init) => {
		requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(
			JSON.stringify({
				content: [{ type: 'text', text: '- Mock verdict' }],
				usage: { input_tokens: 100, output_tokens: 20 },
			}),
			{ status: 200, headers: { 'Content-Type': 'application/json' } },
		);
	}) as typeof fetch;

	try {
		const result = await llmExplain({
			sessionId: 'private-session-123',
			subagentType: 'Reality Checker',
			totalCost: 1.23,
			turnCount: 1,
			models: new Map([['claude-sonnet-4-6', 1.23]]),
			tools: new Map([['Read', 1]]),
			cacheReuseRatio: 10,
			topTurns: [
				{
					turnIndex: 1,
					timestamp: '2026-07-23T00:00:00Z',
					model: 'claude-sonnet-4-6',
					cost: 1.23,
					inputTokens: 100,
					outputTokens: 20,
					cacheCreate5m: 0,
					cacheCreate1h: 0,
					cacheRead: 1000,
					tools: ['Read'],
				},
			],
		});

		const messages = requestBody?.messages as Array<{ content: string }>;
		expect(messages[0]?.content).toContain('Session [redacted]');
		expect(messages[0]?.content).not.toContain('private-session-123');
		expect(result).toContain('Mock verdict');
	} finally {
		globalThis.fetch = originalFetch;
		if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
		else process.env.ANTHROPIC_API_KEY = originalKey;
	}
});
