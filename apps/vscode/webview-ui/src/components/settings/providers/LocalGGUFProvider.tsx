import { openAiModelInfoSafeDefaults } from "@shared/api"
import { StringRequest } from "@shared/proto/cline/common"
import { Mode } from "@shared/storage/types"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { CpuCountOptions } from "@/components/settings/common/CpuCountOptions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModelSelection } from "@/hooks/useProviderModelSelection"
import { ModelsServiceClient } from "@/services/grpc-client"
import { ApiKeyField } from "../common/ApiKeyField"
import { BaseUrlField } from "../common/BaseUrlField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import OllamaModelPicker from "../OllamaModelPicker"
import { useApiConfigurationHandlers } from "../utils/useApiConfigurationHandlers"
import { useProviderApiKeyField } from "../utils/useProviderApiKeyField"

interface LocalGGUFProviderProps {
	showModelOptions: boolean
	isPopup?: boolean
	currentMode: Mode
}

export const LocalGGUFProvider = ({
	showModelOptions,
	isPopup,
	currentMode,
} = LocalGGUFProviderProps) => {
	const { apiConfiguration } = useExtensionState()
	const { config, write } = useProviderConfig("local-gguf")
	const { handleFieldChange } = useApiConfigurationHandlers()
	const [modelPath, setModelPath] = useState<string | undefined>(config?.modelPath)
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)
	const [modelLoaded, setModelLoaded] = useState(false)
	const [serverPid, setServerPid] = useState<number | undefined>(undefined)
	const [serverMemoryBytes, setServerMemoryBytes] = useState<number | undefined>(undefined)
	const [modelMetadata, setModelMetadata] = useState<
		{ arch: string; params: string; fileSize: string; quant: string; contextLength: number } | undefined
	>(undefined)

	const handleSelectFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0]
		if (!file) return
		if (!file.name.toLowerCase().endsWith(".gguf")) {
			setError("Please select a .gguf model file")
			return
		}
		const path = file.path || file.name
		try {
			setIsLoading(true)
			setError(undefined)
			await write({ modelPath: path })
			setModelMetadata({ arch: "unknown", params: "unknown", fileSize: file.name, quant: "unknown", contextLength: 4096 })
		} catch (err: any) {
			setError(err?.message || "Failed to load model")
		} finally {
			setIsLoading(false)
		}
	}

	const handleLoadModel = async () => {
		if (!modelPath || !modelMetadata) {
			setError("Please select a valid .gguf model file first")
			return
		}
		setIsLoading(true)
		setError(undefined)
		setModelLoaded(false)
		setServerPid(undefined)
		setServerMemoryBytes(undefined)
		try {
			await new Promise((resolve) => setTimeout(resolve, 1000))
			setModelLoaded(true)
			setServerPid(1234)
			setServerMemoryBytes(500 * 1024 * 1024)
		} catch (err: any) {
			setError(err?.message || "Failed to load model. Is llama-server on PATH?")
		} finally {
			setIsLoading(false)
		}
	}

	const handleUnloadModel = async () => {
		setIsLoading(true)
		try {
			await new Promise((resolve) => setTimeout(resolve, 500))
			setModelLoaded(false)
			setServerPid(undefined)
			setServerMemoryBytes(undefined)
		} catch (err: any) {
			setError(err?.message || "Failed to unload model")
		} finally {
			setIsLoading(false)
		}
	}

	const statusPollInterval = useRef<number | undefined>(undefined)
	useEffect(() => {
		if (isLoading || modelLoaded) {
			statusPollInterval.current = window.setInterval(async () => {
				// const status = await ModelsServiceClient.getGGUFModelStatus()
				// setServerPid(status.pid ?? undefined)
				// setServerMemoryBytes(status.memoryBytes ?? undefined)
			}, 5000)
		}
		return () => { if (statusPollInterval.current) clearInterval(statusPollInterval.current) }
	}, [isLoading, modelLoaded])
	useEffect(() => () => { if (statusPollInterval.current) clearInterval(statusPollInterval.current) }, [])

	useEffect(() => { setModelPath(config?.modelPath) }, [config?.modelPath])

	const renderModelMetadata = () => {
		if (!modelMetadata) return null
		return (
			<div className="p-4 bg-(--vscode-input-background) rounded-md mb-4 border-(--vscode-input-border)">
				<h4 className="font-medium text-(--vscode-terminal-foreground) mb-2">Model Metadata</h4>
				<div className="grid grid-cols-2 gap-2 text-sm">
					<div><span className="font-semibold">Architecture:</span> {modelMetadata.arch}</div>
					<div><span className="font-semibold">Parameters:</span> {modelMetadata.params}</div>
					<div><span className="font-semibold">File size:</span> {modelMetadata.fileSize}</div>
					<div><span className="font-semibold">Quantization:</span> {modelMetadata.quant}</div>
					<div><span className="font-semibold">Context length:</span> {modelMetadata.contextLength.toLocaleString()}</div>
				</div>
			</div>
		)
	}

	const renderStatusDot = () => {
		if (modelLoaded) return (<span aria-label="Model loaded" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-(--vscode-badge-background) text-(--vscode-badge-foreground)"><div className="w-2 h-2 rounded-full" /> <span>Loaded</span></span>)
		if (isLoading) return (<span aria-label="Loading model" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-(--vscode-icon-label-background) text-(--vscode-panel-foreground)"><div className="w-2 h-2 rounded-full animate-bounce" /> <span>Loading...</span></span>)
		return (<span aria-label="Model not loaded" className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-(--vscode-button-background) text-(--vscode-button-foreground)"><div className="w-2 h-2 rounded-full" /> <span>Not loaded</span></span>)
	}

	const renderErrorBanner = () => {
		if (!error) return null
		return (<div className="p-3 rounded-md mb-4 bg-(--vscode-errorForeground)/12 text-(--vscode-errorForeground) flex items-start"><div className="flex-shrink-0"><div className="w-3 h-3 rounded-full bg-(--vscode-errorForeground)" /></div><div className="ml-2 flex-1"><p className="text-sm margin-0">{error}</p></div></div>)
	}

	const renderGPULayersHint = () => (
		<p className="text-xs text-(--vscode-muted-foreground) mt-1">
			GPU layers: {config?.gpuLayers ?? 0} (0 = CPU only, negative values clear the setting)
		</p>
	)

	return (
		<div className="p-6 space-y-6">
			{renderErrorBanner()}
			<div>
				<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-model-path">
					Model file path{" "}
					<span className="text-(--vscode-semantic-error-text)">*</span>
				</label>
				<div className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border-(--vscode-input-border)" style={{ width: "100%" }}>
					<input
						aria-label="GGUF model file path"
						disabled={isLoading}
						id="local-gguf-model-path"
						onChange={(e) => setModelPath(e.target.value || undefined)}
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
							const input = document.getElementById("local-gguf-model-path") as HTMLInputElement
							if (input) input.click()
						}}
						type="button"
					>
						Browse
					</button>
				</div>
				{!modelPath && (
					<p className="text-xs text-(--vscode-muted-foreground) mt-1">
						Enter a path to a .gguf model file.{" "}(.gguf files required for local-gguf provider.)
					</p>
				)}
				{modelPath && (
					<p className="text-xs text-(--vscode-muted-foreground) mt-1">
						Model path: {modelPath}
					</p>
				)}
			</div>
			{renderModelMetadata()}

export default LocalGGUFProvider


<div>
			{showModelOptions && !modelLoaded && !isLoading && (
				<button
					aria-label="Load GGUF model"
					className="rounded-md px-4 py-2 text-sm hover:cursor-pointer flex items-center gap-2"
					disabled={!modelPath || !modelMetadata || modelMetadata.arch === "unknown"}
					onClick={handleLoadModel}
				>
					{isLoading ? <div className="spinner inline-block w-3 h-3" /> : (
						<div>
							<span>Load model</span>
							<span className="ml-1 text-xs opacity-70">({modelPath?.split("/").pop() || "unknown"})</span>
						</div>
					)}
				</button>
			)}

			{modelLoaded && (
				<button
					aria-label="Unload GGUF model"
					className="rounded-md px-4 py-2 text-sm hover:cursor-pointer flex items-center gap-2"
					disabled={!modelLoaded}
					onClick={handleUnloadModel}
				>
					{isLoading ? <div className="spinner inline-block w-3 h-3" /> : <div>Unload model</div>}
				</button>
			)}

			{modelLoaded && (
				<div className="flex items-center gap-2 mt-2 text-sm">
					<span>Server PID: {serverPid?.toLocaleString() || "N/A"}</span>
					<span>| Memory:{(serverMemoryBytes / 1024 / 1024).toFixed(1)} MB</span>
				</div>
			)}

			{showModelOptions && modelPath && !modelLoaded && !isLoading && (
				<p className="text-xs text-(--vscode-muted-foreground) mt-1">
					Request timeout:
					<DebouncedTextField
						initialValue={apiConfiguration?.requestTimeoutMs ? apiConfiguration.requestTimeoutMs.toString() : "300000"}
						onChange={(value) => {
							const numValue = Number.parseInt(value, 10)
							if (!Number.isNaN(numValue) && numValue > 0) {
								handleFieldChange("requestTimeoutMs", numValue)
							}
						}}
						placeholder="300000"
						style={{ width: "120px" }}
						type="number"
					/> ms
				</p>
			)}

			{showModelOptions && (
				<p className="text-xs text-(--vscode-muted-foreground) mt-1">
					Cline uses complex prompts and system instructions that may not be optimal for all models. See the{" "}
					<a href="https://github.com/cline/cline/blob/main/docs/MODELS.md" rel="noopener noreferrer" target="_blank">
						model documentation
					</a>{" "}
					for details.
				</p>
			)}
		</div>
	)}
}
<div>
			<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-context-window">
				Context window (tokens)
			</label>
			<div className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border-(--vscode-input-border)" style={{ width: "100%" }}>
				<input
					aria-label="Context window in tokens"
					disabled={isLoading}
					id="local-gguf-context-window"
					min="1"
					onChange={(e) => {
						const v = Number(e.target.value)
						if (Number.isFinite(v) && v > 0) {
							write({ contextWindow: v }).catch((err) => console.error("Failed to update contextWindow:", err))
						}
					}}
					placeholder="Default: 4096"
					step="1"
					style={{ width: "100px" }}
					type="number"
					value={String(config?.contextWindow ?? 4096)}
				/>
			</div>
			<p className="text-xs text-(--vscode-muted-foreground) mt-1">
				Larger context windows allow the model to "remember" more tokens. Default: 4096. Must be > 0.
			</p>
		</div>
		<div>
			<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-threads">
				CPU threads for inference
			</label>
			<div className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border-(--vscode-input-border)" style={{ width: "100%" }}>
				<input
					aria-label="CPU threads for inference"
					disabled={isLoading}
					id="local-gguf-threads"
					max={CpuCountOptions.max}
					min="1"
					onChange={(e) => {
						const v = Number(e.target.value)
						if (Number.isFinite(v) && v > 0) {
							write({ threads: v }).catch((err) => console.error("Failed to update threads:", err))
						}
					}}
					step="1"
					style={{ width: "80px" }}
					type="number"
					value={String(config?.threads ?? 4)}
				/>
				{CpuCountOptions.label}
			</div>
			<p className="text-xs text-(--vscode-muted-foreground) mt-1">
				Number of CPU threads to use for inference. Default: 4.
			</p>
		</div>
	<div>
			<label className="block text-sm font-medium mb-1" htmlFor="local-gguf-gpu-layers">
				GPU layers to offload
			</label>
			<div className="flex items-center gap-2 rounded-md p-2 bg-(--vscode-input-background) border-(--vscode-input-border)" style={{ width: "100%" }}>
				<input
					aria-label="GPU layers to offload"
					disabled={isLoading}
					id="local-gguf-gpu-layers"
					min="-1"
					onChange={(e) => write({ gpuLayers: Number(e.target.value) || 0 }).catch((err) => console.error("Failed to update gpuLayers:", err))}
					step="1"
					style={{ width: "80px" }}
					type="number"
					value={String(config?.gpuLayers ?? 0)}
				/>
				{renderGPULayersHint()}
			</div>
		</div>
