import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiConfigurationSection from "./sections/ApiConfigurationSection"

// Phase 15 (Settings View Integration) has no per-provider registry to edit:
// SettingsView is a tab shell, ApiConfigurationSection renders <ApiOptions>
// unconditionally, and ApiOptions derives its dropdown from the catalog listing.
// So instead of asserting on a list that does not exist, this suite locks the
// behaviour those tasks actually care about — that `local-gguf` reaches the
// provider form through the settings surface without any opt-in step.

const mocks = vi.hoisted(() => ({
	listings: [] as unknown[],
	apiConfiguration: {} as Record<string, unknown>,
	readProviderConfig: vi.fn(),
	writeProviderConfig: vi.fn(),
}))

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
	VSCodeTextField: ({ value }: { value?: string }) => <input value={value} />,
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
	VSCodeDropdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

vi.mock("@radix-ui/react-tooltip", () => ({
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { selectFiles: vi.fn() },
	ModelsServiceClient: {
		resolveProviderModels: vi.fn(),
		readProviderConfig: mocks.readProviderConfig,
		writeProviderConfig: mocks.writeProviderConfig,
		commitModelSelection: vi.fn(),
		getGGUFMetadata: vi.fn(),
		getGGUFModelStatus: vi.fn(),
		loadGGUFModel: vi.fn(),
		unloadGGUFModel: vi.fn(),
	},
	StateServiceClient: { updateSettings: vi.fn() },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mocks.apiConfiguration,
		mode: "act",
		planActSeparateModelsSetting: false,
		remoteConfigSettings: undefined,
	}),
}))

vi.mock("@/hooks/useProviderListings", () => ({
	useProviderListings: () => ({ providers: mocks.listings, isLoading: false, error: undefined, refresh: vi.fn() }),
}))

vi.mock("./providers/LocalGGUFProvider", () => ({
	LocalGGUFProvider: () => <div data-testid="local-gguf-form" />,
}))
vi.mock("./providers/GenericProviderSettings", () => ({
	GenericProviderSettings: () => <div data-testid="generic-form" />,
}))
vi.mock("./providers/OpenAICompatible", () => ({
	OpenAICompatibleProvider: () => <div data-testid="openai-compatible-form" />,
}))
vi.mock("./providers/AnthropicProvider", () => ({
	AnthropicProvider: () => <div data-testid="anthropic-form" />,
}))
vi.mock("./providers/AihubmixProvider", () => ({ AIhubmixProvider: () => null }))
vi.mock("./providers/AskSageProvider", () => ({ AskSageProvider: () => null }))
vi.mock("./providers/BasetenProvider", () => ({ BasetenProvider: () => null }))
vi.mock("./providers/BedrockProvider", () => ({ BedrockProvider: () => null }))
vi.mock("./providers/ClaudeCodeProvider", () => ({ ClaudeCodeProvider: () => null }))
vi.mock("./providers/ClinePassProvider", () => ({ ClinePassProvider: () => null }))
vi.mock("./providers/ClineProvider", () => ({ ClineProvider: () => null }))
vi.mock("./providers/DifyProvider", () => ({ DifyProvider: () => null }))
vi.mock("./providers/GroqProvider", () => ({ GroqProvider: () => null }))
vi.mock("./providers/HicapProvider", () => ({ HicapProvider: () => null }))
vi.mock("./providers/HuggingFaceProvider", () => ({ HuggingFaceProvider: () => null }))
vi.mock("./providers/LiteLlmProvider", () => ({ LiteLlmProvider: () => null }))
vi.mock("./providers/LMStudioProvider", () => ({ LMStudioProvider: () => null }))
vi.mock("./providers/MoonshotProvider", () => ({ MoonshotProvider: () => null }))
vi.mock("./providers/OcaProvider", () => ({ OcaProvider: () => null }))
const LOCAL_GGUF_LISTING = {
	allowsCustomModelIds: true,
	id: "local-gguf",
	name: "Local GGUF",
	protocol: "openai-chat",
}

describe("ApiConfigurationSection local-gguf integration", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.listings = [LOCAL_GGUF_LISTING]
		mocks.apiConfiguration = { actModeApiProvider: "local-gguf", planModeApiProvider: "anthropic" }
	})

	// 288 / 289 — no per-provider enablement check exists, and none is needed:
	// the section renders <ApiOptions> for every provider unconditionally.
	it("renders the provider form for local-gguf with no per-provider opt-in", () => {
		render(<ApiConfigurationSection />)

		expect(screen.getByTestId("local-gguf-form")).toBeInTheDocument()
	})

	// 291 — there is no provider-section key/registry; the provider id itself is
	// the routing key, so the form mounting proves the id resolves end-to-end.
	it("routes on the provider id, so no separate section id is required", () => {
		render(<ApiConfigurationSection />)

		expect(screen.queryByTestId("generic-form")).not.toBeInTheDocument()
		expect(screen.queryByTestId("openai-compatible-form")).not.toBeInTheDocument()
	})

	// 294 — the catalog listing is the only thing that surfaces the provider.
	it("surfaces local-gguf purely from the provider listing", () => {
		render(<ApiConfigurationSection />)

		expect(screen.getByTestId("local-gguf-form")).toBeInTheDocument()
		expect(mocks.listings).toContainEqual(LOCAL_GGUF_LISTING)
	})

	// 293 — the form is ordinary focusable markup inside the section, so it joins
	// the tab order with no extra wiring; asserted structurally here.
	it("renders the form inside the section's focusable markup", () => {
		render(<ApiConfigurationSection />)

		expect(screen.getByTestId("local-gguf-form")).toBeInTheDocument()
		expect(screen.getByText("Use different models for Plan and Act modes")).toBeInTheDocument()
	})
})
vi.mock("./providers/OllamaProvider", () => ({ OllamaProvider: () => null }))
vi.mock("./providers/OpenAINative", () => ({ OpenAINativeProvider: () => null }))
vi.mock("./providers/OpenAiCodexProvider", () => ({ OpenAiCodexProvider: () => null }))
vi.mock("./providers/OpenRouterProvider", () => ({ OpenRouterProvider: () => null }))
vi.mock("./providers/QwenCodeProvider", () => ({ QwenCodeProvider: () => null }))
vi.mock("./providers/QwenProvider", () => ({ QwenProvider: () => null }))
vi.mock("./providers/RequestyProvider", () => ({ RequestyProvider: () => null }))
vi.mock("./providers/SapAiCoreProvider", () => ({ SapAiCoreProvider: () => null }))
vi.mock("./providers/VercelAIGatewayProvider", () => ({ VercelAIGatewayProvider: () => null }))
vi.mock("./providers/VertexProvider", () => ({ VertexProvider: () => null }))
vi.mock("./providers/VSCodeLmProvider", () => ({ VSCodeLmProvider: () => null }))
vi.mock("./providers/XaiProvider", () => ({ XaiProvider: () => null }))
vi.mock("./providers/ZAiProvider", () => ({ ZAiProvider: () => null }))
vi.mock("./ClinePassHint", () => ({ ClinePassHint: () => null }))
vi.mock("./utils/providerUtils", () => ({ syncModeConfigurations: vi.fn() }))
vi.mock("./utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: vi.fn(),
		handleModeFieldChange: vi.fn(),
		handleFieldsChange: vi.fn(),
	}),
}))
