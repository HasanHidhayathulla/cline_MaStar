import { GGUFParseError } from "@cline/llms"
import type { Controller } from ".."
import { StringRequest } from "@shared/proto/cline/common"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getGGUFMetadata } from "../getGGUFMetadata"

const mocks = vi.hoisted(() => ({
	parseGGUFMetadataFromFile: vi.fn(),
}))

vi.mock("@cline/llms", async (importOriginal: () => Promise<Record<string, unknown>>) => {
	const actual = await importOriginal()
	return {
		...actual,
		parseGGUFMetadataFromFile: mocks.parseGGUFMetadataFromFile,
	}
})

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		log: vi.fn(),
	},
}))

const baseMetadata = {
	architecture: "llama",
	modelType: "llama-3",
	name: "TinyTest",
	description: "a tiny model",
	hasVisionEncoder: false,
	parameterCount: "8B",
	contextLength: 8192,
	embeddingLength: 4096,
	fileSize: 123456,
	quantization: "Q4_K_M",
}

describe("getGGUFMetadata (task 177)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.parseGGUFMetadataFromFile.mockResolvedValue(baseMetadata)
	})

	it("maps parsed metadata onto the proto response", async () => {
		const response = await getGGUFMetadata(
			{} as unknown as Controller,
			StringRequest.create({ value: "/models/tiny.gguf" }),
		)

		expect(response.architecture).toBe("llama")
		expect(response.modelType).toBe("llama-3")
		expect(response.parameterCount).toBe("8B")
		// int64 fields mirror existing proto usage (ThinkingConfig.max_budget).
		expect(Number(response.contextLength)).toBe(8192)
		expect(Number(response.embeddingLength)).toBe(4096)
		expect(Number(response.fileSize)).toBe(123456)
		expect(response.quantization).toBe("Q4_K_M")
		expect(response.modelName).toBe("TinyTest")
		expect(response.description).toBe("a tiny model")
		expect(mocks.parseGGUFMetadataFromFile).toHaveBeenCalledWith("/models/tiny.gguf")
	})

	it("falls back to modelType when the file declares no general.name", async () => {
		mocks.parseGGUFMetadataFromFile.mockResolvedValue({ ...baseMetadata, name: "" })

		const response = await getGGUFMetadata(
			{} as unknown as Controller,
			StringRequest.create({ value: "/models/tiny.gguf" }),
		)

		expect(response.modelName).toBe("llama-3")
	})

	it("rejects a non-.gguf path before parsing", async () => {
		await expect(
			getGGUFMetadata({} as unknown as Controller, StringRequest.create({ value: "/models/tiny.bin" })),
		).rejects.toThrow("[NOT_A_GGUF_PATH]")
		expect(mocks.parseGGUFMetadataFromFile).not.toHaveBeenCalled()
	})

	it("rejects an empty path without touching the filesystem", async () => {
		await expect(
			getGGUFMetadata({} as unknown as Controller, StringRequest.create({ value: "   " })),
		).rejects.toThrow("[ENOENT]")
		expect(mocks.parseGGUFMetadataFromFile).not.toHaveBeenCalled()
	})

	it("wraps a typed parse failure with its code preserved (task 158)", async () => {
		mocks.parseGGUFMetadataFromFile.mockRejectedValue(new GGUFParseError("NOT_GGUF", "Not a GGUF file: /models/bogus.gguf"))

		await expect(
			getGGUFMetadata(
				{} as unknown as Controller,
				StringRequest.create({ value: "/models/bogus.gguf" }),
			),
		).rejects.toThrow("[NOT_GGUF]")
	})
})
