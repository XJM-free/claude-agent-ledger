import { readdir, realpath, stat } from 'node:fs/promises';
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
	onSkippedRecord?: (reason: string) => void;
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
	for await (const lf of walkForJsonl(dir, projectId, new Set())) out.push(lf);
	return out;
}

async function* walkForJsonl(dir: string, projectId: string, visited: Set<string>): AsyncGenerator<LogFile> {
	let entries: string[] = [];
	try {
		const canonical = await realpath(dir);
		if (visited.has(canonical)) return;
		visited.add(canonical);
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
			yield* walkForJsonl(full, projectId, visited);
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
	onSkippedRecord?: (reason: string) => void,
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
			const turn = tryParseLine(line, sessionId, subagentType, projectId, parentSessionId, onSkippedRecord);
			if (turn) yield turn;
		}
	}
	// Flush any trailing partial line.
	buffer += decoder.decode();
	if (buffer.trim()) {
		const turn = tryParseLine(buffer, sessionId, subagentType, projectId, parentSessionId, onSkippedRecord);
		if (turn) yield turn;
	}
}

function tryParseLine(
	line: string,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
	onSkippedRecord?: (reason: string) => void,
): SessionTurn | undefined {
	let obj: unknown;
	try {
		obj = JSON.parse(line);
	} catch {
		onSkippedRecord?.('invalid_json');
		return undefined;
	}
	if (!isRecord(obj)) {
		onSkippedRecord?.('invalid_record');
		return undefined;
	}
	const msg = isRecord(obj.message) ? obj.message : {};
	const type = obj.type ?? msg.role;
	if (typeof type !== 'string' || !['assistant', 'user', 'summary', 'system'].includes(type)) return undefined;
	if (typeof obj.timestamp !== 'string' || !Number.isFinite(Date.parse(obj.timestamp))) {
		onSkippedRecord?.('invalid_timestamp');
		return undefined;
	}
	if (msg.model !== undefined && typeof msg.model !== 'string') {
		onSkippedRecord?.('invalid_model');
		return undefined;
	}
	if (msg.usage !== undefined && !validUsage(msg.usage)) {
		onSkippedRecord?.('invalid_usage');
		return undefined;
	}
	return extractTurn(obj, sessionId, subagentType, projectId, parentSessionId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCounters(value: Record<string, unknown>, keys: string[]): boolean {
	return keys.every((key) => value[key] === undefined || (
		typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0
	));
}

function validUsage(value: unknown): value is TokenUsage {
	if (!isRecord(value) || !validCounters(value, [
		'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
	])) return false;
	for (const [field, keys] of [
		['cache_creation', ['ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens']],
		['server_tool_use', ['web_search_requests', 'web_fetch_requests']],
	] as const) {
		const detail = value[field];
		if (detail !== undefined && (!isRecord(detail) || !validCounters(detail, [...keys]))) return false;
	}
	return true;
}

function extractTurn(
	obj: Record<string, unknown>,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
): SessionTurn {
	const msg = isRecord(obj.message) ? obj.message : {};
	const rawUsage = msg.usage as TokenUsage | undefined;
	const usage = rawUsage ? {
		...rawUsage,
		input_tokens: rawUsage.input_tokens ?? 0,
		output_tokens: rawUsage.output_tokens ?? 0,
	} : undefined;
	const model = (msg.model ?? undefined) as string | undefined;
	const perTurnSubagent = typeof obj.subagentType === 'string' ? obj.subagentType || undefined : undefined;
	const perTurnProject = typeof obj.projectId === 'string' ? obj.projectId || undefined : undefined;
	const perTurnParent = typeof obj.parentSessionId === 'string' ? obj.parentSessionId || undefined : undefined;

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
		type: (obj.type ?? msg.role) as SessionTurn['type'],
		timestamp: obj.timestamp as string,
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
				readLog(file.path, file.subagentType, file.projectId, file.parentSessionId, opts.onSkippedRecord),
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
