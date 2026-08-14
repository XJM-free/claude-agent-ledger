import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function withRootSessions<T>(rootCount: number, run: (home: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), 'agent-ledger-tree-'));
	const projectDir = join(home, '.claude', 'projects', '-synthetic');
	mkdirSync(projectDir, { recursive: true });
	const timestamp = new Date(Date.now() - 1_000).toISOString();
	for (let i = 0; i < rootCount; i++) {
		writeFileSync(
			join(projectDir, `root-${String(i).padStart(2, '0')}.jsonl`),
			JSON.stringify({
				type: 'assistant',
				timestamp,
				subagentType: `root-${String(i).padStart(2, '0')}`,
				message: {
					model: 'claude-sonnet-4-6',
					usage: { input_tokens: 1_000_000, output_tokens: 0 },
					content: [],
				},
			}) + '\n',
			'utf8',
		);
	}
	try {
		return run(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

describe('CLI metadata flags', () => {
	for (const args of [['--help'], ['-h'], ['help'], ['week', '--help']]) {
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

describe('tree accounting', () => {
	test('budget and grand total include roots omitted from the top-20 display', () => {
		withRootSessions(21, (home) => {
			const env = { HOME: home, USERPROFILE: home };
			const result = runCli(['week', '--tree', '--json', '--budget', '61'], env);
			const report = JSON.parse(result.stdout) as {
				roots: unknown[];
				totalCost: number;
			};

			expect(result.exitCode).toBe(2);
			expect(report.roots).toHaveLength(20);
			expect(report.totalCost).toBeCloseTo(63, 6);
			expect(result.stderr).toContain('total $63.00 > budget $61.00');

			const equalBudget = runCli(['week', '--tree', '--json', '--budget', '63'], env);
			expect(equalBudget.exitCode).toBe(0);
			expect(JSON.parse(equalBudget.stdout).totalCost).toBeCloseTo(63, 6);
		});
	});
});
