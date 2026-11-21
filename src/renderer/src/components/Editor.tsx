import { EFFECTS, effectParam, formatParam, type ParamDef } from '@shared/effects'
import {
  DEFAULT_SAMPLER,
  type AudioClip,
  type BuiltInEffectType,
  type Effect,
  type InstrumentType,
  type SamplerParams,
  type SynthParams,
  type Track,
  type Waveform
} from '@shared/model'
import { timeMap } from '@shared/timemap'
import { useSyncExternalStore } from 'react'
import { engine, nativeEngine } from '../engine'
import { loadSampleDialog } from '../platform'
import { pluginLabel, scanPlugins, usePlugins } from '../plugins'
import {
  addEffect,
  addPluginEffect,
  duplicateClips,
  findClip,
  removeClips,
  removeEffect,
  setClipStretch,
  setInstrument,
  setInstrumentPlugin,
  setSend,
  splitClips,
  updateClip,
  updateEffect,
  updateTrack
} from '../state/actions'
import { useStudio } from '../state/store'
import { pitchName } from '../util'
import { Slider } from './controls'
import { PianoRoll } from './PianoRoll'

const WAVES: Waveform[] = ['sine', 'triangle', 'sawtooth', 'square']
const INSTRUMENTS: [InstrumentType, string][] = [
  ['synth', 'Synth'],
  ['drums', 'Drum machine'],
  ['sampler', 'Sampler']
]

/** The bottom panel: track inspector on the left, clip editor on the right. */
export function Editor(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const selectedClipIds = useStudio((s) => s.selectedClipIds)
  const selectedTrackId = useStudio((s) => s.selectedTrackId)
  const found = findClip(project, selectedClipIds[selectedClipIds.length - 1])
  const track = found?.track ?? project.tracks.find((t) => t.id === selectedTrackId)

  return (
    <section className="editor">
      <aside className="inspector">{track ? <Inspector track={track} /> : <p className="muted">Select a track.</p>}</aside>
      <div className="editor-main">
        {selectedClipIds.length > 1 ? (
          <div className="placeholder">
            <p>{selectedClipIds.length} clips selected</p>
            <p>
              <button onClick={() => splitClips(selectedClipIds, engine.getPosition())}>Split at playhead</button>{' '}
              <button onClick={() => duplicateClips(selectedClipIds)}>Duplicate</button>{' '}
              <button onClick={() => removeClips(selectedClipIds)}>Delete</button>
            </p>
          </div>
        ) : found?.clip.kind === 'midi' ? (
          <PianoRoll track={found.track} clip={found.clip} />
        ) : found ? (
          <AudioClipPanel clip={found.clip} />
        ) : (
          <div className="placeholder">
            <p>Select a clip to edit it.</p>
            <p className="muted">
              Double-click an instrument track's lane to create a clip. Drop audio files onto the timeline to import them.
            </p>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Inspector ────────────────────────────────────────────────────────────

export function Inspector({ track }: { track: Track }): React.JSX.Element {
  const instrument = track.instrument ?? 'synth'
  const { plugins } = usePlugins()
  const instruments = (plugins ?? []).filter((p) => p.instrument)
  return (
    <>
      <h2>
        <span className="dot" style={{ background: track.color }} />
        {track.name}
      </h2>

      {track.kind === 'midi' && (
        <section>
          <div className="params">
            <label>
              <span>Instrument</span>
              <select
                value={instrument}
                onChange={(e) => {
                  const { value } = e.target
                  const plugin = value.startsWith('plugin:') ? instruments[Number(value.slice(7))] : undefined
                  if (plugin) setInstrumentPlugin(track.id, plugin)
                  else if (value !== 'plugin') setInstrument(track.id, value as InstrumentType)
                }}
              >
                {INSTRUMENTS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
                {/* The plugin in use is listed even if it is not installed here. */}
                {instrument === 'plugin' && <option value="plugin">{track.plugin ? pluginLabel(track.plugin) : 'Plugin'}</option>}
                {instruments.length > 0 && (
                  <optgroup label="Plugins">
                    {instruments.map((plugin, i) => (
                      <option key={plugin.description} value={`plugin:${i}`}>
                        {pluginLabel(plugin)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            {instrument === 'plugin' && <PluginControls track={track} effectId={null} />}
            {instrument === 'synth' && track.synth && <SynthPanel track={track} synth={track.synth} />}
            {instrument === 'sampler' && <SamplerPanel track={track} sampler={track.sampler ?? DEFAULT_SAMPLER} />}
          </div>
          {instrument === 'drums' && (
            <p className="muted">Each note name is a drum: C kick, D snare, F♯ hat, A♯ open hat. The piano roll shows them all.</p>
          )}
        </section>
      )}
      {track.kind === 'bus' && <p className="muted">A bus plays what other tracks send to it, through its own effects.</p>}

      <EffectsPanel track={track} />
      {track.kind !== 'bus' && <SendsPanel track={track} />}
    </>
  )
}

function SynthPanel({ track, synth }: { track: Track; synth: SynthParams }): React.JSX.Element {
  const set = (patch: Partial<SynthParams>, key: string): void =>
    updateTrack(track.id, { synth: { ...synth, ...patch } }, `synth-${key}-${track.id}`)
  return (
    <>
      <label>
        <span>Wave</span>
        <select value={synth.wave} onChange={(e) => updateTrack(track.id, { synth: { ...synth, wave: e.target.value as Waveform } })}>
          {WAVES.map((wave) => (
            <option key={wave}>{wave}</option>
          ))}
        </select>
      </label>
      <Param label="Cutoff" text={`${Math.round(synth.cutoff)} Hz`}>
        {/* Logarithmic: equal slider travel per octave. */}
        <Slider label="Cutoff" min={Math.log2(80)} max={Math.log2(16000)} step={0.01} value={Math.log2(synth.cutoff)} onChange={(v) => set({ cutoff: 2 ** v }, 'cutoff')} />
      </Param>
      <Param label="Resonance" text={synth.resonance.toFixed(1)}>
        <Slider label="Resonance" min={0.1} max={20} step={0.1} value={synth.resonance} onChange={(v) => set({ resonance: v }, 'res')} />
      </Param>
      <Param label="Attack" text={`${Math.round(synth.attack * 1000)} ms`}>
        <Slider label="Attack" min={0.001} max={1} step={0.001} value={synth.attack} onChange={(v) => set({ attack: v }, 'a')} />
      </Param>
      <Param label="Decay" text={`${Math.round(synth.decay * 1000)} ms`}>
        <Slider label="Decay" min={0.01} max={2} step={0.01} value={synth.decay} onChange={(v) => set({ decay: v }, 'd')} />
      </Param>
      <Param label="Sustain" text={`${Math.round(synth.sustain * 100)}%`}>
        <Slider label="Sustain" min={0} max={1} step={0.01} value={synth.sustain} onChange={(v) => set({ sustain: v }, 's')} />
      </Param>
      <Param label="Release" text={`${Math.round(synth.release * 1000)} ms`}>
        <Slider label="Release" min={0.01} max={3} step={0.01} value={synth.release} onChange={(v) => set({ release: v }, 'r')} />
      </Param>
    </>
  )
}

function SamplerPanel({ track, sampler }: { track: Track; sampler: SamplerParams }): React.JSX.Element {
  const asset = useStudio((s) => (sampler.assetId ? s.project.assets[sampler.assetId] : undefined))
  const set = (patch: Partial<SamplerParams>, key: string): void =>
    updateTrack(track.id, { sampler: { ...sampler, ...patch } }, `sampler-${key}-${track.id}`)
  return (
    <>
      <label>
        <span>Sample</span>
        <button className="wide" title={asset?.name} onClick={() => void loadSampleDialog(track.id)}>
          {asset ? asset.name : 'Load sample…'}
        </button>
      </label>
      <Param label="Root note" text={pitchName(sampler.root)}>
        <Slider label="Root note" min={24} max={96} step={1} reset={60} value={sampler.root} onChange={(v) => set({ root: v }, 'root')} />
      </Param>
      <Param label="Attack" text={`${Math.round(sampler.attack * 1000)} ms`}>
        <Slider label="Attack" min={0.001} max={1} step={0.001} value={sampler.attack} onChange={(v) => set({ attack: v }, 'a')} />
      </Param>
      <Param label="Release" text={`${Math.round(sampler.release * 1000)} ms`}>
        <Slider label="Release" min={0.01} max={3} step={0.01} value={sampler.release} onChange={(v) => set({ release: v }, 'r')} />
      </Param>
    </>
  )
}

function EffectsPanel({ track }: { track: Track }): React.JSX.Element {
  const effects = track.effects ?? []
  const list = usePlugins()
  const available = (list.plugins ?? []).filter((p) => !p.instrument)
  return (
    <section>
      <h3>Effects</h3>
      {effects.map((effect) => (
        <EffectPanel key={effect.id} track={track} effect={effect} />
      ))}
      <select
        className="add-effect"
        aria-label="Add effect"
        value=""
        onChange={(e) => {
          const { value } = e.target
          const plugin = value.startsWith('plugin:') ? available[Number(value.slice(7))] : undefined
          if (plugin) addPluginEffect(track.id, plugin)
          else if (value === 'scan') scanPlugins()
          else if (value) addEffect(track.id, value as BuiltInEffectType)
        }}
      >
        <option value="">Add effect…</option>
        {Object.entries(EFFECTS).map(([type, def]) => (
          <option key={type} value={type}>
            {def.label}
          </option>
        ))}
        {/* Plugins are the native engine's to find and run. */}
        {nativeEngine && (
          <optgroup label="Plugins">
            {available.map((plugin, i) => (
              <option key={plugin.description} value={`plugin:${i}`}>
                {pluginLabel(plugin)}
              </option>
            ))}
            <option value="scan" disabled={list.scanning}>
              {list.scanning ? 'Looking for plugins…' : list.plugins ? 'Look for plugins again…' : 'Look for plugins…'}
            </option>
          </optgroup>
        )}
      </select>
      {list.error && <p className="muted">{list.error}</p>}
      {list.failed.length > 0 && (
        <p className="muted" title={list.failed.join('\n')}>
          {list.failed.length === 1 ? '1 plugin' : `${list.failed.length} plugins`} could not be examined and {list.failed.length === 1 ? 'is' : 'are'} not listed.
        </p>
      )}
    </section>
  )
}

/** What the inspector shows for a plugin: a button for its own window, or why there is none. `effectId` is null for a track's instrument. */
function PluginControls({ track, effectId }: { track: Track; effectId: string | null }): React.JSX.Element {
  const error = useSyncExternalStore(
    (listener) => nativeEngine?.onStatus(listener) ?? (() => {}),
    () => nativeEngine?.pluginError(track.id, effectId) ?? null
  )
  if (!nativeEngine) return <p className="muted plugin-note">Plugins need the native engine. With this one it is left out.</p>
  if (error) return <p className="muted plugin-note">Could not be loaded: {error}</p>
  return (
    <button className="plugin-open" title="The plugin's own window" onClick={() => nativeEngine?.showPlugin(track.id, effectId)}>
      Open window
    </button>
  )
}

function EffectPanel({ track, effect }: { track: Track; effect: Effect }): React.JSX.Element {
  const def = effect.type === 'plugin' ? { label: effect.plugin ? pluginLabel(effect.plugin) : 'Plugin', params: [] } : EFFECTS[effect.type]
  return (
    <div className={`effect ${effect.bypass ? 'bypassed' : ''}`}>
      <div className="effect-head">
        <strong title={effect.plugin?.manufacturer}>{def.label}</strong>
        <button
          className={`mini wide-mini ${effect.bypass ? '' : 'on'}`}
          title={effect.bypass ? 'Turn on' : 'Bypass'}
          onClick={() => updateEffect(track.id, effect.id, { bypass: !effect.bypass })}
        >
          {effect.bypass ? 'Off' : 'On'}
        </button>
        <button className="mini" title="Remove effect" onClick={() => removeEffect(track.id, effect.id)}>
          ×
        </button>
      </div>
      <div className="params">
        {def.params.map((param) => (
          <EffectParam key={param.key} track={track} effect={effect} def={param} />
        ))}
      </div>
      {effect.type === 'plugin' && <PluginControls track={track} effectId={effect.id} />}
    </div>
  )
}

function EffectParam({ track, effect, def }: { track: Track; effect: Effect; def: ParamDef }): React.JSX.Element {
  const value = effectParam(effect, def.key)
  // Log-scaled parameters put the slider in octaves.
  const toSlider = (v: number): number => (def.log ? Math.log2(v) : v)
  const fromSlider = (v: number): number => (def.log ? 2 ** v : v)
  return (
    <Param label={def.label} text={formatParam(def, value)}>
      <Slider
        label={def.label}
        min={toSlider(def.min)}
        max={toSlider(def.max)}
        step={(toSlider(def.max) - toSlider(def.min)) / 200}
        reset={toSlider(def.default)}
        value={toSlider(value)}
        onChange={(v) => {
          const next = Math.min(def.max, Math.max(def.min, fromSlider(v)))
          updateEffect(track.id, effect.id, { params: { ...effect.params, [def.key]: next } }, `fx-${effect.id}-${def.key}`)
        }}
      />
    </Param>
  )
}

function SendsPanel({ track }: { track: Track }): React.JSX.Element | null {
  const tracks = useStudio((s) => s.project.tracks)
  const buses = tracks.filter((t) => t.kind === 'bus')
  if (!buses.length) return null
  return (
    <section>
      <h3>Sends</h3>
      <div className="params">
        {buses.map((bus) => {
          const level = track.sends?.find((s) => s.busId === bus.id)?.level ?? 0
          return (
            <Param key={bus.id} label={bus.name} text={`${Math.round(level * 100)}%`}>
              <Slider label={`Send to ${bus.name}`} min={0} max={1} step={0.01} reset={0} value={level} onChange={(v) => setSend(track.id, bus.id, v, `send-${track.id}-${bus.id}`)} />
            </Param>
          )
        })}
      </div>
    </section>
  )
}

function Param(props: { label: string; text: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label>
      <span>{props.label}</span>
      {props.children}
      <output>{props.text}</output>
    </label>
  )
}

// ── Audio clip ───────────────────────────────────────────────────────────

export function AudioClipPanel({ clip }: { clip: AudioClip }): React.JSX.Element {
  const asset = useStudio((s) => s.project.assets[clip.assetId])
  const project = useStudio((s) => s.project)
  const seconds = timeMap(project).duration(clip.start, clip.start + clip.length)
  const gain = clip.gain ?? 1
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0
  const set = (patch: Partial<AudioClip>, key: string): void => updateClip(clip.id, patch, `clip-${key}-${clip.id}`)
  return (
    <div className="placeholder clip-panel">
      <p>
        <input
          className="clip-name"
          aria-label="Clip name"
          value={clip.name}
          onChange={(e) => set({ name: e.target.value }, 'name')}
          onBlur={() => useStudio.getState().endGesture()}
        />
      </p>
      <p className="muted">{asset ? `${asset.name} · ${asset.duration.toFixed(2)} s` : 'Source file missing'}</p>
      <div className="params">
        <Param label="Gain" text={gain > 0 ? `${(20 * Math.log10(gain)).toFixed(1)} dB` : '-∞ dB'}>
          <Slider label="Gain" min={0} max={2} step={0.01} reset={1} value={gain} onChange={(v) => set({ gain: v }, 'gain')} />
        </Param>
        <Param label="Stretch" text={`${Math.round((clip.stretch ?? 1) * 100)}%`}>
          {/* Logarithmic, so half speed and double speed are the same distance from the middle. */}
          <Slider label="Stretch length without changing pitch" min={-1} max={1} step={0.01} reset={0} value={Math.log2(clip.stretch ?? 1)} onChange={(v) => setClipStretch(clip.id, 2 ** v, `clip-stretch-${clip.id}`)} />
        </Param>
        <Param label="Pitch" text={`${(clip.pitch ?? 0) > 0 ? '+' : ''}${clip.pitch ?? 0} st`}>
          <Slider label="Shift pitch without changing length" min={-12} max={12} step={1} reset={0} value={clip.pitch ?? 0} onChange={(v) => set({ pitch: v }, 'pitch')} />
        </Param>
        {/* The two fades may not overlap. */}
        <Param label="Fade in" text={`${fadeIn.toFixed(2)} s`}>
          <Slider label="Fade in" min={0} max={seconds} step={0.01} reset={0} value={fadeIn} onChange={(v) => set({ fadeIn: Math.min(v, seconds - fadeOut) }, 'fadein')} />
        </Param>
        <Param label="Fade out" text={`${fadeOut.toFixed(2)} s`}>
          <Slider label="Fade out" min={0} max={seconds} step={0.01} reset={0} value={fadeOut} onChange={(v) => set({ fadeOut: Math.min(v, seconds - fadeIn) }, 'fadeout')} />
        </Param>
      </div>
      <p>
        <button onClick={() => splitClips([clip.id], engine.getPosition())}>Split at playhead</button>{' '}
        <button onClick={() => duplicateClips([clip.id])}>Duplicate</button> <button onClick={() => removeClips([clip.id])}>Delete</button>
      </p>
    </div>
  )
}
