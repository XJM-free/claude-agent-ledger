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

export interface LogFile {
	path: string;
	projectId: string;
	subagentType: string | undefined;
	parentSessionId?: string | undefined; // for subagent logs, the parent session
}

type ReadyOutcome<T> =
	| { index: number; ok: true; result: IteratorResult<T> }
	| { index: number; ok: false; error: unknown };

export async function* findSessionLogs(
	projectsDir: string = CLAUDE_PROJECTS_DIR,
): AsyncGenerator<LogFile> {
	let projects: string[] = [];
	try {
		projects = await readdir(projectsDir);
	} catch {
		return;
	}
	// Parallelize project-level walks, then retain the discovered file metadata.
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

// Yield whichever stream produces a value first. Each iterator has at most one
// in-flight or ready turn, so memory is bounded by the number of active streams
// instead of the number of turns in each stream.
export async function* mergeAsyncIterables<T>(
	streams: AsyncIterable<T>[],
): AsyncGenerator<T> {
	const iterators: AsyncIterator<T>[] = [];
	const finished: boolean[] = [];
	const ready: ReadyOutcome<T>[] = [];
	let resume: (() => void) | undefined;
	let active = 0;

	const enqueue = (outcome: ReadyOutcome<T>): void => {
		ready.push(outcome);
		const wake = resume;
		resume = undefined;
		wake?.();
	};

	const schedule = (index: number): void => {
		const iterator = iterators[index];
		if (!iterator) return;
		try {
			void iterator.next().then(
				(result) => enqueue({ index, ok: true, result }),
				(error: unknown) => enqueue({ index, ok: false, error }),
			);
		} catch (error) {
			enqueue({ index, ok: false, error });
		}
	};

	const nextReady = async (): Promise<ReadyOutcome<T> | undefined> => {
		while (ready.length === 0 && active > 0) {
			await new Promise<void>((resolve) => {
				resume = resolve;
			});
		}
		return ready.shift();
	};

	try {
		// Acquire every iterator before starting reads. If a later factory throws,
		// no earlier source has an in-flight next() that could prevent cleanup.
		for (const stream of streams) {
			iterators.push(stream[Symbol.asyncIterator]());
			finished.push(false);
		}
		active = iterators.length;
		for (let index = 0; index < iterators.length; index++) schedule(index);

		while (active > 0) {
			const outcome = await nextReady();
			if (!outcome) continue;
			const { index } = outcome;
			if (!outcome.ok) throw outcome.error;
			const { result } = outcome;
			if (result.done) {
				finished[index] = true;
				active--;
				continue;
			}
			schedule(index);
			yield result.value;
		}
	} finally {
		// AsyncIterator.return() cannot interrupt every outstanding next() (an
		// async generator may queue it behind a blocked read). Request cleanup,
		// but do not make consumer cancellation wait on an uncooperative source.
		for (let index = 0; index < iterators.length; index++) {
			if (finished[index]) continue;
			const iterator = iterators[index];
			if (!iterator) continue;
			try {
				void iterator.return?.().catch(() => undefined);
			} catch {
				// Cleanup is best-effort after completion, cancellation, or an error.
			}
		}
	}
}

async function* filterByRange(
	turns: AsyncIterable<SessionTurn>,
	opts: ParseOptions,
): AsyncGenerator<SessionTurn> {
	for await (const turn of turns) {
		if (opts.from && new Date(turn.timestamp) < opts.from) continue;
		if (opts.to && new Date(turn.timestamp) > opts.to) continue;
		yield turn;
	}
}

type LogReader = typeof parseFile;

export async function* streamLogFiles(
	files: LogFile[],
	opts: ParseOptions = {},
	readLog: LogReader = parseFile,
): AsyncGenerator<SessionTurn> {
	// Fan out file reads in batches of CONCURRENCY and merge them with one
	// in-flight or ready turn per file.
	for (let i = 0; i < files.length; i += CONCURRENCY) {
		const batch = files.slice(i, i + CONCURRENCY);
		const streams = batch.map((file) =>
			filterByRange(
				readLog(file.path, file.subagentType, file.projectId, file.parentSessionId),
				opts,
			),
		);
		yield* mergeAsyncIterables(streams);
	}
}

// Parallelized, streaming. Does not materialize all turns — caller iterates
// once and dispatches to aggregators. Reads up to CONCURRENCY files at a time.
export async function* parseAll(opts: ParseOptions = {}): AsyncGenerator<SessionTurn> {
	const dir = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
	const files: LogFile[] = [];
	for await (const file of findSessionLogs(dir)) {
		files.push(file);
		opts.onSessionLog?.(basename(file.path, '.jsonl'));
	}
	yield* streamLogFiles(files, opts);
}
