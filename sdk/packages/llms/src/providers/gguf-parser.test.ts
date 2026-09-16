import { describe, expect, it } from "vitest";
import {
	extractGGUFMetadata,
	GGUFParseError,
	hasGGUFMagic,
	parseGGUFMetadataFromBuffer,
	parseGGUFMetadataFromFile,
	quantizationFromFilename,
	readGGUFString,
	readGGUFVersion,
	readMetadataKvCount,
	readTensorCount,
	readUleb128,
	readUint64LE,
} from "./gguf-parser";

function writeU64LE(view: DataView, offset: number, value: number): void {
	view.setUint32(offset, value >>> 0, true);
	view.setUint32(offset + 4, Math.floor(value / 2 ** 32), true);
}

/** Minimal valid GGUF header: magic + v3 + 0 tensors + N KV entries. */
function buildHeader(kvs: Array<{ key: string; type: number; value: Uint8Array }>): Buffer {
	const parts: number[] = [0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0];
	for (let i = 0; i < 8; i += 1) {
		parts.push(0); // tensor count = 0
	}
	writeU64Into(parts, kvs.length); // kv count
	const bytes: number[] = [...parts];
	for (const kv of kvs) {
		pushString(bytes, kv.key);
		pushU32(bytes, kv.type);
		for (const b of kv.value) {
			bytes.push(b);
		}
	}
	return Buffer.from(bytes);
}

function writeU64Into(parts: number[], value: number): void {
	parts.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff, 0, 0, 0, 0);
}

function pushU32(bytes: number[], value: number): void {
	bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}

function pushU64(bytes: number[], value: number): void {
	writeU64Into(bytes, value);
}

function pushString(bytes: number[], value: string): void {
	const encoded = Buffer.from(value, "utf8");
	pushU64(bytes, encoded.length);
	for (const b of encoded) {
		bytes.push(b);
	}
}

function stringValue(value: string): Uint8Array {
	const encoded = Buffer.from(value, "utf8");
	const out: number[] = [];
	pushU64(out, encoded.length);
	for (const b of encoded) {
		out.push(b);
	}
	return Uint8Array.from(out);
}

function u32Value(value: number): Uint8Array {
	const out: number[] = [];
	pushU32(out, value);
	return Uint8Array.from(out);
}

const STRING = 8;
const UINT32 = 4;

describe("gguf-parser", () => {
	it("accepts valid magic and version, reports KV/tensor counts", () => {
		const header = buildHeader([]);
		expect(hasGGUFMagic(header)).toBe(true);
		expect(readGGUFVersion(header)).toBe(3);
		expect(readTensorCount(header)).toBe(0);
		expect(readMetadataKvCount(header)).toBe(0);
	});

	it("rejects bad magic and truncated headers", () => {
		expect(hasGGUFMagic(Buffer.from([0, 1, 2]))).toBe(false);
		expect(() => extractGGUFMetadata(Buffer.from("NOPE"))).toThrowError(GGUFParseError);
		expect(() => extractGGUFMetadata(Buffer.alloc(10))).toThrowError(GGUFParseError);
	});

	it("rejects unsupported versions", () => {
		const header = buildHeader([]);
		header.writeUInt32LE(99, 4);
		expect(() => extractGGUFMetadata(header)).toThrowError(GGUFParseError);
	});

	it("decodes ULEB128 boundary values", () => {
		expect(readUleb128(Buffer.from([0x00]), 0)).toEqual([0, 1]);
		expect(readUleb128(Buffer.from([0x7f]), 0)).toEqual([127, 1]);
		expect(readUleb128(Buffer.from([0x80, 0x01]), 0)).toEqual([128, 2]);
		expect(readUleb128(Buffer.from([0xff, 0x7f]), 0)).toEqual([16383, 2]);
		expect(readUleb128(Buffer.from([0x80, 0x80, 0x01]), 0)).toEqual([16384, 3]);
	});

	it("reads uint64 and GGUF strings", () => {
		const header = buildHeader([]);
		expect(readUint64LE(header, 8)).toBe(0n);

		// GGUF string: uint64 length + UTF-8 payload.
		const encoded = Buffer.from("hello gguf", "utf8");
		const parts: number[] = [];
		pushU64(parts, encoded.length);
		for (const b of encoded) {
			parts.push(b);
		}
		const stringBuffer = Buffer.from(parts);
		const parsed = readGGUFString(stringBuffer, 0);
		expect(parsed.value).toBe("hello gguf");
		expect(parsed.next).toBe(stringBuffer.length);
	});

	it("extracts metadata key-values into a record", () => {
		const header = buildHeader([
			{ key: "general.architecture", type: STRING, value: stringValue("llama") },
			{ key: "general.name", type: STRING, value: stringValue("TinyTest") },
			{ key: "llama.context_length", type: UINT32, value: u32Value(4096) },
			{ key: "llama.embedding_length", type: UINT32, value: u32Value(2048) },
		]);
		const raw = extractGGUFMetadata(header);
		expect(raw["general.architecture"]).toBe("llama");
		expect(raw["llama.context_length"]).toBe(4096);
		const meta = parseGGUFMetadataFromBuffer(header, { filePath: "tiny-Q4_K_M.gguf" });
		expect(meta.architecture).toBe("llama");
		expect(meta.contextLength).toBe(4096);
		expect(meta.embeddingLength).toBe(2048);
		expect(meta.quantization).toBe("Q4_K_M");
	});

	it("derives quantization from the filename", () => {
		expect(quantizationFromFilename("C:\\models\\llama-Q5_0.gguf")).toBe("Q5_0");
		expect(quantizationFromFilename("/tmp/model-f16.gguf")).toBe("F16");
		expect(quantizationFromFilename("/tmp/model.gguf")).toBe("unknown");
	});

	it("rejects non-.gguf paths and missing files", async () => {
		await expect(parseGGUFMetadataFromFile("/tmp/not-a-model.bin")).rejects.toThrowError(
			GGUFParseError,
		);
		await expect(
			parseGGUFMetadataFromFile("/tmp/does-not-exist-12345.gguf"),
		).rejects.toThrowError(GGUFParseError);
	});
});
