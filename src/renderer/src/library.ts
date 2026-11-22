/**
 * Every instrument a track can be given, from every source, as one list: the
 * engine's own, the SoundFont's presets, installed SFZ instruments, Surge
 * XT's patches and hosted plugins. Each knows how to make itself a track's
 * instrument, so the browser need not know where it came from.
 */
import type { Id, PluginRef, SfzInstrument, SoundFontPreset, SurgePatch, Track } from '@shared/model'
import { nativeEngine } from './engine'
import { bridge } from './platform'
import { usePlugins } from './plugins'
import { DRUM_BANK, useSfzInstruments, useSoundFontPresets, useSurgePatches } from './soundfont'
import { setInstrument, setInstrumentPatch, setInstrumentPlugin, setInstrumentSfz, setInstrumentSoundFont } from './state/actions'

export const SOURCES = ['Built in', 'General MIDI', 'SFZ', 'Surge XT', 'Plugins'] as const
export type Source = (typeof SOURCES)[number]

/** What kind of instrument something is, whatever it is made with. In the order the browser shows them. */
export const FAMILIES = ['Keys', 'Organ', 'Mallets', 'Guitar', 'Bass', 'Strings', 'Brass', 'Winds', 'Leads', 'Pads', 'Plucks', 'Synth', 'Drums', 'Percussion', 'Sequences', 'FX', 'World', 'Other'] as const
export type Family = (typeof FAMILIES)[number]

export interface LibraryItem {
  /** The same for the same instrument from one session to the next: favourites are kept by it. */
  id: string
  name: string
  family: Family
  source: Source
  /** Where it comes from, in a few words. */
  detail: string
  /** A note that shows it off: a low one for a bass, a kick for a drum kit. */
  auditionPitch: number
  /** The octave the typing keyboard is moved to when it is chosen (see `octaveFor`). */
  octave: number
  /** Makes it the track's instrument. Rejects if it cannot be read. With a `gesture`, a run of these is one undo step. */
  apply: (trackId: Id, gesture?: string) => void | Promise<void>
}

/** General MIDI files its 128 programs in sixteen families of eight. */
const GM_FAMILIES: Family[] = ['Keys', 'Mallets', 'Organ', 'Guitar', 'Bass', 'Strings', 'Strings', 'Brass', 'Winds', 'Winds', 'Leads', 'Pads', 'FX', 'World', 'Percussion', 'FX']

/** Surge XT's folder names, as families. */
const SURGE_FAMILIES: Record<string, Family> = {
  Basses: 'Bass',
  Brass: 'Brass',
  Chords: 'Synth',
  Drums: 'Drums',
  FX: 'FX',
  Keys: 'Keys',
  Leads: 'Leads',
  Organs: 'Organ',
  Pads: 'Pads',
  Atmospheres: 'Pads',
  Ambiance: 'Pads',
  Percussion: 'Percussion',
  Plucks: 'Plucks',
  Polysynths: 'Synth',
  Synths: 'Synth',
  Sequences: 'Sequences',
  Rhythms: 'Sequences',
  Arps: 'Sequences',
  Strings: 'Strings',
  Winds: 'Winds',
  Bells: 'Mallets',
  Mallets: 'Mallets',
  Guitars: 'Guitar'
}

/** An SFZ instrument says nothing of what it is but its name, so the name is read for a clue. Order matters: a bassoon is not a bass. */
const NAME_CLUES: [RegExp, Family][] = [
  [/bassoon|flute|clarinet|oboe|sax|piccolo|recorder|woodwind/i, 'Winds'],
  [/drum|kit\b|snare|kick|hat\b|cymbal|tom\b/i, 'Drums'],
  [/bass/i, 'Bass'],
  [/piano|rhodes|wurli|clav|harpsi|keys/i, 'Keys'],
  [/organ/i, 'Organ'],
  [/violin|viola|cello|string|harp\b/i, 'Strings'],
  [/trumpet|trombone|horn|tuba|brass/i, 'Brass'],
  [/guitar|banjo|ukulele|mandolin/i, 'Guitar'],
  [/marimba|xylo|glock|vibra|celesta|bell|chime/i, 'Mallets'],
  [/perc|timpani|tambourine|shaker|conga|bongo|clap/i, 'Percussion']
]

/**
 * Where each kind of instrument is played, as the octave of the typing
 * keyboard's lowest C (4 is middle C). A bass tried at middle C says little
 * about how it sounds as a bass, so it is played from C2: low enough to be a
 * bass, high enough to be heard on small speakers (Z goes lower). A drum
 * kit's kick and snare are at C2 as well.
 */
const OCTAVES: Partial<Record<Family, number>> = { Bass: 2, Drums: 2 }
export const octaveFor = (family: Family): number => OCTAVES[family] ?? 4

/** The note that shows a kind of instrument off: the lowest C of where it is played, which for a drum kit is its kick. */
const pitchFor = (family: Family): number => (octaveFor(family) + 1) * 12

function item(id: string, name: string, family: Family, source: Source, detail: string, apply: LibraryItem['apply']): LibraryItem {
  return { id, name, family, source, detail, auditionPitch: pitchFor(family), octave: octaveFor(family), apply }
}

/** Where a plugin has both a VST3 and an Audio Unit, the VST3. */
function oneFormatEach(plugins: PluginRef[]): PluginRef[] {
  const key = (plugin: PluginRef): string => `${plugin.manufacturer}/${plugin.name}`
  const vst3 = new Set(plugins.filter((plugin) => plugin.format === 'VST3').map(key))
  return plugins.filter((plugin) => plugin.format === 'VST3' || !vst3.has(key(plugin)))
}

export interface Library {
  items: LibraryItem[]
  /** Surge XT's patches are on disk but no scan has found Surge XT to play them. */
  surgeNeedsScan: boolean
  /** Nothing but the engine's own three can be played: this is the Web Audio engine. */
  nativeOnly: boolean
}

export function useLibrary(): Library {
  return buildLibrary(useSoundFontPresets() ?? null, useSfzInstruments(), useSurgePatches(), usePlugins().plugins ?? [])
}

/** The library as it stands now, asked for afresh: for a caller that is not a component (see mcp.ts). */
export async function loadLibrary(): Promise<Library> {
  const [presets, sfz, patches, found] = await Promise.all([
    (bridge?.soundFontPresets() ?? Promise.resolve(null)).catch(() => null),
    (bridge?.sfzInstruments() ?? Promise.resolve([])).catch(() => []),
    (bridge?.surgePatches() ?? Promise.resolve([])).catch(() => []),
    (nativeEngine?.plugins(false) ?? Promise.resolve(null)).catch(() => null)
  ])
  return buildLibrary(presets, sfz, patches, found?.plugins ?? [])
}

function buildLibrary(presets: SoundFontPreset[] | null, sfz: SfzInstrument[], patches: SurgePatch[], scanned: PluginRef[]): Library {
  const plugins = oneFormatEach(scanned.filter((plugin) => plugin.instrument))
  const surge = plugins.find((plugin) => plugin.name === 'Surge XT' && plugin.format === 'VST3')

  const items: LibraryItem[] = [
    item('builtin:synth', 'Synth', 'Synth', 'Built in', 'One oscillator, a filter and an envelope', (id, gesture) => setInstrument(id, 'synth', gesture)),
    item('builtin:drums', 'Drum machine', 'Drums', 'Built in', 'Synthesised kit', (id, gesture) => setInstrument(id, 'drums', gesture)),
    item('builtin:sampler', 'Sampler', 'Other', 'Built in', 'Plays one sample of your own across the keys', (id, gesture) => setInstrument(id, 'sampler', gesture)),
    ...(presets ?? []).map((preset) =>
      item(
        `sf:${preset.bank}:${preset.program}`,
        preset.name,
        preset.bank === DRUM_BANK ? 'Drums' : GM_FAMILIES[preset.program >> 3],
        'General MIDI',
        preset.bank === DRUM_BANK ? 'MuseScore General · drum kit' : preset.bank === 0 ? `MuseScore General · program ${preset.program + 1}` : `MuseScore General · bank ${preset.bank}`,
        (id, gesture) => setInstrumentSoundFont(id, preset, gesture)
      )
    ),
    ...sfz.map((each) =>
      item(`sfz:${each.file}`, each.name, NAME_CLUES.find(([clue]) => clue.test(`${each.name} ${each.pack}`))?.[1] ?? 'Other', 'SFZ', each.pack, (id, gesture) => setInstrumentSfz(id, each, gesture))
    ),
    ...(surge
      ? patches.map((patch) =>
          item(`surge:${patch.author}/${patch.category}/${patch.name}`, patch.name, SURGE_FAMILIES[patch.category] ?? 'Other', 'Surge XT', `${patch.author} · ${patch.category}`, async (id, gesture) => {
            const state = await bridge?.surgePatchState(patch.path)
            if (!state) throw new Error(`The Surge XT patch “${patch.name}” could not be read.`)
            setInstrumentPatch(id, surge, state, patch.name, gesture)
          })
        )
      : []),
    ...plugins.map((plugin) =>
      item(`plugin:${plugin.format}:${plugin.manufacturer}/${plugin.name}`, plugin.name, 'Synth', 'Plugins', [plugin.manufacturer, plugin.format === 'AudioUnit' ? 'AU' : plugin.format].filter(Boolean).join(' · '), (id, gesture) =>
        setInstrumentPlugin(id, plugin, gesture)
      )
    )
  ]
  return { items, surgeNeedsScan: !surge && patches.length > 0 && !!nativeEngine, nativeOnly: !nativeEngine }
}

/** The library id of the instrument a track has now, so the browser can mark it; null where it cannot be told. */
export function currentItemId(track: Track | undefined, items: LibraryItem[]): string | null {
  if (!track || track.kind !== 'midi') return null
  const instrument = track.instrument ?? 'synth'
  if (instrument === 'soundfont') return track.soundfont ? `sf:${track.soundfont.bank}:${track.soundfont.program}` : null
  if (instrument === 'sfz') return track.sfz ? `sfz:${track.sfz.file}` : null
  if (instrument !== 'plugin') return `builtin:${instrument}`
  if (!track.plugin) return null
  // A patch is known only by its name; the first of that name is as good a guess as any.
  if (track.pluginPatch) return items.find((each) => each.source === 'Surge XT' && each.name === track.pluginPatch)?.id ?? null
  return `plugin:${track.plugin.format}:${track.plugin.manufacturer}/${track.plugin.name}`
}
