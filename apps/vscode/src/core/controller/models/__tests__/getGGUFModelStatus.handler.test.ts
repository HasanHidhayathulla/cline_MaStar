import { getRunningServer } from "@cline/llms"
import { StringRequest } from "@shared/proto/cline/common"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../.."
import { getGGUFModelStatus } from "../getGGUFModelStatus"
import { setGgufRuntimeState } from "../ggufModelRuntime"

// Tasks 351-353. toGgufStatusSnapshot (the projector) is unit-tested in
// ggufModelRuntime.test.ts; this pins which state the handler feeds it.

const mocks = vi.hoisted(() => ({
	getRunningServer: vi.fn(),
	fetch: vi.fn(),
}))

vi.mock("@cline/llms", async (importOriginal: () => Promise<Record<string, unknown>>) => {
	const actual = await importOriginal()
	return { ...actual, getRunningServer: mocks.getRunningServer }
})

vi.mock("@/shared/net", () => ({ fetch: (...args: unknown[]) => mocks.fetch(...args) }))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), log: vi.fn() },
}))

const MODEL_PATH = "C:/models/tiny.gguf"

function loadedController(port = 8080): Controller {
	const controller = {} as unknown as Controller
	setGgufRuntimeState(controller, {
		handler: { getServerPort: () => port, dispose: vi.fn() } as never,
		modelPath: MODEL_PATH,
		loadedAtMs: Date.now() - 5_000,
	})
	return controller
}

describe("getGGUFModelStatus handler (tasks 351-353)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.getRunningServer.mockReturnValue(undefined)
		// Memory is optional: an older llama-server has no /system/info.
		mocks.fetch.mockRejectedValue(new Error("no such endpoint"))
		vi.stubGlobal("fetch", mocks.fetch)
	})

	// 351
	it("reports loaded:false when the controller holds no server", async () => {
		const status = await getGGUFModelStatus({} as unknown as Controller, StringRequest.create({ value: MODEL_PATH }))

		expect(status.loaded).toBe(false)
		expect(status.pid ?? 0).toBe(0)
		expect(status.memoryBytes ?? 0).toBe(0)
	})

	// 352
	it("reports the live pid and memory when the process is running", async () => {
		mocks.getRunningServer.mockReturnValue({ pid: 4321 })
		mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ rss_bytes: 2_000_000_000 }) })

		const status = await getGGUFModelStatus(loadedController(), StringRequest.create({ value: MODEL_PATH }))

		expect(status.loaded).toBe(true)
		expect(status.modelPath).toBe(MODEL_PATH)
		expect(Number(status.pid)).toBe(4321)
		expect(Number(status.memoryBytes)).toBe(2_000_000_000)
	})

	// 353
	it("reports loaded:false once the child process is gone", async () => {
		// getRunningServer returns nothing once the SDK registry drops the child
		// on exit, even though the controller still holds a reference.
		mocks.getRunningServer.mockReturnValue(undefined)

		const status = await getGGUFModelStatus(loadedController(), StringRequest.create({ value: MODEL_PATH }))

		expect(status.loaded).toBe(false)
		expect(Number(status.pid ?? 0)).toBe(0)
	})

	// 352 (negative) — a /system/info failure must not fail the whole status.
	it("omits memory when the optional system-info probe fails", async () => {
		mocks.getRunningServer.mockReturnValue({ pid: 99 })
		mocks.fetch.mockRejectedValue(new Error("boom"))

		const status = await getGGUFModelStatus(loadedController(), StringRequest.create({ value: MODEL_PATH }))

		expect(status.loaded).toBe(true)
		expect(Number(status.memoryBytes ?? 0)).toBe(0)
	})

	it("does not report a different model's server as loaded for this path", async () => {
		const controller = {} as unknown as Controller
		setGgufRuntimeState(controller, {
			handler: { getServerPort: () => 1234, dispose: vi.fn() } as never,
			modelPath: "C:/models/other.gguf",
			loadedAtMs: Date.now(),
		})

		const status = await getGGUFModelStatus(controller, StringRequest.create({ value: MODEL_PATH }))

		expect(status.loaded).toBe(false)
	})
})

// Referenced only to document that the handler reads through the SDK registry.
void getRunningServer
