import { newId, type BuiltInEffectType, type Effect, type PluginRef } from './model'

export interface ParamDef {
  key: string
  label: string
  min: number
  max: number
  default: number
  /** 'dB', 'Hz', 's', '%' (stored 0–1) or ':1'. */
  unit: string
  /** Slider travels logarithmically. */
  log?: boolean
}

/** The effects both engines have. Plugins are not listed: their parameters are their own. */
export const EFFECTS: Record<BuiltInEffectType, { label: string; params: ParamDef[] }> = {
  eq: {
    label: 'EQ',
    params: [
      { key: 'low', label: 'Low', min: -18, max: 18, default: 0, unit: 'dB' },
      { key: 'mid', label: 'Mid', min: -18, max: 18, default: 0, unit: 'dB' },
      { key: 'midFreq', label: 'Mid freq', min: 200, max: 8000, default: 1000, unit: 'Hz', log: true },
      { key: 'high', label: 'High', min: -18, max: 18, default: 0, unit: 'dB' }
    ]
  },
  compressor: {
    label: 'Compressor',
    params: [
      { key: 'threshold', label: 'Threshold', min: -60, max: 0, default: -18, unit: 'dB' },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, default: 4, unit: ':1' },
      { key: 'attack', label: 'Attack', min: 0.001, max: 0.2, default: 0.01, unit: 's', log: true },
      { key: 'release', label: 'Release', min: 0.02, max: 1, default: 0.15, unit: 's', log: true },
      { key: 'makeup', label: 'Makeup', min: 0, max: 24, default: 0, unit: 'dB' }
    ]
  },
  delay: {
    label: 'Delay',
    params: [
      { key: 'time', label: 'Time', min: 0.02, max: 1.5, default: 0.3, unit: 's', log: true },
      { key: 'feedback', label: 'Feedback', min: 0, max: 0.9, default: 0.35, unit: '%' },
      { key: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, unit: '%' }
    ]
  },
  reverb: {
    label: 'Reverb',
    params: [
      { key: 'decay', label: 'Decay', min: 0.3, max: 6, default: 2, unit: 's', log: true },
      { key: 'tone', label: 'Tone', min: 800, max: 16000, default: 6000, unit: 'Hz', log: true },
      { key: 'mix', label: 'Mix', min: 0, max: 1, default: 0.3, unit: '%' }
    ]
  }
}

export function makeEffect(type: BuiltInEffectType, overrides: Record<string, number> = {}): Effect {
  const params = Object.fromEntries(EFFECTS[type].params.map((p) => [p.key, p.default]))
  return { id: newId(), type, bypass: false, params: { ...params, ...overrides } }
}

export function makePluginEffect(plugin: PluginRef): Effect {
  return { id: newId(), type: 'plugin', bypass: false, params: {}, plugin }
}

/** A parameter's value, falling back to its default if the project file lacks it. */
export function effectParam(effect: Effect, key: string): number {
  const defs = effect.type === 'plugin' ? [] : EFFECTS[effect.type].params
  return effect.params[key] ?? defs.find((p) => p.key === key)?.default ?? 0
}

export function formatParam(def: ParamDef, value: number): string {
  switch (def.unit) {
    case '%':
      return `${Math.round(value * 100)}%`
    case 's':
      return value < 1 ? `${Math.round(value * 1000)} ms` : `${value.toFixed(2)} s`
    case 'Hz':
      return value >= 1000 ? `${(value / 1000).toFixed(1)} kHz` : `${Math.round(value)} Hz`
    case 'dB':
      return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
    default:
      return `${value.toFixed(1)}${def.unit}`
  }
}
