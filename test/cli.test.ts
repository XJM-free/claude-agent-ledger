import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

const explainSessionId = 'private-session-8f3a';

function withExplainFixture<T>(run: (home: string, sessionPath: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), 'agent-ledger-explain-'));
	const projectDir = join(home, '.claude', 'projects', '-synthetic');
	mkdirSync(projectDir, { recursive: true });
	const sessionPath = join(projectDir, `${explainSessionId}.jsonl`);
	writeFileSync(
		sessionPath,
		JSON.stringify({
			type: 'assistant',
			timestamp: '2026-08-14T00:00:00.000Z',
			subagentType: 'secret-client-agent',
			message: {
				model: 'claude-sonnet-4-6',
				usage: { input_tokens: 1_000, output_tokens: 100 },
				content: [{ type: 'tool_use', name: 'Bash', input: {} }],
			},
		}) + '\n',
		'utf8',
	);
	try {
		return run(home, sessionPath);
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

describe('explain privacy flags', () => {
	test('default output keeps the supplied session identifier', () => {
		withExplainFixture((home) => {
			const result = runCli(['explain', explainSessionId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain(`# Session ${explainSessionId}`);
			expect(result.stderr).toBe('');
		});
	});

	for (const args of [
		['explain', explainSessionId, '--anonymize'],
		['explain', '--anonymize', explainSessionId],
		['explain', '--anonymize', explainSessionId, '--anonymize'],
	]) {
		test(`${args.slice(1).join(' ')} anonymizes local output`, () => {
			withExplainFixture((home) => {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain('# Session sess-A');
				expect(result.stdout).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stdout).toContain('secret-client-agent');
				expect(result.stdout).toContain('Bash');
			});
		});
	}

	test('anonymized lookup failure does not echo the supplied identifier', () => {
		withExplainFixture((home) => {
			const missingId = 'missing-private-session';
			const result = runCli(['explain', '--anonymize', missingId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('no session found matching the supplied ID');
			expect(result.stderr).not.toContain(missingId);
		});
	});

	test('anonymized read failure does not echo paths or session identifiers', () => {
		withExplainFixture((home, sessionPath) => {
			chmodSync(sessionPath, 0o000);
			try {
				const sessionPrefix = 'private-session';
				const result = runCli(['explain', '--anonymize', sessionPrefix], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('unable to inspect local sessions');
				expect(result.stderr).not.toContain(sessionPrefix);
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('EACCES');
			} finally {
				chmodSync(sessionPath, 0o600);
			}
		});
	});

	test('missing projects directory does not leak an anonymized home path', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-empty-home-'));
		try {
			const missingId = 'missing-private-session';
			const result = runCli(['explain', missingId, '--anonymize'], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('unable to inspect local sessions');
			expect(result.stderr).not.toContain(missingId);
			expect(result.stderr).not.toContain(home);
			expect(result.stderr).not.toContain('ENOENT');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('missing session identifier is a usage error', () => {
		const result = runCli(['explain', '--anonymize']);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('missing sessionId argument');
	});

	test('unknown explain flags are rejected', () => {
		const unknownFlag = '--private-secret-flag';
		const result = runCli(['explain', explainSessionId, unknownFlag]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('unsupported flag');
		expect(result.stderr).not.toContain(unknownFlag);
	});

	test('extra explain positional arguments are rejected without echoing them', () => {
		const extra = 'second-private-session';
		const result = runCli(['explain', explainSessionId, extra]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('expected exactly one sessionId argument');
		expect(result.stderr).not.toContain(extra);
	});

	test('glob metacharacters are rejected without being echoed', () => {
		const unsafePrefix = 'private-*';
		const result = runCli(['explain', '--anonymize', unsafePrefix]);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe('');
		expect(result.stderr).toContain('letters, numbers, and hyphens');
		expect(result.stderr).not.toContain(unsafePrefix);
	});

	for (const flag of ['--help', '-h']) {
		test(`explain ${flag} exits successfully`, () => {
			const result = runCli(['explain', flag]);
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain('explain <sessionId> [--anonymize]');
			expect(result.stderr).toBe('');
		});
	}

	for (const args of [
		['explain', '--help', '--private-secret-flag'],
		['explain', explainSessionId, 'extra-private-session', '--help'],
	]) {
		test(`${args.slice(1).join(' ')} does not bypass argument validation`, () => {
			const result = runCli(args);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('Usage:');
			expect(result.stderr).not.toContain('--private-secret-flag');
			expect(result.stderr).not.toContain('extra-private-session');
		});
	}
});
