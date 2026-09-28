import { describe, expect, it } from "vitest";
import { safeParseSettings, toProviderConfig } from "./provider-settings";

describe("provider settings", () => {
	it("formats Cline OAuth access tokens for runtime API keys", () => {
		const config = toProviderConfig({
			provider: "cline",
			model: "anthropic/claude-sonnet-4.6",
			auth: {
				accessToken: "oauth-access-token",
			},
		});

		expect(config.apiKey).toBe("workos:oauth-access-token");
		expect(config.accessToken).toBe("oauth-access-token");
	});

	it("accepts the Bedrock apikey authentication alias", () => {
		const result = safeParseSettings({
			provider: "bedrock",
			model: "anthropic.claude-sonnet-4-5-20250929-v1:0",
			aws: {
				authentication: "apikey",
				region: "us-east-1",
			},
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected Bedrock apikey settings to parse");
		}

		expect(toProviderConfig(result.data).aws).toEqual(
			expect.objectContaining({
				authentication: "apikey",
			}),
		);
	});

	it("resolves the regional endpoint from apiLine when no base URL is set", () => {
		expect(
			toProviderConfig({ provider: "zai", apiLine: "china" }),
		).toMatchObject({
			apiLine: "china",
			baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		});

		expect(
			toProviderConfig({ provider: "moonshot", apiLine: "china" }),
		).toMatchObject({
			baseUrl: "https://api.moonshot.cn/v1",
		});

		expect(
			toProviderConfig({ provider: "qwen", apiLine: "international" }),
		).toMatchObject({
			baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
		});
	});

	it("lets an explicit base URL win over apiLine", () => {
		expect(
			toProviderConfig({
				provider: "zai",
				apiLine: "china",
				baseUrl: "https://proxy.example.com/v4",
			}),
		).toMatchObject({
			baseUrl: "https://proxy.example.com/v4",
		});
	});

	it("limits ChatGPT subscription known models to the Codex catalog", () => {
		const knownModels = toProviderConfig({
			provider: "openai-codex",
		}).knownModels;
		const modelIds = Object.keys(knownModels ?? {});

		expect(modelIds).toEqual(
			expect.arrayContaining(["gpt-5.5", "gpt-5.6-terra"]),
		);
		expect(modelIds).not.toContain("gpt-4o");
		expect(modelIds).not.toContain("gpt-4.1");
		expect(modelIds).not.toContain("chatgpt-image-latest");
		expect(modelIds).not.toContain("gpt-5.4-nano");
		expect(knownModels?.["gpt-5.5"]).toMatchObject({
			contextWindow: 400_000,
			maxInputTokens: 272_000 * 0.95,
		});
	});

	it("keeps the provider default base URL when no apiLine is set", () => {
		expect(toProviderConfig({ provider: "zai" })).toMatchObject({
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		expect(toProviderConfig({ provider: "moonshot" })).toMatchObject({
			baseUrl: "https://api.moonshot.ai/v1",
		});
	});

	it("keeps local model settings through the persistence schema", () => {
		const result = safeParseSettings({
			provider: "local-gguf",
			modelPath: "/models/tinyllama-Q4_K_M.gguf",
			threads: 8,
			gpuLayers: 0,
			contextWindow: 8192,
		});

		expect(result.success).toBe(true);
		if (!result.success) {
			throw new Error("expected local model settings to parse");
		}

		// The fields must survive validation, not just type-check: a stripping
		// schema here silently breaks local model configuration for every host
		// that persists through providers.json.
		expect(result.data).toMatchObject({
			provider: "local-gguf",
			modelPath: "/models/tinyllama-Q4_K_M.gguf",
			threads: 8,
			gpuLayers: 0,
			contextWindow: 8192,
		});

		expect(toProviderConfig(result.data)).toMatchObject({
			providerId: "local-gguf",
			modelPath: "/models/tinyllama-Q4_K_M.gguf",
			threads: 8,
			gpuLayers: 0,
			contextWindow: 8192,
			maxInputTokens: 8192,
		});
	});

	it("rejects invalid local model knobs", () => {
		// threads must be a positive count; gpuLayers may be zero (CPU only).
		expect(
			safeParseSettings({ provider: "local-gguf", threads: 0 }).success,
		).toBe(false);
		expect(
			safeParseSettings({ provider: "local-gguf", threads: 2.5 }).success,
		).toBe(false);
		expect(
			safeParseSettings({ provider: "local-gguf", gpuLayers: -1 }).success,
		).toBe(false);
		expect(
			safeParseSettings({ provider: "local-gguf", gpuLayers: 0 }).success,
		).toBe(true);
	});

	it("omits local model fields from the runtime config when unset", () => {
		const config = toProviderConfig({
			provider: "openai-compatible",
			baseUrl: "http://127.0.0.1:8080/v1",
			model: "local-model",
		});

		expect(config).not.toHaveProperty("modelPath");
		expect(config).not.toHaveProperty("threads");
		expect(config).not.toHaveProperty("gpuLayers");
		expect(config).not.toHaveProperty("contextWindow");
	});
});
