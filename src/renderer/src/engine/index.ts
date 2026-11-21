import { NativeEngine } from './NativeEngine'
import type { AudioEngine } from './types'
import { WebAudioEngine } from './WebAudioEngine'

// The engine is chosen when the app starts: the native one if the main
// process was started with STUDIO_ENGINE=native (it then hands the renderer a
// link to it), otherwise Web Audio. A plain browser tab has no bridge at all
// and always gets Web Audio.
const link = window.studio?.nativeEngine ?? null

/** The native engine, when that is the one in use. For showing its status; play through `engine`. */
export const nativeEngine: NativeEngine | null = link ? new NativeEngine(link) : null

/** The one engine instance. */
export const engine: AudioEngine = nativeEngine ?? new WebAudioEngine()
