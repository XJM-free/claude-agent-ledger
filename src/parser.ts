import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionTurn, TokenUsage } from './types.ts';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export interface ParseOptions {
	from?: Date;
	to?: Date;
	projectsDir?: string;
}

interface LogFile {
	path: string;
	projectId: string;
	subagentType: string | undefined;
}

// Walk the projects directory and yield every JSONL log.
// Real Claude Code layout (as of 2026-04):
//   ~/.claude/projects/<encoded-project>/<session-uuid>.jsonl             (main session)
//   ~/.claude/projects/<encoded-project>/<session-uuid>/subagents/agent-<hash>.jsonl  (subagent)
//   ~/.claude/projects/<encoded-project>/<session-uuid>/subagents/agent-<hash>.meta.json
//
// The .meta.json next to each subagent .jsonl carries { "agentType": "...", "description": "..." }.
// We read it to attribute the subagent by its real name (e.g. "Reality Checker") rather than an opaque hash.
export async function* findSessionLogs(
	projectsDir: string = CLAUDE_PROJECTS_DIR,
): AsyncGenerator<LogFile> {
	let projects: string[] = [];
	try {
		projects = await readdir(projectsDir);
	} catch {
		return;
	}
	for (const project of projects) {
		yield* walkForJsonl(join(projectsDir, project), project);
	}
}

async function* walkForJsonl(dir: string, projectId: string): AsyncGenerator<LogFile> {
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		if (name.startsWith('.') || name === 'memory') continue;
		const full = join(dir, name);
		let isDir = false;
		try {
			isDir = (await stat(full)).isDirectory();
		} catch {
			continue;
		}
		if (isDir) {
			yield* walkForJsonl(full, projectId);
			continue;
		}
		if (name.endsWith('.jsonl')) {
			yield { path: full, projectId, subagentType: await resolveSubagentType(full) };
		}
	}
}

async function resolveSubagentType(jsonlPath: string): Promise<string | undefined> {
	// Subagent logs live under `.../subagents/agent-<hash>.jsonl` with a sibling `.meta.json`.
	if (basename(dirname(jsonlPath)) !== 'subagents') return undefined;
	const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
	try {
		const text = await Bun.file(metaPath).text();
		const meta = JSON.parse(text) as { agentType?: string };
		return meta.agentType;
	} catch {
		return undefined;
	}
}

// Stream-parse one JSONL file. Skips malformed lines rather than aborting.
export async function* parseFile(
	path: string,
	subagentType?: string,
	projectId?: string,
): AsyncGenerator<SessionTurn> {
	const file = Bun.file(path);
	const text = await file.text();
	const sessionId = basename(path).replace('.jsonl', '');

	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		yield extractTurn(obj, sessionId, subagentType, projectId);
	}
}

function extractTurn(
	obj: Record<string, unknown>,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
): SessionTurn {
	const msg = (obj.message ?? {}) as Record<string, unknown>;
	const usage = (msg.usage ?? undefined) as TokenUsage | undefined;
	const model = (msg.model ?? undefined) as string | undefined;
	// If the raw turn carries its own subagentType (our fixture format), prefer it;
	// otherwise fall back to the directory-derived one.
	const perTurnSubagent = ((obj.subagentType as string) ?? undefined) || undefined;
	const perTurnProject = ((obj.projectId as string) ?? undefined) || undefined;

	return {
		type: ((obj.type as string) ?? 'assistant') as SessionTurn['type'],
		timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
		sessionId,
		projectId: perTurnProject ?? projectId,
		subagentType: perTurnSubagent ?? subagentType,
		model,
		usage,
		raw: obj,
	};
}

// Convenience: stream every turn across every log under ~/.claude/projects.
export async function* parseAll(opts: ParseOptions = {}): AsyncGenerator<SessionTurn> {
	const dir = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
	for await (const file of findSessionLogs(dir)) {
		for await (const turn of parseFile(file.path, file.subagentType, file.projectId)) {
			if (opts.from && new Date(turn.timestamp) < opts.from) continue;
			if (opts.to && new Date(turn.timestamp) > opts.to) continue;
			yield turn;
		}
	}
}
