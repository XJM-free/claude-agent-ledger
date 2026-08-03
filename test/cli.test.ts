import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json';

const cliPath = fileURLToPath(new URL('../bin/agent-ledger.ts', import.meta.url));

function runCli(args: string[], env: Record<string, string> = {}) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, cliPath, ...args],
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, NO_COLOR: '1', ...env },
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe('CLI metadata flags', () => {
	for (const args of [['--help'], ['-h'], ['help'], ['week', '--help'], ['forecast', '--help']]) {
		test(`${args.join(' ')} prints help and exits successfully`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('Usage:');
			expect(result.stderr).toBe('');
		});
	}

	for (const flag of ['--version', '-v']) {
		test(`${flag} prints the package version`, () => {
			const result = runCli([flag]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.trim()).toBe(packageJson.version);
			expect(result.stderr).toBe('');
		});
	}

	test('an invalid command remains a usage error', () => {
		const result = runCli(['tomorrow']);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('Usage:');
	});
});

describe('forecast CLI', () => {
	test('emits a pure JSON no-activity report from a readable empty source', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-empty-home-'));
		try {
			mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
			const result = runCli(['forecast', '--json', '--plan', 'max'], {
				HOME: home,
				TZ: 'UTC',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe('');
			const report = JSON.parse(result.stdout);
				expect(report).toMatchObject({
				schemaVersion: 1,
				command: 'forecast',
				metric: 'shadow_cost_usd',
				timeZone: 'UTC',
				plan: 'max',
				amountsAreLowerBounds: false,
				basis: {
					calendarDays: 7,
					daysWithActivity: 0,
					assistantTurns: 0,
					dataStatus: 'no-activity',
					shadowCostUsd: 0,
				},
				forecast: {
					calendarDays: 7,
					projectedShadowCostUsd: 0,
				},
				pricing: { status: 'complete' },
				records: { status: 'no-issues-detected' },
			});
			expect(report.basis.daily).toHaveLength(7);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('keeps JSON stdout clean and warns once for an unknown model', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-unknown-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			const unknownTurn = (model: string) =>
				JSON.stringify({
					type: 'assistant',
					timestamp,
					message: { model, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
				});
			writeFileSync(
				join(project, 'forecast-session.jsonl'),
				[
					unknownTurn('claude-future-z'),
					unknownTurn('claude-future-a'),
					unknownTurn('claude-future-z'),
				].join('\n') + '\n',
			);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.basis.dataStatus).toBe('ok');
			expect(report.basis.daysWithActivity).toBe(1);
			expect(report.pricing.unpricedModels).toEqual(['claude-future-a', 'claude-future-z']);
			expect(report.pricing.unpricedAssistantTurns).toBe(3);
			expect(report.amountsAreLowerBounds).toBe(true);
			expect(result.stderr.match(/incomplete cost coverage/g)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails instead of presenting a missing data source as a zero forecast', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-missing-home-'));
		try {
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Claude projects directory is not readable');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails when the projects root is readable but not traversable', () => {
		if (process.getuid?.() === 0) return;
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-mode-home-'));
		const projects = join(home, '.claude', 'projects');
		try {
			mkdirSync(projects, { recursive: true });
			chmodSync(projects, 0o400);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Claude projects directory is not readable');
		} finally {
			chmodSync(projects, 0o700);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails closed when a nested source directory cannot be traversed', () => {
		if (process.getuid?.() === 0) return;
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-nested-mode-home-'));
		const project = join(home, '.claude', 'projects', 'forecast-project');
		try {
			mkdirSync(project, { recursive: true });
			chmodSync(project, 0o400);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('failed to read Claude projects source');
		} finally {
			chmodSync(project, 0o700);
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('fails closed on a nested symbolic link', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-symlink-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			symlinkSync(project, join(project, 'loop'));
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('symbolic link is not allowed');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('reports malformed, missing-timestamp, and invalid-usage records separately', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-damaged-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			writeFileSync(
				join(project, 'damaged.jsonl'),
				[
					JSON.stringify({
						type: 'assistant',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1_000_000, output_tokens: 0 },
						},
					}),
					JSON.stringify({
						type: 'assistant',
						timestamp: '2026-02-30T12:00:00Z',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}),
					JSON.stringify({
						type: 'assistant',
						timestamp: '0',
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1, output_tokens: 1 },
						},
					}),
					'{malformed-json',
					JSON.stringify({
						type: 'assistant',
						timestamp,
						message: {
							model: 'claude-sonnet-4-6',
							usage: { input_tokens: 1 },
						},
					}),
				].join('\n') + '\n',
			);
			const result = runCli(['forecast', '--json'], { HOME: home, TZ: 'UTC' });
			expect(result.exitCode).toBe(0);
			const report = JSON.parse(result.stdout);
			expect(report.amountsAreLowerBounds).toBe(true);
			expect(report.pricing.status).toBe('complete');
			expect(report.records).toEqual({
				status: 'issues-detected',
				malformedJsonLines: 1,
				invalidTimestampTurns: 3,
				invalidUsageTurns: 1,
			});
			expect(report.basis).toMatchObject({
				dataStatus: 'ok',
				assistantTurns: 1,
				daysWithActivity: 1,
				shadowCostUsd: 0,
			});
			expect(result.stderr.match(/incomplete cost coverage/g)).toHaveLength(1);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('renders default text and keeps verbose JSON machine-readable', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-text-home-'));
		try {
			const project = join(home, '.claude', 'projects', 'forecast-project');
			mkdirSync(project, { recursive: true });
			const timestamp = new Date(Date.now() - 36 * 3_600_000).toISOString();
			writeFileSync(
				join(project, 'known.jsonl'),
				JSON.stringify({
					type: 'assistant',
					timestamp,
					message: {
						model: 'claude-sonnet-4-6',
						usage: { input_tokens: 1_000_000, output_tokens: 0 },
					},
				}) + '\n',
			);
			const textResult = runCli(['forecast', '--plan', 'pro'], { HOME: home, TZ: 'UTC' });
			expect(textResult.exitCode).toBe(0);
			expect(textResult.stderr).toBe('');
			expect(textResult.stdout).toContain('agent-ledger forecast');
			expect(textResult.stdout).toContain('pro · shadow-cost equivalent only');

			const jsonResult = runCli(['forecast', '--json', '--plan', 'pro', '--verbose'], {
				HOME: home,
				TZ: 'UTC',
			});
			expect(jsonResult.exitCode).toBe(0);
			expect(JSON.parse(jsonResult.stdout).plan).toBe('pro');
			expect(jsonResult.stderr).toMatch(/parsed 1 candidate turns in \d+ms/);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	for (const args of [
		['forecast', '--md'],
		['forecast', '--summary'],
		['forecast', 'extra'],
		['forecast', '--plan'],
		['forecast', '--plan', 'payg'],
	]) {
		test(`${args.join(' ')} is rejected`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('agent-ledger forecast:');
		});
	}
});
