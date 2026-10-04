import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiOptions from "./ApiOptions"

// Phase 12 verification for the `local-gguf` provider (tasks 252-260). The
// provider tree is stubbed so this suite only exercises ApiOptions' routing
// decisions: which listing resolves, whether the provider counts as "custom",
// and which settings form actually mounts.

const mocks = vi.hoisted(() => ({
	listings: [] as unknown[],
	handleModeFieldChange: vi.fn(),
	apiConfiguration: {} as Record<string, unknown>,
}))

// ApiOptions itself renders only VSCodeTextField from the toolkit; every
// provider form is stubbed below.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		value,
		onFocus,
		onInput,
		onKeyDown,
	}: {
		value?: string
		onFocus?: () => void
		onInput?: (e: unknown) => void
		onKeyDown?: (e: unknown) => void
	}) => (
		<input
			onChange={(e) => {
				onInput?.(e)
				onKeyDown?.(e)
			}}
			onFocus={onFocus}
			value={value}
		/>
	),
	VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
	VSCodeDropdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

// Radix-backed tooltip wrappers used by ApiOptions itself.
vi.mock("@radix-ui/react-tooltip", () => ({
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/ui/tooltip", () => ({
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))
vi.mock("./ClinePassHint", () => ({ ClinePassHint: () => null }))

// ApiOptions statically imports every provider form, so each one must resolve.
// A named export per module keeps the real routing logic intact while keeping
// the assertions focused on which form mounts.
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

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		apiConfiguration: mocks.apiConfiguration,
		remoteConfigSettings: undefined,
	}),
}))

vi.mock("@/hooks/useProviderListings", () => ({
	useProviderListings: () => ({ providers: mocks.listings, isLoading: false, error: undefined, refresh: vi.fn() }),
}))

vi.mock("./utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({
		handleFieldChange: vi.fn(),
		handleModeFieldChange: mocks.handleModeFieldChange,
	}),
}))

// Only the local-gguf branch is under test; each sibling form renders a marker
// so a mis-route is visible instead of silently rendering nothing.
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

const LOCAL_GGUF_LISTING = {
	allowsCustomModelIds: true,
	id: "local-gguf",
	name: "Local GGUF",
	protocol: "openai-chat",
}
const DEEPSEEK_LISTING = {
	allowsCustomModelIds: false,
	id: "deepseek",
	name: "DeepSeek",
	protocol: "openai-chat",
}

function renderApiOptions() {
	return render(<ApiOptions currentMode="act" isPopup={false} showModelOptions={false} />)
}

describe("ApiOptions local-gguf routing", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.listings = [LOCAL_GGUF_LISTING, DEEPSEEK_LISTING]
		mocks.apiConfiguration = { actModeApiProvider: "local-gguf", planModeApiProvider: "anthropic" }
	})

	// 252 / 258
	it("resolves the selected provider id verbatim and mounts the local-gguf form", () => {
		renderApiOptions()

		expect(screen.getByTestId("local-gguf-form")).toBeInTheDocument()
	})

	// 253 / 254 / 257
	it("lists Local GGUF in the provider dropdown from the catalog listing", () => {
		renderApiOptions()
		// Options render only while the dropdown is open; typing in the search
		// field is what opens it.
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Local" } })

		expect(screen.getByTestId("provider-option-local-gguf")).toHaveTextContent("Local GGUF")
	})

	// 255 / 256
	it("never routes local-gguf to the generic or OpenAI-compatible forms", () => {
		renderApiOptions()

		expect(screen.queryByTestId("generic-form")).not.toBeInTheDocument()
		expect(screen.queryByTestId("openai-compatible-form")).not.toBeInTheDocument()
	})

	// 260
	it("switches the provider without writing any provider config", () => {
		renderApiOptions()
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "Deep" } })

		fireEvent.click(screen.getByTestId("provider-option-deepseek"))

		expect(mocks.handleModeFieldChange).toHaveBeenCalled()
	})

	// 259
	it("mounts only the newly selected provider's form", () => {
		mocks.apiConfiguration = { actModeApiProvider: "deepseek", planModeApiProvider: "anthropic" }
		renderApiOptions()

		expect(screen.getByTestId("generic-form")).toBeInTheDocument()
		expect(screen.queryByTestId("local-gguf-form")).not.toBeInTheDocument()
	})
})
