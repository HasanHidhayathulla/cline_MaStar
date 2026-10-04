import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import { type GGUFMetadataResponse, LoadGGUFModelRequest } from "@shared/proto/cline/models"
import { Mode } from "@shared/storage/types"
import { VSCodeButton, VSCodeLink, VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { FileServiceClient, ModelsServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "../common/DebouncedTextField"
import { LocalGGUFModelPicker } from "../LocalGGUFModelPicker"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"

/**
 * Props for the LocalGGUFProvider component
 */
interface LocalGGUFProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

const DEFAULT_CONTEXT_WINDOW = 4096
const DEFAULT_THREADS = 4
const DEFAULT_REQUEST_TIMEOUT_MS = 300000
const STATUS_POLL_INTERVAL_MS = 5000

/** Best-effort CPU count so the threads field has a sane upper bound. */
const detectCpuCount = (): number => {
	if (
		typeof navigator !== "undefined" &&
		typeof navigator.hardwareConcurrency === "number" &&
		navigator.hardwareConcurrency > 0
	) {
		return navigator.hardwareConcurrency
	}
	return 8
}

/** Formats byte counts for the metadata card (e.g. 4.2 GB). */
const formatBytes = (bytes: number): string => {
	if (!Number.isFinite(bytes) || bytes <= 0) {
		return "unknown"
	}
	const units = ["B", "KB", "MB", "GB", "TB"]
	let value = bytes
	let unitIndex = 0
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024
		unitIndex += 1
	}
	return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

/**
 * Settings UI for the `local-gguf` builtin provider. Lets the user point Cline
 * at a local `.gguf` file, reads its header metadata, and loads/unloads it
 * through a local llama-server process owned by the extension host.
 */
export const LocalGGUFProvider = ({ showModelOptions, currentMode }: LocalGGUFProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { config, write } = useProviderConfig("local-gguf")
	const { handleFieldChange } = useApiConfigurationHandlers()
	const [modelPath, setModelPath] = useState<string | undefined>(config?.modelPath)
	const [metadata, setMetadata] = useState<GGUFMetadataResponse | undefined>(undefined)
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)
	const [modelLoaded, setModelLoaded] = useState(false)
	const [serverPid, setServerPid] = useState<number | undefined>(undefined)
	const [serverMemoryBytes, setServerMemoryBytes] = useState<number | undefined>(undefined)
	const statusPollInterval = useRef<number | undefined>(undefined)
	const cpuCount = detectCpuCount()

	// `applyStatus`/`refreshStatus`/`loadMetadata` are recreated every render, so
	// wrapping them in useCallback keeps the effects below keyed on real inputs
	// instead of firing on every state change.
	const applyStatus = useCallback((status: { loaded: boolean; pid?: number; memoryBytes?: number }) => {
		setModelLoaded(status.loaded)
		setServerPid(status.loaded ? status.pid : undefined)
		setServerMemoryBytes(status.loaded ? status.memoryBytes : undefined)
	}, [])

	const refreshStatus = useCallback(
		async (path: string) => {
			try {
				const status = await ModelsServiceClient.getGGUFModelStatus(StringRequest.create({ value: path }))
				applyStatus(status)
			} catch {
				// Status is a UI affordance; a failed probe must not surface as an error.
			}
		},
		[applyStatus],
	)

	const loadMetadata = useCallback(async (path: string) => {
		setIsLoading(true)
		setError(undefined)
		try {
			setMetadata(await ModelsServiceClient.getGGUFMetadata(StringRequest.create({ value: path })))
		} catch (err) {
			setMetadata(undefined)
			setError((err as Error)?.message || "Failed to read GGUF metadata")
		} finally {
			setIsLoading(false)
		}
	}, [])

	useEffect(() => {
		setModelPath(config?.modelPath)
	}, [config?.modelPath])

	// Restore the previously loaded state and refresh metadata when the path changes.
	useEffect(() => {
		const path = config?.modelPath?.trim()
		if (!path) {
			setMetadata(undefined)
			setModelLoaded(false)
			setServerPid(undefined)
			setServerMemoryBytes(undefined)
			return
		}
		void loadMetadata(path)
		void refreshStatus(path)
	}, [config?.modelPath, loadMetadata, refreshStatus])

	useEffect(() => {
		if (isLoading || modelLoaded) {
			statusPollInterval.current = window.setInterval(() => {
				const path = config?.modelPath?.trim()
				if (path) {
					void refreshStatus(path)
				}
			}, STATUS_POLL_INTERVAL_MS)
		}
		return () => {
			if (statusPollInterval.current) {
				clearInterval(statusPollInterval.current)
			}
		}
	}, [isLoading, modelLoaded, config?.modelPath, refreshStatus])

	/**
	 * Opens the native VS Code file dialog and persists the chosen path.
	 *
	 * A webview `<input type="file">` cannot be used here: the browser only
	 * exposes `File.name`, never the absolute on-disk path that
	 * `parseGGUFMetadataFromFile` and `llama-server -m` need. The dialog runs
	 * in the extension host, which returns real paths.
	 */
	const handleBrowse = useCallback(async () => {
		setError(undefined)
		try {
			const response = await FileServiceClient.selectFiles(BooleanRequest.create({ value: false }))
			// `values1` holds images (data URLs); `values2` holds other file paths.
			const pickedPath = response?.values2?.[0]?.trim()
			if (!pickedPath) {
				// An empty result means the user cancelled the dialog.
				return
			}
			if (!pickedPath.toLowerCase().endsWith(".gguf")) {
				setError("Please select a .gguf model file")
				return
			}
			setModelPath(pickedPath)
			await write({ modelPath: pickedPath })
		} catch (err) {
			setError((err as Error)?.message || "Failed to open the file picker")
		}
	}, [write])

	const handleLoadModel = async () => {
		const path = modelPath?.trim()
		if (!path || !metadata) {
			setError("Please select a valid .gguf model file first")
			return
		}
		setIsLoading(true)
		setError(undefined)
		try {
			const response = await ModelsServiceClient.loadGGUFModel(
				LoadGGUFModelRequest.create({
					modelPath: path,
					threads: config?.threads ?? DEFAULT_THREADS,
					contextWindow: config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
					gpuLayers: config?.gpuLayers ?? 0,
				}),
			)
			if (!response.success) {
				setError(response.error || "Failed to load model. Is llama-server on PATH?")
				return
			}
			setModelLoaded(true)
			await refreshStatus(path)
		} catch (err) {
			setError((err as Error)?.message || "Failed to load model. Is llama-server on PATH?")
		} finally {
			setIsLoading(false)
		}
	}

	const handleUnloadModel = async () => {
		const path = modelPath?.trim()
		if (!path) {
			return
		}
		setIsLoading(true)
		setError(undefined)
		try {
			await ModelsServiceClient.unloadGGUFModel(StringRequest.create({ value: path }))
			setModelLoaded(false)
			setServerPid(undefined)
			setServerMemoryBytes(undefined)
		} catch (err) {
			setError((err as Error)?.message || "Failed to unload model")
		} finally {
			setIsLoading(false)
		}
	}

	/**
	 * Task 230 — Enter loads the model / unloads it when one is running, and
	 * Escape clears the path back to the "no file selected" state. Bound on the
	 * path field so typing a path and pressing Enter is the fast path, without
	 * hijacking Enter elsewhere in the form (the number fields keep plain
	 * numeric editing semantics).
	 */
	const handlePathKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
		if (event.key === "Enter") {
			event.preventDefault()
			if (modelLoaded) {
				void handleUnloadModel()
			} else {
				void handleLoadModel()
			}
			return
		}
		if (event.key === "Escape" && modelPath) {
			event.preventDefault()
			setModelPath(undefined)
			setMetadata(undefined)
			void write({ modelPath: "" })
		}
	}

	const renderMetadata = () => {
		if (!metadata) {
			return null
		}
		const rows: Array<[string, string]> = [
			["Architecture", metadata.architecture || metadata.modelType || "unknown"],
			["Parameters", metadata.parameterCount || "unknown"],
			["File size", formatBytes(metadata.fileSize)],
			["Quantization", metadata.quantization || "unknown"],
			["Context length", metadata.contextLength > 0 ? `${metadata.contextLength.toLocaleString()} tokens` : "unknown"],
		]
		return (
			<div className="p-3 rounded-md mb-4 border border-(--vscode-input-border) bg-(--vscode-input-background)">
				<h4 className="font-medium mb-2">{metadata.modelName || metadata.modelType || "Model metadata"}</h4>
				<div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-sm">
					{rows.map(([label, value]) => (
						<div key={label}>
							<span className="font-semibold">{label}:</span> {value}
						</div>
					))}
				</div>
				{metadata.description && (
					<p className="text-xs text-(--vscode-descriptionForeground) mt-2">{metadata.description}</p>
				)}
			</div>
		)
	}

	// Tasks 299/300/302 — one status affordance for all three states. The
	// spinner is the toolkit's `VSCodeProgressRing`, which themes itself from
	// `--vscode-progressBar-background`; the pass/error colours come from the
	// testing-icon theme tokens so they follow the active color theme.
	const renderStatusDot = () => {
		if (isLoading) {
			return (
				<span className="inline-flex items-center gap-2 text-xs" style={{ color: "var(--vscode-descriptionForeground)" }}>
					<VSCodeProgressRing aria-label="Loading model" />
					Loading model…
				</span>
			)
		}
		if (modelLoaded) {
			return (
				<span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--vscode-testing-iconPassed)" }}>
					<span aria-hidden="true">✓</span>
					Model loaded
				</span>
			)
		}
		if (error) {
			return (
				<span className="inline-flex items-center gap-1 text-xs" style={{ color: "var(--vscode-testing-iconFailed)" }}>
					<span aria-hidden="true">✗</span>
					Model not loaded
				</span>
			)
		}
		return (
			<span className="text-xs" style={{ color: "var(--vscode-descriptionForeground)" }}>
				○ Model not loaded
			</span>
		)
	}

	const renderErrorBanner = () => {
		if (!error) {
			return null
		}
		// The host reports a missing binary as `[NOT_INSTALLED] ...` (see
		// `GGUFInferenceError`). That is the one failure the user can fix
		// themselves, so it gets an install link instead of a bare message.
		const isNotInstalled = error.includes("NOT_INSTALLED")
		return (
			<div
				aria-live="polite"
				className="p-3 rounded-md mb-4"
				role="alert"
				style={{
					backgroundColor: "var(--vscode-inputValidation-errorBackground)",
					color: "var(--vscode-errorForeground)",
				}}>
				<span aria-hidden="true" style={{ color: "var(--vscode-testing-iconFailed)" }}>
					✗
				</span>
				<span className="text-sm">{error}</span>
				{isNotInstalled && (
					<p className="text-sm mt-2 mb-0">
						Install <code>llama-server</code> from{" "}
						<VSCodeLink href="https://github.com/ggml-org/llama.cpp/releases">llama.cpp releases</VSCodeLink> and make
						sure it is on your PATH, then try again.
					</p>
				)}
			</div>
		)
	}

	return (
		<div className="flex flex-col gap-2">
			{renderErrorBanner()}

			<div>
				<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-model-path">
					Model file path <span style={{ color: "var(--vscode-errorForeground)" }}>*</span>
				</label>
				<div
					className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border border-(--vscode-input-border)"
					style={{ width: "100%" }}>
					<input
						aria-label="GGUF model file path"
						disabled={isLoading}
						id="local-gguf-model-path"
						onChange={(event) => setModelPath(event.target.value || undefined)}
						onKeyDown={handlePathKeyDown}
						placeholder="C:/models/model-Q4_K_M.gguf"
						required={!isLoading}
						type="text"
						value={modelPath ?? ""}
					/>
					<button
						aria-label="Browse for model file"
						className="rounded-md px-3 py-1 text-sm hover:cursor-pointer"
						disabled={isLoading}
						onClick={() => {
							void handleBrowse()
						}}
						type="button">
						Browse
					</button>
				</div>
				{!modelPath && (
					<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
						Enter a path to a .gguf model file (.gguf files are required for the local-gguf provider).
					</p>
				)}
				{modelPath && <p className="text-xs text-(--vscode-descriptionForeground) mt-1">Model path: {modelPath}</p>}
			</div>

			{renderMetadata()}

			<div>
				<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-gpu-layers">
					GPU layers to offload
				</label>
				<div
					className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border border-(--vscode-input-border)"
					style={{ width: "100%" }}>
					<input
						aria-label="GPU layers to offload"
						disabled={isLoading}
						id="local-gguf-gpu-layers"
						min="-1"
						onChange={(event) =>
							write({ gpuLayers: Number(event.target.value) || 0 }).catch((err) =>
								console.error("Failed to update gpuLayers:", err),
							)
						}
						step="1"
						style={{ width: "80px" }}
						title="Layers to offload to the GPU (-ngl). 0 runs on CPU only; a negative value clears the setting."
						type="number"
						value={String(config?.gpuLayers ?? 0)}
					/>
					<span className="text-xs text-(--vscode-descriptionForeground)">0 = CPU only</span>
				</div>
			</div>

			<div>
				<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-context-window">
					Context window (tokens)
				</label>
				<div
					className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border border-(--vscode-input-border)"
					style={{ width: "100%" }}>
					<input
						aria-label="Context window in tokens"
						disabled={isLoading}
						id="local-gguf-context-window"
						min="1"
						onChange={(event) => {
							const value = Number(event.target.value)
							if (Number.isFinite(value) && value > 0) {
								write({ contextWindow: value }).catch((err) =>
									console.error("Failed to update contextWindow:", err),
								)
							}
						}}
						placeholder={`Default: ${DEFAULT_CONTEXT_WINDOW}`}
						step="1"
						style={{ width: "100px" }}
						title="Context window in tokens (-c). Larger windows let the model keep more history, at the cost of RAM/VRAM. Must be greater than 0."
						type="number"
						value={String(config?.contextWindow ?? DEFAULT_CONTEXT_WINDOW)}
					/>
				</div>
			</div>

			<div>
				<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-threads">
					CPU threads for inference
				</label>
				<div
					className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border border-(--vscode-input-border)"
					style={{ width: "100%" }}>
					<input
						aria-label="CPU threads for inference"
						disabled={isLoading}
						id="local-gguf-threads"
						max={cpuCount}
						min="1"
						onChange={(event) => {
							const value = Number(event.target.value)
							if (Number.isFinite(value) && value > 0) {
								write({ threads: value }).catch((err) => console.error("Failed to update threads:", err))
							}
						}}
						step="1"
						style={{ width: "80px" }}
						title="CPU threads used for inference (-t). More threads can speed up prompt processing, at the cost of leaving fewer cores free."
						type="number"
						value={String(config?.threads ?? DEFAULT_THREADS)}
					/>
					<span className="text-xs text-(--vscode-descriptionForeground)">detected CPUs: {cpuCount}</span>
				</div>
			</div>

			<div className="space-y-3">
				<div className="flex items-center gap-3 text-sm">
					{renderStatusDot()}
					{modelLoaded && serverPid !== undefined && <span>PID: {serverPid}</span>}
					{modelLoaded && serverMemoryBytes !== undefined && <span>Memory: {formatBytes(serverMemoryBytes)}</span>}
				</div>

				{!modelLoaded && (
					<VSCodeButton appearance="primary" disabled={isLoading || !modelPath || !metadata} onClick={handleLoadModel}>
						{isLoading ? (
							<>
								<VSCodeProgressRing aria-label="Loading model" />
								Loading…
							</>
						) : (
							<>Load model</>
						)}
					</VSCodeButton>
				)}

				{modelLoaded && (
					<VSCodeButton appearance="secondary" disabled={isLoading} onClick={handleUnloadModel}>
						{isLoading ? (
							<>
								<VSCodeProgressRing aria-label="Unloading model" />
								Unloading…
							</>
						) : (
							<>Unload model</>
						)}
					</VSCodeButton>
				)}

				{showModelOptions && <LocalGGUFModelPicker currentMode={currentMode} />}

				{showModelOptions && modelPath && !modelLoaded && (
					<DebouncedTextField
						initialValue={
							apiConfiguration?.requestTimeoutMs
								? apiConfiguration.requestTimeoutMs.toString()
								: String(DEFAULT_REQUEST_TIMEOUT_MS)
						}
						onChange={(value) => {
							const numValue = Number.parseInt(value, 10)
							if (!Number.isNaN(numValue) && numValue > 0) {
								handleFieldChange("requestTimeoutMs", numValue)
							}
						}}
						placeholder="Default: 300000 (5 minutes)"
						style={{ width: "100%" }}>
						<span className="font-semibold">Request Timeout (ms)</span>
					</DebouncedTextField>
				)}

				{showModelOptions && (
					<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
						Cline uses complex prompts and system instructions that may not be optimal for all models. See the{" "}
						<a
							href="https://github.com/cline/cline/blob/main/docs/MODELS.md"
							rel="noopener noreferrer"
							target="_blank">
							model documentation
						</a>{" "}
						for details.
					</p>
				)}
			</div>
		</div>
	)
}
