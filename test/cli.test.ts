import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json';

const cliPath = fileURLToPath(new URL('../bin/agent-ledger.ts', import.meta.url));

function runCli(args: string[]) {
	const result = Bun.spawnSync({
		cmd: [process.execPath, cliPath, ...args],
		stdout: 'pipe',
		stderr: 'pipe',
		env: { ...process.env, NO_COLOR: '1' },
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

async function runCliWithDeadline(args: string[], deadlineMs = 2000) {
	const isolatedHome = mkdtempSync(join(tmpdir(), 'agent-ledger-cli-'));
	mkdirSync(join(isolatedHome, '.claude', 'projects'), { recursive: true });
	try {
		const child = Bun.spawn({
			cmd: [process.execPath, cliPath, ...args],
			stdout: 'pipe',
			stderr: 'pipe',
			env: {
				...process.env,
				HOME: isolatedHome,
				USERPROFILE: isolatedHome,
				NO_COLOR: '1',
			},
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		let timedOut = false;
		const deadline = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, deadlineMs);
		const exitCode = await child.exited;
		clearTimeout(deadline);
		return {
			exitCode,
			stdout: await stdout,
			stderr: await stderr,
			timedOut,
		};
	} finally {
		rmSync(isolatedHome, { recursive: true, force: true });
	}
}

describe('CLI metadata flags', () => {
	for (const args of [
		['--help'],
		['-h'],
		['help'],
		['week', '--help'],
		['watch', '--help'],
		['watch', '-h'],
	]) {
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

describe('watch interval validation', () => {
	test('rejects invalid or overflowing explicit intervals before scanning', async () => {
		const invalidArgs = [
			['watch', ' '],
			['watch', ' 4'],
			['watch', '4 '],
			['watch', 'Infinity'],
			['watch', 'NaN'],
			['watch', '1e309'],
			['watch', '1e3'],
			['watch', '+4'],
			['watch', '0x10'],
			['watch', 'garbage'],
			['watch', '٤'],
			['watch', '0'],
			['watch', '1'],
			['watch', '-1'],
			['watch', '1.5'],
			['watch', '2147483.648'],
			['watch', '2147484'],
			['watch', '9007199254740992'],
			['watch', '--json'],
			['watch', '2', 'extra-private-value'],
		];
		const expectedError =
			'agent-ledger watch: interval must be a decimal integer from 2 to 2147483 seconds\n' +
			'Usage: agent-ledger watch [seconds]\n';

		for (const args of invalidArgs) {
			const result = await runCliWithDeadline(args);
			expect(result.timedOut).toBe(false);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe('');
			expect(result.stderr).toBe(expectedError);
		}
	});

	for (const [label, args, expectedInterval] of [
		['the default', ['watch'], 10],
		['the minimum', ['watch', '2'], 2],
		['the documented example', ['watch', '4'], 4],
		['a leading-zero decimal', ['watch', '0002'], 2],
		['the timer-safe maximum', ['watch', '2147483'], 2_147_483],
	] as const) {
		test(`accepts ${label} interval`, async () => {
			const result = await runCliWithDeadline([...args], 750);
			expect(result.timedOut).toBe(true);
			expect(result.stdout).toContain(`refreshing every ${expectedInterval}s`);
			expect(result.stdout).toContain('today $0.00');
			expect(result.stderr).toBe('');
		});
	}

	test('documents the watch subcommand in help output', () => {
		const result = runCli(['--help']);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			'agent-ledger watch [seconds]                — refresh today\'s cost (2..2147483 seconds; default: 10)',
		);
		expect(result.stderr).toBe('');
	});
});
