/**
 * Reads GGUF header metadata for a model file without loading it (tasks 153–158).
 *
 * The path comes from `request.value` (the same selection the settings UI
 * persists as `modelPath` in providers.json). Parsing and path validation live
 * in the SDK / `ggufModelRuntime.ts`; this module is the proto adapter.
 *
 * File name and export must match the `getGGUFMetadata` RPC: the ProtoBus setup
 * (`scripts/generate-protobus-setup.mjs`) imports
 * `@core/controller/models/getGGUFMetadata` and registers that exact symbol.
 */
import { GGUFMetadataResponse } from "@shared/proto/cline/models"
import { StringRequest } from "@shared/proto/cline/common"
import { parseGGUFMetadataFromFile } from "@cline/llms"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { assertGgufModelPath, toGgufHandlerFailureMessage } from "./ggufModelRuntime"

export async function getGGUFMetadata(_controller: Controller, request: StringRequest): Promise<GGUFMetadataResponse> {
	const modelPath = request.value?.trim() ?? ""
	try {
		assertGgufModelPath(modelPath)
		const metadata = await parseGGUFMetadataFromFile(modelPath)
		return GGUFMetadataResponse.create({
			architecture: metadata.architecture,
			modelType: metadata.modelType,
			parameterCount: metadata.parameterCount,
			contextLength: metadata.contextLength,
			embeddingLength: metadata.embeddingLength,
			fileSize: metadata.fileSize,
			quantization: metadata.quantization,
			// `general.name` is the display name; fall back to `modelType`
			// (which is also what `GGUFInferenceHandler.getModel()` shows).
			modelName: metadata.name || metadata.modelType,
			description: metadata.description,
		})
	} catch (error) {
		Logger.error(`Failed to read GGUF metadata for ${modelPath || "<unset>"}:`, error)
		throw new Error(toGgufHandlerFailureMessage(error))
	}
}
