import { PPQ, type Id, type Project } from './model'

interface TempoSegment {
  /** Null for the project's starting tempo. */
  id: Id | null
  tick: number
  bpm: number
  /** Time at which the segment starts. */
  seconds: number
}

export interface MeterSegment {
  /** Null for the project's starting time signature. */
  id: Id | null
  /** Index of the segment's first bar. */
  bar: number
  tick: number
  numerator: number
  denominator: number
  barTicks: number
  beatTicks: number
}

export interface Bar {
  /** 0-based. */
  index: number
  start: number
  length: number
  beatTicks: number
  beats: number
}

/**
 * Converts between musical time (ticks, bars) and clock time (seconds) for a
 * project whose tempo and time signature change along the way. Tempo changes
 * are steps: each tempo holds until the next change.
 */
export class TimeMap {
  readonly tempos: TempoSegment[]
  readonly meters: MeterSegment[]

  constructor(project: Project) {
    this.tempos = [{ id: null, tick: 0, bpm: project.bpm, seconds: 0 }]
    const changes = [...(project.tempoChanges ?? [])].filter((c) => c.tick > 0).sort((a, b) => a.tick - b.tick)
    for (const change of changes) {
      const last = this.tempos[this.tempos.length - 1]
      const seconds = last.seconds + ((change.tick - last.tick) / PPQ) * (60 / last.bpm)
      // Two changes on the same tick: the later one wins.
      if (change.tick === last.tick) this.tempos.pop()
      this.tempos.push({ id: change.id, tick: change.tick, bpm: change.bpm, seconds })
    }

    const meter = (id: Id | null, bar: number, tick: number, numerator: number, denominator: number): MeterSegment => {
      const beatTicks = (PPQ * 4) / denominator
      return { id, bar, tick, numerator, denominator, beatTicks, barTicks: numerator * beatTicks }
    }
    this.meters = [meter(null, 0, 0, project.beatsPerBar, project.beatUnit ?? 4)]
    const meterChanges = [...(project.meterChanges ?? [])].filter((c) => c.bar > 0).sort((a, b) => a.bar - b.bar)
    for (const change of meterChanges) {
      const last = this.meters[this.meters.length - 1]
      if (change.bar === last.bar) {
        // Two changes on the same bar: the later one wins.
        this.meters[this.meters.length - 1] = meter(change.id, last.bar, last.tick, change.numerator, change.denominator)
      } else {
        const tick = last.tick + (change.bar - last.bar) * last.barTicks
        this.meters.push(meter(change.id, change.bar, tick, change.numerator, change.denominator))
      }
    }
  }

  // ── Tempo ──────────────────────────────────────────────────────────────

  /** The tempo segment in effect at a tick. */
  tempoAt(tick: number): TempoSegment {
    let segment = this.tempos[0]
    for (const candidate of this.tempos) {
      if (candidate.tick > tick) break
      segment = candidate
    }
    return segment
  }

  tickToSeconds(tick: number): number {
    const segment = this.tempoAt(tick)
    return segment.seconds + ((tick - segment.tick) / PPQ) * (60 / segment.bpm)
  }

  secondsToTick(seconds: number): number {
    let segment = this.tempos[0]
    for (const candidate of this.tempos) {
      if (candidate.seconds > seconds) break
      segment = candidate
    }
    return segment.tick + (seconds - segment.seconds) * (segment.bpm / 60) * PPQ
  }

  /** Seconds between two ticks (negative if `to` is earlier). */
  duration(from: number, to: number): number {
    return this.tickToSeconds(to) - this.tickToSeconds(from)
  }

  /** How many ticks pass in `seconds` starting from `tick`. */
  ticksAfter(tick: number, seconds: number): number {
    return this.secondsToTick(this.tickToSeconds(tick) + seconds) - tick
  }

  // ── Bars ───────────────────────────────────────────────────────────────

  meterAt(tick: number): MeterSegment {
    let segment = this.meters[0]
    for (const candidate of this.meters) {
      if (candidate.tick > tick) break
      segment = candidate
    }
    return segment
  }

  /** The bar containing a tick. */
  barAt(tick: number): Bar {
    const meter = this.meterAt(Math.max(0, tick))
    const index = meter.bar + Math.floor((Math.max(0, tick) - meter.tick) / meter.barTicks)
    return this.bar(meter, index)
  }

  /** Tick at which a bar (0-based) starts. */
  barStart(index: number): number {
    let meter = this.meters[0]
    for (const candidate of this.meters) {
      if (candidate.bar > index) break
      meter = candidate
    }
    return meter.tick + (index - meter.bar) * meter.barTicks
  }

  /** Every bar that starts before `until`. */
  barsUntil(until: number): Bar[] {
    const bars: Bar[] = []
    for (let bar = this.barAt(0); bar.start < until; bar = this.barAt(bar.start + bar.length)) bars.push(bar)
    return bars
  }

  private bar(meter: MeterSegment, index: number): Bar {
    return {
      index,
      start: meter.tick + (index - meter.bar) * meter.barTicks,
      length: meter.barTicks,
      beatTicks: meter.beatTicks,
      beats: meter.numerator
    }
  }
}

const cache = new WeakMap<Project, TimeMap>()

/** The time map for a project. Projects are immutable, so each one's map is built once. */
export function timeMap(project: Project): TimeMap {
  let map = cache.get(project)
  if (!map) {
    map = new TimeMap(project)
    cache.set(project, map)
  }
  return map
}

/** True if two projects keep the same time: same tempo at every tick. */
export function sameTempo(a: Project, b: Project): boolean {
  return a.bpm === b.bpm && a.tempoChanges === b.tempoChanges
}
