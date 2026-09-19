/**
 * Local GGUF model resolution (tasks 114–131).
 *
 * Turns a configured `.gguf` model file into the provider's model list.
 * This is the catalog-side counterpart to `gguf-inference.ts` (which runs the
 * file): hosts ask "what model does this file represent?" while the settings
 * picker is open, long before `llama-server` is spawned.
 *
 * Contract:
 * - One model per file. A local GGUF provider runs exactly the file the user
 *   selected, so the result is always a single `"local-model"` entry keyed by
 *   {@link LOCAL_GGUF_MODEL_ID}.
 * - Sparse metadata never fails the call. Every field has a documented
 *   fallback (task 124), so a header that parses but carries no usable
 *   `general.*` keys still yields a selectable entry instead of an empty list.
 * - Unreadable files *do* throw, with a typed {@link GGUFParseError}
 *   (`ENOENT`, `NOT_GGUF`, `TRUNCATED`, `UNSUPPORTED_VERSION`). Callers such
 *   as the model catalog translate that into a user-facing failure; this
 *   module does not decide how failures are presented.
 * - Parsed metadata is cached per path + mtime + size (task 127), so opening
 *   the picker repeatedly does not re-read the file. `forceRefresh` bypasses
 *   that cache (task 126).
 */

import type { ModelInfo } from "@cline/shared";
import { BUILTIN_SPECS } from "./builtins";
import {
	filenameStem,
	GGUFParseError,
	type GGUFMetadata,
	parseGGUFMetadataFromFile,
} from "./gguf-parser";

/** The single model id every local GGUF provider exposes. */
export const LOCAL_GGUF_MODEL_ID = "local-model";

/** Fallback context window when neither the file nor the caller declares one. */
export const DEFAULT_LOCAL_GGUF_CONTEXT_WINDOW = 4096;

/** Cap on generated tokens; llama-server's own default when `-n` is omitted. */
export const DEFAULT_LOCAL_GGUF_MAX_TOKENS = 4096;

export interface LocalGGUFModelResolveOptions {
	/** Path to the `.gguf` file. Absent/blank means "nothing configured yet". */
	modelPath?: string;
	/** Re-parse the file even when a cached parse matches its mtime + size. */
	forceRefresh?: boolean;
	/** Provider-level context window (providers.json). Clamped by the file. */
	contextWindow?: number;
	/** Override for the generated-token cap. */
	maxTokens?: number;
}

interface CachedMetadata {
	readonly mtimeMs: number;
	readonly size: number;
	readonly metadata: GGUFMetadata;
}

const METADATA_CACHE = new Map<string, CachedMetadata>();

/** providerId → config field path → declared default, resolved lazily. */
const CONFIG_FIELD_DEFAULTS = new Map<string, Map<string, unknown>>();

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/**
 * A metadata label worth showing, or `undefined`. The parser reports absent
 * structural fields as the literal `"unknown"`, which must not shadow a later
 * fallback (a sparse header should name the model after its file, not
 * "unknown").
 */
function usableLabel(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed.toLowerCase() !== "unknown" ? trimmed : undefined;
}

/**
 * The provider's own declared default for a config field (e.g. `contextWindow`
 * from its spec's `configFields`). Keeps this resolver provider-neutral: a
 * provider that declares a larger default context window gets it without any
 * per-provider branch here.
 */
function readDeclaredFieldDefault(
	providerId: string,
	fieldPath: string,
): unknown {
	let fields = CONFIG_FIELD_DEFAULTS.get(providerId);
	if (!fields) {
		fields = new Map<string, unknown>();
		const spec = BUILTIN_SPECS.find((entry) => entry.id === providerId);
		for (const field of spec?.configFields ?? []) {
			fields.set(field.path, field.defaultValue);
		}
		CONFIG_FIELD_DEFAULTS.set(providerId, fields);
	}
	return fields.get(fieldPath);
}

async function statModelFile(
	modelPath: string,
): Promise<{ mtimeMs: number; size: number }> {
	const fs = await import("node:fs/promises");
	try {
		const stat = await fs.stat(modelPath);
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		throw new GGUFParseError("ENOENT", `GGUF file not found: ${modelPath}`);
	}
}

/**
 * Task 127 — read metadata through the path+mtime+size cache. A cache hit
 * never touches the file beyond the `stat` above; a miss reads only the
 * header (see `parseGGUFMetadataFromFile`).
 */
async function readGGUFMetadata(
	modelPath: string,
	forceRefresh: boolean,
): Promise<GGUFMetadata> {
	const stat = await statModelFile(modelPath);
	const cached = METADATA_CACHE.get(modelPath);
	if (
		!forceRefresh &&
		cached &&
		cached.mtimeMs === stat.mtimeMs &&
		cached.size === stat.size
	) {
		return cached.metadata;
	}
	const metadata = await parseGGUFMetadataFromFile(modelPath);
	METADATA_CACHE.set(modelPath, {
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		metadata,
	});
	return metadata;
}

/**
 * Task 120 — the file's declared context length is the ceiling; a
 * user-configured window narrows it and never widens it, otherwise the agent
 * would budget for more tokens than `llama-server` was started with.
 * Absent both, use the provider's declared default, then the module default.
 */
function resolveContextWindow(
	providerId: string,
	metadata: GGUFMetadata,
	requested: number | undefined,
): number {
	const fromFile = positiveNumber(metadata.contextLength);
	if (fromFile !== undefined && requested !== undefined) {
		return Math.min(fromFile, requested);
	}
	if (fromFile !== undefined) {
		return fromFile;
	}
	if (requested !== undefined) {
		return requested;
	}
	const declared = positiveNumber(
		readDeclaredFieldDefault(providerId, "contextWindow"),
	);
	return declared ?? DEFAULT_LOCAL_GGUF_CONTEXT_WINDOW;
}

/**
 * Tasks 117–123 — build the single model record. Every field falls back
 * individually so a valid-but-sparse header still produces a usable entry
 * (task 124): `name` → `general.name`, then `general.type`, then the filename
 * stem; `description` only when `general.description` is present.
 */
function toModelInfo(
	providerId: string,
	modelPath: string,
	metadata: GGUFMetadata,
	options: LocalGGUFModelResolveOptions,
): ModelInfo {
	const name =
		usableLabel(metadata.name) ??
		usableLabel(metadata.modelType) ??
		usableLabel(filenameStem(modelPath)) ??
		LOCAL_GGUF_MODEL_ID;
	// `supportsTools` is expressed as the `tools` capability in the SDK model
	// shape — llama.cpp serves OpenAI `chat-completions` with tool definitions.
	const capabilities: NonNullable<ModelInfo["capabilities"]> =
		metadata.hasVisionEncoder ? ["tools", "images"] : ["tools"];
	const info: ModelInfo = {
		id: LOCAL_GGUF_MODEL_ID,
		name,
		contextWindow: resolveContextWindow(
			providerId,
			metadata,
			options.contextWindow,
		),
		maxTokens:
			positiveNumber(options.maxTokens) ?? DEFAULT_LOCAL_GGUF_MAX_TOKENS,
		capabilities,
	};
	const description = metadata.description.trim();
	if (description) {
		info.description = description;
	}
	if (metadata.hasVisionEncoder) {
		info.modalities = { input: ["text", "image"], output: ["text"] };
	}
	return info;
}

/**
 * Task 116 — the model catalogue for a local GGUF provider.
 *
 * Returns a `Record<string, ModelInfo>` keyed by {@link LOCAL_GGUF_MODEL_ID}:
 * an empty record when no `modelPath` is configured, otherwise exactly one
 * entry. Throws {@link GGUFParseError} when the configured file cannot be read
 * or is not a usable GGUF file (tasks 125/130/131 hand that to the caller).
 */
export async function resolveLocalGGUFModels(
	providerId: string,
	options: LocalGGUFModelResolveOptions = {},
): Promise<Record<string, ModelInfo>> {
	const modelPath = options.modelPath?.trim();
	if (!modelPath) {
		return {};
	}
	const metadata = await readGGUFMetadata(
		modelPath,
		options.forceRefresh === true,
	);
	return {
		[LOCAL_GGUF_MODEL_ID]: toModelInfo(providerId, modelPath, metadata, options),
	};
}

/** Drop every cached parse (file changed underneath us, or test isolation). */
export function clearLocalGGUFModelCache(): void {
	METADATA_CACHE.clear();
}

/** Internal test hook — mirrors the `_testing` convention used by hosts. */
export const _testing = {
	cacheSize: (): number => METADATA_CACHE.size,
	getCachedMetadata: (modelPath: string): GGUFMetadata | undefined =>
		METADATA_CACHE.get(modelPath)?.metadata,
};