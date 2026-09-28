/**
 * Unloads the running local `.gguf` model (tasks 166–169).
 *
 * Idempotent by design: unloading when nothing is loaded, or when a different
 * model path is loaded, is a successful no-op — the caller only needs the
 * post-condition "this file is not running".
 */
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { clearGgufRuntimeState, getGgufRuntimeState } from "./ggufModelRuntime"

export async function unloadGGUFModel(controller: Controller, request: StringRequest): Promise<Empty> {
	const requestedPath = request.value?.trim() ?? ""
	const state = getGgufRuntimeState(controller)

	// Task 169 — nothing loaded for this controller.
	if (!state) {
		return Empty.create({})
	}
	// A different model is loaded; leave it running.
	if (requestedPath && requestedPath !== state.modelPath) {
		return Empty.create({})
	}

	// Tasks 167–168 — kill the child (also removes it from the SDK's
	// running-server registry) and release our reference either way, so a
	// failed kill cannot leave the controller pinning a dead process.
	try {
		state.handler.dispose()
	} catch (error) {
		Logger.error(`Failed to dispose llama-server for ${state.modelPath}:`, error)
	} finally {
		clearGgufRuntimeState(controller)
	}

	return Empty.create({})
}
