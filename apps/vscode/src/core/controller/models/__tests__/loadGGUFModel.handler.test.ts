import { BUILT_IN_PROVIDER, GGUFInferenceHandler } from "@cline/llms"
import { LoadGGUFModelRequest } from "@shared/proto/cline/models"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { getGgufRuntimeState } from "../ggufModelRuntime"
import { loadGGUFModel } from "../loadGGUFModel"

// Handler-level coverage for tasks 341-345. The planner itself is unit-tested in
// ggufModelRuntime.test.ts; this file pins what the handler does around it:
// probe -> factory -> initialize -> hold state on the controller -> respond.

const mocks = vi.hoisted(() => ({
	detectLlamaServer: vi.fn(),
	createHandler: vi.fn(),
}))

vi.mock("@cline/llms", async (importOriginal: () => Promise<Record<string, unknown>>) => {
	const actual = await importOriginal()
	return {
		...actual,
		detectLlamaServer: mocks.detectLlamaServer,
		createHandler: mocks.createHandler,
	}
})

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn() },
}))

const MODEL_PATH = "C:/models/tiny.gguf"

function request(overrides: Partial<LoadGGUFModelRequest> = {}): LoadGGUFModelRequest {
	return LoadGGUFModelRequest.create({
		modelPath: MODEL_PATH,
		threads: 4,
		contextWindow: 4096,
		gpuLayers: 0,
		extraArgs: [],
		...overrides,
	})
}

/**
 * A real GGUFInferenceHandler with its process-touching methods stubbed. The
 * handler gates on `instanceof`, so a plain object would take the
 * "provider not registered" branch instead of the load path.
 */
function stubbedHandler(options: { initializeError?: Error } = {}) {
	const handler = new GGUFInferenceHandler({
		modelPath: MODEL_PATH,
		threads: 4,
		contextWindow: 4096,
		gpuLayers: 0,
	})
	const initialize = vi.spyOn(handler, "initialize").mockImplementation(async () => {
		if (options.initializeError) {
			throw options.initializeError
		}
	})
	const dispose = vi.spyOn(handler, "dispose").mockImplementation(() => {})
	return { handler, initialize, dispose }
}

describe("loadGGUFModel handler (tasks 341-345)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.detectLlamaServer.mockResolvedValue({ available: true, path: "C:/bin/llama-server.exe", version: "b1234" })
	})

	// 343 / 344 / 345
	it("loads, holds the live handler on the controller, and reports success", async () => {
		const { handler, initialize } = stubbedHandler()
		mocks.createHandler.mockReturnValue(handler)
		const controller = {} as unknown as Controller

		const response = await loadGGUFModel(controller, request())

		// The SDK factory (not a direct construction) owns handler creation, and it
		// routes on providerId — a config without it silently resolves to the
		// gateway handler instead of the local-gguf one.
		expect(mocks.createHandler).toHaveBeenCalledWith({
			providerId: BUILT_IN_PROVIDER.LOCAL_GGUF,
			modelId: "local-model",
			modelPath: MODEL_PATH,
			threads: 4,
			contextWindow: 4096,
			gpuLayers: 0,
		})
		expect(initialize).toHaveBeenCalledTimes(1)
		expect(response.success).toBe(true)
		expect(response.modelId).toBe("local-model")
		expect(response.error).toBe("")
		expect(response.serverVersion).toBe("b1234")
		// 345 — the live handler is retained for status/unload.
		expect(getGgufRuntimeState(controller)).toBeDefined()
	})

	// 341 / 342
	it("probes for llama-server before creating a handler and fails cleanly when missing", async () => {
		mocks.detectLlamaServer.mockResolvedValue({ available: false })

		const response = await loadGGUFModel({} as unknown as Controller, request())

		expect(mocks.detectLlamaServer).toHaveBeenCalledTimes(1)
		// No process may be spawned when the binary is absent.
		expect(mocks.createHandler).not.toHaveBeenCalled()
		expect(response.success).toBe(false)
		expect(response.error).toContain("llama-server")
		expect(response.error).toContain("llama.cpp")
	})

	// 342 (cont.) — path validation must win over the probe.
	it("rejects a bad path without probing", async () => {
		const response = await loadGGUFModel({} as unknown as Controller, request({ modelPath: "C:/models/notes.txt" }))

		expect(mocks.detectLlamaServer).not.toHaveBeenCalled()
		expect(response.success).toBe(false)
	})

	// 345 (negative) — a failed initialize must not leave a half-started process.
	it("disposes the handler when initialize() fails and still reports failure", async () => {
		const { handler } = stubbedHandler({ initializeError: new Error("exited with code 1") })
		mocks.createHandler.mockReturnValue(handler)
		const controller = {} as unknown as Controller

		const response = await loadGGUFModel(controller, request())

		// The failed instance must be torn down rather than left running, and
		// must not be retained as the controller's live model.
		expect(handler.dispose).toHaveBeenCalledTimes(1)
		expect(getGgufRuntimeState(controller)).toBeUndefined()
		expect(response.success).toBe(false)
		expect(response.error).toContain("exited with code 1")
	})

	// 343 (negative) — a build without the registered factory must fail loudly.
	it("fails when the provider is not registered in this build", async () => {
		mocks.createHandler.mockReturnValue({ initialize: vi.fn(), dispose: vi.fn() })

		const response = await loadGGUFModel({} as unknown as Controller, request())

		expect(response.success).toBe(false)
		expect(response.error).toContain("not registered")
	})
})
