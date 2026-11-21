/**
 * The presets of the SoundFont the native engine plays General MIDI
 * instruments from. One copy for the whole app, asked for once.
 */
import { useSyncExternalStore } from 'react'
import type { SoundFontPreset } from '@shared/model'
import { bridge } from './platform'

/** `undefined` until asked for; `null` if there is no SoundFont to be had (it has not been downloaded, or this is a browser tab). */
let presets: SoundFontPreset[] | null | undefined
const listeners = new Set<() => void>()
let asked = false

export function useSoundFontPresets(): SoundFontPreset[] | null | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      if (!asked) {
        asked = true
        void (bridge?.soundFontPresets() ?? Promise.resolve(null))
          .catch(() => null)
          .then((found) => {
            presets = found
            for (const each of listeners) each()
          })
      }
      return () => listeners.delete(listener)
    },
    () => presets
  )
}

/** In a SoundFont, bank 128 holds the drum kits. */
export const DRUM_BANK = 128
