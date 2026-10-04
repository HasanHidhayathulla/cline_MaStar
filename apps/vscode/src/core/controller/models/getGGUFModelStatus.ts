/**
 * Reports the live status of the local `.gguf` model (tasks 170–173).
 *
 * Status is derived from the process reference held on the controller, so it
 * stays correct even if the child died (the SDK removes it from its registry
 * on exit) and never throws when llama-server's optional endpoints are
 * missing or too old.
 */
import { getRunningServer } from "@cline/llms"
import { StringRequest } from "@shared/proto/cline/common"
import { GGUFModelStatus } from "@shared/proto/cline/models"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."
import { clearGgufRuntimeState, getGgufRuntimeState, readSystemInfoMemoryBytes, toGgufStatusSnapshot } from "./ggufModelRuntime"

/** Short timeout: status is a UI affordance and must not stall the webview. */
const SYSTEM_INFO_TIMEOUT_MS = 2_000

/** Task 172 — best-effort memory usage; never throws. */
async function querySystemInfoMemoryBytes(port: number): Promise<number | undefined> {
	if (!port) {
		return undefined
	}
	try {
		const response = await fetch(`http://127.0.0.1:${port}/system/info`, {
			signal: AbortSignal.timeout(SYSTEM_INFO_TIMEOUT_MS),
		})
		if (!response.ok) {
			return undefined
		}
		return readSystemInfoMemoryBytes(await response.json())
	} catch {
		// Older builds have no /system/info; memory usage is optional.
		return undefined
	}
}

export async function getGGUFModelStatus(controller: Controller, request: StringRequest): Promise<GGUFModelStatus> {
	const state = getGgufRuntimeState(controller)
	const requestedPath = request.value?.trim() ?? ""

	// No loaded model, or the caller asked about a different file.
	if (!state || (requestedPath && requestedPath !== state.modelPath)) {
		return GGUFModelStatus.create(toGgufStatusSnapshot({ nowMs: Date.now() }))
	}

	try {
		// Task 171 — PID comes from the live child process.
		const running = getRunningServer(state.modelPath)
		if (!running) {
			// The SDK registry drops the child when it exits, so a held reference
			// with no registry entry means the process is gone. Release it and
			// report "not loaded"; otherwise the UI keeps claiming a live
			// model (with PID 0) and the controller pins a dead process forever.
			clearGgufRuntimeState(controller)
			return GGUFModelStatus.create(toGgufStatusSnapshot({ nowMs: Date.now() }))
		}
		const pid = running.pid
		const memoryBytes = await querySystemInfoMemoryBytes(state.handler.getServerPort())
		return GGUFModelStatus.create(toGgufStatusSnapshot({ state, nowMs: Date.now(), pid, memoryBytes }))
	} catch (error) {
		Logger.error(`Failed to read local GGUF status for ${state.modelPath}:`, error)
		return GGUFModelStatus.create(toGgufStatusSnapshot({ nowMs: Date.now() }))
	}
}
