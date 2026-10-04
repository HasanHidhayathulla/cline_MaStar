import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GGUFInferenceError,
	GGUFInferenceHandler,
	getRunningServer,
} from "./gguf-inference";

// Process lifecycle (tasks 327/328) and the request-shaping paths (329/333).
// These need a controllable `spawn`, a successful PATH probe, and a readable
// model file, so they live in their own file with module mocks rather than
// sharing the contract-only suite in `gguf-inference.test.ts`.

const fakeChild = {
	exitCode: null as number | null,
	killed: false,
	kill: vi.fn(),
	once: vi.fn(),
	stderr: { on: vi.fn() },
	pid: 4242,
};

const spawnMock = vi.fn(() => fakeChild);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		spawn: (...args: unknown[]) => spawnMock(...args),
		// `detectLlamaServer` promisifies this, so it must stay callback-shaped:
		// one call to locate the binary, one more for `--version`.
		execFile: (
			_command: string,
			_args: string[],
			callback: (
				error: Error | null,
				result: { stdout: string; stderr: string },
			) => void,
		) =>
			callback(null, {
				stdout: "C:/bin/llama-server.exe\nb1234\n",
				stderr: "",
			}),
	};
});

vi.mock("./gguf-parser", async (importOriginal) => {
	const actual = await importOriginal<Record<string, unknown>>();
	return {
		...actual,
		parseGGUFMetadataFromFile: vi.fn(async () => ({
			architecture: "llama",
			modelType: "llama",
			name: "TinyLlama",
			contextLength: 4096,
			fileSize: 1024,
			quantization: "Q4_K_M",
			description: "",
		})),
	};
});

const config = {
	modelPath: "C:/models/tiny-Q4_K_M.gguf",
	threads: 4,
	contextWindow: 4096,
	gpuLayers: 0,
};

describe("gguf-inference process lifecycle", () => {
	beforeEach(() => {
		spawnMock.mockClear();
		fakeChild.kill.mockClear();
		fakeChild.exitCode = null;
		fakeChild.killed = false;
		// Readiness probe: any 200 makes initialize() resolve immediately.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, status: 200 })),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		// Leave the module-level registry clean between cases.
		new GGUFInferenceHandler(config).dispose();
	});

	// 328
	it("reuses one llama-server per model path instead of spawning twice", async () => {
		const first = new GGUFInferenceHandler(config);
		await first.initialize();
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(getRunningServer(config.modelPath)).toBe(fakeChild);

		const second = new GGUFInferenceHandler(config);
		await second.initialize();

		// The second handler adopts the running child rather than spawning.
		expect(spawnMock).toHaveBeenCalledTimes(1);
		expect(getRunningServer(config.modelPath)).toBe(fakeChild);
		expect(second.getServerPort()).toBeGreaterThan(0);
	});

	// 327
	it("dispose() kills the child process and releases the registry entry", async () => {
		const handler = new GGUFInferenceHandler(config);
		await handler.initialize();
		expect(fakeChild.kill).not.toHaveBeenCalled();

		handler.dispose();

		expect(fakeChild.kill).toHaveBeenCalledTimes(1);
		expect(getRunningServer(config.modelPath)).toBeUndefined();
		expect(handler.getServerPort()).toBe(0);
	});

	// 327 — killing an already-dead child must not throw (idempotence).
	it("dispose() is a no-op when the child already exited", async () => {
		const handler = new GGUFInferenceHandler(config);
		await handler.initialize();
		fakeChild.exitCode = 1;

		expect(() => handler.dispose()).not.toThrow();
		expect(fakeChild.kill).not.toHaveBeenCalled();
	});

	// 329
	it("getMessages() builds an OpenAI chat-completions payload", () => {
		const handler = new GGUFInferenceHandler(config);
		const payload = handler.getMessages("you are helpful", [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]) as { messages: Array<{ role: string; content: string }> };

		expect(payload.messages).toEqual([
			{ role: "system", content: "you are helpful" },
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi" },
		]);
	});

	it("getMessages() omits the system message when the prompt is empty", () => {
		const handler = new GGUFInferenceHandler(config);
		const payload = handler.getMessages("", [
			{ role: "user", content: "hello" },
		]) as {
			messages: Array<{ role: string }>;
		};

		expect(payload.messages).toEqual([{ role: "user", content: "hello" }]);
	});

	// 333 — the checklist said "finished-error chunk"; the implementation rejects
	// the stream with a typed error instead, so pin the real contract.
	it("surfaces a non-OK HTTP response as a SERVER_ERROR", async () => {
		const handler = new GGUFInferenceHandler(config);
		await handler.initialize();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 503 })),
		);

		const stream = handler.createMessage("sys", [
			{ role: "user", content: "hi" },
		]);
		// A generator that has thrown is `done` on every later `next()`, so the
		// rejection has to be captured from the first pull.
		const error = await stream.next().then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(GGUFInferenceError);
		expect((error as GGUFInferenceError).code).toBe("SERVER_ERROR");
		expect((error as GGUFInferenceError).message).toContain("503");
	});
});
