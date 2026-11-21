import { useState, useSyncExternalStore } from 'react'
import { EFFECTS, effectParam, formatParam, type ParamDef } from '@shared/effects'
import {
  DEFAULT_SAMPLER,
  type BuiltInEffectType,
  type Effect,
  type InstrumentType,
  type PluginRef,
  type SamplerParams,
  type SfzInstrument,
  type SoundFontPreset,
  type SurgePatch,
  type SynthParams,
  type Track,
  type Waveform
} from '@shared/model'
import { TextField } from './controls/fields'
import { nativeEngine } from '../engine'
import { pluginLabel, scanPlugins, usePlugins } from '../plugins'
import { bridge, loadSampleDialog } from '../platform'
import { DRUM_BANK, useSfzInstruments, useSoundFontPresets, useSurgePatches } from '../soundfont'
import {
  addEffect,
  addPluginEffect,
  findClip,
  removeEffect,
  setInstrument,
  setInstrumentPatch,
  setInstrumentPlugin,
  setInstrumentSfz,
  setInstrumentSoundFont,
  setSend,
  updateEffect,
  updateTrack
} from '../state/actions'
import { useStudio } from '../state/store'
import { pitchName } from '../util'
import { Button, IconButton, Segmented, Toggle } from './controls/buttons'
import { Dial } from './controls/Dial'
import { Picker, type PickerGroup } from './controls/Picker'
import { useMenu } from './controls/Popover'
import { logCurve } from './controls/value'

const KIND: Record<Track['kind'], string> = { midi: 'Instrument track', audio: 'Audio track', bus: 'Bus' }
const INSTRUMENTS: [InstrumentType, string][] = [
  ['synth', 'Synth'],
  ['drums', 'Drum machine'],
  ['sampler', 'Sampler']
]
const WAVES: [Waveform, string][] = [
  ['sine', 'Sine'],
  ['triangle', 'Tri'],
  ['sawtooth', 'Saw'],
  ['square', 'Square']
]

const endGesture = (): void => useStudio.getState().endGesture()
const time = (seconds: number): string => (seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`)
const hertz = (hz: number): string => (hz >= 1000 ? `${(hz / 1000).toFixed(1)} kHz` : `${Math.round(hz)} Hz`)

const CUTOFF = logCurve(80, 16000)
const ATTACK = logCurve(0.001, 1)
const DECAY = logCurve(0.01, 2)
const RELEASE = logCurve(0.01, 3)

/**
 * Many plugins install as both a VST3 and an Audio Unit, and a scan finds
 * both. Listing each twice only invites the question of which to pick, so
 * where a plugin has a VST3 that is the one offered.
 */
function oneFormatEach(plugins: PluginRef[]): PluginRef[] {
  const id = (plugin: PluginRef): string => `${plugin.manufacturer}/${plugin.name}`
  const vst3 = new Set(plugins.filter((plugin) => plugin.format === 'VST3').map(id))
  return plugins.filter((plugin) => plugin.format === 'VST3' || !vst3.has(id(plugin)))
}

/** What is in the scan's results, and how to ask for another. Shared by the instrument and effect pickers. */
function usePluginChoices(): { instruments: PluginRef[]; effects: PluginRef[]; actions: { label: string; onSelect: () => void; disabled?: boolean }[]; note: string | null } {
  const list = usePlugins()
  const all = oneFormatEach(list.plugins ?? [])
  const failed = list.failed.length
  return {
    instruments: all.filter((p) => p.instrument),
    effects: all.filter((p) => !p.instrument),
    // Plugins are the native engine's to find and run.
    actions: nativeEngine
      ? [{ label: list.scanning ? 'Looking for plugins…' : list.plugins ? 'Look for plugins again…' : 'Look for plugins…', onSelect: scanPlugins, disabled: list.scanning }]
      : [],
    note: list.error ?? (failed ? `${failed === 1 ? '1 plugin' : `${failed} plugins`} could not be examined and ${failed === 1 ? 'is' : 'are'} not listed.` : null)
  }
}

/** The inspector for the track of the selected clip, or else the selected track. */
export function Inspector(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const selectedClipIds = useStudio((s) => s.selectedClipIds)
  const selectedTrackId = useStudio((s) => s.selectedTrackId)
  const track = findClip(project, selectedClipIds[selectedClipIds.length - 1])?.track ?? project.tracks.find((t) => t.id === selectedTrackId)
  if (!track) return <p className="insp-empty">Select a track to see its instrument, effects and sends.</p>
  const buses = project.tracks.filter((t) => t.kind === 'bus')
  return (
    <>
      <header className="insp-head">
        <span className="insp-color" style={{ background: track.color }} />
        <div>
          <TextField className="insp-name" label="Track name" value={track.name} onCommit={(name) => name.trim() && updateTrack(track.id, { name: name.trim() })} />
          <div className="insp-kind">{KIND[track.kind]}</div>
        </div>
      </header>

      {track.kind === 'midi' && <InstrumentSection track={track} />}
      {track.kind === 'bus' && <p className="insp-note insp-pad">A bus plays what other tracks send to it, through its own effects.</p>}
      <EffectsSection track={track} />
      {track.kind !== 'bus' && buses.length > 0 && (
        <Section title="Sends">
          <div className="dials">
            {buses.map((bus) => {
              const level = track.sends?.find((s) => s.busId === bus.id)?.level ?? 0
              return (
                <Dial
                  key={bus.id}
                  label={`Send to ${bus.name}`}
                  caption={bus.name}
                  min={0}
                  max={1}
                  reset={0}
                  value={level}
                  text={`${Math.round(level * 100)}%`}
                  onChange={(v) => setSend(track.id, bus.id, v, `send-${track.id}-${bus.id}`)}
                  onEnd={endGesture}
                />
              )
            })}
          </div>
        </Section>
      )}
    </>
  )
}

/** A titled part of the inspector that folds away. `aside` sits at the right of its heading. */
function Section(props: { title: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  return (
    <section className="insp-section">
      <div className="insp-section-head">
        <button type="button" className="insp-fold" aria-expanded={open} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden style={{ transform: open ? undefined : 'rotate(-90deg)' }}>
            <path d="M2 4.25 6 8l4-3.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {props.title}
        </button>
        {props.aside}
      </div>
      {open && <div className="insp-section-body">{props.children}</div>}
    </section>
  )
}

// ── Instrument ───────────────────────────────────────────────────────────

function InstrumentSection({ track }: { track: Track }): React.JSX.Element {
  const instrument = track.instrument ?? 'synth'
  const choices = usePluginChoices()
  const presets = useSoundFontPresets()
  // The SoundFont's presets by where they sit: bank 0 is the General MIDI set, bank 128 the drum kits, and the rest variations on bank 0.
  const sounds = (from: (preset: SoundFontPreset) => boolean, detail: (preset: SoundFontPreset) => string | undefined): { value: SoundFontPreset; label: string; detail?: string }[] =>
    (presets ?? []).filter(from).map((preset) => ({ value: preset, label: preset.name, detail: detail(preset) }))
  const sfz = useSfzInstruments()
  const packs = [...new Set(sfz.map((each) => each.pack))]
  // Surge XT's patches are offered once a scan has found Surge XT itself, which is what plays them.
  const surge = choices.instruments.find((plugin) => plugin.name === 'Surge XT' && plugin.format === 'VST3')
  const patches = useSurgePatches()
  const categories = surge ? [...new Set(patches.map((patch) => patch.category))] : []
  const pickPatch = async (patch: SurgePatch): Promise<void> => {
    const state = await bridge?.surgePatchState(patch.path)
    if (surge && state) setInstrumentPatch(track.id, surge, state, patch.name)
    else window.alert(`The Surge XT patch “${patch.name}” could not be read.`)
  }
  const groups: PickerGroup<InstrumentType | PluginRef | SoundFontPreset | SfzInstrument | SurgePatch>[] = [
    { label: 'Built in', options: INSTRUMENTS.map(([value, label]) => ({ value, label })) },
    { label: 'General MIDI', options: sounds((p) => p.bank === 0, (p) => String(p.program + 1)) },
    { label: 'Drum kits', options: sounds((p) => p.bank === DRUM_BANK, () => undefined) },
    { label: 'More sounds', options: sounds((p) => p.bank !== 0 && p.bank !== DRUM_BANK, (p) => `Bank ${p.bank}`) },
    // One group for each SFZ pack installed.
    ...packs.map((pack) => ({ label: pack, options: sfz.filter((each) => each.pack === pack).map((each) => ({ value: each, label: each.name })) })),
    { label: 'Plugins', options: choices.instruments.map((plugin) => ({ value: plugin, label: plugin.name, detail: [plugin.manufacturer, plugin.format === 'AudioUnit' ? 'AU' : plugin.format].filter(Boolean).join(' · ') })) },
    // After the plugins themselves, since there are thousands: one group for each of Surge XT's categories.
    ...categories.map((category) => ({
      label: `Surge XT · ${category}`,
      options: patches.filter((patch) => patch.category === category).map((patch) => ({ value: patch, label: patch.name, detail: patch.author }))
    }))
  ]
  const name =
    instrument === 'plugin'
      ? track.plugin
        ? track.pluginPatch
          ? `${track.pluginPatch} · ${track.plugin.name}`
          : pluginLabel(track.plugin)
        : 'Plugin'
      : instrument === 'soundfont'
        ? (track.soundfont?.name ?? 'SoundFont')
        : instrument === 'sfz'
          ? (track.sfz?.name ?? 'SFZ instrument')
        : INSTRUMENTS.find(([value]) => value === instrument)![1]
  return (
    <Section title="Instrument">
      <Picker
        wide
        label={name}
        title="Choose this track's instrument"
        placeholder="Search instruments"
        groups={groups.filter((group) => group.options.length)}
        actions={choices.actions}
        onPick={(value) =>
          typeof value === 'string'
            ? setInstrument(track.id, value)
            : 'description' in value
              ? setInstrumentPlugin(track.id, value)
              : 'category' in value
                ? void pickPatch(value)
                : 'file' in value
                  ? setInstrumentSfz(track.id, value)
                  : setInstrumentSoundFont(track.id, value)
        }
      />
      {instrument === 'soundfont' && <SoundFontNote installed={presets !== null} />}
      {instrument === 'sfz' && <SfzNote chosen={track.sfz} installed={sfz.some((each) => each.file === track.sfz?.file)} />}
      {instrument === 'synth' && track.synth && <SynthControls track={track} synth={track.synth} />}
      {instrument === 'sampler' && <SamplerControls track={track} sampler={track.sampler ?? DEFAULT_SAMPLER} />}
      {instrument === 'drums' && <p className="insp-note">Each note name is a drum: C kick, D snare, F♯ hat, A♯ open hat. The piano roll shows them all.</p>}
      {instrument === 'plugin' && <PluginControls track={track} effectId={null} />}
    </Section>
  )
}

/** Says where a SoundFont instrument's sound comes from, or why it cannot be heard. */
function SoundFontNote({ installed }: { installed: boolean }): React.JSX.Element {
  if (!nativeEngine) return <p className="insp-note">SoundFont instruments need the native engine. With this one the track is silent.</p>
  if (!installed) return <p className="insp-note insp-error">The SoundFont is not installed, so this track is silent. Run `npm run fetch:content` to download it.</p>
  return <p className="insp-note">Played from MuseScore General, an open SoundFont (MIT licence).</p>
}

/** Says which pack an SFZ instrument is from, or why it cannot be heard. */
function SfzNote({ chosen, installed }: { chosen: SfzInstrument | undefined; installed: boolean }): React.JSX.Element {
  if (!nativeEngine) return <p className="insp-note">SFZ instruments need the native engine. With this one the track is silent.</p>
  if (!installed) return <p className="insp-note insp-error">{chosen ? `“${chosen.pack}” is not installed, so this track is silent.` : 'No instrument is chosen, so this track is silent.'}</p>
  return <p className="insp-note">From the SFZ pack “{chosen?.pack}”.</p>
}

function SynthControls({ track, synth }: { track: Track; synth: SynthParams }): React.JSX.Element {
  const set = (patch: Partial<SynthParams>, key: string): void => updateTrack(track.id, { synth: { ...synth, ...patch } }, `synth-${key}-${track.id}`)
  return (
    <>
      <Segmented label="Waveform" value={synth.wave} options={WAVES} onChange={(wave) => updateTrack(track.id, { synth: { ...synth, wave } })} />
      <div className="dials">
        <Dial label="Cutoff" min={80} max={16000} curve={CUTOFF} reset={2000} value={synth.cutoff} text={hertz(synth.cutoff)} onChange={(cutoff) => set({ cutoff }, 'cutoff')} onEnd={endGesture} />
        <Dial label="Resonance" caption="Reso" min={0.1} max={20} snap={0.1} reset={1} value={synth.resonance} text={synth.resonance.toFixed(1)} onChange={(resonance) => set({ resonance }, 'res')} onEnd={endGesture} />
      </div>
      <div className="dials">
        <Dial label="Attack" min={0.001} max={1} curve={ATTACK} value={synth.attack} text={time(synth.attack)} onChange={(attack) => set({ attack }, 'a')} onEnd={endGesture} />
        <Dial label="Decay" min={0.01} max={2} curve={DECAY} value={synth.decay} text={time(synth.decay)} onChange={(decay) => set({ decay }, 'd')} onEnd={endGesture} />
        <Dial label="Sustain" min={0} max={1} snap={0.01} value={synth.sustain} text={`${Math.round(synth.sustain * 100)}%`} onChange={(sustain) => set({ sustain }, 's')} onEnd={endGesture} />
        <Dial label="Release" min={0.01} max={3} curve={RELEASE} value={synth.release} text={time(synth.release)} onChange={(release) => set({ release }, 'r')} onEnd={endGesture} />
      </div>
    </>
  )
}

function SamplerControls({ track, sampler }: { track: Track; sampler: SamplerParams }): React.JSX.Element {
  const asset = useStudio((s) => (sampler.assetId ? s.project.assets[sampler.assetId] : undefined))
  const set = (patch: Partial<SamplerParams>, key: string): void => updateTrack(track.id, { sampler: { ...sampler, ...patch } }, `sampler-${key}-${track.id}`)
  return (
    <>
      <Button title={asset ? `${asset.name} (click to replace)` : 'Choose the audio file this sampler plays'} onClick={() => void loadSampleDialog(track.id)}>
        <span className="btn-text">{asset ? asset.name : 'Load sample…'}</span>
      </Button>
      <div className="dials">
        <Dial label="Root note" caption="Root" min={24} max={96} snap={1} reset={60} value={sampler.root} text={pitchName(sampler.root)} onChange={(root) => set({ root }, 'root')} onEnd={endGesture} />
        <Dial label="Attack" min={0.001} max={1} curve={ATTACK} value={sampler.attack} text={time(sampler.attack)} onChange={(attack) => set({ attack }, 'a')} onEnd={endGesture} />
        <Dial label="Release" min={0.01} max={3} curve={RELEASE} value={sampler.release} text={time(sampler.release)} onChange={(release) => set({ release }, 'r')} onEnd={endGesture} />
      </div>
    </>
  )
}

/** For a plugin: a button for its own window, or why there is none. `effectId` is null for a track's instrument. */
function PluginControls({ track, effectId }: { track: Track; effectId: string | null }): React.JSX.Element {
  const error = useSyncExternalStore(
    (listener) => nativeEngine?.onStatus(listener) ?? (() => {}),
    () => nativeEngine?.pluginError(track.id, effectId) ?? null
  )
  if (!nativeEngine) return <p className="insp-note">Plugins need the native engine. With this one it is left out.</p>
  if (error) return <p className="insp-note insp-error">Could not be loaded: {error}</p>
  return (
    <Button title="The plugin's own window" onClick={() => nativeEngine?.showPlugin(track.id, effectId)}>
      Open window
    </Button>
  )
}

// ── Effects ──────────────────────────────────────────────────────────────

function EffectsSection({ track }: { track: Track }): React.JSX.Element {
  const effects = track.effects ?? []
  const choices = usePluginChoices()
  const groups: PickerGroup<BuiltInEffectType | PluginRef>[] = [
    { label: 'Built in', options: (Object.keys(EFFECTS) as BuiltInEffectType[]).map((type) => ({ value: type, label: EFFECTS[type].label })) },
    { label: 'Plugins', options: choices.effects.map((plugin) => ({ value: plugin, label: plugin.name, detail: [plugin.manufacturer, plugin.format === 'AudioUnit' ? 'AU' : plugin.format].filter(Boolean).join(' · ') })) }
  ]
  const move = (index: number, by: number): void => {
    const next = [...effects]
    const [effect] = next.splice(index, 1)
    next.splice(index + by, 0, effect)
    updateTrack(track.id, { effects: next })
  }
  return (
    <Section title="Effects" aside={effects.length > 0 && <span className="insp-count">{effects.length}</span>}>
      {effects.map((effect, index) => (
        <EffectCard key={effect.id} track={track} effect={effect} onMove={(by) => move(index, by)} first={index === 0} last={index === effects.length - 1} />
      ))}
      <Picker
        wide
        label="Add effect…"
        placeholder="Search effects"
        groups={groups.filter((group) => group.options.length)}
        actions={choices.actions}
        onPick={(value) => (typeof value === 'string' ? addEffect(track.id, value) : addPluginEffect(track.id, value))}
      />
      {choices.note && <p className="insp-note">{choices.note}</p>}
    </Section>
  )
}

function EffectCard(props: { track: Track; effect: Effect; first: boolean; last: boolean; onMove: (by: number) => void }): React.JSX.Element {
  const { track, effect } = props
  const [menu, openMenu] = useMenu()
  const def = effect.type === 'plugin' ? { label: effect.plugin ? pluginLabel(effect.plugin) : 'Plugin', params: [] } : EFFECTS[effect.type]
  return (
    <div className={`fx ${effect.bypass ? 'bypassed' : ''}`}>
      <div className="fx-head">
        <Toggle label={effect.bypass ? 'Turn on' : 'Bypass'} tone="ok" size="sm" pressed={!effect.bypass} onChange={(on) => updateEffect(track.id, effect.id, { bypass: !on })}>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
            <path d="M6 1.5v4M3.4 3.2a4 4 0 1 0 5.2 0" />
          </svg>
        </Toggle>
        <strong title={effect.plugin?.manufacturer}>{def.label}</strong>
        <IconButton
          label="More: reorder or remove"
          size="sm"
          onClick={(event) =>
            openMenu(event, [
              { label: 'Move Up', disabled: props.first, onSelect: () => props.onMove(-1) },
              { label: 'Move Down', disabled: props.last, onSelect: () => props.onMove(1) },
              { separator: true },
              { label: 'Remove', danger: true, onSelect: () => removeEffect(track.id, effect.id) }
            ])
          }
        >
          <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden>
            <circle cx="2" cy="6" r="1.1" />
            <circle cx="6" cy="6" r="1.1" />
            <circle cx="10" cy="6" r="1.1" />
          </svg>
        </IconButton>
      </div>
      {def.params.length > 0 && (
        <div className="dials">
          {def.params.map((param) => (
            <EffectDial key={param.key} track={track} effect={effect} def={param} />
          ))}
        </div>
      )}
      {effect.type === 'plugin' && <PluginControls track={track} effectId={effect.id} />}
      {menu}
    </div>
  )
}

function EffectDial({ track, effect, def }: { track: Track; effect: Effect; def: ParamDef }): React.JSX.Element {
  const value = effectParam(effect, def.key)
  return (
    <Dial
      label={def.label}
      min={def.min}
      max={def.max}
      curve={def.log ? logCurve(def.min, def.max) : undefined}
      // A gain that goes both ways is shown from its middle.
      bipolar={def.min < 0 && def.max > 0}
      reset={def.default}
      value={value}
      text={formatParam(def, value)}
      onChange={(next) => updateEffect(track.id, effect.id, { params: { ...effect.params, [def.key]: next } }, `fx-${effect.id}-${def.key}`)}
      onEnd={endGesture}
    />
  )
}
