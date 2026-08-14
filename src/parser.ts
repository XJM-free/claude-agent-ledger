import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { SessionTurn, TokenUsage } from './types.ts';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Limit concurrent file reads so we don't exhaust fd on huge setups.
const CONCURRENCY = 8;

export interface ParseOptions {
	from?: Date;
	to?: Date;
	projectsDir?: string;
	onSessionLog?: (sessionId: string) => void;
}

interface LogFile {
	path: string;
	projectId: string;
	subagentType: string | undefined;
	parentSessionId?: string | undefined; // for subagent logs, the parent session
}

export async function* findSessionLogs(
	projectsDir: string = CLAUDE_PROJECTS_DIR,
): AsyncGenerator<LogFile> {
	let projects: string[] = [];
	try {
		projects = await readdir(projectsDir);
	} catch {
		return;
	}
	// Parallelize the project-level walks; collect LogFiles via streaming queue.
	const walkers = projects.map((project) =>
		collectWalk(join(projectsDir, project), project),
	);
	const settled = await Promise.all(walkers);
	for (const list of settled) {
		for (const lf of list) yield lf;
	}
}

async function collectWalk(dir: string, projectId: string): Promise<LogFile[]> {
	const out: LogFile[] = [];
	for await (const lf of walkForJsonl(dir, projectId)) out.push(lf);
	return out;
}

async function* walkForJsonl(dir: string, projectId: string): AsyncGenerator<LogFile> {
	let entries: string[] = [];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	// If this directory IS named 'subagents', its parent session is one level up.
	// e.g. .../<session-uuid>/subagents/agent-XXX.jsonl → parent = <session-uuid>
	const parentSession = basename(dir) === 'subagents' ? basename(dirname(dir)) : undefined;
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
			const subagentType = await resolveSubagentType(full);
			yield {
				path: full,
				projectId,
				subagentType,
				parentSessionId: parentSession,
			};
		}
	}
}

async function resolveSubagentType(jsonlPath: string): Promise<string | undefined> {
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

// Streaming line reader — does NOT buffer the whole file.
// Handles partial lines across chunk boundaries. Skips malformed JSON.
export async function* parseFile(
	path: string,
	subagentType?: string,
	projectId?: string,
	parentSessionId?: string,
): AsyncGenerator<SessionTurn> {
	const sessionId = basename(path).replace('.jsonl', '');
	const stream = Bun.file(path).stream();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let buffer = '';
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) !== -1) {
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			const turn = tryParseLine(line, sessionId, subagentType, projectId, parentSessionId);
			if (turn) yield turn;
		}
	}
	// Flush any trailing partial line.
	buffer += decoder.decode();
	if (buffer.trim()) {
		const turn = tryParseLine(buffer, sessionId, subagentType, projectId, parentSessionId);
		if (turn) yield turn;
	}
}

function tryParseLine(
	line: string,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
): SessionTurn | undefined {
	let obj: Record<string, unknown>;
	try {
		obj = JSON.parse(line);
	} catch {
		return undefined;
	}
	return extractTurn(obj, sessionId, subagentType, projectId, parentSessionId);
}

function extractTurn(
	obj: Record<string, unknown>,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
): SessionTurn {
	const msg = (obj.message ?? {}) as Record<string, unknown>;
	const usage = (msg.usage ?? undefined) as TokenUsage | undefined;
	const model = (msg.model ?? undefined) as string | undefined;
	const perTurnSubagent = ((obj.subagentType as string) ?? undefined) || undefined;
	const perTurnProject = ((obj.projectId as string) ?? undefined) || undefined;
	const perTurnParent = ((obj.parentSessionId as string) ?? undefined) || undefined;

	// Extract tool_use blocks from the assistant message content (if any).
	// Used by the --by tool aggregator and subagent-graph attribution.
	const toolUses: string[] = [];
	const content = msg.content;
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block && typeof block === 'object') {
				const b = block as Record<string, unknown>;
				if (b.type === 'tool_use' && typeof b.name === 'string') {
					toolUses.push(b.name);
				}
			}
		}
	}

	return {
		type: ((obj.type as string) ?? 'assistant') as SessionTurn['type'],
		timestamp: (obj.timestamp as string) ?? new Date().toISOString(),
		sessionId,
		projectId: perTurnProject ?? projectId,
		subagentType: perTurnSubagent ?? subagentType,
		parentSessionId: perTurnParent ?? parentSessionId,
		model,
		usage,
		toolUses: toolUses.length > 0 ? toolUses : undefined,
		raw: obj,
	};
}

// Parallelized, streaming. Does not materialize all turns — caller iterates
// once and dispatches to aggregators. Reads up to CONCURRENCY files at a time.
export async function* parseAll(opts: ParseOptions = {}): AsyncGenerator<SessionTurn> {
	const dir = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
	const files: LogFile[] = [];
	for await (const f of findSessionLogs(dir)) {
		files.push(f);
		opts.onSessionLog?.(basename(f.path, '.jsonl'));
	}

	// Fan out file reads in batches of CONCURRENCY, yield turns in arrival order.
	for (let i = 0; i < files.length; i += CONCURRENCY) {
		const batch = files.slice(i, i + CONCURRENCY);
		const streams = batch.map((f) =>
			collectBatch(parseFile(f.path, f.subagentType, f.projectId, f.parentSessionId), opts),
		);
		const results = await Promise.all(streams);
		for (const turns of results) {
			for (const t of turns) yield t;
		}
	}
}

async function collectBatch(
	gen: AsyncGenerator<SessionTurn>,
	opts: ParseOptions,
): Promise<SessionTurn[]> {
	const out: SessionTurn[] = [];
	for await (const t of gen) {
		if (opts.from && new Date(t.timestamp) < opts.from) continue;
		if (opts.to && new Date(t.timestamp) > opts.to) continue;
		out.push(t);
	}
	return out;
}
