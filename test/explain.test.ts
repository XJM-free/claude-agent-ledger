import { expect, test } from 'bun:test';
import { llmExplain } from '../src/explain.ts';

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
