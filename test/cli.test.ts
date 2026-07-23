import { describe, expect, test } from 'bun:test';
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
