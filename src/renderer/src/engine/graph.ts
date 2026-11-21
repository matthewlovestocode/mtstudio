import {
  automationValue,
  clipStretch,
  type AudioClip,
  type AutomationPoint,
  type Effect,
  type Id,
  type Project,
  type Track
} from '@shared/model'
import { timeMap, type TimeMap } from '@shared/timemap'
import type { NoteEvent } from './dsp/protocol'
import { StreamPlayer } from './stream'
import type { AudioStream } from './types'
import { effectConfigs, EffectsNode, instrumentConfig, InstrumentNode, MeterNode, sampleData } from './worklets'

/**
 * One track's signal path. The instrument, the insert effects and the meter
 * are audio worklets (see ./dsp); the fader, pan, gate and sends are plain
 * gain nodes so they can be automated.
 *
 *   instrument ─┐
 *   audio clips ┴→ input → effects → volume → pan → gate ─┬→ master
 *                                                         ├→ meter
 *                                                         └→ send gains → bus inputs
 */
export interface Strip {
  input: GainNode
  volume: GainNode
  pan: StereoPannerNode
  /** Mute/solo gate. */
  gate: GainNode
  meter: MeterNode | null
  instrument: InstrumentNode | null
  /** The track settings the instrument was last configured from. */
  configured: unknown[]
  /** Id of the sample the instrument has been given. */
  sample: Id | null
  /** Present while the track has at least one active effect. */
  effects: EffectsNode | null
  effectsSeen: readonly Effect[] | undefined
  sends: Map<Id, GainNode>
}

export interface PlayingClip {
  clip: AudioClip
  /** Stops at `time` on the audio clock, or at once. */
  stop(time?: number): void
  /** For clips played from disk: reads ahead. Called on every scheduling pass. */
  pump?(): void
}

/** Where a scheduling pass records what it started, so it can be stopped later. */
export interface ScheduleState {
  clips: Map<Id, PlayingClip>
  metronome: boolean
}

export interface GraphOptions {
  /** Level meters are only needed when someone is watching. */
  meters: boolean
  /**
   * For an offline render: every note of the piece, by track. Messages cannot
   * be relied on to reach a worklet in time when rendering faster than real
   * time, so instruments are handed their whole performance at creation.
   */
  notes?: Map<Id, NoteEvent[]>
  /** Time-stretched copies of audio files, by `clipStretch(clip).key`. */
  stretched: Map<string, AudioBuffer>
  /** Files played from disk rather than from memory, by asset id. */
  streams: Map<Id, AudioStream>
}

const hasPoints = (points: AutomationPoint[] | undefined): points is AutomationPoint[] => !!points && points.length > 0

let lastNoteId = 0
export const newNoteId = (): number => ++lastNoteId

/** Calls `visit` for each note that starts in the tick range [from, to). */
function eachNote(
  project: Project,
  map: TimeMap,
  from: number,
  to: number,
  visit: (track: Track, pitch: number, velocity: number, tick: number, seconds: number) => void
): void {
  for (const track of project.tracks) {
    if (track.kind !== 'midi') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'midi' || clip.start >= to || clip.start + clip.length <= from) continue
      for (const note of clip.notes) {
        const tick = clip.start + note.start
        // Notes outside the clip's bounds (after trimming) are kept but silent.
        if (note.start < 0 || note.start >= clip.length || tick < from || tick >= to) continue
        const length = Math.min(note.length, clip.length - note.start)
        visit(track, note.pitch, note.velocity, tick, Math.max(0.01, map.duration(tick, tick + length)))
      }
    }
  }
}

/** Every note in [from, to) as timed events by track, where `from` sounds at `time`. */
export function collectNotes(project: Project, from: number, to: number, time: number): Map<Id, NoteEvent[]> {
  const map = timeMap(project)
  const notes = new Map<Id, NoteEvent[]>()
  eachNote(project, map, from, to, (track, pitch, velocity, tick, duration) => {
    let list = notes.get(track.id)
    if (!list) notes.set(track.id, (list = []))
    list.push({ id: newNoteId(), pitch, velocity, time: time + map.duration(from, tick), duration })
  })
  return notes
}

/**
 * The mixer and instruments for one audio context. The live engine owns one
 * on a real-time context; a mixdown builds another on an offline context and
 * schedules the whole project into it. The context must have had
 * `loadWorklets` run on it first.
 */
export class Graph {
  readonly master: GainNode
  readonly strips = new Map<Id, Strip>()
  /** While the transport runs, automated parameters follow their curves instead of the faders. */
  running = false
  private masterMeter: MeterNode | null = null

  constructor(
    readonly ctx: BaseAudioContext,
    private buffers: Map<Id, AudioBuffer>,
    private options: GraphOptions
  ) {
    this.master = ctx.createGain()
    // Safety limiter so a stack of loud tracks cannot clip the output.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -3
    limiter.knee.value = 0
    limiter.ratio.value = 20
    limiter.attack.value = 0.002
    limiter.release.value = 0.1
    // The browser's compressor adds make-up gain of its own accord; take it back out so the limiter is level-neutral.
    const untouched = 10 ** ((limiter.threshold.value * (1 - 1 / limiter.ratio.value)) / 20)
    const trim = ctx.createGain()
    trim.gain.value = untouched ** 0.6
    this.master.connect(limiter)
    limiter.connect(trim)
    trim.connect(ctx.destination)
    if (options.meters) {
      this.masterMeter = new MeterNode(ctx)
      trim.connect(this.masterMeter.node)
    }
  }

  /** Latest peak level, 0–1+, of a track or the master output. */
  peak(target: Id | 'master'): number {
    const meter = target === 'master' ? this.masterMeter : this.strips.get(target)?.meter
    return meter?.peak ?? 0
  }

  // ── Mixer ──────────────────────────────────────────────────────────────

  /** Makes the channel strips, instruments, effects and sends match the project's tracks. */
  sync(project: Project, immediate = false): void {
    const now = this.ctx.currentTime
    const set = (param: AudioParam, value: number, smoothing: number): void => {
      if (immediate) {
        param.value = value
      } else {
        param.cancelScheduledValues(now)
        param.setTargetAtTime(value, now, smoothing)
      }
    }
    const anySolo = project.tracks.some((t) => t.solo)

    for (const track of project.tracks) {
      let strip = this.strips.get(track.id)
      if (!strip) {
        strip = this.createStrip()
        this.strips.set(track.id, strip)
      }
      // Buses stay open under solo so a soloed track keeps its reverb.
      const audible = !track.mute && (!anySolo || track.solo || track.kind === 'bus')
      if (!(this.running && hasPoints(track.automation?.volume))) set(strip.volume.gain, track.volume, 0.015)
      if (!(this.running && hasPoints(track.automation?.pan))) set(strip.pan.pan, track.pan, 0.015)
      set(strip.gate.gain, audible ? 1 : 0, 0.01)
      if (track.kind === 'midi') this.syncInstrument(strip, track)
      this.syncEffects(strip, track)
    }

    // Sends, once every bus strip exists.
    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)!
      const wanted = new Map<Id, number>()
      if (track.kind !== 'bus') {
        for (const send of track.sends ?? []) {
          const isBus = project.tracks.some((t) => t.id === send.busId && t.kind === 'bus')
          if (isBus && send.level > 0) wanted.set(send.busId, send.level)
        }
      }
      for (const [busId, gain] of strip.sends) {
        if (wanted.has(busId)) continue
        gain.disconnect()
        strip.sends.delete(busId)
      }
      for (const [busId, level] of wanted) {
        let gain = strip.sends.get(busId)
        if (!gain) {
          gain = this.ctx.createGain()
          gain.gain.value = level
          strip.gate.connect(gain)
          gain.connect(this.strips.get(busId)!.input)
          strip.sends.set(busId, gain)
        }
        set(gain.gain, level, 0.015)
      }
    }

    const ids = new Set(project.tracks.map((t) => t.id))
    for (const [id, strip] of this.strips) {
      if (ids.has(id)) continue
      strip.instrument?.node.disconnect()
      strip.effects?.node.disconnect()
      strip.input.disconnect()
      strip.gate.disconnect()
      for (const gain of strip.sends.values()) gain.disconnect()
      this.strips.delete(id)
    }
  }

  private createStrip(): Strip {
    const ctx = this.ctx
    const strip: Strip = {
      input: ctx.createGain(),
      volume: ctx.createGain(),
      pan: ctx.createStereoPanner(),
      gate: ctx.createGain(),
      meter: this.options.meters ? new MeterNode(ctx) : null,
      instrument: null,
      configured: [],
      sample: null,
      effects: null,
      effectsSeen: undefined,
      sends: new Map()
    }
    strip.input.connect(strip.volume)
    strip.volume.connect(strip.pan)
    strip.pan.connect(strip.gate)
    strip.gate.connect(this.master)
    if (strip.meter) strip.gate.connect(strip.meter.node)
    return strip
  }

  /** Creates the track's instrument, and passes on changed settings and its sample. */
  private syncInstrument(strip: Strip, track: Track): void {
    // A plugin or SoundFont instrument needs the native engine; here the track is silent.
    if (track.instrument === 'plugin' || track.instrument === 'soundfont') {
      strip.instrument?.node.disconnect()
      strip.instrument = null
      return
    }
    const config = instrumentConfig(track)
    const settings = [track.instrument, track.synth, track.sampler]
    const sampleId = config.sampler.sampleId
    const buffer = sampleId ? this.buffers.get(sampleId) : undefined
    const sample = sampleId && buffer ? sampleData(sampleId, buffer) : null

    if (!strip.instrument) {
      strip.instrument = new InstrumentNode(this.ctx, {
        config,
        samples: sample ? [sample] : [],
        notes: this.options.notes?.get(track.id) ?? []
      })
      strip.instrument.node.connect(strip.input)
      strip.configured = settings
      strip.sample = sample?.id ?? null
      return
    }
    if (settings.some((value, i) => value !== strip.configured[i])) {
      strip.instrument.configure(config)
      strip.configured = settings
    }
    if (sample && strip.sample !== sample.id) {
      strip.instrument.loadSample(sample)
      strip.sample = sample.id
    }
  }

  /** Inserts, updates or removes the effects worklet between the strip's input and its fader. */
  private syncEffects(strip: Strip, track: Track): void {
    // Plugins need the native engine; here they are passed over.
    const active = (track.effects ?? []).filter((e) => !e.bypass && e.type !== 'plugin')
    if (!active.length) {
      if (strip.effects) {
        strip.input.disconnect()
        strip.effects.node.disconnect()
        strip.effects = null
        strip.input.connect(strip.volume)
      }
    } else if (!strip.effects) {
      strip.effects = new EffectsNode(this.ctx, effectConfigs(active))
      strip.input.disconnect()
      strip.input.connect(strip.effects.node)
      strip.effects.node.connect(strip.volume)
    } else if (strip.effectsSeen !== track.effects) {
      strip.effects.setChain(effectConfigs(active))
    }
    strip.effectsSeen = track.effects
  }

  // ── Scheduling ─────────────────────────────────────────────────────────

  /** Schedules events in the tick range [from, to), where `from` sounds at `time`. */
  scheduleSegment(project: Project, from: number, to: number, time: number, state: ScheduleState): void {
    const map = timeMap(project)
    const at = (tick: number): number => time + map.duration(from, tick)

    // In an offline render the instruments already hold their notes.
    if (!this.options.notes) {
      eachNote(project, map, from, to, (track, pitch, velocity, tick, duration) => {
        this.strips.get(track.id)?.instrument?.note({ id: newNoteId(), pitch, velocity, time: at(tick), duration })
      })
    }

    for (const track of project.tracks) {
      const strip = this.strips.get(track.id)
      if (!strip) continue
      this.scheduleAutomation(strip.volume.gain, track.automation?.volume, from, to, at)
      this.scheduleAutomation(strip.pan.pan, track.automation?.pan, from, to, at)

      for (const clip of track.clips) {
        if (clip.kind !== 'audio' || state.clips.has(clip.id)) continue
        if (clip.start >= to || clip.start + clip.length <= from) continue
        const startTick = Math.max(clip.start, from)
        const playing = this.startClip(strip, clip, map, startTick, at(startTick))
        if (playing) state.clips.set(clip.id, playing)
      }
    }
    for (const playing of state.clips.values()) playing.pump?.()

    if (state.metronome) {
      // One click per beat of the time signature in force, accented on the bar line.
      for (let bar = map.barAt(from); bar.start < to; bar = map.barAt(bar.start + bar.length)) {
        for (let beat = 0; beat < bar.beats; beat++) {
          const tick = bar.start + beat * bar.beatTicks
          if (tick >= from && tick < to) this.click(at(tick), beat === 0)
        }
      }
    }
  }

  /** Silences every note the sequencer has started or queued. */
  stopNotes(): void {
    for (const strip of this.strips.values()) strip.instrument?.stop()
  }

  /** Writes one segment of an automation curve onto a parameter. */
  private scheduleAutomation(
    param: AudioParam,
    points: AutomationPoint[] | undefined,
    from: number,
    to: number,
    at: (tick: number) => number
  ): void {
    if (!hasPoints(points)) return
    param.setValueAtTime(automationValue(points, from), at(from))
    for (const point of points) {
      if (point.tick > from && point.tick < to) param.linearRampToValueAtTime(point.value, at(point.tick))
    }
    param.linearRampToValueAtTime(automationValue(points, to), at(to))
  }

  /** Starts an audio clip from `startTick` (inside the clip) at audio time `when`. */
  private startClip(strip: Strip, clip: AudioClip, map: TimeMap, startTick: number, when: number): PlayingClip | null {
    const original = this.buffers.get(clip.assetId)
    const stream = this.options.streams.get(clip.assetId)
    if (!original && !stream) return null
    const sourceSeconds = original ? original.duration : stream!.frames / stream!.sampleRate
    // A stretched or repitched clip plays from a prepared copy; until that is ready the clip stays silent.
    const { stretch, rate, ratio, key } = clipStretch(clip)
    const buffer = ratio === 1 ? original : this.options.stretched.get(key)
    if (!buffer && (ratio !== 1 || !stream)) return null
    const into = map.duration(clip.start, startTick)
    const duration = map.duration(clip.start, clip.start + clip.length)
    // Position in the original file, in seconds.
    const position = clip.offset + into / stretch
    if (position >= sourceSeconds) return null

    const gain = this.ctx.createGain()
    gain.connect(strip.input)

    // Clip gain with linear fades at either end.
    const level = clip.gain ?? 1
    const fadeIn = Math.min(clip.fadeIn ?? 0, duration)
    const fadeOut = Math.min(clip.fadeOut ?? 0, duration - fadeIn)
    const clipStart = when - into
    const clipEnd = clipStart + duration
    const levelAt = (t: number): number =>
      level * Math.min(1, fadeIn > 0 ? t / fadeIn : 1, fadeOut > 0 ? (duration - t) / fadeOut : 1)
    gain.gain.setValueAtTime(levelAt(into), when)
    if (fadeIn > into) gain.gain.linearRampToValueAtTime(level, clipStart + fadeIn)
    if (fadeOut > 0) {
      const fadeStart = Math.max(when, clipEnd - fadeOut)
      gain.gain.setValueAtTime(levelAt(fadeStart - clipStart), fadeStart)
      gain.gain.linearRampToValueAtTime(0, clipEnd)
    }

    if (!buffer) {
      // Straight from disk, a piece at a time.
      const player = new StreamPlayer(this.ctx, stream!, gain, when, position, Math.min(duration - into, sourceSeconds - position))
      return { clip, stop: (time) => player.stop(time), pump: () => player.pump() }
    }
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(gain)
    source.onended = () => gain.disconnect()
    // Offset and length are measured in the buffer's own time, before the playback rate is applied.
    source.playbackRate.value = rate
    source.start(when, position * ratio, (duration - into) * rate)
    return { clip, stop: (time) => source.stop(time) }
  }

  private click(time: number, accent: boolean): void {
    const osc = this.ctx.createOscillator()
    const env = this.ctx.createGain()
    osc.frequency.value = accent ? 1760 : 1175
    env.gain.setValueAtTime(accent ? 0.3 : 0.18, time)
    env.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
    osc.connect(env)
    env.connect(this.master)
    osc.start(time)
    osc.stop(time + 0.06)
    osc.onended = () => env.disconnect()
  }
}
