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

function writeExplainSession(
	projectDir: string,
	sessionId: string,
	subagentType: string,
	timestamp = '2026-08-14T00:00:00.000Z',
): string {
	mkdirSync(projectDir, { recursive: true });
	const sessionPath = join(projectDir, `${sessionId}.jsonl`);
	writeFileSync(
		sessionPath,
		JSON.stringify({
			type: 'assistant',
			timestamp,
			subagentType,
			message: {
				model: 'claude-sonnet-4-6',
				usage: { input_tokens: 1_000, output_tokens: 100 },
				content: [{ type: 'tool_use', name: 'Bash', input: {} }],
			},
		}) + '\n',
		'utf8',
	);
	return sessionPath;
}

function withExplainFixture<T>(run: (home: string, sessionPath: string) => T): T {
	const home = mkdtempSync(join(tmpdir(), 'agent-ledger-explain-'));
	const projectDir = join(home, '.claude', 'projects', '-synthetic');
	const sessionPath = writeExplainSession(projectDir, explainSessionId, 'secret-client-agent');
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

	test('ambiguous prefixes are rejected instead of selecting the first session', () => {
		withExplainFixture((home) => {
			const secondSessionId = 'private-session-9b4c';
			const longerSessionId = `${explainSessionId}-longer`;
			writeExplainSession(
				join(home, '.claude', 'projects', '-second-synthetic'),
				secondSessionId,
				'second-secret-agent',
			);
			writeExplainSession(
				join(home, '.claude', 'projects', '-third-synthetic'),
				longerSessionId,
				'third-secret-agent',
			);

			for (const args of [
				['explain', 'private-session'],
				['explain', '--anonymize', 'private-session'],
			]) {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('multiple sessions match the supplied ID');
				expect(result.stderr).toContain('agent-ledger week --by session');
				expect(result.stderr).not.toContain(explainSessionId);
				expect(result.stderr).not.toContain(secondSessionId);
				expect(result.stderr).not.toContain(longerSessionId);
				expect(result.stderr).not.toContain(home);
			}

			const stillAmbiguous = runCli(
				['explain', '--anonymize', 'private-session-8'],
				{ HOME: home, ANTHROPIC_API_KEY: '' },
			);
			expect(stillAmbiguous.exitCode).toBe(1);
			expect(stillAmbiguous.stderr).not.toContain(explainSessionId);

			for (const uniqueId of ['private-session-9', secondSessionId]) {
				const result = runCli(['explain', '--anonymize', uniqueId], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(result.exitCode).toBe(0);
				expect(result.stdout).toContain('# Session sess-A');
				expect(result.stdout).not.toContain(explainSessionId);
				expect(result.stdout).not.toContain(secondSessionId);
				expect(result.stdout).not.toContain(longerSessionId);
				expect(result.stderr).toBe('');
			}

			const exact = runCli(['explain', '--anonymize', explainSessionId], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(exact.exitCode).toBe(0);
			expect(exact.stdout).toContain('secret-client-agent');
			expect(exact.stdout).not.toContain('third-secret-agent');
			expect(exact.stdout).not.toContain(explainSessionId);
			expect(exact.stdout).not.toContain(longerSessionId);
		});
	});

	test('--by session emits collision-safe prefixes that resolve through explain', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-session-labels-'));
		const projectsDir = join(home, '.claude', 'projects');
		const currentTimestamp = new Date(Date.now() - 60_000).toISOString();
		const sessions = [
			{
				id: 'agent-aa-current-one',
				project: '-current-one',
				subagent: 'first-session-agent',
			},
			{
				id: 'agent-aa-current-two',
				project: '-current-two',
				subagent: 'second-session-agent',
			},
		];
		const archivedId = 'agent-aa-current-old';
		try {
			for (const session of sessions) {
				writeExplainSession(
					join(projectsDir, session.project),
					session.id,
					session.subagent,
					currentTimestamp,
				);
			}
			writeExplainSession(
				join(projectsDir, '-archived'),
				archivedId,
				'archived-session-agent',
				'2000-01-01T00:00:00.000Z',
			);

			const result = runCli(['month', '--by', 'session', '--json'], { HOME: home });
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe('');
			const report = JSON.parse(result.stdout) as {
				rows: Array<{ subagent: string; sessionCount: number; inputTokens: number }>;
				total: { sessionCount: number };
			};
			expect(report.rows).toHaveLength(2);
			expect(report.total.sessionCount).toBe(2);

			for (const row of report.rows) {
				expect(row.subagent.length).toBeGreaterThan(8);
				expect(row.sessionCount).toBe(1);
				expect(row.inputTokens).toBe(1_000);
				const session = sessions.find(({ id }) => id.startsWith(row.subagent));
				expect(session).toBeDefined();

				const explained = runCli(['explain', row.subagent, '--anonymize'], {
					HOME: home,
					ANTHROPIC_API_KEY: '',
				});
				expect(explained.exitCode).toBe(0);
				expect(explained.stdout).toContain('# Session sess-A');
				expect(explained.stdout).toContain(session!.subagent);
				expect(explained.stderr).toBe('');
			}

			for (const args of [
				['month', '--by', 'session', '--anonymize'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const anonymized = runCli(args, { HOME: home });
				expect(anonymized.exitCode).toBe(0);
				expect(anonymized.stderr).toBe('');
				expect(anonymized.stdout).toContain('sess-A');
				for (const session of sessions) {
					expect(anonymized.stdout).not.toContain(session.id);
				}
				for (const row of report.rows) {
					expect(anonymized.stdout).not.toContain(row.subagent);
				}
				expect(anonymized.stdout).not.toContain(archivedId);
				expect(anonymized.stdout).not.toContain(home);
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('--by session rejects duplicated full ids without leaking either path', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-duplicate-session-'));
		const duplicateId = 'duplicate-private-session-id';
		const timestamp = new Date(Date.now() - 60_000).toISOString();
		try {
			for (const project of ['-first-private-project', '-second-private-project']) {
				writeExplainSession(
					join(home, '.claude', 'projects', project),
					duplicateId,
					'duplicate-session-agent',
					timestamp,
				);
			}

			for (const args of [
				['month', '--by', 'session'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('duplicate full session IDs');
				expect(result.stderr).not.toContain(duplicateId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('DuplicateSessionIdError');
			}

			for (const args of [
				['explain', duplicateId],
				['explain', duplicateId, '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home, ANTHROPIC_API_KEY: '' });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('multiple local logs use this full session ID');
				expect(result.stderr).not.toContain(duplicateId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('DuplicateSessionFileError');
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('--by session rejects unsafe filename ids without echoing them', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-unsafe-session-'));
		const unsafeId = 'agent_bad-private-session';
		try {
			writeExplainSession(
				join(home, '.claude', 'projects', '-private-project'),
				unsafeId,
				'unsafe-session-agent',
				new Date(Date.now() - 60_000).toISOString(),
			);

			for (const args of [
				['month', '--by', 'session'],
				['month', '--by', 'session', '--json', '--anonymize'],
			]) {
				const result = runCli(args, { HOME: home });
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe('');
				expect(result.stderr).toContain('cannot be labeled safely for explain');
				expect(result.stderr).not.toContain(unsafeId);
				expect(result.stderr).not.toContain(home);
				expect(result.stderr).not.toContain('UnsupportedSessionIdError');
			}
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test('anonymized session reports hide local read failures in text and JSON modes', () => {
		withExplainFixture((home, sessionPath) => {
			chmodSync(sessionPath, 0o000);
			try {
				for (const args of [
					['month', '--by', 'session', '--anonymize'],
					['month', '--by', 'session', '--json', '--anonymize'],
				]) {
					const result = runCli(args, { HOME: home });
					expect(result.exitCode).toBe(1);
					expect(result.stdout).toBe('');
					expect(result.stderr).toContain('unable to inspect local session logs');
					expect(result.stderr).not.toContain(explainSessionId);
					expect(result.stderr).not.toContain(home);
					expect(result.stderr).not.toContain('EACCES');
					expect(result.stderr).not.toContain('error:');
				}
			} finally {
				chmodSync(sessionPath, 0o600);
			}
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

	test('missing projects directory is a privacy-safe no-match', () => {
		const home = mkdtempSync(join(tmpdir(), 'agent-ledger-empty-home-'));
		try {
			const missingId = 'missing-private-session';
			const result = runCli(['explain', missingId, '--anonymize'], {
				HOME: home,
				ANTHROPIC_API_KEY: '',
			});
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toContain('no session found matching the supplied ID');
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
