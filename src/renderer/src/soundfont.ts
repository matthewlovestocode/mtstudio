/**
 * The sampled instruments the native engine can play: the presets of its
 * General MIDI SoundFont, the SFZ instruments installed in the content
 * folder, and Surge XT's patches. One copy of each list for the whole app,
 * asked for once.
 */
import { useSyncExternalStore } from 'react'
import type { SfzInstrument, SoundFontPreset, SurgePatch } from '@shared/model'
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

let sfz: SfzInstrument[] = []
const sfzListeners = new Set<() => void>()
let sfzAsked = false

/** The installed SFZ instruments, ordered by pack and then name. Empty until the list arrives, and in a browser tab. */
export function useSfzInstruments(): SfzInstrument[] {
  return useSyncExternalStore(
    (listener) => {
      sfzListeners.add(listener)
      if (!sfzAsked) {
        sfzAsked = true
        void (bridge?.sfzInstruments() ?? Promise.resolve([]))
          .catch(() => [])
          .then((found) => {
            sfz = found
            for (const each of sfzListeners) each()
          })
      }
      return () => sfzListeners.delete(listener)
    },
    () => sfz
  )
}

let patches: SurgePatch[] = []
const patchListeners = new Set<() => void>()
let patchesAsked = false

/** Surge XT's patches, ordered by category and then name. Empty until the list arrives, where Surge XT is not installed, and in a browser tab. */
export function useSurgePatches(): SurgePatch[] {
  return useSyncExternalStore(
    (listener) => {
      patchListeners.add(listener)
      if (!patchesAsked) {
        patchesAsked = true
        void (bridge?.surgePatches() ?? Promise.resolve([]))
          .catch(() => [])
          .then((found) => {
            patches = found
            for (const each of patchListeners) each()
          })
      }
      return () => patchListeners.delete(listener)
    },
    () => patches
  )
}
