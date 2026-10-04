import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { FormEventHandler, ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LocalGGUFProvider } from "./LocalGGUFProvider"

const mocks = vi.hoisted(() => ({
	MODEL_PATH: "C:/models/tiny.gguf",
	write: vi.fn(),
	handleFieldChange: vi.fn(),
	getGGUFMetadata: vi.fn(),
	loadGGUFModel: vi.fn(),
	unloadGGUFModel: vi.fn(),
	getGGUFModelStatus: vi.fn(),
	selectFiles: vi.fn(),
}))

const metadata = {
	architecture: "llama",
	modelType: "llama",
	parameterCount: "7B",
	contextLength: 8192,
	embeddingLength: 4096,
	fileSize: 4_600_000_000,
	quantization: "Q4_K_M",
	modelName: "TinyLlama Chat",
	description: "A tiny test model",
}

// Render the toolkit web components as native elements so value/change
// behavior is observable in jsdom.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeLink: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href}>{children}</a>,
	VSCodeButton: ({ children, disabled, onClick }: { children?: ReactNode; disabled?: boolean; onClick?: () => void }) => (
		<button disabled={disabled} onClick={onClick} type="button">
			{children}
		</button>
	),
	VSCodeTextField: ({
		children,
		id,
		onInput,
		placeholder,
		value,
	}: {
		children?: ReactNode
		id?: string
		onInput?: FormEventHandler<HTMLInputElement>
		placeholder?: string
		value?: string
	}) => (
		<div>
			<label htmlFor={id}>{children}</label>
			<input id={id} onChange={onInput} placeholder={placeholder} value={value} />
		</div>
	),
	VSCodeDropdown: ({ children, value }: { children?: ReactNode; value?: string }) => <select value={value}>{children}</select>,
	VSCodeOption: ({ children, value }: { children?: ReactNode; value?: string }) => <option value={value}>{children}</option>,
}))

// The model picker has its own tests; keep this suite focused on the provider form.
vi.mock("../LocalGGUFModelPicker", () => ({
	LocalGGUFModelPicker: () => <div data-testid="local-gguf-model-picker" />,
}))

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		selectFiles: mocks.selectFiles,
	},
	ModelsServiceClient: {
		getGGUFMetadata: mocks.getGGUFMetadata,
		loadGGUFModel: mocks.loadGGUFModel,
		unloadGGUFModel: mocks.unloadGGUFModel,
		getGGUFModelStatus: mocks.getGGUFModelStatus,
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: {} }),
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: { modelPath: mocks.MODEL_PATH, contextWindow: 4096, threads: 4, gpuLayers: 0 },
		write: mocks.write,
		commitSelection: vi.fn(),
	}),
}))

vi.mock("../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldChange: mocks.handleFieldChange }),
}))

function renderProvider(showModelOptions = false) {
	return render(<LocalGGUFProvider currentMode="act" isPopup={false} showModelOptions={showModelOptions} />)
}

describe("LocalGGUFProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.write.mockResolvedValue(undefined)
		mocks.unloadGGUFModel.mockResolvedValue({})
		mocks.getGGUFMetadata.mockResolvedValue(metadata)
		mocks.getGGUFModelStatus.mockResolvedValue({ loaded: false, modelPath: "" })
		mocks.loadGGUFModel.mockResolvedValue({ success: true, modelId: "local-model", error: "", serverVersion: "b1234" })
	})

	it("reads the configured model path and renders its metadata", async () => {
		renderProvider()

		expect(screen.getByLabelText("GGUF model file path")).toHaveValue(mocks.MODEL_PATH)
		expect(mocks.getGGUFMetadata).toHaveBeenCalledWith(expect.objectContaining({ value: mocks.MODEL_PATH }))
		expect(await screen.findByText("TinyLlama Chat")).toBeInTheDocument()
		expect(screen.getByText("Q4_K_M")).toBeInTheDocument()
		expect(screen.getByText("4.3 GB")).toBeInTheDocument()
		expect(screen.getByText("8,192 tokens")).toBeInTheDocument()
	})

	it("opens the native dialog and persists the absolute path it returns", async () => {
		mocks.selectFiles.mockResolvedValue({ values1: [], values2: ["C:/models/picked.gguf"] })
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Browse for model file" }))

		// The absolute path is required by the parser and `llama-server -m`; a
		// bare file name (what a webview <input type=file> yields) would not work.
		await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ modelPath: "C:/models/picked.gguf" }))
	})

	it("does nothing when the user cancels the native dialog", async () => {
		mocks.selectFiles.mockResolvedValue({ values1: [], values2: [] })
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Browse for model file" }))

		await waitFor(() => expect(mocks.selectFiles).toHaveBeenCalled())
		expect(mocks.write).not.toHaveBeenCalled()
	})

	it("rejects a picked file that is not .gguf", async () => {
		mocks.selectFiles.mockResolvedValue({ values1: [], values2: ["C:/models/notes.txt"] })
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Browse for model file" }))

		expect(await screen.findByText("Please select a .gguf model file")).toBeInTheDocument()
		expect(mocks.write).not.toHaveBeenCalled()
	})

	it("loads the model with the configured tuning knobs", async () => {
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Load model" }))

		expect(mocks.loadGGUFModel).toHaveBeenCalledWith(
			expect.objectContaining({ modelPath: mocks.MODEL_PATH, threads: 4, contextWindow: 4096, gpuLayers: 0 }),
		)
	})

	it("surfaces the load failure message inline", async () => {
		mocks.loadGGUFModel.mockResolvedValue({
			success: false,
			modelId: "local-model",
			error: "[NOT_INSTALLED] llama-server not found on PATH",
			serverVersion: "",
		})
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Load model" }))

		expect(await screen.findByText("[NOT_INSTALLED] llama-server not found on PATH")).toBeInTheDocument()
	})

	it("shows pid and memory while loaded, then unloads", async () => {
		mocks.getGGUFModelStatus.mockResolvedValue({
			loaded: true,
			modelPath: mocks.MODEL_PATH,
			pid: 4321,
			memoryBytes: 2_000_000_000,
		})
		renderProvider()

		expect(await screen.findByText("● Model loaded")).toBeInTheDocument()
		expect(screen.getByText("PID: 4321")).toBeInTheDocument()
		expect(screen.getByText("Memory: 1.9 GB")).toBeInTheDocument()

		fireEvent.click(screen.getByRole("button", { name: "Unload model" }))

		await waitFor(() =>
			expect(mocks.unloadGGUFModel).toHaveBeenCalledWith(expect.objectContaining({ value: mocks.MODEL_PATH })),
		)
		expect(await screen.findByText("○ Model not loaded")).toBeInTheDocument()
	})

	it("renders the model picker when model options are shown", async () => {
		renderProvider(true)
		await screen.findByText("TinyLlama Chat")

		expect(screen.getByTestId("local-gguf-model-picker")).toBeInTheDocument()
	})

	// Task 226 — the install guidance is the only fix the user can apply
	// themselves, so it is linked rather than left as a bare error string.
	it("adds an install link when llama-server is not on PATH", async () => {
		mocks.loadGGUFModel.mockResolvedValue({
			success: false,
			modelId: "local-model",
			error: "[NOT_INSTALLED] llama-server was not found on your PATH",
			serverVersion: "",
		})
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Load model" }))

		const alert = await screen.findByRole("alert")
		expect(alert).toHaveTextContent("NOT_INSTALLED")
		expect(alert.querySelector("a")).toHaveAttribute("href", "https://github.com/ggml-org/llama.cpp/releases")
	})

	it("omits the install link for errors the user cannot fix by installing", async () => {
		mocks.loadGGUFModel.mockResolvedValue({
			success: false,
			modelId: "local-model",
			error: "[LOAD_FAILED] llama-server exited with code 1: out of memory",
			serverVersion: "b1234",
		})
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.click(screen.getByRole("button", { name: "Load model" }))

		const alert = await screen.findByRole("alert")
		expect(alert).toHaveTextContent("LOAD_FAILED")
		expect(alert.querySelector("a")).toBeNull()
	})

	// Task 230 — Enter on the path field is the load shortcut.
	it("loads the model when Enter is pressed in the path field", async () => {
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.keyDown(screen.getByLabelText("GGUF model file path"), { key: "Enter" })

		expect(mocks.loadGGUFModel).toHaveBeenCalled()
	})

	it("clears the selected path when Escape is pressed in the path field", async () => {
		renderProvider()
		await screen.findByText("TinyLlama Chat")

		fireEvent.keyDown(screen.getByLabelText("GGUF model file path"), { key: "Escape" })

		await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ modelPath: "" }))
		expect(screen.getByLabelText("GGUF model file path")).toHaveValue("")
	})
})
