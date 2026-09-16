/**
 * Local GGUF inference bridge (tasks 71–97).
 *
 * Spawns `llama-server` (llama.cpp's OpenAI-compatible HTTP server) for a
 * selected `.gguf` model file and adapts it onto Cline's `ApiHandler`
 * contract. The handler talks to `http://127.0.0.1:<port>/v1/*` so the
 * provider reuses the same wire shape as other OpenAI-compatible vendors.
 *
 * Invariants:
 * - The server binds 127.0.0.1 only (never exposed to the LAN).
 * - Only one server per model path is alive (registry keyed by path).
 * - `dispose()` always terminates the child process.
 */

import {
	spawn,
	type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { createServer } from "node:net";
import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type {
	ApiStream,
	ApiStreamChunk,
	ContentBlock,
	Message,
	ToolDefinition,
} from "./types";
import type { ApiHandler } from "./handler";
import type { HandlerModelInfo } from "./handler";
import { parseGGUFMetadataFromFile, type GGUFMetadata } from "./gguf-parser";

export interface GGUFInferenceConfig {
	modelPath: string;
	threads: number;
	contextWindow: number;
	gpuLayers: number;
	extraArgs?: string[];
	timeoutMs?: number;
}

export interface LlamaServerProbe {
	available: boolean;
	path?: string;
	version?: string;
}

const DEFAULT_PORT_MIN = 49152;
const READINESS_TIMEOUT_MS = 180_000;
const READINESS_INTERVAL_MS = 250;

/**
 * llama-server child process type: stdin is "ignore" (null), stdout/stderr
 * are piped. Kept explicit so the spawn call type-checks without casts.
 */
export type LlamaServerProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Message content may be a plain string or a block array. Empty/unknown
 * blocks collapse to "" so the OpenAI payload never carries `undefined`.
 */
function flattenContent(content: string | ContentBlock[] | undefined): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => (typeof block === "object" && block !== null && "text" in block ? String(block.text) : ""))
		.filter((text) => text.length > 0)
		.join("\n");
}

/** Task 73 — locate a `llama-server` binary on PATH (all platforms). */
export async function detectLlamaServer(): Promise<LlamaServerProbe> {
	try {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const execFileAsync = promisify(execFile);
		const command = process.platform === "win32" ? "where.exe" : "which";
		const { stdout } = await execFileAsync(command, ["llama-server"]);
		const path = stdout.trim().split(/\r?\n/)[0];
		if (!path) {
			return { available: false };
		}
		let version: string | undefined;
		try {
			const { stdout: vOut } = await execFileAsync(path, ["--version"]);
			version = vOut.trim().split(/\r?\n/)[0];
		} catch {
			// version probe is best-effort
		}
		return { available: true, path, version };
	} catch {
		return { available: false };
	}
}

/** Task 75 — ask the OS for an ephemeral port to avoid collisions. */
export async function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : DEFAULT_PORT_MIN;
			server.close(() => resolve(port));
		});
	});
}

/** Task 77 — build the llama-server argv; `--jinja` uses the GGUF chat template. */
export function buildLlamaServerArgs(config: GGUFInferenceConfig, port: number): string[] {
	return [
		"-m",
		config.modelPath,
		"-c",
		String(config.contextWindow),
		"-t",
		String(config.threads),
		"-ngl",
		String(config.gpuLayers),
		"--host",
		"127.0.0.1",
		"--port",
		String(port),
		"--jinja",
		...(config.extraArgs ?? []),
	];
}

/** Task 76 — spawn the server (llama-server is resolved via PATH). */
export function spawnLlamaServer(
	config: GGUFInferenceConfig,
	port: number,
): LlamaServerProcess {
	return spawn("llama-server", buildLlamaServerArgs(config, port), {
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
}

/** Task 79 — poll `/health` until ready, with timeout + backoff. */
export async function waitForReadiness(
	port: number,
	timeoutMs = READINESS_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError = "unknown";
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/health`);
			if (response.ok) {
				return;
			}
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(READINESS_INTERVAL_MS);
	}
	throw new Error(`llama-server did not become ready within ${timeoutMs}ms: ${lastError}`);
}

const RUNNING_SERVERS = new Map<string, LlamaServerProcess>();

function disposeProcess(process: LlamaServerProcess): void {
	if (process.exitCode === null && !process.killed) {
		process.kill();
	}
}

export class GGUFInferenceError extends Error {
	readonly code: "NOT_INSTALLED" | "MODEL_NOT_FOUND" | "LOAD_FAILED" | "SERVER_ERROR";
	constructor(
		code: "NOT_INSTALLED" | "MODEL_NOT_FOUND" | "LOAD_FAILED" | "SERVER_ERROR",
		message: string,
	) {
		super(message);
		this.name = "GGUFInferenceError";
		this.code = code;
	}
}

/** Task 81 — ApiHandler implementation over the spawned llama-server. */
export class GGUFInferenceHandler implements ApiHandler {
	private config: GGUFInferenceConfig;
	private port = 0;
	private process?: LlamaServerProcess;
	private metadata?: GGUFMetadata;
	private abortController = new AbortController();

	constructor(config: GGUFInferenceConfig) {
		this.config = config;
	}

	/** Tasks 80 + 87 (initialise) — validate model file, spawn, wait ready. */
	async initialize(): Promise<void> {
		const existing = RUNNING_SERVERS.get(this.config.modelPath);
		if (existing) {
			this.process = existing;
			return;
		}
		const probe = await detectLlamaServer();
		if (!probe.available) {
			throw new GGUFInferenceError(
				"NOT_INSTALLED",
				"llama-server was not found on PATH. Install llama.cpp (https://github.com/ggerganov/llama.cpp) and add `llama-server` to PATH.",
			);
		}
		this.metadata = await parseGGUFMetadataFromFile(this.config.modelPath);
		this.port = await findFreePort();
		const child = spawnLlamaServer(this.config, this.port);
		let stderrTail = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
		});
		child.once("exit", (code) => {
			RUNNING_SERVERS.delete(this.config.modelPath);
			if (this.process === child && code !== 0) {
				this.abortController.abort(
					new GGUFInferenceError(
						"LOAD_FAILED",
						`llama-server exited with code ${code}: ${stderrTail}`,
					),
				);
			}
		});
		try {
			await waitForReadiness(this.port, this.config.timeoutMs ?? READINESS_TIMEOUT_MS);
		} catch (error) {
			disposeProcess(child);
			RUNNING_SERVERS.delete(this.config.modelPath);
			throw new GGUFInferenceError(
				"LOAD_FAILED",
				`llama-server failed to start: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		this.process = child;
		RUNNING_SERVERS.set(this.config.modelPath, child);
	}

	get baseUrl(): string {
		return `http://127.0.0.1:${this.port}`;
	}

	getServerPort(): number {
		return this.port;
	}

	getMetadata(): GGUFMetadata | undefined {
		return this.metadata;
	}

	/** Task 82 — OpenAI-compatible chat payload. */
	getMessages(systemPrompt: string, messages: Message[]): unknown {
		return {
			messages: [
				...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
				...messages.map((message) => ({
					role: message.role,
					content: flattenContent(message.content),
				})),
			],
		};
	}

	/** Tasks 83–85 — stream chat completions and map SSE deltas to ApiStream. */
	createMessage(
		systemPrompt: string,
		messages: Message[],
		tools?: ToolDefinition[],
	): ApiStream {
		const controller = this.abortController;
		const port = this.port;
		const payload = this.getMessages(systemPrompt, messages) as Record<string, unknown>;
		return (async function* () {
			if (!port) {
				throw new GGUFInferenceError(
					"LOAD_FAILED",
					"Model is not loaded; call initialize() first",
				);
			}
			const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					...payload,
					stream: true,
					...(tools && tools.length > 0
						? { tools: tools.map((tool) => ({ type: "function", function: tool })) }
						: {}),
				}),
				signal: controller.signal,
			});
			if (!response.ok || !response.body) {
				throw new GGUFInferenceError(
					"SERVER_ERROR",
					`llama-server returned HTTP ${response.status}`,
				);
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split(/\r?\n/);
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith("data:")) {
						continue;
					}
					const data = trimmed.slice(5).trim();
					if (data === "[DONE]") {
						yield { type: "done", success: true } as ApiStreamChunk;
						return;
					}
					for (const chunk of mapDeltaToChunks(JSON.parse(data))) {
						yield chunk;
					}
				}
			}
			yield { type: "done", success: true } as ApiStreamChunk;
		})();
	}

	/** Task 86 — expose resolved model info from parsed GGUF metadata. */
	getModel(): HandlerModelInfo {
		const meta = this.metadata;
		return {
			id: "local-model",
			info: {
				id: "local-model",
				name: meta?.modelType ?? "Local GGUF model",
				contextWindow: meta?.contextLength ?? this.config.contextWindow,
				capabilities: ["tools"],
			},
		};
	}

	/** Task 87 — cancel any in-flight request. */
	abort(): void {
		this.abortController.abort();
	}

	/** Task 88 — runtime cancellation signal. */
	setAbortSignal(signal: AbortSignal | undefined): void {
		if (!signal) {
			return;
		}
		if (signal.aborted) {
			this.abortController.abort();
			return;
		}
		signal.addEventListener("abort", () => this.abortController.abort(), { once: true });
	}

	/** Task 89 — kill the child process and release the port. */
	dispose(): void {
		const child = this.process;
		if (child) {
			disposeProcess(child);
			RUNNING_SERVERS.delete(this.config.modelPath);
		}
		this.process = undefined;
		this.port = 0;
	}
}

interface OpenAIDelta {
	choices?: Array<{
		delta?: { content?: string | null; reasoning_content?: string | null };
		finish_reason?: string | null;
	}>;
	usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

/** Tasks 85 + 97 — map an OpenAI SSE delta to Cline stream chunks. */
export function mapDeltaToChunks(data: OpenAIDelta): ApiStreamChunk[] {
	const chunks: ApiStreamChunk[] = [];
	const choice = data.choices?.[0];
	const delta = choice?.delta;
	if (delta?.reasoning_content) {
		chunks.push({ type: "reasoning", reasoning: delta.reasoning_content } as ApiStreamChunk);
	}
	if (delta?.content) {
		chunks.push({ type: "text", text: delta.content } as ApiStreamChunk);
	}
	if (data.usage) {
		chunks.push({
			type: "usage",
			inputTokens: data.usage.prompt_tokens ?? 0,
			outputTokens: data.usage.completion_tokens ?? 0,
		} as ApiStreamChunk);
	}
	if (choice?.finish_reason) {
		chunks.push({ type: "done", success: true } as ApiStreamChunk);
	}
	return chunks;
}

/** Task 90 — exactly one live server per model path. */
export function getRunningServer(
	modelPath: string,
): LlamaServerProcess | undefined {
	return RUNNING_SERVERS.get(modelPath);
}

/** Diagnostic helper: total logical CPU count (UI clamps `threads`). */
export function logicalCpuCount(): number {
	return os.cpus().length;
}
