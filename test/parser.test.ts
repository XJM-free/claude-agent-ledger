import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { aggregate } from '../src/aggregator.ts';
import { parseAll } from '../src/parser.ts';

const PROJECTS_DIR = join(import.meta.dir, 'fixtures', 'projects');

describe('parseAll()', () => {
	test('walks nested subagents/ directories and attributes subagent type', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		const agents = report.rows.map((r) => r.subagent).sort();
		expect(agents).toContain('(main)');
		expect(agents).toContain('Reality Checker');
	});

	test('main-session turns are attributed to (main), not to any subagent', async () => {
		const from = new Date('2026-04-21T00:00:00Z');
		const to = new Date('2026-04-21T23:59:59Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		const main = report.rows.find((r) => r.subagent === '(main)');
		const realityChecker = report.rows.find((r) => r.subagent === 'Reality Checker');

		expect(main).toBeDefined();
		expect(realityChecker).toBeDefined();
		expect(main!.sessionCount).toBe(1);
		expect(realityChecker!.sessionCount).toBe(1);
	});

	test('respects date range filter', async () => {
		const from = new Date('2030-01-01T00:00:00Z');
		const to = new Date('2030-01-02T00:00:00Z');

		const report = await aggregate(
			parseAll({ from, to, projectsDir: PROJECTS_DIR }),
			from,
			to,
		);

		expect(report.rows.length).toBe(0);
	});

	test('reports every session log before filtering turns by date', async () => {
		const discovered: string[] = [];
		for await (const _turn of parseAll({
			from: new Date('2030-01-01T00:00:00Z'),
			to: new Date('2030-01-02T00:00:00Z'),
			projectsDir: PROJECTS_DIR,
			onSessionLog: (sessionId) => discovered.push(sessionId),
		})) {
			// The fixture has no turns in 2030; discovery still covers every log.
		}

		expect(discovered.sort()).toEqual(['agent-deadbeef', 'session-abc']);
	});
});
