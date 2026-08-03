import { constants } from 'node:fs';
import { access, lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
	LOG_SHAPE_IDS,
	addParseDiagnostic,
	classifyLogRecord,
	isSupportedSubagentMeta,
	type ParseDiagnostics,
} from './log-contract.ts';
import { parseRfc3339Timestamp } from './timestamp.ts';
import type { SessionTurn } from './types.ts';

export type { ParseDiagnostics } from './log-contract.ts';

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// Limit concurrent file reads so we don't exhaust fd on huge setups.
const CONCURRENCY = 8;

export interface ParseOptions {
	from?: Date;
	to?: Date;
	projectsDir?: string;
	/** Fail instead of silently skipping unreadable paths; reject nested symlinks. */
	strictSource?: boolean;
	diagnostics?: ParseDiagnostics;
}

type ParseRange = Pick<ParseOptions, 'from' | 'to'>;

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
	strictSource = false,
	diagnostics?: ParseDiagnostics,
): AsyncGenerator<LogFile> {
	const projects = await readDirectory(projectsDir, strictSource);
	// Parallelize project-level walks, then retain the discovered file metadata.
	const walkers = projects.map(async (project) => {
		const projectPath = join(projectsDir, project);
		if (strictSource) {
			const info = await inspectPath(projectPath, true);
			if (!info) throw new Error(`cannot inspect forecast source path: ${projectPath}`);
			if (info.isSymbolicLink()) {
				throw new Error(`symbolic link is not allowed in forecast source: ${projectPath}`);
			}
			if (!info.isDirectory()) return [];
		}
		return collectWalk(projectPath, project, strictSource, diagnostics);
	});
	const settled = await Promise.all(walkers);
	for (const list of settled) {
		for (const lf of list) yield lf;
	}
}

async function collectWalk(
	dir: string,
	projectId: string,
	strictSource: boolean,
	diagnostics: ParseDiagnostics | undefined,
): Promise<LogFile[]> {
	const out: LogFile[] = [];
	for await (const lf of walkForJsonl(dir, projectId, strictSource, diagnostics)) out.push(lf);
	return out;
}

async function readDirectory(dir: string, strictSource: boolean): Promise<string[]> {
	try {
		if (strictSource) await access(dir, constants.R_OK | constants.X_OK);
		return (await readdir(dir)).sort();
	} catch (error) {
		if (strictSource) {
			throw new Error(`cannot read forecast source directory: ${dir}`, { cause: error });
		}
		return [];
	}
}

async function inspectPath(path: string, strictSource: boolean) {
	try {
		return strictSource ? await lstat(path) : await stat(path);
	} catch (error) {
		if (strictSource) {
			throw new Error(`cannot inspect forecast source path: ${path}`, { cause: error });
		}
		return undefined;
	}
}

async function* walkForJsonl(
	dir: string,
	projectId: string,
	strictSource: boolean,
	diagnostics: ParseDiagnostics | undefined,
): AsyncGenerator<LogFile> {
	const entries = await readDirectory(dir, strictSource);
	// If this directory IS named 'subagents', its parent session is one level up.
	// e.g. .../<session-uuid>/subagents/agent-XXX.jsonl → parent = <session-uuid>
	const parentSession = basename(dir) === 'subagents' ? basename(dirname(dir)) : undefined;
	for (const name of entries) {
		if (name.startsWith('.') || name === 'memory') continue;
		const full = join(dir, name);
		const info = await inspectPath(full, strictSource);
		if (!info) continue;
		if (strictSource && info.isSymbolicLink()) {
			throw new Error(`symbolic link is not allowed in forecast source: ${full}`);
		}
		if (info.isDirectory()) {
			yield* walkForJsonl(full, projectId, strictSource, diagnostics);
			continue;
		}
		if (name.endsWith('.jsonl')) {
			if (strictSource) await access(full, constants.R_OK);
			const subagentType = await resolveSubagentType(full, diagnostics);
			yield {
				path: full,
				projectId,
				subagentType,
				parentSessionId: parentSession,
			};
		}
	}
}

async function resolveSubagentType(
	jsonlPath: string,
	diagnostics?: ParseDiagnostics,
): Promise<string | undefined> {
	if (basename(dirname(jsonlPath)) !== 'subagents') return undefined;
	const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json');
	try {
		const text = await Bun.file(metaPath).text();
		const meta: unknown = JSON.parse(text);
		if (!isSupportedSubagentMeta(meta)) throw new TypeError('unsupported subagent metadata');
		return meta.agentType;
	} catch {
		addParseDiagnostic(diagnostics, {
			code: 'invalid-subagent-meta',
			expectedShape: LOG_SHAPE_IDS.subagentMeta,
			source: basename(metaPath),
			reason: 'subagent metadata must contain a non-empty string agentType',
		});
		return undefined;
	}
}

// Streaming line reader — does NOT buffer the whole file.
// Handles partial lines across chunk boundaries. Malformed JSON is skipped and
// counted when the caller supplies diagnostics.
export async function* parseFile(
	path: string,
	subagentType?: string,
	projectId?: string,
	parentSessionId?: string,
	diagnostics?: ParseDiagnostics,
	diagnosticRange: ParseRange = {},
): AsyncGenerator<SessionTurn> {
	const sessionId = basename(path).replace('.jsonl', '');
	const stream = Bun.file(path).stream();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	let buffer = '';
	let lineNumber = 0;
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true });
		let nl: number;
		while ((nl = buffer.indexOf('\n')) !== -1) {
			lineNumber++;
			const line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (!line.trim()) continue;
			const turn = tryParseLine(
				line,
				sessionId,
				subagentType,
				projectId,
				parentSessionId,
				diagnostics,
				basename(path),
				lineNumber,
				diagnosticRange,
			);
			if (turn) yield turn;
		}
	}
	// Flush any trailing partial line.
	buffer += decoder.decode();
	if (buffer.trim()) {
		lineNumber++;
		const turn = tryParseLine(
			buffer,
			sessionId,
			subagentType,
			projectId,
			parentSessionId,
			diagnostics,
			basename(path),
			lineNumber,
			diagnosticRange,
		);
		if (turn) yield turn;
	}
}

function tryParseLine(
	recordLine: string,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
	diagnostics: ParseDiagnostics | undefined,
	source: string,
	lineNumber: number,
	diagnosticRange: ParseRange,
): SessionTurn | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(recordLine);
	} catch {
		addParseDiagnostic(diagnostics, {
			code: 'malformed-json',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			source,
			line: lineNumber,
			reason: 'line is not valid JSON',
		});
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		addParseDiagnostic(diagnostics, {
			code: 'unsupported-json-root',
			expectedShape: LOG_SHAPE_IDS.assistantUsage,
			source,
			line: lineNumber,
			reason: 'JSON line must contain an object',
		});
		return undefined;
	}
	const obj = parsed as Record<string, unknown>;
	const classification = classifyLogRecord(obj);
	if (classification.status === 'ignored') {
		if (diagnostics) diagnostics.ignoredSourceRecordLines++;
		return undefined;
	}
	if (classification.status === 'invalid') {
		if (diagnosticMatchesRange(obj, diagnosticRange)) {
			addParseDiagnostic(diagnostics, {
				code: classification.code,
				expectedShape: classification.expectedShape,
				source,
				line: lineNumber,
				reason: classification.reason,
			});
		}
		return undefined;
	}
	return extractTurn(
		obj,
		classification.message,
		classification.usage,
		classification.model,
		sessionId,
		subagentType,
		projectId,
		parentSessionId,
	);
}

function diagnosticMatchesRange(record: Record<string, unknown>, range: ParseRange): boolean {
	const timestamp = parseRfc3339Timestamp(record.timestamp);
	if (!timestamp) return true;
	if (range.from && timestamp < range.from) return false;
	if (range.to && timestamp > range.to) return false;
	return true;
}

function extractTurn(
	obj: Record<string, unknown>,
	msg: Record<string, unknown>,
	usage: SessionTurn['usage'],
	model: string | undefined,
	sessionId: string,
	subagentType: string | undefined,
	projectId: string | undefined,
	parentSessionId: string | undefined,
): SessionTurn {
	const perTurnSubagent = optionalNonEmptyString(obj.subagentType);
	const perTurnProject = optionalNonEmptyString(obj.projectId);
	const perTurnParent = optionalNonEmptyString(obj.parentSessionId);

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
		type: 'assistant',
		timestamp: obj.timestamp as string,
		sessionId,
		projectId: perTurnProject ?? projectId,
		subagentType: perTurnSubagent ?? subagentType,
		parentSessionId: perTurnParent ?? parentSessionId,
		model,
		usage,
		toolUses: toolUses.length > 0 ? toolUses : undefined,
	};
}

function optionalNonEmptyString(value: unknown): string | undefined {
	return typeof value === 'string' && value.length > 0 ? value : undefined;
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
		const timestamp = parseRfc3339Timestamp(turn.timestamp);
		if (!timestamp) continue;
		if (opts.from && timestamp < opts.from) continue;
		if (opts.to && timestamp > opts.to) continue;
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
				readLog(
					file.path,
					file.subagentType,
					file.projectId,
					file.parentSessionId,
					opts.diagnostics,
					opts,
				),
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
	for await (const file of findSessionLogs(dir, opts.strictSource, opts.diagnostics)) files.push(file);
	yield* streamLogFiles(files, opts);
}
