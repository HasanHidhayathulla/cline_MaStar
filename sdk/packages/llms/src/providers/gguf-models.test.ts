import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
	clearLocalGGUFModelCache,
	DEFAULT_LOCAL_GGUF_CONTEXT_WINDOW,
	DEFAULT_LOCAL_GGUF_MAX_TOKENS,
	LOCAL_GGUF_MODEL_ID,
	resolveLocalGGUFModels,
} from "./gguf-models";
import { GGUFParseError } from "./gguf-parser";

const VISION_KEY = "clip.has_vision_encoder";
const FIXTURE_MTIME = new Date("2024-01-01T00:00:00Z");

let fixtureDir: string;

function nextFixturePath(fileName: string): string {
	if (!fixtureDir) {
		fixtureDir = mkdtempSync(join(tmpdir(), "cline-gguf-models-"));
	}
	return join(fixtureDir, fileName);
}

afterAll(() => {
	if (fixtureDir) {
		rmSync(fixtureDir, { recursive: true, force: true });
	}
});

beforeEach(() => {
	clearLocalGGUFModelCache();
});

// ---------------------------------------------------------------------------
// Minimal GGUF writer (mirrors the encoding used by gguf-parser.test.ts).
// ---------------------------------------------------------------------------

function pushU64(bytes: number[], value: number): void {
	bytes.push(
		value & 0xff,
		(value >>> 8) & 0xff,
		(value >>> 16) & 0xff,
		(value >>> 24) & 0xff,
		0,
		0,
		0,
		0,
	);
}

function pushU32(bytes: number[], value: number): void {
	bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushString(bytes: number[], value: string): void {
	const encoded = Buffer.from(value, "utf8");
	pushU64(bytes, encoded.length);
	for (const byte of encoded) {
		bytes.push(byte);
	}
}

function stringValue(value: string): number[] {
	const out: number[] = [];
	pushString(out, value);
	return out;
}

function u32Value(value: number): number[] {
	const out: number[] = [];
	pushU32(out, value);
	return out;
}

const GGUF_STRING = 8;
const GGUF_UINT32 = 4;
const GGUF_BOOL = 7;

interface GGUFKeyValue {
	key: string;
	type: number;
	value: number[];
}

/** Minimal valid GGUF header: magic + v3 + 0 tensors + N metadata entries. */
function buildGGUF(kvs: GGUFKeyValue[]): Buffer {
	const bytes: number[] = [0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0];
	for (let i = 0; i < 8; i += 1) {
		bytes.push(0); // tensor count = 0
	}
	pushU64(bytes, kvs.length); // metadata KV count
	for (const kv of kvs) {
		pushString(bytes, kv.key);
		pushU32(bytes, kv.type);
		bytes.push(...kv.value);
	}
	return Buffer.from(bytes);
}

function llamaKeyValues(options: {
	name?: string;
	description?: string;
	contextLength?: number;
	architecture?: string;
	vision?: boolean;
}): GGUFKeyValue[] {
	const kvs: GGUFKeyValue[] = [
		{
			key: "general.architecture",
			type: GGUF_STRING,
			value: stringValue(options.architecture ?? "llama"),
		},
	];
	if (options.name !== undefined) {
		kvs.push({ key: "general.name", type: GGUF_STRING, value: stringValue(options.name) });
	}
	if (options.description !== undefined) {
		kvs.push({
			key: "general.description",
			type: GGUF_STRING,
			value: stringValue(options.description),
		});
	}
	if (options.contextLength !== undefined) {
		kvs.push({
			key: `${options.architecture ?? "llama"}.context_length`,
			type: GGUF_UINT32,
			value: u32Value(options.contextLength),
		});
	}
	if (options.vision) {
		kvs.push({ key: VISION_KEY, type: GGUF_BOOL, value: [1] });
	}
	return kvs;
}

/** Write a fixture and pin its mtime so cache tests are filesystem-independent. */
function writeFixture(fileName: string, body: Buffer): string {
	const path = nextFixturePath(fileName);
	writeFileSync(path, body);
	utimesSync(path, FIXTURE_MTIME, FIXTURE_MTIME);
	return path;
}

describe("resolveLocalGGUFModels (tasks 116–124)", () => {
	it("builds a single local-model entry from parsed metadata (tasks 117–122)", async () => {
		const modelPath = writeFixture(
			"TinyTest-Q4_K_M.gguf",
			buildGGUF(
				llamaKeyValues({
					name: "TinyTest",
					description: "A tiny test model",
					contextLength: 8192,
				}),
			),
		);

		const models = await resolveLocalGGUFModels("local-gguf", { modelPath });

		expect(Object.keys(models)).toEqual([LOCAL_GGUF_MODEL_ID]);
		const info = models[LOCAL_GGUF_MODEL_ID];
		expect(info.id).toBe(LOCAL_GGUF_MODEL_ID);
		expect(info.name).toBe("TinyTest");
		expect(info.description).toBe("A tiny test model");
		expect(info.contextWindow).toBe(8192);
		expect(info.maxTokens).toBe(DEFAULT_LOCAL_GGUF_MAX_TOKENS);
		// `supportsTools` is the `tools` capability in the SDK model shape.
		expect(info.capabilities).toEqual(["tools"]);
	});

	it("narrows the context window to the configured value and never widens it (tasks 120/420)", async () => {
		const modelPath = writeFixture(
			"Windowed.gguf",
			buildGGUF(llamaKeyValues({ name: "Windowed", contextLength: 32768 })),
		);

		const narrowed = await resolveLocalGGUFModels("local-gguf", {
			modelPath,
			contextWindow: 4096,
		});
		expect(narrowed[LOCAL_GGUF_MODEL_ID].contextWindow).toBe(4096);

		const widened = await resolveLocalGGUFModels("local-gguf", {
			modelPath,
			contextWindow: 131072,
		});
		expect(widened[LOCAL_GGUF_MODEL_ID].contextWindow).toBe(32768);
	});

	it("returns an empty record when no model file is configured (task 116)", async () => {
		expect(await resolveLocalGGUFModels("local-gguf", {})).toEqual({});
		expect(await resolveLocalGGUFModels("local-gguf", { modelPath: "   " })).toEqual({});
	});

	it("falls back to the filename stem for a header with no usable metadata (task 124)", async () => {
		const modelPath = writeFixture("bare-model-Q5_0.gguf", buildGGUF([]));

		const models = await resolveLocalGGUFModels("local-gguf", { modelPath });
		const info = models[LOCAL_GGUF_MODEL_ID];
		expect(info.name).toBe("bare-model-Q5_0");
		expect(info.description).toBeUndefined();
		// Declared default from the provider's own `contextWindow` config field.
		expect(info.contextWindow).toBe(DEFAULT_LOCAL_GGUF_CONTEXT_WINDOW);
		expect(info.capabilities).toEqual(["tools"]);
	});

	it("flags vision-capable files as image-input models (task 123, OPT)", async () => {
		const modelPath = writeFixture(
			"llava-v1.6.gguf",
			buildGGUF(llamaKeyValues({ name: "LLaVA", architecture: "llava", vision: true })),
		);

		const models = await resolveLocalGGUFModels("local-gguf", { modelPath });
		const info = models[LOCAL_GGUF_MODEL_ID];
		expect(info.capabilities).toEqual(["tools", "images"]);
		expect(info.modalities).toEqual({ input: ["text", "image"], output: ["text"] });
	});
});

describe("resolveLocalGGUFModels caching and failures (tasks 125–131)", () => {
	it("serves a cache hit while mtime and size are unchanged, and re-reads on forceRefresh (tasks 126/127/129)", async () => {
		const { _testing } = await import("./gguf-models");
		// Same byte length in both revisions, so only the mtime could tell them apart.
		const modelPath = writeFixture(
			"Cached.gguf",
			buildGGUF(llamaKeyValues({ name: "alpha" })),
		);

		const first = await resolveLocalGGUFModels("local-gguf", { modelPath });
		expect(first[LOCAL_GGUF_MODEL_ID].name).toBe("alpha");
		expect(_testing.cacheSize()).toBe(1);

		// Rewrite the file on disk, then restore the original mtime: a cache hit
		// must return the *first* parse, proving the file was not re-read.
		writeFileSync(modelPath, buildGGUF(llamaKeyValues({ name: "bravo" })));
		utimesSync(modelPath, FIXTURE_MTIME, FIXTURE_MTIME);

		const cached = await resolveLocalGGUFModels("local-gguf", { modelPath });
		expect(cached[LOCAL_GGUF_MODEL_ID].name).toBe("alpha");
		expect(_testing.cacheSize()).toBe(1);

		// forceRefresh bypasses the cache and re-parses the current bytes.
		const refreshed = await resolveLocalGGUFModels("local-gguf", {
			modelPath,
			forceRefresh: true,
		});
		expect(refreshed[LOCAL_GGUF_MODEL_ID].name).toBe("bravo");

		// The fresh parse replaced the cached entry.
		const afterRefresh = await resolveLocalGGUFModels("local-gguf", { modelPath });
		expect(afterRefresh[LOCAL_GGUF_MODEL_ID].name).toBe("bravo");
	});

	it("re-reads when the file's mtime moves on (task 127)", async () => {
		const modelPath = writeFixture(
			"Stamped.gguf",
			buildGGUF(llamaKeyValues({ name: "before" })),
		);
		await resolveLocalGGUFModels("local-gguf", { modelPath });

		const later = new Date("2024-06-01T00:00:00Z");
		writeFileSync(modelPath, buildGGUF(llamaKeyValues({ name: "after" })));
		utimesSync(modelPath, later, later);

		const models = await resolveLocalGGUFModels("local-gguf", { modelPath });
		expect(models[LOCAL_GGUF_MODEL_ID].name).toBe("after");
	});

	it("clears cached parses on demand", async () => {
		const { _testing } = await import("./gguf-models");
		const modelPath = writeFixture(
			"Cleared.gguf",
			buildGGUF(llamaKeyValues({ name: "cleared" })),
		);
		await resolveLocalGGUFModels("local-gguf", { modelPath });
		expect(_testing.cacheSize()).toBe(1);

		clearLocalGGUFModelCache();
		expect(_testing.cacheSize()).toBe(0);
		expect(_testing.getCachedMetadata(modelPath)).toBeUndefined();
	});

	it("throws a typed ENOENT error for a missing file (task 130)", async () => {
		const modelPath = nextFixturePath("does-not-exist.gguf");
		await expect(resolveLocalGGUFModels("local-gguf", { modelPath })).rejects.toMatchObject({
			name: "GGUFParseError",
			code: "ENOENT",
		});
	});

	it("throws a typed NOT_GGUF error for a corrupted file (task 131)", async () => {
		const modelPath = writeFixture(
			"corrupted.gguf",
			Buffer.from("THIS IS NOT A GGUF FILE, IT IS PLAIN TEXT"),
		);
		const error = await resolveLocalGGUFModels("local-gguf", { modelPath }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(GGUFParseError);
		expect((error as GGUFParseError).code).toBe("NOT_GGUF");
	});

	it("throws a typed TRUNCATED error when metadata is cut short (task 131)", async () => {
		const modelPath = writeFixture(
			"truncated.gguf",
			// Valid magic + version + kv count of 1, but no entry bytes follow.
			Buffer.from([
				0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0,
			]),
		);
		const error = await resolveLocalGGUFModels("local-gguf", { modelPath }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(GGUFParseError);
		expect((error as GGUFParseError).code).toBe("TRUNCATED");
	});

	it("rejects a non-.gguf path (task 195 contract)", async () => {
		const modelPath = writeFixture("model.bin", buildGGUF([]));
		const error = await resolveLocalGGUFModels("local-gguf", { modelPath }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(GGUFParseError);
		expect((error as GGUFParseError).code).toBe("NOT_A_GGUF_PATH");
	});
});