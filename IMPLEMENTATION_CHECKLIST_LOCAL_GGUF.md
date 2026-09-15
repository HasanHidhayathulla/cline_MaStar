# Local GGUF Support — Micro-Task Implementation Checklist

> **Feature:** let Cline run a `.gguf` model file **directly** — no Ollama, no LM Studio, no external provider process or server.
> **Total micro-tasks:** 577 across 32 phases.

## How to use this checklist

- Work top-down — phases are ordered by dependency.
- Tick `- [ ]` → `- [x]` as you complete. Keep the numbers: reference them in commits (`feat(local-gguf): #47`).
- **(BLOCKER)** — must land before dependent phases start.
- **(SPIKE)** — time-boxed research, max 2h, output = written decision.
- **(OPT)** — deferrable past MVP.
- **(RISK)** — touches native/inference code; verify on a real model before closing.
- **MVP cut list** is at the end — the ~90 tasks needed for a working first version.

---

## Phase 0 — Research & Discovery (1–15)

- [x] 1. Audit Node.js GGUF parser libraries (`gguf`, `gguf-js`, `@huggingface/gguf`) — DISCOVERED: `gguf-js` preferred (pure JS, well-maintained, good type definitions). Also `node-llama-cpp` has built-in GGUF parsing via llama.cpp bindings.

- [x] 2. Verify `node-llama-cpp` prebuilt binaries exist for Windows x64 / macOS arm64 / Linux x64 — CONFIRMED: Prebuilt binaries available via npm for all major platforms. See: https://www.npmjs.com/package/node-llama-cpp

- [x] 3. Record llama.cpp `llama-server` CLI flags (`-m`, `-c`, `-ngl`, `-t`, `--jinja`, `--host`, `--port`) — DOCUMENTED: `-m <model>`, `-c <ctx-size>`, `-ngl <gpu-layers>`, `-t <threads>`, `--jinja` (use GGUF chat template), `--host <addr>`, `--port <num>`

- [x] 4. Confirm `llama-server` exposes OpenAI-compatible `/v1/chat/completions` — CONFIRMED: llama-server provides full OpenAI-compatible API at `http://localhost:PORT/v1/`

- [x] 5. Confirm `llama-server` exposes `/v1/models` for model listing — CONFIRMED: `/v1/models` returns available models

- [x] 6. Check license terms of llama.cpp binaries before any bundling decision — DOCUMENTED: llama.cpp is MIT licensed. Bundling binaries requires careful consideration of platform-specific builds. Recommended: detect user-installed llama-server first, optionally bundle later.

- [x] 7. Audit Cline's existing `openai-compatible` provider flow end-to-end — REVIEWED: Provider selection → config persistence → gRPC → handler registration → `AgentModel` stream. Pattern: `getOllamaModels.ts` as reference for RPC-based provider operations.

- [x] 8. Map how `providerSettingsRegistry.ts` picks which UI component renders — MAPPED: `CUSTOM_PROVIDER_SETTINGS_IDS` Set controls UI selection. Add `"local-gguf"` to this set to render custom UI.

- [x] 9. Trace gRPC flow: webview → extension host → SDK → response — TRACED: Webview → `ModelsServiceClient` (gRPC) → `ModelsService` handler → SDK `/cline/llms` → response. Pattern: `getOllamaModels.ts` and `getLmStudioModels.ts` as templates.

- [x] 10. Read `sdk/packages/llms/src/providers/factory-registry.ts` fully — REVIEWED: `registerHandler()` for synchronous handlers, `registerAsyncHandler()` for async. Custom handlers registered here provide `ApiHandler` that gets wrapped into `AgentModel` via `apihandler-agent-model-adapter.ts`.

- [x] 11. Read `sdk/packages/llms/src/providers/handler.ts` fully — REVIEWED: `ApiHandler` interface: `getMessages()`, `createMessage()`, `getModel()`, `abort()`, `setAbortSignal()`. This is the contract our GGUF handler must implement.

- [x] 12. Read `sdk/packages/llms/src/catalog/types.ts` for the `ModelInfo` shape — DOCUMENTED: ModelInfo includes `id`, `name`, `description`, `contextWindow`, `maxTokens`, `inputPrice`, `outputPrice`, `supportsTools`, `supportsImages`, etc.

- [x] 13. Read `apps/vscode/src/core/controller/models/providerCatalogShared.ts` fully — REVIEWED: Host-side provider catalog bridging gRPC ↔ SDK. Functions: `readProviderConfig`, `writeProviderConfig`, `resolveProviderModels`, `toProtobufModelInfo`, `toRedactedProviderConfigResponse`.

- [x] 14. Read `sdk/packages/core/src/services/llms/provider-settings.ts` fully — REVIEWED: Host-side provider settings management. `ProviderSettingsManager` handles persistence. `getProviderSettings()`, `saveProviderSettings()`, `deleteProviderSettings()`.

- [x] 15. Read `apps/vscode/proto/cline/models.proto` + `models.proto` RPC patterns — DOCUMENTED: Service = `ModelsService`. RPCs: `getOllamaModels`, `getLmStudioModels`, `readProviderConfig`, `writeProviderConfig`, `resolveProviderModels`, `listProviders`, `commitModelSelection`. Pattern: request message → `Empty` or specific response message.

---

## Phase 1 — Provider ID & Type System (16–30)

- [x] 16. Add `LOCAL_GGUF = "local-gguf"` to `BUILT_IN_PROVIDER` in `ids.ts` — **COMPLETED**
- [x] 17. Confirm `BUILT_IN_PROVIDER_IDS` auto-includes the new enum value — **COMPLETED** (verified via `Object.values(BUILT_IN_PROVIDER)`)
- [x] 18. Add `"local-gguf"` to the `ProviderFamily` union in `builtin-types.ts` — **COMPLETED**
- [x] 19. Add optional `modelPath?: string` to `ProviderConfig` in `config.ts` — **COMPLETED**
- [x] 20. Add optional `threads?: number` to `ProviderConfig` — **COMPLETED**
- [x] 21. Add optional `gpuLayers?: number` to `ProviderConfig` — **COMPLETED**
- [x] 22. Extend `ProviderConfigField["type"]` with `"file"` and `"number"` — **COMPLETED** (`sdk/packages/shared/src/rpc/runtime.ts`: added `"file"` to `ProviderConfigFieldType`)
- [x] 23. Add optional `fileFilter?: string` to `ProviderConfigField` — **COMPLETED**
- [x] 24. Add optional `min`/`max` to `ProviderConfigField` for numeric fields — **COMPLETED**
- [ ] 25. Check `normalizeProviderId` handles `"local-gguf"` unchanged
- [ ] 26. Confirm `isBuiltInProviderId("local-gguf")` returns `true`
- [ ] 27. Add type-level test asserting `"local-gguf"` is a valid `BuiltInProviderId`
- [ ] 28. Grep for exhaustive `switch` over provider ids that now needs a new case
- [ ] 29. Run `bun run build:sdk` — zero TypeScript errors
- [ ] 30. Run `bun -F @cline/llms test` — existing tests still green

---

## Phase 2 — Builtin Spec Definition (31–46)

- [ ] 31. Add a `local-gguf` entry to `OPENAI_COMPATIBLE_SPEC_OVERRIDES` in `builtins.ts`
- [ ] 32. Set `id: "local-gguf"`
- [ ] 33. Set `name: "Local GGUF"`
- [ ] 34. Set `description: "Run a local .gguf model file directly"`
- [ ] 35. Set `family: "openai-compatible"`
- [ ] 36. Set `popular: 100` so it surfaces at the top of the picker
- [ ] 37. Set `capabilities: ["tools"]`
- [ ] 38. Set `defaultModelId: "local-model"`
- [ ] 39. Set `apiKeyEnv: []` (no key required)
- [ ] 40. Set `defaults: { baseUrl: "" }` (path-driven, not URL-driven)
- [ ] 41. Add `configFields` entry `modelPath` (type `file`, required)
- [ ] 42. Add `configFields` entry `threads` (number, default 4, min 1)
- [ ] 43. Add `configFields` entry `contextWindow` (number, default 4096)
- [ ] 44. Add `configFields` entry `gpuLayers` (number, default 0)
- [ ] 45. Add `docsUrl` pointing at the local-models docs page
- [ ] 46. Add a unit test asserting the spec merges into `BUILTIN_SPECS`

---

## Phase 3 — GGUF Metadata Parser (47–70)

- [ ] 47. Create `sdk/packages/llms/src/providers/gguf-parser.ts`
- [ ] 48. Define `GGUFMetadata` interface (architecture, modelType, parameterCount, contextLength, embeddingLength, fileSize, quantization)
- [ ] 49. Implement `hasGGUFMagic(buffer: Buffer): boolean`
- [ ] 50. Implement `readGGUFVersion(buffer: Buffer): number`
- [ ] 51. Implement `readUint64LE(buffer: Buffer, offset: number): bigint`
- [ ] 52. Implement ULEB128 decoder `readUleb128(buffer, offset)`
- [ ] 53. Implement `readGGUFString(buffer, offset): { value: string; next: number }`
- [ ] 54. Implement `readMetadataKvCount(buffer): number`
- [ ] 55. Implement `readTensorCount(buffer): number`
- [ ] 56. Implement typed value decoding for GGUF value types (u8..f64, string, array)
- [ ] 57. Implement `extractGGUFMetadata(buffer): Record<string, unknown>`
- [ ] 58. Map raw keys → `GGUFMetadata` (`general.architecture`, `general.name`, `*.context_length`, `*.embedding_length`, `*.block_count`)
- [ ] 59. Derive `parameterCount` label from tensor shapes when absent (best-effort)
- [ ] 60. Derive `quantization` from filename regex (`Q4_K_M`, `Q5_0`, `Q8_0`, `F16`) as fallback
- [ ] 61. Implement `parseGGUFMetadataFromBuffer(buffer): GGUFMetadata`
- [ ] 62. Implement `parseGGUFMetadataFromFile(filePath): Promise<GGUFMetadata>` using `node:fs/promises`
- [ ] 63. Read only the header region for speed (seek + bounded read), not the whole file
- [ ] 64. Add `stat()` call to populate `fileSize`
- [ ] 65. Validate `.gguf` extension; return typed error otherwise
- [ ] 66. Add typed error `GGUFParseError` with codes (`NOT_GGUF`, `UNSUPPORTED_VERSION`, `TRUNCATED`, `ENOENT`)
- [ ] 67. Add `gguf-parser.test.ts` — valid magic bytes pass
- [ ] 68. Test — truncated header returns `TRUNCATED`
- [ ] 69. Test — ULEB128 multi-byte boundary values (0, 127, 128, 16383, 16384)
- [ ] 70. Test — missing file returns `ENOENT`; run `bun -F @cline/llms test`

---

## Phase 4 — Inference Bridge (71–98)

- [ ] 71. Create `sdk/packages/llms/src/providers/gguf-inference.ts`
- [ ] 72. Define `GGUFInferenceConfig` (modelPath, threads, contextWindow, gpuLayers, port, extraArgs)
- [ ] 73. Implement `detectLlamaServer(): Promise<{ available: boolean; path?: string; version?: string }>`
- [ ] 74. Probe PATH plus common install locations on all 3 platforms
- [ ] 75. Implement `findFreePort(): Promise<number>` to avoid port collisions
- [ ] 76. Implement `spawnLlamaServer(config): ChildProcess` with resolved absolute model path
- [ ] 77. Build argv: `-m <path> -c <ctx> -t <threads> -ngl <layers> --host 127.0.0.1 --port <port>`
- [ ] 78. Add `--jinja` so the GGUF's embedded chat template is used (BLOCKER)
- [ ] 79. Implement readiness poll on `GET /health` with timeout + backoff
- [ ] 80. Capture llama-server stderr into a bounded ring buffer for diagnostics
- [ ] 81. Implement `GGUFInferenceHandler implements ApiHandler`
- [ ] 82. Implement `getMessages(systemPrompt, messages)` → OpenAI-compatible payload
- [ ] 83. Implement `createMessage(systemPrompt, messages, tools?)` returning `ApiStream`
- [ ] 84. Implement SSE/chunked parsing of the streaming response
- [ ] 85. Map stream chunks → Cline `ApiStreamChunk` (`text`, `reasoning`, `usage`, `tool_calls`)
- [ ] 86. Implement `getModel()` returning handler model info from parsed metadata
- [ ] 87. Implement `abort()` — cancel in-flight request
- [ ] 88. Implement `setAbortSignal(signal)`
- [ ] 89. Implement `dispose()` — kill child process, release port
- [ ] 90. Ensure only one llama-server per model path is alive (process registry keyed by path)
- [ ] 91. Add idle/unload timer so the model frees RAM after N minutes idle (OPT)
- [ ] 92. Add `gguf-inference.test.ts` — construction with valid config
- [ ] 93. Test — argv builder produces expected flags
- [ ] 94. Test — `detectLlamaServer` reports unavailable when nothing on PATH
- [ ] 95. Test — readiness poll times out with clear error
- [ ] 96. Test — `dispose()` terminates the child process
- [ ] 97. Test — stream chunk mapping for text + tool-call deltas
- [ ] 98. Run `bun -F @cline/llms test` and `bun run types`

---

## Phase 5 — Factory Registration (99–113)

- [ ] 99. Import `GGUFInferenceHandler` + `detectLlamaServer` into `factory-registry.ts`
- [ ] 100. Call `registerHandler("local-gguf", factory)` at module init (side-effect import)
- [ ] 101. Add `registerAsyncHandler` variant if llama-server probe happens at creation (BLOCKER)
- [ ] 102. Verify `hasRegisteredHandler("local-gguf") === true`
- [ ] 103. Verify `getRegisteredHandler("local-gguf", config)` returns a handler instance
- [ ] 104. Verify `isRegisteredHandlerAsync("local-gguf")` matches the chosen registration
- [ ] 105. Confirm `createHandler` in `providers.ts` routes `local-gguf` to the handler
- [ ] 106. Confirm `createHandlerAsync` in `providers.ts` routes `local-gguf` correctly
- [ ] 107. Verify `withNormalizedProviderId` preserves `"local-gguf"`
- [ ] 108. Check `builtins-runtime.ts` exposes a runtime manifest for `local-gguf`
- [ ] 109. Confirm `BUILTIN_PROVIDER_REGISTRATIONS` includes `local-gguf` manifest
- [ ] 110. Ensure `registry.ts listProviders()` includes `local-gguf`
- [ ] 111. Add registration unit test: handler factory produces a `GGUFInferenceHandler`
- [ ] 112. Add test: handler factory rejects when `modelPath` is empty
- [ ] 113. Run `bun -F @cline/llms test` — all green

---

## Phase 6 — Catalog & Model Resolution (114–132)

- [ ] 114. Read `catalog-live.ts` model-resolution path end-to-end (SPIKE)
- [ ] 115. Add `local-gguf` branch to `resolveModels`
- [ ] 116. Implement `resolveLocalGGUFModels(providerId, options)` returning `Record<string, ModelInfo>`
- [ ] 117. Build model record from parsed GGUF metadata (single model expected)
- [ ] 118. Set `ModelInfo.name` from `general.name` (fallback: filename stem)
- [ ] 119. Set `ModelInfo.description` from `general.description` when present
- [ ] 120. Set `ModelInfo.contextWindow` from `*.context_length` (> 0)
- [ ] 121. Set `ModelInfo.maxTokens` default `4096` (OPT)
- [ ] 122. Set `ModelInfo.supportsTools` = true (llama.cpp supports `chat-completions` with tools)
- [ ] 123. Set `ModelInfo.supportsImages` from multimodal architecture keys (OPT)
- [ ] 124. Fallback: return a single `"local-model"` entry when metadata parse fails
- [ ] 125. Ensure `resolveModels` never **throws** for missing file → return `ok: false` + message
- [ ] 126. Respect `forceRefresh` option (re-parse the file)
- [ ] 127. Cache parsed metadata per file path + mtime (avoid re-read on every call)
- [ ] 128. Add `resolveLocalGGUFModels` unit test with a temp `.gguf` fixture
- [ ] 129. Test cache hit/miss behavior
- [ ] 130. Test missing file → graceful `ok: false`
- [ ] 131. Test corrupted file → graceful `ok: false` with parse error detail
- [ ] 132. Run `bun -F @cline/llms test` + `bun run types`

---

## Phase 7 — Proto/gRPC Contracts (133–152)

- [ ] 133. Open `apps/vscode/proto/cline/models.proto`
- [ ] 134. Add `rpc getGGUFMetadata(StringRequest) returns (GGUFMetadataResponse);`
- [ ] 135. Add `rpc loadGGUFModel(LoadGGUFModelRequest) returns (LoadGGUFModelResponse);`
- [ ] 136. Add `rpc unloadGGUFModel(StringRequest) returns (Empty);`
- [ ] 137. Add `rpc getGGUFModelStatus(StringRequest) returns (GGUFModelStatus);`
- [ ] 138. Add `message GGUFMetadataResponse` (architecture, model_type, parameter_count, context_length, embedding_length, file_size, quantization)
- [ ] 139. Add `message LoadGGUFModelRequest` (model_path, threads, context_window, gpu_layers, extra_args)
- [ ] 140. Add `message LoadGGUFModelResponse` (success, model_id, error, server_version)
- [ ] 141. Add `message GGUFModelStatus` (loaded, model_path, pid, port, memory_bytes, uptime_seconds)
- [ ] 142. Run `bun run protos` from `apps/vscode` to regenerate TypeScript
- [ ] 143. Verify `src/generated/grpc-js/` has new handlers
- [ ] 144. Verify `src/shared/proto/cline/models.ts` has new request/response types
- [ ] 145. Verify `models_pb.js` / `_pb2.ts` updated for new messages
- [ ] 146. Confirm the generated nice-grpc client exposes the new methods
- [ ] 147. Check proto syntax correctness (field numbers, message names, JSON names)
- [ ] 148. Add proto doc comments for each new message field
- [ ] 149. Write a proto compatibility test (existing messages unaffected)
- [ ] 150. Run `bun run check` to typecheck proto changes
- [ ] 151. Test proto round-trip: construct → serialize → deserialize → assert equality
- [ ] 152. Register the new RPCs in the VS Code `ModelsService` handler dispatch

---

## Phase 8 — Extension Host Handlers (153–182)

- [ ] 153. Create `apps/vscode/src/core/controller/models/resolveGGUFMetadata.ts`
- [ ] 154. Import `parseGGUFMetadataFromFile` from `@cline/llms`
- [ ] 155. Implement handler(controller, request: StringRequest) → Promise\<GGUFMetadataResponse\>
- [ ] 156. Read model path from `request.value` and validate extension
- [ ] 157. Call `parseGGUFMetadataFromFile` and map the result to proto fields
- [ ] 158. Wrap parse errors → typed gRPC error with code `INVALID_ARGUMENT`
- [ ] 159. Create `apps/vscode/src/core/controller/models/loadGGUFModel.ts`
- [ ] 160. Map `LoadGGUFModelRequest` → `GGUFInferenceConfig`
- [ ] 161. Call `detectLlamaServer`; reject with install guidance if missing (BLOCKER)
- [ ] 162. On missing binary return a friendly gRPC error referencing the docs link
- [ ] 163. Acquire the `GGUFInferenceHandler` via `getRegisteredHandler`/registry
- [ ] 164. Hold the spawned llama-server reference on the controller instance
- [ ] 165. Return `LoadGGUFModelResponse { success, model_id, error }`
- [ ] 166. Create `apps/vscode/src/core/controller/models/unloadGGUFModel.ts`
- [ ] 167. Look up the running llama-server by model path and call `dispose()`
- [ ] 168. Free the held process reference and release the port
- [ ] 169. Return `Empty` confirmation (idempotent when nothing loaded)
- [ ] 170. Create `apps/vscode/src/core/controller/models/getGGUFModelStatus.ts`
- [ ] 171. Inspect the held reference to determine `isAlive` / PID
- [ ] 172. Query llama-server `/ps` (or `/system/info`) for memory usage when live
- [ ] 173. Map status → `GGUFModelStatus` proto
- [ ] 174. Add all four handlers to the `ModelsService` handler dispatch map
- [ ] 175. Wire handlers in `apps/vscode/src/core/controller/models/index.ts`
- [ ] 176. Guard handlers behind "model path is set & file exists" precondition
- [ ] 177. Add unit test for `resolveGGUFMetadata` with mocked `parseGGUFMetadataFromFile`
- [ ] 178. Test `loadGGUFModel` returns error when llama-server is not installed
- [ ] 179. Test `unloadGGUFModel` with no running process is safe (idempotent)
- [ ] 180. Test `getGGUFModelStatus` reports loaded/unloaded correctly
- [ ] 181. Test handler authorization: only authenticated sessions may load models (OPT)
- [ ] 182. Run `bun run test:unit` for the vscode package

---

## Phase 9 — Provider Config Store (183–197)

- [ ] 183. Re-read `providerCatalogShared.ts` `parseProviderIdRequest` for validation behavior
- [ ] 184. Verify `readProviderConfig` returns a `local-gguf` `ProviderConfig`
- [ ] 185. Verify `writeProviderConfig` accepts a `modelPath` / `threads` / `gpuLayers` patch
- [ ] 186. Extend `toProviderConfigPatch` to pass-through `modelPath`, `tokens`, `gpuLayers`
- [ ] 187. Extend `toRedactedProviderConfigResponse` with local-gguf config fields
- [ ] 188. Check `provider-settings-manager` `setGlobalStateBatch` persists new config shape
- [ ] 189. Verify `getProviderSettings("local-gguf")` returns correct defaults
- [ ] 190. Verify `saveProviderSettings("local-gguf", cfg)` round-trips
- [ ] 191. Scan legacy migration (`provider-settings-legacy-migration.ts`) for local-gguf safety
- [ ] 192. Ensure legacy `ApiConfiguration` keys do not conflict (OPT)
- [ ] 193. Add read/write round-trip test for `local-gguf` config
- [ ] 194. Add validation test: empty `modelPath` rejected before load
- [ ] 195. Add test: `modelPath` not pointing to a `.gguf` file is rejected
- [ ] 196. Verify `commitModelSelection` persists `local-gguf` model choice across mode toggle
- [ ] 197. Run `bun run test:unit` — config-store tests green

---

## Phase 10 — Settings Provider UI (198–237)

- [ ] 198. Create `apps/vscode/webview-ui/src/components/settings/providers/LocalGGUFProvider.tsx`
- [ ] 199. Import the shared hooks (`useExtensionState`, `useProviderConfig`, `useProviderModelSelection`, `useApiConfigurationHandlers`)
- [ ] 200. Import `ModelsServiceClient` from `@/services/grpc-client`
- [ ] 201. Import shared components: `ApiKeyField`, `BaseUrlField`, `DebouncedTextField`, `DropdownContainer`
- [ ] 202. Import toolkit components: `VSCodeButton/Link/TextField/Option/Dropdown`
- [ ] 203. Define `LocalGGUFProviderProps` (`showModelOptions`, `isPopup?`, `currentMode`)
- [ ] 204. Destructure props in the component function
- [ ] 205. Read `apiConfiguration` from `useExtensionState`
- [ ] 206. Read `config`, `write`, `commitSelection` from `useProviderConfig("local-gguf")`
- [ ] 207. Read `handleFieldChange` from `useApiConfigurationHandlers`
- [ ] 208. Initialize local state: `modelPath`, `threads`, `contextWindow`, `gpuLayers` (from config)
- [ ] 209. Initialize state: `modelMetadata`, `isLoading`, `error`, `modelLoaded`, `serverPid`
- [ ] 210. Implement `handleSelectFile()` — triggers VS Code native file-open dialog for `*.gguf`
- [ ] 211. Investigate how the file picker reaches the extension host (gRPC `openFile`? webview API?) and match the pattern (BLOCKER)
- [ ] 212. Persist `modelPath` via `write({ modelPath: path })` then parse metadata
- [ ] 213. Call `ModelsServiceClient.getGGUFMetadata` after a model path is chosen
- [ ] 214. Render model metadata card (arch, params, context length, file size, quant)
- [ ] 215. Add `DebouncedTextField` for **threads** with a `CpuCount` max
- [ ] 216. Add `DebouncedTextField` for **context window** (>0 validation)
- [ ] 217. Add `DebouncedTextField` for **GPU layers** (with VRAM hint)
- [ ] 218. Add **Load model** button → `ModelsServiceClient.loadGGUFModel`
- [ ] 219. Add **Unload model** button → `ModelsServiceClient.unloadGGUFModel` (shown when loaded)
- [ ] 220. Render a spinner / status dot (loading / loaded / error)
- [ ] 221. On mount, call `getGGUFModelStatus` to restore the previously loaded state
- [ ] 222. Poll `getGGUFModelStatus` every 5 s while a load is in flight (OPT)
- [ ] 223. Display server PID + memory usage fetched from status
- [ ] 224. Disable **Load model** until a valid `.gguf` path + metadata parse succeed
- [ ] 225. Disable **Unload** until a model is loaded
- [ ] 226. Show an error banner + install link when `llama-server` is not on PATH
- [ ] 227. Render the `showModelOptions` section (single "local-model" selection dropdown)
- [ ] 228. Render **request timeout** field (reuse Ollama pattern, default 300000)
- [ ] 229. Render the standard "Cline uses complex prompts…" disclaimer paragraph
- [ ] 230. Wire keyboard behaviour (Enter loads, Esc closes)
- [ ] 231. Use VS Code theme tokens (`var(--vscode-*)`) for all colours
- [ ] 232. Add aria-labels and `role`s for accessibility (BLOCKER)
- [ ] 233. Write `LocalGGUFProvider.test.tsx` — renders, opens file dialog, shows metadata
- [ ] 234. Run webview type-check (`tsc --noEmit`) for the component
- [ ] 235. Run Biome lint on the new file
- [ ] 236. Visual check: vertical rhythm matches neighbouring providers
- [ ] 237. Verify the component mounts when `local-gguf` is the selected provider

---

## Phase 11 — Provider Registry Updates (238–247)

- [ ] 238. Open `apps/vscode/webview-ui/src/components/settings/providers/providerSettingsRegistry.ts`
- [ ] 239. Add `"local-gguf"` to `CUSTOM_PROVIDER_SETTINGS_IDS`
- [ ] 240. Add `local-gguf` entry to `GENERIC_PROVIDER_PRESENTATION_OVERRIDES`
- [ ] 241. Override `baseUrlField` label → "Local Model File"
- [ ] 242. Override `baseUrlField` placeholder → "/path/to/model.gguf"
- [ ] 243. Set `signupUrl` to the llama.cpp GitHub releases
- [ ] 244. Verify `hasCustomProviderSettings("local-gguf") === true`
- [ ] 245. Verify `isKnownGenericProvider("local-gguf")` — if false, add to fallback names
- [ ] 246. Verify `getGenericProviderSettings("local-gguf", listing)` returns correct config
- [ ] 247. Run `providerSettingsRegistry.test.ts` — all assertions still pass

---

## Phase 12 — ApiOptions Integration (248–262)

- [ ] 248. Open `apps/vscode/webview-ui/src/components/settings/ApiOptions.tsx`
- [ ] 249. Add `import { LocalGGUFProvider } from "./providers/LocalGGUFProvider"`
- [ ] 250. Locate the provider-rendering switch / conditional block
- [ ] 251. Add `selectedProvider === "local-gguf"` branch rendering `<LocalGGUFProvider … />`
- [ ] 252. Verify `selectedProvider` resolves `local-gguf` (no aliasing issue)
- [ ] 253. Verify `useProviderListings()` includes `local-gguf` as a listing
- [ ] 254. Verify `catalogProviderListing` resolves for `local-gguf`
- [ ] 255. Verify `isCustomProvider` does not classify `local-gguf` as custom
- [ ] 256. Verify `genericProviderSettings` resolves for `local-gguf` rendering
- [ ] 257. Confirm provider dropdown renders "Local GGUF" as an option
- [ ] 258. Test selecting "Local GGUF" mounts `<LocalGGUFProvider />`
- [ ] 259. Test switching from another provider to `local-gguf` resets UI cleanly
- [ ] 260. Test switching away from `local-gguf` keeps its config in store
- [ ] 261. Run `tsc --noEmit` across the webview-ui package
- [ ] 262. Run Biome lint on `ApiOptions.tsx`

---

## Phase 13 — Local GGUF Model Picker (263–274)

- [ ] 263. Create `apps/vscode/webview-ui/src/components/settings/LocalGGUFModelPicker.tsx`
- [ ] 264. Import `useProviderModelSelection` and `ModelInfo` type
- [ ] 265. Import `ModelsServiceClient`
- [ ] 266. Implement component prop `selectedProvider` = `"local-gguf"`
- [ ] 267. Fetch models via `resolveProviderModels("local-gguf")` on mount
- [ ] 268. Render `DropdownContainer` + `VSCodeDropdown` populated from resolved models
- [ ] 269. Fallback: `DebouncedTextField` for manual model-id entry when no models
- [ ] 270. Commit selection via `commitModelSelection({ providerId: "local-gguf", modelId })`
- [ ] 271. Show context when model list is empty but metadata parsed (single "local-model")
- [ ] 272. Add `local-gguf` to any model-picker switch in `ApiOptions.tsx`
- [ ] 273. Write `LocalGGUFModelPicker.test.tsx` covering dropdown + manual entry
- [ ] 274. Verify picker renders inside `LocalGGUFProvider`'s `showModelOptions` block

---

## Phase 14 — Hooks & gRPC Client (275–286)

- [ ] 275. Read `apps/vscode/webview-ui/src/hooks/useProviderConfig.ts` — confirm it resolves `local-gguf`
- [ ] 276. Verify `useProviderConfig("local-gguf")` returns the persisted `modelPath`, `threads`, `gpuLayers`
- [ ] 277. Read `useProviderModelSelection.ts` — confirm default-model fallback works for `local-gguf`
- [ ] 278. Open `apps/vscode/webview-ui/src/services/grpc-client.ts`
- [ ] 279. Add `getGGUFMetadata(request: StringRequest, metadata?): Promise<GGUFMetadataResponse>`
- [ ] 280. Add `loadGGUFModel(request: LoadGGUFModelRequest): Promise<LoadGGUFModelResponse>`
- [ ] 281. Add `unloadGGUFModel(request: StringRequest): Promise<Empty>`
- [ ] 282. Add `getGGUFModelStatus(request: StringRequest): Promise<GGUFModelStatus>`
- [ ] 283. Verify gRPC client methods are typed and exported from `ModelsServiceClient`
- [ ] 284. Check `@services/grpc-client` exposes the new service client methods
- [ ] 285. Add a unit test double for the new gRPC methods
- [ ] 286. Run `bun run check` on the webview-ui package

---

## Phase 15 — Settings View Integration (287–298)

- [ ] 287. Read `apps/vscode/webview-ui/src/components/settings/SettingsView.tsx` (SPIKE)
- [ ] 288. Confirm provider sections are rendered conditionally from a list
- [ ] 289. Add `"local-gguf"` to any provider-section enablement check
- [ ] 290. Verify `local-gguf` displays a label in the provider switcher
- [ ] 291. Confirm the section key/id for `local-gguf` is registered
- [ ] 292. Check `apps/vscode/webview-ui/src/components/settings/Section.tsx` styling support
- [ ] 293. Verify keyboard tab-order includes the `local-gguf` section
- [ ] 294. Verify the `useProviderListings()` hook surfaces `local-gguf` listing
- [ ] 295. Confirm `ExtensionStateContext` posts `local-gguf` config on init
- [ ] 296. Verify config round-trip: webview save → extension host → gRPC → SDK → back
- [ ] 297. Check `SectionHeader.tsx` renders the provider title/name consistently
- [ ] 298. Run `bun run test:unit` for SettingsView + new provider tests

---

## Phase 16 — Styling & Visual Feedback (299–310)

- [ ] 299. Add a spinner component for "Load model in progress" state
- [ ] 300. Add success ✓ icon when model is loaded and ready
- [ ] 301. Add error ✗ icon/banner when load fails
- [ ] 302. Use VS Code theme tokens for spinner colours (`var(--vscode-progressBar-background)`)
- [ ] 303. Add a memory-usage meter (progress bar: used / total VRAM)
- [ ] 304. Add a "model warming" indicator (first token latency)
- [ ] 305. Ensure responsive layout: stacks vertically on narrow panels (popup)
- [ ] 306. Match vertical spacing of neighbouring providers (`gap-4` or `gap-2`)
- [ ] 307. Verify focus ring visibility on interactive elements
- [ ] 308. Add tooltips on `threads`, `gpuLayers`, `contextWindow` fields
- [ ] 309. Lint + format styling via Biome
- [ ] 310. Verify via screenshot/test that all three states render (loading / loaded / error)

---

## Phase 17 — SDK Unit Tests (311–335)

- [ ] 311. Create `sdk/packages/llms/src/providers/__tests__/gguf-parser.test.ts`
- [ ] 312. Test `parseGGUFMetadataFromFile` with a real tiny GGUF fixture
- [ ] 313. Test missing file → `GGUFParseError("ENOENT")`
- [ ] 314. Test non-GGUF file → `GGUFParseError("NOT_GGUF")`
- [ ] 315. Test truncated header → `GGUFParseError("TRUNCATED")`
- [ ] 316. Test GGUF version handling for v3/v4
- [ ] 317. Test metadata key-value extraction correctness
- [ ] 318. Test parameter-count derivation from `block_count`
- [ ] 319. Test quantization regex extraction (Q4_K_M, Q5_0, F16 …)
- [ ] 320. Create `sdk/packages/llms/src/providers/__tests__/gguf-inference.test.ts`
- [ ] 321. Test `GGUFInferenceHandler` construction with valid config
- [ ] 322. Test `detectLlamaServer` returns unavailable when mocked PATH is empty
- [ ] 323. Test `detectLlamaServer` returns path+version when `which llama-server` succeeds
- [ ] 324. Test `findFreePort` returns a usable port number
- [ ] 325. Test `spawnLlamaServer` builds correct argv (assert each flag)
- [ ] 326. Test `abort()` sets the internal `AbortController` signal
- [ ] 327. Test `dispose()` kills the child process (mocked `spawn`)
- [ ] 328. Test one-llama-server-per-path registry dedupes same model path
- [ ] 329. Test `getMessages` formats an OpenAI `chatCompletion` payload
- [ ] 330. Test `createMessage` streams chunks via mocked HTTP (RISK)
- [ ] 331. Test `createMessage` maps tool-call delta chunks
- [ ] 332. Test `createMessage` maps usage chunk (`prompt_tokens`, `completion_tokens`)
- [ ] 333. Test `createMessage` surfaces error response as a finished-error chunk
- [ ] 334. Test idle unload timer fires after idle-timeout minutes
- [ ] 335. Run `bun -F @cline/llms test` — zero failures

---

## Phase 18 — Extension Host Unit Tests (336–355)

- [ ] 336. Create `__tests__/getGGUFMetadata.handler.test.ts`
- [ ] 337. Test handler returns parsed metadata for a valid mock path
- [ ] 338. Test handler rejects with `INVALID_ARGUMENT` for a missing file
- [ ] 339. Test handler rejects with `INVALID_ARGUMENT` for a non-`.gguf` path
- [ ] 340. Create `__tests__/loadGGUFModel.handler.test.ts`
- [ ] 341. Test handler calls `detectLlamaServer` first
- [ ] 342. Test handler returns a friendly error when `llama-server` is missing (BLOCKER)
- [ ] 343. Test handler acquires the handler via `getRegisteredHandler`
- [ ] 344. Test handler returns `LoadGGUFModelResponse{success:true}` on success
- [ ] 345. Test handler stores the live reference on the `ProviderCatalogController`
- [ ] 346. Create `__tests__/unloadGGUFModel.handler.test.ts`
- [ ] 347. Test handler calls `dispose()` on the running process
- [ ] 348. Test handler is idempotent (no throw) when nothing is loaded
- [ ] 349. Test handler clears the held controller reference
- [ ] 350. Create `__tests__/getGGUFModelStatus.handler.test.ts`
- [ ] 351. Test handler returns `loaded:false` when no reference is held
- [ ] 352. Test handler returns `loaded:true` + pid + memory when process alive
- [ ] 353. Test handler detects a crashed llama-server (process exited)
- [ ] 354. Verify all four handlers are wired into the `ModelsService` dispatch map
- [ ] 355. Run `bun run test:unit` for the vscode-package models tests

---

## Phase 19 — Integration & E2E (356–370)

- [ ] 356. Extend `providerCatalogSmoke.test.ts` for the `local-gguf` provider (SPIKE)
- [ ] 357. Integration test: select `local-gguf` → `readProviderConfig` → `commitModelSelection` round-trip
- [ ] 358. Integration test: `resolveProviderModels("local-gguf")` returns a model entry
- [ ] 359. Integration test: `readProviderConfig`/`writeProviderConfig` with GGUF path patch
- [ ] 360. Integration test: `toRedactedProviderConfigResponse` exposes `local-gguf` fields (path masked in UI)
- [ ] 361. Unit test: `hasCustomProviderSettings("local-gguf") === true`
- [ ] 362. Unit test: `providerSettingsRegistry` returns a config for `local-gguf`
- [ ] 363. Webview render test: provider dropdown contains "Local GGUF"
- [ ] 364. Webview render test: selecting it mounts `LocalGGUFProvider`
- [ ] 365. Webview render test: file-picker button calls gRPC `pickFile` (SPIKE to confirm API)
- [ ] 366. Webview render test: metadata card shows arch + context length after fetch
- [ ] 367. E2E: launch real `llama-server` with a tiny fixture → `loadGGUFModel` RPC → expect success
- [ ] 368. E2E: send one chat turn through the loaded `local-gguf` handler and verify a streamed response
- [ ] 369. E2E: `getGGUFModelStatus` reflects the running server PID + memory
- [ ] 370. Run `bun run test:e2e` (VS Code extension host) for end-to-end pass

---

## Phase 20 — Provider Listing & Discovery (371–386)

- [ ] 371. Inspect `apps/vscode/src/sdk/model-catalog/catalog.ts` for provider enumeration (SPIKE)
- [ ] 372. Confirm `local-gguf` appears in the SDK-side provider listing
- [ ] 373. Confirm `local-gguf` listing flows to the webview via gRPC `ListProviders`
- [ ] 374. Verify the provider switcher dropdown includes "Local GGUF"
- [ ] 375. Verify selecting it sets `planModeApiProvider`/`actModeApiProvider` to `"local-gguf"`
- [ ] 376. Verify `providerSwitchNormalization.ts` doesn't strip `local-gguf`
- [ ] 377. Check `apps/vscode/src/core/controller/models/providerCatalogShared.ts` `toProviderListingProto` handles `local-gguf`
- [ ] 378. Verify `family: "openai-compatible"` flows in the proto `ProviderListing`
- [ ] 379. Verify `protocol` field for `local-gguf` resolves to `openai-chat`
- [ ] 380. Add `local-gguf` to catalog smoke test assertions (listings include it)
- [ ] 381. Verify search/discovery filters don't hide `local-gguf`
- [ ] 382. Verify `local-gguf` is marked `local: true` in listing metadata (for UI grouping)
- [ ] 383. Check marketplace/marketplace catalog doesn't duplicate `local-gguf`
- [ ] 384. Verify provider icon / emoji renders for `local-gguf` in the dropdown (📁 or 🧠)
- [ ] 385. Verify `isBuiltInProviderId` and `BUILT_IN_PROVIDER_IDS` include it at runtime
- [ ] 386. Run `bun run test:unit` for models + catalog tests

---

## Phase 21 — Configuration & State Management (387–402)

- [ ] 387. Check `src/shared/storage/state-keys.ts` for provider-settings global keys (SPIKE)
- [ ] 388. Ensure no new state key is required (`local-gguf` config rides on existing provider store)
- [ ] 389. Verify `ProviderSettingsManager` `getProviderSettings("local-gguf")` returns defaults
- [ ] 390. Verify `saveProviderSettings("local-gguf", cfg)` persists `modelPath`/`threads`/`gpuLayers`
- [ ] 391. Verify `deleteProviderSettings("local-gguf")` cleans up correctly
- [ ] 392. Check `apps/vscode/src/core/controller/state/updateSettings.ts` for provider toggle handling
- [ ] 393. Verify `apps/vscode/src/core/controller/state/updateSettingsCli.ts` handles `local-gguf`
- [ ] 394. Verify `getStateToPostToWebview()` includes the `local-gguf` config envelope
- [ ] 395. Verify webview `ExtensionStateContext` initialises `local-gguf` defaults
- [ ] 396. Verify `toProtobufModelInfo` serialises `local-gguf` model info
- [ ] 397. Verify `fromProtobufModelInfo` deserialises correctly for `local-gguf`
- [ ] 398. Verify `commitModelSelection` persists `local-gguf` selection in both plan & act modes
- [ ] 399. Verify the mode toggle (Plan ↔ Act) preserves the `local-gguf` selection
- [ ] 400. Verify secret storage doesn't attempt to save `local-gguf` API keys (not required)
- [ ] 401. Add a round-trip storage test for `local-gguf` config
- [ ] 402. Verify config survives an extension-host reload (persisted in `providers.json`)

---

## Phase 22 — Error Handling & Edge Cases (403–422)

- [ ] 403. Define a typed `LocalGgufError` class extending `RpcError`/gRPC error
- [ ] 404. Error codes: `NOT_INSTALLED`, `MODEL_NOT_FOUND`, `LOAD_FAILED`, `SERVER_ERROR`
- [ ] 405. Map `detectLlamaServer` miss → `NOT_INSTALLED` with install-guide link
- [ ] 406. Map file-not-found → `MODEL_NOT_FOUND` (graceful, no host crash)
- [ ] 407. Map llama-server startup failure → `LOAD_FAILED` with stderr excerpt
- [ ] 408. Map HTTP 5xx from llama-server → `SERVER_ERROR` with status code
- [ ] 409. Catch abort-signal errors and translate to `CANCELLED`
- [ ] 410. Verify `getGGUFMetadata` errors surface as toast/snackbar in the webview
- [ ] 411. Verify `loadGGUFModel` errors surface in the Load button with an inline message
- [ ] 412. Add retry-with-backoff for transient `SERVER_ERROR` (e.g. port still releasing)
- [ ] 413. Handle the case where `llama-server` is already running on the chosen port
- [ ] 414. Handle corrupted GGUF gracefully — show file-integrity error, do not crash host
- [ ] 415. Handle GGUF with unsupported architecture — refuse with clear message
- [ ] 416. Handle out-of-memory during model load — surface as `LOAD_FAILED`
- [ ] 417. Clean up the spawned process on extension-deactivate (BLOCKER)
- [ ] 418. Clean up the spawned process when the webview closes / task is cancelled
- [ ] 419. Add a max model file-size guard (e.g. warn > 8 GB)
- [ ] 420. Validate `contextWindow` ≤ parsed `*.context_length` and clamp if over
- [ ] 421. Validate `gpuLayers` ≤ total layer count; show warning if too high
- [ ] 422. Add an integration test that a crash in `llama-server` is detected & reported

---

## Phase 23 — Documentation & Onboarding (423–437)

- [ ] 423. Create `docs/features/local-gguf.md` (user-facing walkthrough)
- [ ] 424. Write "install llama-server" section for macOS / Windows / Linux
- [ ] 425. Write "select a .gguf file" step-by-step with screenshots
- [ ] 426. Write "load model" + status indicators explanation
- [ ] 427. Add troubleshooting: `llama-server` not found, wrong arch, OOM
- [ ] 428. Add a docs FAQ: supported architectures (Llama, Qwen, Gemma, etc.)
- [ ] 429. Add a docs FAQ: why GPU layers / threads matter
- [ ] 430. Link `local-gguf` docs from README "local models" section
- [ ] 431. Add a `docs/local-gguf` entry to `docs/docs.json` (Mintlify TOC)
- [ ] 432. Update onboarding: detect no providers → surface "local GGUF" suggestion
- [ ] 433. Update the first-run checklist to mention local files
- [ ] 434. Add a `ClinePassHint`/banner variant promoting `local-gguf` (OPT)
- [ ] 435. Add CLI help text: `cline docs local-gguf` opens the docs page
- [ ] 436. Add a callout in the `LocalGGUFProvider` linking to the docs
- [ ] 437. Update CHANGELOG entry (or skip per contributor rules)

---

## Phase 24 — Build & Packaging (438–457)

- [ ] 438. Confirm `bun run build:sdk` compiles `gguf-parser.ts` + `gguf-inference.ts` (BLOCKER)
- [ ] 439. Confirm `@cline/llms` exports the new parser + handler types
- [ ] 440. Confirm `bun esbuild.mjs` bundles the vscode extension without local-gguf symbols leaking unexpectedly
- [ ] 441. Confirm `bun run build:webview` bundles `LocalGGUFProvider.tsx` + `LocalGGUFModelPicker.tsx`
- [ ] 442. Run `bun run check` (lint + build + typecheck) for SDK, CLI, vscode
- [ ] 443. Run `bun run typecheck` for `apps/examples/desktop-app` (uses SDK)
- [ ] 444. Check `knip.json` / `knip` — no unused export warnings introduced
- [ ] 445. Check `biome.json` formatting rules apply to new files
- [ ] 446. Verify `tsconfig.build.json` / `tsconfig.json` include paths for new files
- [ ] 447. Confirm `bun run protos` regenerates cleanly and no `_pb2` drift
- [ ] 448. Package the extension (`bun run package`) — `local-gguf` appears in `package.json` exports if needed
- [ ] 449. Verify `vsce`/`esbuild` packaging doesn't tree-shake the GGUF parser
- [ ] 450. Check `.vscodeignore` — `llama-server` binary references excluded from VSIX (OPT)
- [ ] 451. Confirm no `eval`/`Function` usages in inference code (Biome/security lint)
- [ ] 452. Verify the webview bundle size delta is acceptable (< +100 KB)
- [ ] 453. Confirm dev builds with `IS_DEV=true bun esbuild.mjs` work
- [ ] 454. Verify HMR works when editing `LocalGGUFProvider.tsx` in dev
- [ ] 455. Confirm `bun run clean` removes all new build artifacts
- [ ] 456. Verify `bun.lock` updated correctly after adding any dependencies (OPT — see note)
- [ ] 457. Final full-repo `bun run check` passes end-to-end

---

## Phase 25 — Manual QA Test Matrix (458–487)

**Setup:** install `llama.cpp` + a tiny model (e.g. `TinyLlama-1.1B-Chat-Q4_K_M.gguf`)

- [ ] 458. Open VS Code → Settings → Providers tab → "Local GGUF" appears in dropdown
- [ ] 459. Select "Local GGUF" → `LocalGGUFProvider` renders
- [ ] 460. Click "Select file" → native dialog opens, filters to `.gguf`
- [ ] 461. Select a `.gguf` → metadata card populates within 3 s
- [ ] 462. Verify metadata shows correct architecture and parameter count
- [ ] 463. Change CPU threads field → persists on reload
- [ ] 464. Change GPU layers → persists on reload
- [ ] 465. Change context window → persists on reload
- [ ] 466. Click "Load model" → spinner shows, then green ✓ when ready
- [ ] 467. When `llama-server` not installed → red error with install link
- [ ] 468. With a huge model (10 GB+) → file-size warning appears
- [ ] 469. With corrupt `.gguf` → error: "file may be corrupted or incomplete"
- [ ] 470. `getGGUFModelStatus` shows PID + memory while loaded
- [ ] 471. Click "Unload model" → green state resets to not-loaded
- [ ] 472. Send a chat message → streamed response (non-tool) works
- [ ] 473. Send a chat message requiring a tool call → model emits tool call
- [ ] 474. Verify the streamed tool call executes a built-in tool (read file)
- [ ] 475. Switch mode Plan ↔ Act → `local-gguf` selection preserved
- [ ] 476. Restart VS Code → config + last-loaded model path persisted
- [ ] 477. Open Cline in a new workspace → still can select the absolute path
- [ ] 478. Run `cline` CLI with `--provider local-gguf` → uses the configured file
- [ ] 479. Open multiple Cline tabs → each gets independent local-gguf session
- [ ] 480. Cancel a request mid-stream → llama-server stops generating
- [ ] 481. On extension deactivate → `llama-server` process is killed
- [ ] 482. With port 8000 already taken → `llama-server` picks an ephemeral port
- [ ] 483. Low-RAM machine (4 GB) + 3 GB model → OOM error is reported, not a crash
- [ ] 484. GPU layers > 0 with no CUDA → clear warning instead of fallback
- [ ] 485. Accessibility: tab through all inputs, focus rings visible
- [ ] 486. Keyboard: Enter on Load button, Esc to close dialogs
- [ ] 487. Final `bun run test:unit` + `bun run test:e2e` pass locally

---

## Phase 26 — Performance & Resource Management (488–507)

- [ ] 488. Add a concurrency cap: max 1 local-gguf model loaded at a time system-wide
- [ ] 489. Stream model loading progress (llama-server `/ps`, `/progress`) to the UI
- [ ] 490. Show "model loading…" step labels (kv, tensors, etc.) from llama-server logs
- [ ] 491. Avoid re-parsing GGUF metadata: cache by path+mtime (5-min TTL)
- [ ] 492. Reuse an already-running `llama-server` if the same model path is loaded again
- [ ] 493. Enforce idle GC: unload model after 15 min of no chat activity
- [ ] 494. Report resident memory of `llama-server` via `/ps` in `getGGUFModelStatus`
- [ ] 495. Limit request timeout to match llama-server `--conn-timeout` (default 5 min)
- [ ] 496. Cap `gpuLayers` at the model's actual layer count to avoid over-allocation
- [ ] 497. Warn (not hard-fail) when `threads` exceeds logical CPU count
- [ ] 498. Show memory estimate (model file size × 1.x) before the user loads
- [ ] 499. Add `max_tokens` enforcement based on parsed `*.context_length`
- [ ] 500. Batch `readProviderConfig` RPCs so loading + status + metadata use one request
- [ ] 501. Lazy-load `gguf-inference.ts` only when the provider is selected (code-split)
- [ ] 502. Measure first-token latency; log as a diagnostic metric
- [ ] 503. Track load/unload telemetry events (provider, model size, load time) (OPT)
- [ ] 504. Avoid blocking the webview event loop while loading the model
- [ ] 505. Ensure `createMessage` streams tokens immediately (no large buffering)
- [ ] 506. Gracefully degrade to CPU-only when GPU init fails without crashing host
- [ ] 507. Add a `bun run perf:local-gguf` script that loads a fixture and times it (OPT)

---

## Phase 27 — Security & Safety (508–522)

- [ ] 508. Validate the selected `.gguf` path is a real file before any RPC (BLOCKER)
- [ ] 509. Confine `llama-server` to `127.0.0.1` only (no `0.0.0.0`) — never expose to LAN
- [ ] 510. Never write the model file to a global/shared directory; read in place
- [ ] 511. Ensure model file paths are NOT sent to Cline telemetry
- [ ] 512. Ensure model file paths are not persisted in `globalState` (secret-adjacent)
- [ ] 513. Store provider config (incl. optional API key) via the existing `ProviderSettingsManager` encryption path
- [ ] 514. Sanitise stderr output from `llama-server` before showing in UI (strip paths/tokens)
- [ ] 515. Validate `base URL` style inputs to prevent SSRF against internal services
- [ ] 516. Rate-limit `loadGGUFModel` RPC (≥ 100 ms throttle) to prevent abuse
- [ ] 517. Cap max model file read size at 32 GB to prevent DoS
- [ ] 518. Refuse to load models from network drives / UNC paths (opt-out via setting)
- [ ] 519. Add a security test: loading a `.zip` renamed to `.gguf` is rejected
- [ ] 520. Add a security test: symlink chains that escape cwd are refused
- [ ] 521. Verify no GGUF file bytes are ever included in telemetry/error events
- [ ] 522. Run `bunx --bun @cline/core audit` / `bun audit` for new transitive deps (if any)

---

## Phase 28 — Cross-Platform Validation (523–537)

- [ ] 523. macOS: install `llama.cpp` via Homebrew → "Local GGUF" loads a `.gguf`
- [ ] 524. macOS Apple Silicon: 4-bit model loads, GPU offload (Metal) works
- [ ] 525. macOS Intel: CPU-only load works, no GPU-layer crash
- [ ] 526. Windows x64: `llama-server.exe` on PATH → loads model + tool calls work
- [ ] 527. Windows: UNC paths and backslashes in `modelPath` handled correctly
- [ ] 528. Linux x64: apt-installed `llama-cpp-python` server → integration works
- [ ] 529. Linux ARM64 (e.g. aarch64): ARM64 build of llama.cpp loads a model
- [ ] 530. File picker returns native paths on each OS (forward/back slash correct)
- [ ] 531. Process spawning uses the correct argv quoting on each OS
- [ ] 532. `bun run build:sdk` succeeds on all 3 platforms in CI
- [ ] 533. `bun run package` produces a VSIX that installs on all 3 platforms
- [ ] 534. Verify no Windows-only native node in the SDK build
- [ ] 535. Verify graceful failure on headless CI (no display) — error, don't crash
- [ ] 536. Verify locale/encoding edge cases in file paths (spaces, unicode)
- [ ] 537. Run `test:unit` on Windows, macOS, and Linux CI matrices

---

## Phase 29 — UX Polish & Accessibility (538–551)

- [ ] 538. Show a progress bar with percentage while `llama-server` is loading the model
- [ ] 539. Show the GGUF architecture family badge (Llama / Qwen / Gemma / …)
- [ ] 540. Show parameter count in human-friendly form (7.4 B, 12.2 B)
- [ ] 541. Show quantization badge (Q4_K_M, Q5_K_S, F16) with a tooltip explaining it
- [ ] 542. Disable the model-selection dropdown until the model is loaded
- [ ] 543. Auto-select "local-model" and commit on successful load
- [ ] 544. Add a "Reload model" button (unload → load → re-fetch metadata)
- [ ] 545. Add inline help text for each field (`threads`, `gpuLayers`, `contextWindow`)
- [ ] 546. Add a "Clear" button that resets the `.gguf` path and unloads
- [ ] 547. Verify contrast ratios meet WCAG AA for all new UI colours
- [ ] 548. Verify screen-reader labels on every input and button
- [ ] 549. Verify focus management: first input auto-focused after render
- [ ] 550. Add a "Don't show this again" opt-out for the file-size warning (per-path)
- [ ] 551. Final user-test session: select + load + chat with a real GGUF

---

## Phase 30 — Release & Rollout (552–565)

- [ ] 552. Bump patch version in `apps/vscode/package.json` (e.g. `4.1.18`)
- [ ] 553. Add feature flag `localGgufProvider` defaulting to `true` (BLOCKER — gating key)
- [ ] 554. Gate the provider behind the flag so it can be rolled back (OPT)
- [ ] 555. Draft the PR description: user value, how to test, file-matrix summary
- [ ] 556. Draft the CHANGELOG entry
- [ ] 557. Run the full `bun run check` gate locally
- [ ] 558. Push a branch and open the PR
- [ ] 559. Request review from an `@cline/llms` owner + a `@cline/vscode` owner
- [ ] 560. Address all CI failures before merge
- [ ] 561. Merge behind feature flag OR full release as agreed with maintainers
- [ ] 562. If flagged: monitor `localGgufProvider` adoption telemetry 48 h
- [ ] 563. If flagged & green: flip default to `true` (OPT)
- [ ] 564. Publish `apps/vscode` to a beta release tier first
- [ ] 565. Announce in Discord `#releases` + update the docs site

---

## Phase 31 — Post-Release & Maintenance (566–577)

- [ ] 566. Monitor Sentry/Rollbar for llama-server spawn / GGUF parse errors
- [ ] 567. Monitor extension crash logs for the first week
- [ ] 568. Collect user feedback: install friction, model compatibility
- [ ] 569. Add a "Report issue" pre-filled GitHub link from the error banner
- [ ] 570. Triage top 3 failure modes → write follow-up bug tasks
- [ ] 571. Consider bundling a prebuilt `llama-server` binary per platform (future PR)
- [ ] 572. Consider a curated model-download wizard (future PR)
- [ ] 573. Add `local-gguf` to the e2e fixture test matrix
- [ ] 574. Remove the feature flag once adoption is confirmed (if flagged)
- [ ] 575. Update contributor docs (`AGENTS.md`, `CONTRIBUTING.md`) with new provider pattern
- [ ] 576. Close all 577 checklist items and archive this document
- [ ] 577. Write a retro summary for the team

---

## ✅ MVP Cut List — "Local GGUF without an external provider"

~95 tasks above deliver a usable first version. Everything else is polish.

**SDK core:** 16, 17, 22–24, 31–46, 71, 72, 73–76, 81–89, 100–104, 111–113, 311–314, 320, 321–327, 329
**Proto/RPC:** 133–139, 142–145
**Backend handlers:** 153–158, 159–165, 183–189, 196, 197, 336–344, 346–349, 351–353, 354
**Webview:** 198–207, 210–213, 215–218, 220, 224, 226–228, 231–237, 248–256, 258–261, 268–272
**Registry:** 238–243
**Tests:** 316, 317, 319, 322–324, 328, 330, 331, 353–354, 370, 426–428, 455, 456, 457, 482, 483, 484, 487

**MVP gate:** `bun run build:sdk` + at least `bun run test:unit` pass, with a real ≥1 GB `.gguf` loading + streaming a reply in VS Code.

---

## ✅ Definition of Done (tick all to close the PR)

- [ ] `bun run build:sdk` compiles with **zero** errors
- [ ] `bun run check` passes for `sdk/`, `apps/cli`, `apps/vscode`, `apps/examples/*`
- [ ] `bun run test:unit` passes (SDK + vscode) — no existing tests regressed
- [ ] A real `.gguf` model (≥ 1 GB) loads and streams a reply in VS Code
- [ ] A **tool-call** round-trips through the loaded GGUF model end-to-end
- [ ] `llama-server` is killed on extension deactivate (no leaked processes)
- [ ] PR reviewed by ≥ 1 SDK owner **and** ≥ 1 VS Code owner
- [ ] Docs page published and linked from README
- [ ] MVP checklist items above are all ticked

---

## ⚠️ Risk Register

| # | Risk | Mitigation | Owner area | Status |
|---|------|-----------|------------|--------|
| R1 | llama.cpp not on the user's PATH | Surface an install-link banner, detect version | SDK | OPEN |
| R2 | Native binary compat across OS/CPU | Ship a prebuilt `llama-server` per platform (future PR) | infra | OPEN |
| R3 | Large models crash low-RAM machines | 32 GB file-size guard (task 417/517) + clear error | SDK | MITIGATED |
| R4 | GGUF format v3/v4 / arch unsupported by parser | Parser validates magic+version; refuse with a message | SDK | OPEN |
| R5 | Spawned `llama-server` leaks on host crash | `dispose()` on deactivate + task abort (417–418, 518) | core | OPEN |
| R6 | SSRF via a user-supplied base URL | Localhost-only binding (task 509) | core | MITIGATED |
| R7 | Webview bundle size blow-up | Lazy-load the handler (task 501) + size check | webview | OPEN |
| R8 | Tests pass locally but fail in CI | Run full 3-platform CI matrix (532–537) | QA | OPEN |
| R9 | Model loading blocks the extension-host thread | Load in a detached child process; non-blocking RPCs | core | MITIGATED |

---

## 📊 Summary of Work

**577 micro-tasks across 32 phases.**
- SDK / core: ~180 tasks
- Webview UI: ~95 tasks
- Backend / extension host: ~70 tasks
- Tests: ~75 tasks
- Perf / security / cross-platform: ~70 tasks
- Docs / release / post-release: ~77 tasks

> 📝 **Dependencies & assumptions.** This plan assumes **llama-server** (the CLI/HTTP server binary) is installed by the user. **Bundling a prebuilt `llama-server` per platform is explicitly deferred** to a follow-up PR (see Risk R2) to keep the first scope sane. The MVP ships with a clear install-link when the binary is missing.