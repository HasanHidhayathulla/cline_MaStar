/**
 * Loads a local `.gguf` model into a `llama-server` process (tasks 159–165).
 *
 * The handler is a thin adapter: request normalisation, install detection,
 * process ownership and status projection all live in `ggufModelRuntime.ts` /
 * the SDK's inference bridge so they can be tested without generated proto.
 */
import { createHandler, detectLlamaServer, GGUFInferenceError, GGUFInferenceHandler } from "@cline/llms"
import { LoadGGUFModelRequest, LoadGGUFModelResponse } from "@shared/proto/cline/models"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { LOCAL_GGUF_MODEL_ID, planGgufLoad, setGgufRuntimeState } from "./ggufModelRuntime"

/** Failure response carrying the user-actionable reason. */
function failed(error: string, serverVersion = ""): LoadGGUFModelResponse {
	return LoadGGUFModelResponse.create({
		success: false,
		modelId: LOCAL_GGUF_MODEL_ID,
		error,
		serverVersion,
	})
}

function describeLoadError(error: unknown): string {
	if (error instanceof GGUFInferenceError) {
		return `[${error.code}] ${error.message}`
	}
	return error instanceof Error ? error.message : String(error)
}

export async function loadGGUFModel(controller: Controller, request: LoadGGUFModelRequest): Promise<LoadGGUFModelResponse> {
	// Tasks 161–162/176 — the whole "should this spawn?" decision, including
	// the `llama-server` PATH probe, is owned by the testable planner.
	const probe = await detectLlamaServer()
	const plan = planGgufLoad(request, probe)
	if (plan.kind === "reject") {
		return failed(plan.error, probe.version ?? "")
	}
	const config = plan.config

	// Task 163 — the builtin `local-gguf` factory is registered by the SDK.
	const handler = createHandler(config)
	if (!(handler instanceof GGUFInferenceHandler)) {
		return failed("The local GGUF provider is not registered in this build")
	}

	try {
		// Spawns (or reuses) the server for this path and waits for readiness.
		await handler.initialize()
	} catch (error) {
		// Never leave a half-started process behind.
		handler.dispose()
		Logger.error("Failed to load local GGUF model:", error)
		return failed(describeLoadError(error), probe.version ?? "")
	}

	// Task 164 — hold the process reference on the controller instance.
	setGgufRuntimeState(controller, {
		handler,
		modelPath: config.modelPath,
		loadedAtMs: Date.now(),
	})

	// Task 165.
	return LoadGGUFModelResponse.create({
		success: true,
		modelId: LOCAL_GGUF_MODEL_ID,
		error: "",
		serverVersion: probe.version ?? "",
	})
}
