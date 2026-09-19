/**
 * Local model-file overlays for the model catalog (task 115).
 *
 * A provider whose model list *is* a file the user picked on disk needs two
 * things the SDK catalog cannot supply:
 *
 * 1. **Resolution** — read the file's metadata and expose it as the provider's
 *    model entry (`resolveLocalGGUFModels` in the SDK does the parsing).
 * 2. **Actionable failures** — a missing or corrupted file must reach the
 *    picker as a message, not an empty list. The SDK's provider-defaults path
 *    swallows its own resolution errors, so this layer reports the failure by
 *    throwing and lets the catalog's `toCatalogError` funnel turn it into
 *    `ok: false`.
 *
 * Detection is deliberately data-shape based rather than a provider-id list:
 * a provider is file-backed when its effective config carries a `modelPath`
 * and the SDK has not declared a `modelsSourceUrl` for it (a provider that
 * fetches its model list from a URL keeps the SDK path). Any future provider
 * that declares a local model file therefore works with no change here.
 */

import { MODEL_COLLECTIONS_BY_PROVIDER_ID, type ModelInfo, resolveLocalGGUFModels } from "@cline/llms"
import type { CatalogError, EffectiveProviderConfig } from "./contracts"

type LocalModelFileConfig = Pick<EffectiveProviderConfig, "providerId" | "modelPath" | "contextWindow">

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

/**
 * The configured local model file for this provider, or `undefined` when the
 * provider is not file-backed. Returning `undefined` keeps the SDK catalog
 * path authoritative for every other provider.
 */
export function resolveLocalModelFilePath(config: Pick<EffectiveProviderConfig, "providerId" | "modelPath">): string | undefined {
	const modelPath = config.modelPath?.trim()
	if (!modelPath) {
		return undefined
	}
	// An SDK-declared model source URL means the SDK owns this provider's list.
	const declaredModelsSourceUrl = MODEL_COLLECTIONS_BY_PROVIDER_ID[config.providerId]?.provider.modelsSourceUrl?.trim()
	if (declaredModelsSourceUrl) {
		return undefined
	}
	return modelPath
}

/**
 * Resolve the model list from the configured file. Throws the SDK's typed
 * `GGUFParseError` when the file cannot be read, which the catalog maps to a
 * `config`/`shape` error rather than an opaque `unknown`.
 *
 * `forceRefresh` reaches the SDK parser so a manual refresh re-reads a file
 * that changed on disk without its mtime moving (e.g. a restored backup).
 */
export async function resolveLocalModelFileModels(
	config: LocalModelFileConfig,
	options: { readonly forceRefresh?: boolean } = {},
): Promise<ReadonlyMap<string, ModelInfo>> {
	const models = await resolveLocalGGUFModels(config.providerId, {
		modelPath: config.modelPath,
		forceRefresh: options.forceRefresh,
		contextWindow: config.contextWindow,
	})
	return new Map(Object.entries(models))
}

/** Error code carried by the SDK's parse errors, when present. */
function readErrorCode(error: unknown): string | undefined {
	if (!isRecord(error)) {
		return undefined
	}
	const code = error.code
	return typeof code === "string" ? code : undefined
}

/**
 * Map a local model-file failure onto the catalog's structured error. Codes
 * come from `GGUFParseError` and keep their meaning:
 * - `ENOENT` / `NOT_A_GGUF_PATH` — the configured path is wrong (`config`).
 * - `NOT_GGUF` / `TRUNCATED` / `UNSUPPORTED_VERSION` — the file itself is
 *   unusable (`shape`).
 */
export function toLocalModelFileCatalogError(error: unknown): CatalogError {
	const code = readErrorCode(error)
	const message = error instanceof Error ? error.message : String(error)
	if (code === "ENOENT" || code === "NOT_A_GGUF_PATH") {
		return { kind: "config", message, code }
	}
	if (code) {
		return { kind: "shape", message, code }
	}
	return { kind: "unknown", message }
}
