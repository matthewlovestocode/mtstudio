/**
 * The list of installed VST3 and Audio Unit plugins, which only the native
 * engine can find and host. One copy for the whole app.
 */
import { useSyncExternalStore } from 'react'
import type { PluginRef } from '@shared/model'
import { nativeEngine } from './engine'

export interface PluginList {
  /** Null until a scan has been done (on this machine, ever). */
  plugins: PluginRef[] | null
  /** Plugins the last scan could not examine. */
  failed: string[]
  scanning: boolean
  error: string | null
}

let state: PluginList = { plugins: null, failed: [], scanning: false, error: null }
const listeners = new Set<() => void>()
let asked = false

function set(change: Partial<PluginList>): void {
  state = { ...state, ...change }
  for (const listener of listeners) listener()
}

async function load(rescan: boolean): Promise<void> {
  if (!nativeEngine || state.scanning) return
  if (rescan) set({ scanning: true, error: null })
  try {
    const found = await nativeEngine.plugins(rescan)
    set({ plugins: found?.plugins ?? state.plugins, failed: found?.failed ?? state.failed, scanning: false })
  } catch (error) {
    set({ scanning: false, error: error instanceof Error ? error.message : 'Could not look for plugins.' })
  }
}

/** Looks for installed plugins afresh. Every plugin is loaded to be examined, so this can take minutes. */
export function scanPlugins(): void {
  void load(true)
}

/** The plugin list, read from the last scan's results the first time it is asked for. */
export function usePlugins(): PluginList {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      if (!asked) {
        asked = true
        void load(false)
      }
      return () => listeners.delete(listener)
    },
    () => state
  )
}

/** How a plugin is listed: its name and, in short, its format. */
export function pluginLabel(plugin: PluginRef): string {
  return `${plugin.name} (${plugin.format === 'AudioUnit' ? 'AU' : plugin.format})`
}
