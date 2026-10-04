import { fireEvent, render, screen } from "@testing-library/react"
import type { ChangeEventHandler, FormEventHandler, KeyboardEventHandler, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LocalGGUFModelPicker } from "./LocalGGUFModelPicker"

// Render the toolkit web components as native elements so value/change
// behavior is observable in jsdom.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeDropdown: ({
		children,
		id,
		onChange,
		value,
		"aria-label": ariaLabel,
	}: {
		children?: ReactNode
		id?: string
		onChange?: ChangeEventHandler<HTMLSelectElement>
		value?: string
		"aria-label"?: string
	}) => (
		<select aria-label={ariaLabel} id={id} onChange={onChange} value={value}>
			{children}
		</select>
	),
	VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
	VSCodeTextField: ({
		children,
		id,
		onInput,
		onKeyDown,
		placeholder,
		value,
	}: {
		children?: ReactNode
		id?: string
		onInput?: FormEventHandler<HTMLInputElement>
		onKeyDown?: KeyboardEventHandler<HTMLInputElement>
		placeholder?: string
		value?: string
	}) => (
		<div>
			<label htmlFor={id}>{children}</label>
			<input id={id} onChange={onInput} onKeyDown={onKeyDown} placeholder={placeholder} value={value} />
		</div>
	),
}))

const mocks = vi.hoisted(() => ({
	commitSelection: vi.fn(async () => undefined),
	providerModels: {
		models: {} as Record<string, { name: string; supportsPromptCache: boolean; contextWindow: number }>,
		defaultModelId: "",
		isLoading: false,
		isStale: false,
		error: undefined as string | undefined,
	},
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: undefined,
		write: vi.fn(),
		commitSelection: mocks.commitSelection,
	}),
}))

vi.mock("@/hooks/useProviderModels", () => ({
	useProviderModels: () => mocks.providerModels,
}))

const localModel = { name: "local-model", supportsPromptCache: false, contextWindow: 4096 }

describe("LocalGGUFModelPicker", () => {
	beforeEach(() => {
		mocks.commitSelection.mockClear()
		mocks.providerModels.models = {}
		mocks.providerModels.defaultModelId = ""
		mocks.providerModels.isLoading = false
		mocks.providerModels.isStale = false
		mocks.providerModels.error = undefined
	})

	it("lists the model the catalog resolved from the configured .gguf file", () => {
		mocks.providerModels.models = { "local-model": localModel }
		mocks.providerModels.defaultModelId = "local-model"

		render(<LocalGGUFModelPicker currentMode="act" />)

		expect(screen.getByLabelText("Model")).toHaveValue("local-model")
		expect(screen.getByRole("option", { name: "local-model" })).toBeInTheDocument()
	})

	it("commits the selected model for the active mode", () => {
		mocks.providerModels.models = { "local-model": localModel }
		mocks.providerModels.defaultModelId = "local-model"

		render(<LocalGGUFModelPicker currentMode="plan" />)
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "local-model" } })

		expect(mocks.commitSelection).toHaveBeenCalledWith("plan", { providerId: "local-gguf", modelId: "local-model" })
	})

	it("surfaces the catalog error and falls back to manual entry", () => {
		mocks.providerModels.error = "[ENOENT] model file not found"

		render(<LocalGGUFModelPicker currentMode="act" />)

		expect(screen.getByRole("alert")).toHaveTextContent("[ENOENT] model file not found")
		expect(screen.getByLabelText("Custom model ID")).toBeInTheDocument()
		expect(screen.queryByLabelText("Model")).not.toBeInTheDocument()
	})

	it("commits a manual model id with Enter when no models resolve", () => {
		render(<LocalGGUFModelPicker currentMode="act" />)

		const input = screen.getByLabelText("Custom model ID")
		fireEvent.change(input, { target: { value: "local-model" } })
		fireEvent.keyDown(input, { key: "Enter" })

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", { providerId: "local-gguf", modelId: "local-model" })
	})

	it("commits a manual model id from the button", () => {
		render(<LocalGGUFModelPicker currentMode="act" />)

		fireEvent.change(screen.getByLabelText("Custom model ID"), { target: { value: "my-gguf-model" } })
		fireEvent.click(screen.getByRole("button", { name: "Use custom model" }))

		expect(mocks.commitSelection).toHaveBeenCalledWith("act", { providerId: "local-gguf", modelId: "my-gguf-model" })
	})

	it("shows the loading state while the catalog is resolving", () => {
		mocks.providerModels.isLoading = true

		render(<LocalGGUFModelPicker currentMode="act" />)

		expect(screen.getByRole("status")).toHaveTextContent("Loading models…")
	})
})
