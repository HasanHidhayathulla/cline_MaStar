import { GGUFParseError, type GGUFInferenceHandler } from "@cline/llms"
import { describe, expect, it } from "bun:test"
import {
	assertGgufModelPath,
	clearGgufRuntimeState,
	DEFAULT_GGUF_CONTEXT_WINDOW,
	DEFAULT_GGUF_GPU_LAYERS,
	DEFAULT_GGUF_THREADS,
	getGgufRuntimeState,
	llamaServerMissingMessage,
	LLAMA_CPP_DOCS_URL,
	normalizeGgufInferenceConfig,
	planGgufLoad,
	readSystemInfoMemoryBytes,
	setGgufRuntimeState,
	toGgufHandlerErrorMessage,
	toGgufHandlerFailureMessage,
	toGgufStatusSnapshot,
} from "../ggufModelRuntime"

function fakeHandler(port: number): GGUFInferenceHandler {
	return { getServerPort: () => port } as unknown as GGUFInferenceHandler
}

describe("normalizeGgufInferenceConfig (task 160)", () => {
	it("applies the provider-spec defaults for an under-specified request", () => {
		expect(normalizeGgufInferenceConfig({ modelPath: " /models/tiny.gguf " })).toEqual({
			modelPath: "/models/tiny.gguf",
			threads: DEFAULT_GGUF_THREADS,
			contextWindow: DEFAULT_GGUF_CONTEXT_WINDOW,
			gpuLayers: DEFAULT_GGUF_GPU_LAYERS,
		})
	})

	it("keeps explicit values, including gpuLayers: 0 (CPU only)", () => {
		expect(
			normalizeGgufInferenceConfig({
				modelPath: "/models/tiny.gguf",
				threads: 8,
				contextWindow: 32768,
				gpuLayers: 0,
			}),
		).toEqual({ modelPath: "/models/tiny.gguf", threads: 8, contextWindow: 32768, gpuLayers: 0 })
	})

	it("rejects nonsensical numbers instead of forwarding them to llama-server", () => {
		const config = normalizeGgufInferenceConfig({
			modelPath: "/models/tiny.gguf",
			threads: 0,
			contextWindow: -1,
			gpuLayers: Number.NaN,
		})

		expect(config.threads).toBe(DEFAULT_GGUF_THREADS)
		expect(config.contextWindow).toBe(DEFAULT_GGUF_CONTEXT_WINDOW)
		expect(config.gpuLayers).toBe(DEFAULT_GGUF_GPU_LAYERS)
	})

	it("drops blank extra args and never emits an empty array", () => {
		expect(normalizeGgufInferenceConfig({ modelPath: "/m.gguf", extraArgs: ["  ", ""] }).extraArgs).toBeUndefined()
		expect(normalizeGgufInferenceConfig({ modelPath: "/m.gguf", extraArgs: [" --flash-attn ", ""] }).extraArgs).toEqual([
			"--flash-attn",
		])
	})
})

describe("llamaServerMissingMessage (task 162)", () => {
	it("names the binary and links the install guide", () => {
		const message = llamaServerMissingMessage()

		expect(message).toContain("llama-server")
		expect(message).toContain(LLAMA_CPP_DOCS_URL)
	})
})

describe("readSystemInfoMemoryBytes (task 172)", () => {
	it("reads the known /system/info shapes", () => {
		expect(readSystemInfoMemoryBytes({ rss_bytes: 1024.7 })).toBe(1024)
		expect(readSystemInfoMemoryBytes({ rss: 2048 })).toBe(2048)
		expect(readSystemInfoMemoryBytes({ memory_bytes: 4096 })).toBe(4096)
		expect(readSystemInfoMemoryBytes({ system_info: { rss_bytes: 8192 } })).toBe(8192)
		expect(readSystemInfoMemoryBytes({ system_info: { rss: 16384 } })).toBe(16384)
	})

	it("returns undefined rather than guessing when the endpoint is absent or unexpected", () => {
		expect(readSystemInfoMemoryBytes(undefined)).toBeUndefined()
		expect(readSystemInfoMemoryBytes("nope")).toBeUndefined()
		expect(readSystemInfoMemoryBytes({ rss_bytes: "1024" })).toBeUndefined()
		expect(readSystemInfoMemoryBytes({ rss_bytes: -5 })).toBeUndefined()
		expect(readSystemInfoMemoryBytes({ something_else: 1 })).toBeUndefined()
	})
})

describe("assertGgufModelPath (tasks 156/176)", () => {
	/** Capture the thrown value without casts or bracket-string matching. */
	function thrownBy(fn: () => void): unknown {
		try {
			fn()
		} catch (error) {
			return error
		}
		throw new Error("expected the function to throw")
	}

	it("narrows a valid path and accepts an uppercase extension", () => {
		const valid: string | undefined = "/models/tiny.gguf"
		assertGgufModelPath(valid)
		expect(valid.endsWith(".gguf")).toBe(true)

		expect(() => assertGgufModelPath("/models/TINY.GGUF")).not.toThrow()
	})

	it("rejects blank paths with the ENOENT code", () => {
		expect(thrownBy(() => assertGgufModelPath(""))).toMatchObject({
			name: "GGUFParseError",
			code: "ENOENT",
		})
		expect(thrownBy(() => assertGgufModelPath("   "))).toMatchObject({ code: "ENOENT" })
		expect(thrownBy(() => assertGgufModelPath(undefined))).toMatchObject({ code: "ENOENT" })
	})

	it("rejects other extensions with the NOT_A_GGUF_PATH code", () => {
		expect(thrownBy(() => assertGgufModelPath("/models/tiny.bin"))).toMatchObject({
			name: "GGUFParseError",
			code: "NOT_A_GGUF_PATH",
		})
	})
})

describe("toGgufHandlerErrorMessage / toGgufHandlerFailureMessage (task 158)", () => {
	it("preserves the SDK error code", () => {
		expect(toGgufHandlerErrorMessage(new GGUFParseError("NOT_GGUF", "bad magic"))).toEqual({
			code: "NOT_GGUF",
			message: "bad magic",
		})
	})

	it("falls back to UNKNOWN for untyped failures", () => {
		expect(toGgufHandlerErrorMessage(new Error("boom"))).toEqual({ code: "UNKNOWN", message: "boom" })
		expect(toGgufHandlerErrorMessage("plain string")).toEqual({ code: "UNKNOWN", message: "plain string" })
	})

	it("reads a code off non-GGUF error classes too", () => {
		const error = Object.assign(new Error("not installed"), { code: "NOT_INSTALLED" })

		expect(toGgufHandlerErrorMessage(error)).toEqual({ code: "NOT_INSTALLED", message: "not installed" })
	})

	it("builds a single user-facing message carrying the code and docs link", () => {
		const message = toGgufHandlerFailureMessage(new GGUFParseError("NOT_GGUF", "bad magic"))

		expect(message).toContain("[NOT_GGUF]")
		expect(message).toContain("bad magic")
		expect(message).toContain(LLAMA_CPP_DOCS_URL)
	})
})

describe("planGgufLoad (tasks 161/162/176)", () => {
	it("rejects a blank path before probing for llama-server", () => {
		const plan = planGgufLoad({ modelPath: "   " }, { available: true })

		expect(plan).toEqual({ kind: "reject", error: expect.stringContaining("[ENOENT]") })
	})

	it("rejects a non-.gguf path before probing for llama-server", () => {
		const plan = planGgufLoad({ modelPath: "/models/tiny.bin" }, { available: true })

		expect(plan).toEqual({ kind: "reject", error: expect.stringContaining("[NOT_A_GGUF_PATH]") })
	})

	it("rejects with install guidance when llama-server is missing (task 178)", () => {
		const plan = planGgufLoad({ modelPath: "/models/tiny.gguf" }, { available: false })

		expect(plan.kind).toBe("reject")
		if (plan.kind !== "reject") {
			throw new Error("expected a rejection when llama-server is missing")
		}
		expect(plan.error).toBe(llamaServerMissingMessage())
	})

	it("proceeds with the normalized config when path and probe are fine", () => {
		const plan = planGgufLoad({ modelPath: "/models/tiny.gguf", threads: 8 }, { available: true })

		expect(plan).toEqual({
			kind: "load",
			config: expect.objectContaining({ modelPath: "/models/tiny.gguf", threads: 8 }),
		})
	})
})

describe("GGUF runtime state ownership (task 164)", () => {
	it("holds and releases state per controller instance", () => {
		const controllerA = {}
		const controllerB = {}
		const state = { handler: fakeHandler(51000), modelPath: "/models/tiny.gguf", loadedAtMs: 1_000 }

		expect(getGgufRuntimeState(controllerA)).toBeUndefined()
		setGgufRuntimeState(controllerA, state)

		expect(getGgufRuntimeState(controllerA)).toBe(state)
		// A different controller cannot observe or unload this model.
		expect(getGgufRuntimeState(controllerB)).toBeUndefined()

		clearGgufRuntimeState(controllerA)
		expect(getGgufRuntimeState(controllerA)).toBeUndefined()
	})
})

describe("toGgufStatusSnapshot (tasks 171/173)", () => {
	it("reports an unloaded model with zeroed numerics", () => {
		expect(toGgufStatusSnapshot({ nowMs: 5_000 })).toEqual({
			loaded: false,
			modelPath: "",
			pid: 0,
			port: 0,
			uptimeSeconds: 0,
			memoryBytes: 0,
		})
	})

	it("reports a live model with port, pid, uptime and memory", () => {
		const snapshot = toGgufStatusSnapshot({
			state: { handler: fakeHandler(51234), modelPath: "/models/tiny.gguf", loadedAtMs: 1_000 },
			nowMs: 91_500,
			pid: 4242,
			memoryBytes: 268_435_456,
		})

		expect(snapshot).toEqual({
			loaded: true,
			modelPath: "/models/tiny.gguf",
			pid: 4242,
			port: 51234,
			uptimeSeconds: 90,
			memoryBytes: 268_435_456,
		})
	})

	it("zeroes unknown pid/memory and clamps a negative uptime", () => {
		const snapshot = toGgufStatusSnapshot({
			state: { handler: fakeHandler(51234), modelPath: "/models/tiny.gguf", loadedAtMs: 10_000 },
			nowMs: 5_000,
		})

		expect(snapshot.pid).toBe(0)
		expect(snapshot.memoryBytes).toBe(0)
		expect(snapshot.uptimeSeconds).toBe(0)
	})
})
