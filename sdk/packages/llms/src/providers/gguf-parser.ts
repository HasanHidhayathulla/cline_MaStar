/**
 * Minimal GGUF metadata parser (tasks 47–57).
 *
 * Reads only the file header (magic, version, tensor count, metadata
 * key-values) — never the tensor data — so the settings UI can show model
 * info without loading gigabytes into memory. Follows the GGUF spec:
 * magic "GGUF", uint32 version, uint64 tensor count, uint64 metadata KV
 * count, then length-prefixed KV entries.
 */

export type GGUFParseErrorCode =
	| "NOT_GGUF"
	| "UNSUPPORTED_VERSION"
	| "TRUNCATED"
	| "ENOENT"
	| "NOT_A_GGUF_PATH";

export class GGUFParseError extends Error {
	readonly code: GGUFParseErrorCode;
	constructor(code: GGUFParseErrorCode, message: string) {
		super(message);
		this.name = "GGUFParseError";
		this.code = code;
	}
}

export interface GGUFMetadata {
	architecture: string;
	modelType: string;
	/** `general.name` verbatim ("" when the file omits it). */
	name: string;
	/** `general.description` verbatim ("" when the file omits it). */
	description: string;
	/** Best-effort multimodal signal — see {@link detectVisionEncoder}. */
	hasVisionEncoder: boolean;
	parameterCount: string;
	contextLength: number;
	embeddingLength: number;
	fileSize: number;
	quantization: string;
}

/** GGUF value type tags (spec § metadata). */
const enum GGUFValueType {
	UINT8 = 0,
	INT8 = 1,
	UINT16 = 2,
	INT16 = 3,
	UINT32 = 4,
	INT32 = 5,
	FLOAT32 = 6,
	BOOL = 7,
	STRING = 8,
	ARRAY = 9,
	UINT64 = 10,
	INT64 = 11,
	FLOAT64 = 12,
}

const GGUF_MAGIC = "GGUF";
const HEADER_MIN_BYTES = 24;
/** Upper bound for the header region we read from disk (metadata lives up front). */
const HEADER_READ_CAP_BYTES = 1024 * 1024;
const SUPPORTED_VERSIONS = new Set([2, 3]);

function need(buffer: Buffer, offset: number, size: number): void {
	if (offset < 0 || size < 0 || offset + size > buffer.length) {
		throw new GGUFParseError("TRUNCATED", "GGUF header is truncated");
	}
}

/** Task 49 — check the 4-byte magic. */
export function hasGGUFMagic(buffer: Buffer): boolean {
	if (buffer.length < 4) {
		return false;
	}
	return buffer.toString("ascii", 0, 4) === GGUF_MAGIC;
}

/** Task 50 — little-endian uint32 version at offset 4. */
export function readGGUFVersion(buffer: Buffer): number {
	need(buffer, 4, 4);
	return buffer.readUInt32LE(4);
}

/** Task 51 — little-endian uint64 at an arbitrary offset. */
export function readUint64LE(buffer: Buffer, offset: number): bigint {
	need(buffer, offset, 8);
	return buffer.readBigUInt64LE(offset);
}

/** Task 52 — ULEB128 decoder; returns [value, nextOffset]. */
export function readUleb128(buffer: Buffer, offset: number): [number, number] {
	let result = 0;
	let shift = 0;
	let cursor = offset;
	for (;;) {
		need(buffer, cursor, 1);
		const byte = buffer[cursor];
		cursor += 1;
		result |= (byte & 0x7f) * 2 ** shift;
		if ((byte & 0x80) === 0) {
			return [result, cursor];
		}
		shift += 7;
		if (shift > 53) {
			throw new GGUFParseError("TRUNCATED", "ULEB128 value overflows");
		}
	}
}

/** Task 53 — GGUF string: uint64 length + UTF-8 bytes. */
export function readGGUFString(
	buffer: Buffer,
	offset: number,
): { value: string; next: number } {
	const length = Number(readUint64LE(buffer, offset));
	const start = offset + 8;
	need(buffer, start, length);
	return { value: buffer.toString("utf8", start, start + length), next: start + length };
}

/** Task 54 — metadata KV count (uint64 at offset 16). */
export function readMetadataKvCount(buffer: Buffer): number {
	return Number(readUint64LE(buffer, 16));
}

/** Task 55 — tensor count (uint64 at offset 8). */
export function readTensorCount(buffer: Buffer): number {
	return Number(readUint64LE(buffer, 8));
}

/** Task 56 — typed value decoding (scalars + arrays). */
function readScalar(buffer: Buffer, offset: number, type: number): { value: unknown; next: number } {
	switch (type) {
		case GGUFValueType.UINT8:
			need(buffer, offset, 1);
			return { value: buffer.readUInt8(offset), next: offset + 1 };
		case GGUFValueType.INT8:
			need(buffer, offset, 1);
			return { value: buffer.readInt8(offset), next: offset + 1 };
		case GGUFValueType.UINT16:
			need(buffer, offset, 2);
			return { value: buffer.readUInt16LE(offset), next: offset + 2 };
		case GGUFValueType.INT16:
			need(buffer, offset, 2);
			return { value: buffer.readInt16LE(offset), next: offset + 2 };
		case GGUFValueType.UINT32:
			need(buffer, offset, 4);
			return { value: buffer.readUInt32LE(offset), next: offset + 4 };
		case GGUFValueType.INT32:
			need(buffer, offset, 4);
			return { value: buffer.readInt32LE(offset), next: offset + 4 };
		case GGUFValueType.FLOAT32:
			need(buffer, offset, 4);
			return { value: buffer.readFloatLE(offset), next: offset + 4 };
		case GGUFValueType.BOOL:
			need(buffer, offset, 1);
			return { value: buffer.readUInt8(offset) !== 0, next: offset + 1 };
		case GGUFValueType.STRING: {
			const s = readGGUFString(buffer, offset);
			return { value: s.value, next: s.next };
		}
		case GGUFValueType.UINT64:
			return { value: readUint64LE(buffer, offset), next: offset + 8 };
		case GGUFValueType.INT64:
			need(buffer, offset, 8);
			return { value: buffer.readBigInt64LE(offset), next: offset + 8 };
		case GGUFValueType.FLOAT64:
			need(buffer, offset, 8);
			return { value: buffer.readDoubleLE(offset), next: offset + 8 };
		default:
			throw new GGUFParseError("TRUNCATED", `Unknown GGUF value type ${type}`);
	}
}

function readTypedValue(
	buffer: Buffer,
	offset: number,
): { value: unknown; next: number } {
	need(buffer, offset, 4);
	const type = buffer.readUInt32LE(offset);
	let cursor = offset + 4;
	if (type === GGUFValueType.ARRAY) {
		need(buffer, cursor, 4);
		const elementType = buffer.readUInt32LE(cursor);
		cursor += 4;
		const length = Number(readUint64LE(buffer, cursor));
		cursor += 8;
		const values: unknown[] = [];
		for (let i = 0; i < length; i += 1) {
			if (elementType === GGUFValueType.ARRAY) {
				throw new GGUFParseError("TRUNCATED", "Nested arrays are not supported");
			}
			const item = readScalar(buffer, cursor, elementType);
			values.push(item.value);
			cursor = item.next;
		}
		return { value: values, next: cursor };
	}
	return readScalar(buffer, cursor, type);
}

/** Task 57 — extract the raw metadata key-value map from the header. */
export function extractGGUFMetadata(buffer: Buffer): Record<string, unknown> {
	if (buffer.length < HEADER_MIN_BYTES) {
		throw new GGUFParseError("TRUNCATED", "GGUF header is truncated");
	}
	if (!hasGGUFMagic(buffer)) {
		throw new GGUFParseError("NOT_GGUF", "Not a GGUF file (bad magic)");
	}
	const version = readGGUFVersion(buffer);
	if (!SUPPORTED_VERSIONS.has(version)) {
		throw new GGUFParseError("UNSUPPORTED_VERSION", `Unsupported GGUF version ${version}`);
	}
	const kvCount = readMetadataKvCount(buffer);
	let cursor = HEADER_MIN_BYTES;
	const out: Record<string, unknown> = {};
	for (let i = 0; i < kvCount; i += 1) {
		const key = readGGUFString(buffer, cursor);
		cursor = key.next;
		const value = readTypedValue(buffer, cursor);
		cursor = value.next;
		out[key.value] = value.value;
	}
	return out;
}

function asNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "bigint") {
		return Number(value);
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	return 0;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Task 60 — filename fallback, e.g. `model-Q4_K_M.gguf` → `Q4_K_M`. */
export function quantizationFromFilename(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const match = base.match(/[-_.](Q\d(?:_\w+)?|F16|F32|BF16|IQ\d[_\w]*)\.gguf$/i);
	return match ? match[1].toUpperCase() : "unknown";
}

/**
 * Task 123 (OPT) — filename stem used when the file carries no `general.name`.
 * `C:\models\tiny-Q4_K_M.gguf` → `tiny-Q4_K_M`.
 */
export function filenameStem(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	return base.replace(/\.gguf$/i, "");
}

/** Vision-capable architectures as they appear in `general.architecture`. */
const VISION_ARCHITECTURE_PATTERN =
	/llava|vision|mllama|internvl|minicpmv|pixtral|moondream|(?:qwen|gemma)\d*vl/i;

/**
 * Task 123 (OPT) — best-effort multimodal detection. llama.cpp attaches
 * vision towers through `clip.*` keys (a projector or vision encoder) and
 * vision-capable architectures name themselves (`llava`, `qwen2vl`, …). Both
 * signals are cheap header reads; neither is authoritative, so callers treat
 * a `false` result as "unknown" rather than "text-only".
 */
export function detectVisionEncoder(raw: Record<string, unknown>): boolean {
	if (raw["clip.has_vision_encoder"] === true) {
		return true;
	}
	if (raw["clip.has_vision_encoder"] === 1) {
		return true;
	}
	if (typeof raw["clip.projector_type"] === "string") {
		return true;
	}
	return VISION_ARCHITECTURE_PATTERN.test(asString(raw["general.architecture"]));
}

/** Task 61 — header buffer (+ optional path for filesize/quant fallback) → metadata. */
export function parseGGUFMetadataFromBuffer(
	buffer: Buffer,
	opts?: { filePath?: string; fileSize?: number },
): GGUFMetadata {
	const raw = extractGGUFMetadata(buffer);
	const architecture = asString(raw["general.architecture"]) || "unknown";
	const modelType =
		asString(raw["general.type"]) || asString(raw["general.name"]) || "unknown";
	const sizeLabel = asString(raw["general.size_label"]);
	const contextLength =
		asNumber(raw[`${architecture}.context_length`]) ||
		asNumber(raw["general.context_length"]);
	const embeddingLength =
		asNumber(raw[`${architecture}.embedding_length`]) ||
		asNumber(raw["general.embedding_length"]);
	// Task 59 — best-effort parameter label; block_count alone cannot yield
	// params, so prefer the size label and otherwise report unknown.
	const parameterCount = sizeLabel || "unknown";
	const quantization =
		asString(raw["general.quantization_version"]) ||
		(opts?.filePath ? quantizationFromFilename(opts.filePath) : "unknown");
	return {
		architecture,
		modelType,
		name: asString(raw["general.name"]),
		description: asString(raw["general.description"]),
		hasVisionEncoder: detectVisionEncoder(raw),
		parameterCount,
		contextLength,
		embeddingLength,
		fileSize: opts?.fileSize ?? 0,
		quantization: quantization || "unknown",
	};
}

/** Tasks 62–65 — bounded header read + stat; never loads tensor data. */
export async function parseGGUFMetadataFromFile(filePath: string): Promise<GGUFMetadata> {
	if (!/\.gguf$/i.test(filePath)) {
		throw new GGUFParseError("NOT_A_GGUF_PATH", `Not a .gguf path: ${filePath}`);
	}
	const fs = await import("node:fs/promises");
	let stat: { size: number };
	try {
		stat = await fs.stat(filePath);
	} catch {
		throw new GGUFParseError("ENOENT", `GGUF file not found: ${filePath}`);
	}
	const handle = await fs.open(filePath, "r");
	try {
		const length = Math.min(stat.size, HEADER_READ_CAP_BYTES);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, 0);
		return parseGGUFMetadataFromBuffer(buffer, { filePath, fileSize: stat.size });
	} catch (error) {
		if (error instanceof GGUFParseError) {
			throw error;
		}
		throw new GGUFParseError(
			"TRUNCATED",
			`Failed to read GGUF header: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		await handle.close();
	}
}
