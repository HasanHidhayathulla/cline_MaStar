/**
 * Local GGUF runtime state and helpers (tasks 159–173).
 *
 * Everything here is deliberately free of proto imports so it can be unit
 * tested (and type-checked) without the generated `@shared/proto` layer: the
 * gRPC handlers are thin adapters over these functions.
 *
 * State ownership (task 164): the loaded inference handler is held per
 * controller instance in a WeakMap, so a disposed/replaced controller cannot
 * leak a running `llama-server` through this module, and no global singleton
 * is introduced.
 */

import { GGUFParseError, type GGUFInferenceConfig, type GGUFInferenceHandler } from "@cline/llms"

/** Stable model id for the single model a `.gguf` file provides. */
export const LOCAL_GGUF_MODEL_ID = "local-model"

/** Defaults mirroring the `local-gguf` builtin spec's config fields. */
export const DEFAULT_GGUF_THREADS = 4
export const DEFAULT_GGUF_CONTEXT_WINDOW = 4096
export const DEFAULT_GGUF_GPU_LAYERS = 0

/** Install guide referenced when `llama-server` is missing (task 162). */
export const LLAMA_CPP_DOCS_URL = "https://github.com/ggerganov/llama.cpp"

/** The subset of `LoadGGUFModelRequest` this module depends on. */
export interface GgufLoadRequestShape {
	readonly modelPath?: string
	readonly threads?: number
	readonly contextWindow?: number
	readonly gpuLayers?: number
	readonly extraArgs?: readonly string[]
}

/** A loaded model: the handler that owns the child process plus its identity. */
export interface GgufRuntimeState {
	readonly handler: GGUFInferenceHandler
	readonly modelPath: string
	readonly loadedAtMs: number
}

const RUNTIME_STATE = new WeakMap<object, GgufRuntimeState>()

function positiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function nonNegativeInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

/**
 * Task 160 — map the load request onto the inference bridge config, applying
 * the same defaults as the provider spec so an under-specified request still
 * starts a usable server. `extraArgs` entries are trimmed and blanks dropped.
 */
export function normalizeGgufInferenceConfig(request: GgufLoadRequestShape): GGUFInferenceConfig {
	const extraArgs = (request.extraArgs ?? []).map((arg) => arg.trim()).filter((arg) => arg.length > 0)
	return {
		modelPath: request.modelPath?.trim() ?? "",
		threads: positiveInt(request.threads, DEFAULT_GGUF_THREADS),
		contextWindow: positiveInt(request.contextWindow, DEFAULT_GGUF_CONTEXT_WINDOW),
		gpuLayers: nonNegativeInt(request.gpuLayers, DEFAULT_GGUF_GPU_LAYERS),
		...(extraArgs.length > 0 ? { extraArgs } : {}),
	}
}

/**
 * Task 161/162 — install guidance for a missing `llama-server`. The client
 * copy lives here rather than in the handler so it stays in one place.
 */
export function llamaServerMissingMessage(): string {
	return `llama-server was not found on PATH. Install llama.cpp (${LLAMA_CPP_DOCS_URL}) and make sure \`llama-server\` is on your PATH, then try again.`
}

/**
 * Task 172 — best-effort memory usage from llama-server's `/system/info`.
 * The endpoint is newer than some builds and its shape has moved, so accept
 * the known spellings and return `undefined` rather than guessing.
 */
export function readSystemInfoMemoryBytes(payload: unknown): number | undefined {
	if (typeof payload !== "object" || payload === null) {
		return undefined
	}
	const record = payload as Record<string, unknown>
	const candidates = [
		record.rss_bytes,
		record.rss,
		record.memory_bytes,
		(record.system_info as Record<string, unknown> | undefined)?.rss_bytes,
		(record.system_info as Record<string, unknown> | undefined)?.rss,
	]
	for (const candidate of candidates) {
		if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
			return Math.floor(candidate)
		}
	}
	return undefined
}

/**
 * Task 156/176 — validate a configured model path before any I/O.
 *
 * `GGUFParseError` is used deliberately (not `GGUFInferenceError`): the model
 * catalog already maps its codes onto user-fixable `config`/`shape` errors,
 * so both paths report the same vocabulary. Note there is no
 * `MODEL_NOT_FOUND` code on `GGUFParseError` (that lives on
 * `GGUFInferenceError`), so a blank path is `ENOENT`.
 */
export function assertGgufModelPath(modelPath: string | undefined): asserts modelPath is string {
	if (!modelPath || !modelPath.trim()) {
		throw new GGUFParseError("ENOENT", "No GGUF model file is configured")
	}
	if (!/\.gguf$/i.test(modelPath.trim())) {
		throw new GGUFParseError("NOT_A_GGUF_PATH", `Not a .gguf model file: ${modelPath}`)
	}
}

/**
 * Task 158 — collapse a failure into a code + message pair. The code is the
 * SDK's own (`ENOENT`, `NOT_GGUF`, `NOT_INSTALLED`, …) so the transport layer
 * can assign a gRPC status without parsing strings, and unknown failures fall
 * back to `UNKNOWN` rather than being lost.
 */
export function toGgufHandlerErrorMessage(error: unknown): { code: string; message: string } {
	if (error instanceof GGUFParseError) {
		return { code: error.code, message: error.message }
	}
	const code = readErrorCode(error)
	const message = error instanceof Error ? error.message : String(error)
	return { code: code ?? "UNKNOWN", message }
}

/** Error code carried by SDK errors, when present. */
function readErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) {
		return undefined
	}
	// `Reflect.get` keeps this cast-free; `code` is a plain own property on the
	// SDK's error classes.
	const code: unknown = Reflect.get(error, "code")
	return typeof code === "string" ? code : undefined
}

/** Wrap a failure into the single-line message the webview displays. */
export function toGgufHandlerFailureMessage(error: unknown): string {
	const { code, message } = toGgufHandlerErrorMessage(error)
	return `[${code}] ${message} — see model setup docs: ${LLAMA_CPP_DOCS_URL}`
}

/** A load request either proceeds with a normalized config or is rejected. */
export type GgufLoadPlan =
	| { readonly kind: "reject"; readonly error: string }
	| { readonly kind: "load"; readonly config: GGUFInferenceConfig }

/**
 * Tasks 161/162/176 — decide whether a load request can proceed.
 *
 * Pure on purpose: it is the whole "should this spawn?" decision, so it can be
 * unit tested without a proto layer, a controller, or a real `llama-server`.
 * Order matters — path validation is cheaper than a PATH probe and gives the
 * user a more specific message.
 */
export function planGgufLoad(request: GgufLoadRequestShape, probe: { readonly available: boolean }): GgufLoadPlan {
	const config = normalizeGgufInferenceConfig(request)
	try {
		assertGgufModelPath(config.modelPath)
	} catch (error) {
		return { kind: "reject", error: toGgufHandlerFailureMessage(error) }
	}
	if (!probe.available) {
		return { kind: "reject", error: llamaServerMissingMessage() }
	}
	return { kind: "load", config }
}

export function setGgufRuntimeState(controller: object, state: GgufRuntimeState): void {
	RUNTIME_STATE.set(controller, state)
}

export function getGgufRuntimeState(controller: object): GgufRuntimeState | undefined {
	return RUNTIME_STATE.get(controller)
}

/** Drop the held reference without touching the process (task 168). */
export function clearGgufRuntimeState(controller: object): void {
	RUNTIME_STATE.delete(controller)
}

export interface GgufStatusSnapshot {
	readonly loaded: boolean
	readonly modelPath: string
	readonly pid: number
	readonly port: number
	readonly uptimeSeconds: number
	readonly memoryBytes: number
}

/**
 * Task 171/173 — project runtime state onto a transport-agnostic status.
 * Unknown numeric fields collapse to 0 because the proto3 `optional` fields
 * are emitted as required-with-default by ts_proto's `useOptionals=none`.
 */
export function toGgufStatusSnapshot(args: {
	readonly state?: GgufRuntimeState
	readonly nowMs: number
	readonly pid?: number
	readonly memoryBytes?: number
}): GgufStatusSnapshot {
	const { state } = args
	if (!state) {
		return { loaded: false, modelPath: "", pid: 0, port: 0, uptimeSeconds: 0, memoryBytes: 0 }
	}
	const uptimeMs = Math.max(0, args.nowMs - state.loadedAtMs)
	return {
		loaded: true,
		modelPath: state.modelPath,
		pid: nonNegativeInt(args.pid, 0),
		port: nonNegativeInt(state.handler.getServerPort(), 0),
		uptimeSeconds: Math.floor(uptimeMs / 1000),
		memoryBytes: nonNegativeInt(args.memoryBytes, 0),
	}
}
