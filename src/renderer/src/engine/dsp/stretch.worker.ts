/** Runs time-stretching off the main thread, since a long file takes a second or more. */
import { timeStretch } from './stretch'

export interface StretchRequest {
  id: number
  channels: Float32Array[]
  ratio: number
  rate: number
}

export interface StretchResponse {
  id: number
  channels: Float32Array[]
}

const scope = self as unknown as { onmessage: ((event: MessageEvent<StretchRequest>) => void) | null; postMessage(message: StretchResponse): void }

scope.onmessage = (event) => {
  const { id, channels, ratio, rate } = event.data
  // Copy out of the shared output arrays so each channel owns its buffer.
  scope.postMessage({ id, channels: timeStretch(channels, ratio, rate).map((c) => c.slice()) })
}
