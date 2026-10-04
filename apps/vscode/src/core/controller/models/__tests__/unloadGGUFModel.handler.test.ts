import { StringRequest } from "@shared/proto/cline/common"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { clearGgufRuntimeState, getGgufRuntimeState, setGgufRuntimeState } from "../ggufModelRuntime"
import { unloadGGUFModel } from "../unloadGGUFModel"

// Tasks 347-349. The runtime state holder is unit-tested in
// ggufModelRuntime.test.ts; this pins the handler's own decisions around it.

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn() },
}))

const MODEL_PATH = "C:/models/tiny.gguf"

function controller(): Controller {
	// Each call yields a distinct object so per-controller isolation holds.
	return {} as unknown as Controller
}

describe("unloadGGUFModel handler (tasks 347-349)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	// 347
	it("calls dispose() on the running handler", async () => {
		const target = controller()
		const handler = { dispose: vi.fn() }
		setGgufRuntimeState(target, {
			handler: handler as never,
			modelPath: MODEL_PATH,
			loadedAtMs: 1,
		})

		await unloadGGUFModel(target, StringRequest.create({ value: MODEL_PATH }))

		expect(handler.dispose).toHaveBeenCalledTimes(1)
	})

	// 348
	it("is a successful no-op when nothing is loaded", async () => {
		await expect(unloadGGUFModel(controller(), StringRequest.create({ value: MODEL_PATH }))).resolves.toBeDefined()
	})

	// 348 (cont.)
	it("leaves a different model's server running", async () => {
		const target = controller()
		const handler = { dispose: vi.fn() }
		setGgufRuntimeState(target, { handler: handler as never, modelPath: "C:/models/other.gguf", loadedAtMs: 1 })

		await unloadGGUFModel(target, StringRequest.create({ value: MODEL_PATH }))

		expect(handler.dispose).not.toHaveBeenCalled()
		expect(getGgufRuntimeState(target)).toBeDefined()
	})

	// 349
	it("clears the held reference after unloading", async () => {
		const target = controller()
		setGgufRuntimeState(target, { handler: { dispose: vi.fn() } as never, modelPath: MODEL_PATH, loadedAtMs: 1 })

		await unloadGGUFModel(target, StringRequest.create({ value: MODEL_PATH }))

		expect(getGgufRuntimeState(target)).toBeUndefined()
	})

	// 349 (negative) — a throwing dispose must not pin the controller forever.
	it("still releases the reference when dispose() throws", async () => {
		const target = controller()
		const handler = {
			dispose: vi.fn(() => {
				throw new Error("kill failed")
			}),
		}
		setGgufRuntimeState(target, { handler: handler as never, modelPath: MODEL_PATH, loadedAtMs: 1 })

		await expect(unloadGGUFModel(target, StringRequest.create({ value: MODEL_PATH }))).resolves.toBeDefined()
		expect(getGgufRuntimeState(target)).toBeUndefined()

		// Keep the module-level map clean for the next case.
		clearGgufRuntimeState(target)
	})
})
