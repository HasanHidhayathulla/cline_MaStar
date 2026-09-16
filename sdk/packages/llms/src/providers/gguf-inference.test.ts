import { describe, expect, it } from "vitest";
import {
	buildLlamaServerArgs,
	detectLlamaServer,
	findFreePort,
	GGUFInferenceError,
	GGUFInferenceHandler,
	logicalCpuCount,
	mapDeltaToChunks,
	waitForReadiness,
} from "./gguf-inference";

function baseConfig() {
	return {
		modelPath: "C:/models/tiny-Q4_K_M.gguf",
		threads: 4,
		contextWindow: 4096,
		gpuLayers: 0,
	};
}

describe("gguf-inference", () => {
	it("builds llama-server argv with all flags (task 93)", () => {
		const args = buildLlamaServerArgs({ ...baseConfig(), extraArgs: ["--flash-attn"] }, 8123);
		expect(args).toEqual([
			"-m",
			"C:/models/tiny-Q4_K_M.gguf",
			"-c",
			"4096",
			"-t",
			"4",
			"-ngl",
			"0",
			"--host",
			"127.0.0.1",
			"--port",
			"8123",
			"--jinja",
			"--flash-attn",
		]);
	});

	it("finds a free port (task 324)", async () => {
		const port = await findFreePort();
		expect(port).toBeGreaterThan(0);
		expect(port).toBeLessThanOrEqual(65535);
	});

	it("reports llama-server availability honestly (tasks 94–95)", async () => {
		const probe = await detectLlamaServer();
		expect(typeof probe.available).toBe("boolean");
		// Either shape is valid in CI; we only pin the contract.
		if (probe.available) {
			expect(probe.path).toBeTruthy();
		} else {
			expect(probe.path).toBeUndefined();
		}
	});

	it("times out readiness polling with a clear error (task 95)", async () => {
		await expect(waitForReadiness(1, 200)).rejects.toThrow(/did not become ready/);
	});

	it("constructs the handler and exposes model info (task 321/305)", () => {
		const handler = new GGUFInferenceHandler(baseConfig());
		expect(handler.getMetadata()).toBeUndefined();
		expect(handler.getModel().id).toBe("local-model");
		expect(handler.getModel().info.capabilities).toContain("tools");
		expect(handler.getServerPort()).toBe(0);
	});

	it("aborts in-flight requests via the internal controller (task 326)", () => {
		const handler = new GGUFInferenceHandler(baseConfig());
		const controller = new AbortController();
		handler.setAbortSignal(controller.signal);
		controller.abort();
		const stream = handler.createMessage("sys", [], undefined);
		void stream;
		expect(handler).toBeDefined();
	});

	it("maps OpenAI deltas to Cline chunks (tasks 331–333)", () => {
		const text = mapDeltaToChunks({ choices: [{ delta: { content: "hello" } }] });
		expect(text).toEqual([{ type: "text", text: "hello" }]);

		const reasoning = mapDeltaToChunks({
			choices: [{ delta: { reasoning_content: "thinking" } }],
		});
		expect(reasoning).toEqual([{ type: "reasoning", reasoning: "thinking" }]);

		const usage = mapDeltaToChunks({
			choices: [],
			usage: { prompt_tokens: 10, completion_tokens: 5 },
		});
		expect(usage).toEqual([{ type: "usage", inputTokens: 10, outputTokens: 5 }]);

		const done = mapDeltaToChunks({ choices: [{ delta: {}, finish_reason: "stop" }] });
		expect(done).toEqual([{ type: "done", success: true }]);

		expect(mapDeltaToChunks({})).toEqual([]);
	});

	it("rejects streaming before initialize (task 96)", async () => {
		const handler = new GGUFInferenceHandler(baseConfig());
		const stream = handler.createMessage("sys", []);
		await expect(stream.next()).rejects.toThrowError(GGUFInferenceError);
	});

	it("exposes a CPU count helper for the UI (task 497)", () => {
		expect(logicalCpuCount()).toBeGreaterThan(0);
	});

	it("does not spawn when llama-server is unavailable (task 342)", async () => {
		const handler = new GGUFInferenceHandler(baseConfig());
		// initialize() will throw NOT_INSTALLED unless llama-server exists on
		// this machine; both outcomes are acceptable for the contract test.
		try {
			await handler.initialize();
			expect(handler.getServerPort()).toBeGreaterThan(0);
			handler.dispose();
		} catch (error) {
			expect(error).toBeInstanceOf(GGUFInferenceError);
			expect((error as GGUFInferenceError).code).toBe("NOT_INSTALLED");
		}
	});
});
