import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { StateManager } from "@/core/storage/StateManager"
import { createProviderCatalog } from "@/sdk/model-catalog/catalog"
import type { ProviderCatalog, ProviderConfigStore } from "@/sdk/model-catalog/contracts"
import { createProviderConfigStore } from "@/sdk/model-catalog/store"
import { Empty, StringRequest } from "@/shared/proto/cline/common"
import { CommitModelSelectionRequest, ProviderConfigPatch, WriteProviderConfigRequest } from "@/shared/proto/cline/models"
import { createStorageContext } from "@/shared/storage/storage-context"
import { commitModelSelection } from "../commitModelSelection"
import { listProviders } from "../listProviders"
import type { ProviderCatalogController } from "../providerCatalogShared"
import { readProviderConfig } from "../readProviderConfig"
import { resolveProviderModels } from "../resolveProviderModels"
import { writeProviderConfig } from "../writeProviderConfig"

vi.mock("@/services/logging/distinctId", () => ({
	initializeDistinctId: vi.fn(async () => undefined),
}))

describe("provider model catalog backend smoke", () => {
	let clineDir: string
	let store: ProviderConfigStore
	let catalog: ProviderCatalog
	let controller: ProviderCatalogController
	let originalClineDir: string | undefined

	beforeAll(async () => {
		clineDir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-provider-catalog-smoke-"))
		originalClineDir = process.env.CLINE_DIR
		process.env.CLINE_DIR = clineDir
		await StateManager.initialize(createStorageContext({ clineDir, workspacePath: clineDir }))
		store = createProviderConfigStore()
		catalog = createProviderCatalog(store)
		controller = {
			getProviderConfigStore: () => store,
			getProviderCatalog: () => catalog,
		}
	})

	afterAll(async () => {
		await StateManager.get().flushPendingState()
		if (originalClineDir === undefined) {
			delete process.env.CLINE_DIR
		} else {
			process.env.CLINE_DIR = originalClineDir
		}
		await StateManager.get().reInitialize()
		await fs.rm(clineDir, { recursive: true, force: true })
	})

	it("lists providers, resolves DeepSeek models, and round-trips committed selection", async () => {
		const providers = await listProviders(controller, Empty.create())
		expect(providers.providers.length).toBeGreaterThanOrEqual(4)
		expect(providers.providers.some((provider) => provider.id === "deepseek")).toBe(true)

		const models = await resolveProviderModels(controller, {
			providerId: "deepseek",
			forceRefresh: false,
			requestId: "smoke-request",
		})
		expect(models.ok).toBe(true)
		expect(models.requestId).toBe("smoke-request")
		// Don't pin an exact count: the generated catalog is refreshed regularly
		// and DeepSeek's lineup changes (e.g. the v4 refresh shrank it to 3).
		expect(Object.keys(models.models).length).toBeGreaterThan(0)

		const modelId = models.defaultModelId || Object.keys(models.models)[0]
		expect(modelId).toBeTruthy()
		const modelInfo = models.models[modelId]
		expect(modelInfo).toBeDefined()

		await commitModelSelection(
			controller,
			CommitModelSelectionRequest.create({
				providerId: "deepseek",
				mode: "act",
				modelId,
			}),
		)

		const config = await readProviderConfig(controller, StringRequest.create({ value: "deepseek" }))
		expect(config.providerId).toBe("deepseek")
		expect(config.actSelection?.providerId).toBe("deepseek")
		expect(config.actSelection?.modelId).toBe(modelId)
		expect(config.actSelection?.modelInfo).toEqual(modelInfo)
		expect(JSON.stringify(config)).not.toContain("SECRET")
	})

	it("integrates local-gguf in catalog smoke: listing, config write/read, model resolution, and selection commit (tasks 356-360)", async () => {
		// Task 372/356: Confirm local-gguf appears in the provider listing
		const providers = await listProviders(controller, Empty.create())
		expect(providers.providers.some((provider) => provider.id === "local-gguf")).toBe(true)

		// Create a temporary mock .gguf model file for integration testing
		const modelPath = path.join(clineDir, "test-model.gguf")
		// Minimal valid GGUF header (magic 0x46554747 + v3 + 0 tensors + 0 KV metadata)
		const ggufHeader = Buffer.from([
			0x47,
			0x47,
			0x55,
			0x46,
			0x03,
			0x00,
			0x00,
			0x00, // magic 'GGUF', version 3
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00, // 0 tensors
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00,
			0x00, // 0 metadata KV
		])
		await fs.writeFile(modelPath, ggufHeader)

		// Task 359 & 360: writeProviderConfig patch with GGUF fields & verify toRedactedProviderConfigResponse
		const writeResponse = await writeProviderConfig(
			controller,
			WriteProviderConfigRequest.create({
				providerId: "local-gguf",
				patch: ProviderConfigPatch.create({
					modelPath,
					threads: 8,
					gpuLayers: 16,
					contextWindow: 4096,
				}),
			}),
		)

		expect(writeResponse.providerId).toBe("local-gguf")
		expect(writeResponse.modelPath).toBe(modelPath)
		expect(writeResponse.threads).toBe(8)
		expect(writeResponse.gpuLayers).toBe(16)
		expect(writeResponse.contextWindow).toBe(4096)

		// Task 359 & 360: readProviderConfig exposes redacted response with local-gguf fields
		const readResponse = await readProviderConfig(controller, StringRequest.create({ value: "local-gguf" }))
		expect(readResponse.providerId).toBe("local-gguf")
		expect(readResponse.modelPath).toBe(modelPath)
		expect(readResponse.threads).toBe(8)
		expect(readResponse.gpuLayers).toBe(16)
		expect(readResponse.contextWindow).toBe(4096)

		// Task 358: resolveProviderModels("local-gguf") returns the local-model entry
		const models = await resolveProviderModels(controller, {
			providerId: "local-gguf",
			forceRefresh: true,
			requestId: "local-gguf-smoke",
		})
		expect(models.ok).toBe(true)
		expect(models.requestId).toBe("local-gguf-smoke")
		expect(models.models["local-model"]).toBeDefined()
		expect(models.models["local-model"].name).toBe("test-model")

		// Task 357: commitModelSelection round-trip for local-gguf
		await commitModelSelection(
			controller,
			CommitModelSelectionRequest.create({
				providerId: "local-gguf",
				mode: "plan",
				modelId: "local-model",
			}),
		)

		const configAfterCommit = await readProviderConfig(controller, StringRequest.create({ value: "local-gguf" }))
		expect(configAfterCommit.planSelection?.providerId).toBe("local-gguf")
		expect(configAfterCommit.planSelection?.modelId).toBe("local-model")
	})
})
