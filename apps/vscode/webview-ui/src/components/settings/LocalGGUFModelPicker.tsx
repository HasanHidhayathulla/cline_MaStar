import { Mode } from "@shared/storage/types"
import { useProviderConfig } from "@/hooks/useProviderConfig"
import { useProviderModelSelection } from "@/hooks/useProviderModelSelection"
import { useProviderModels } from "@/hooks/useProviderModels"
import { type ModelPickerSelection, ModelPickerWithManualEntry } from "./providers/ModelPickerWithManualEntry"

/** The builtin provider this picker is fixed to. */
const LOCAL_GGUF_PROVIDER_ID = "local-gguf"

interface LocalGGUFModelPickerProps {
	currentMode: Mode
}

/**
 * Model picker for the `local-gguf` provider (task 263).
 *
 * The model catalog resolves the provider's model list from the configured
 * `.gguf` file (SDK `resolveLocalGGUFModels` behind `resolveProviderModels`),
 * so the dropdown normally shows the file's single model entry. Manual entry
 * stays available for edge cases where the file is missing or unreadable and
 * the catalog reports a config/shape error instead of a model list.
 */
export const LocalGGUFModelPicker = ({ currentMode }: LocalGGUFModelPickerProps) => {
	const { models, defaultModelId, isLoading, isStale, error } = useProviderModels(LOCAL_GGUF_PROVIDER_ID)
	const { config, commitSelection } = useProviderConfig(LOCAL_GGUF_PROVIDER_ID)
	const { selectedModel, commitModelSelection } = useProviderModelSelection(LOCAL_GGUF_PROVIDER_ID, currentMode, {
		models,
		defaultModelId,
		config,
		commitSelection,
	})

	const handleModelSelect = (selection: ModelPickerSelection) => {
		void commitModelSelection(selection).catch((err) => console.error("Failed to commit local-gguf model selection:", err))
	}

	return (
		<ModelPickerWithManualEntry
			allowsCustomIds
			error={error}
			isLoading={isLoading}
			isStale={isStale}
			models={models}
			onSelect={handleModelSelect}
			selectedModel={selectedModel}
		/>
	)
}

export default LocalGGUFModelPicker
