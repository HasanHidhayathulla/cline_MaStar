import { StringRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "../common/DebouncedTextField"

/**
 * Settings UI for the `local-gguf` builtin provider (model file path + status).
 * Placeholder wired to the getGGUFMetadata RPC; full load/unload controls land
 * with the runtime handlers.
 */
export function LocalGGUFProvider() {
	const { apiConfiguration } = useExtensionState()
	const [modelPath, setModelPath] = useState(apiConfiguration?.localGgufModelPath ?? "")
	const [metadata, setMetadata] = useState<string>("")

	const refreshMetadata = useCallback(async (path: string) => {
		const trimmed = path.trim()
		if (!trimmed) {
			setMetadata("")
			return
		}
		try {
			const response = await ModelsServiceClient.getGGUFMetadata(StringRequest.create({ value: trimmed }))
			setMetadata(`${response.modelName || response.modelType} (${response.quantization || "unknown quant"})`)
		} catch {
			setMetadata("")
		}
	}, [])

	useEffect(() => {
		void refreshMetadata(modelPath)
	}, [modelPath, refreshMetadata])

	return (
		<div>
			<DebouncedTextField
				initialValue={modelPath}
				placeholder="/models/tiny.gguf"
				onChange={(value: string) => setModelPath(value)}
			/>
			{metadata ? <span>{metadata}</span> : null}
		</div>
	)
}

