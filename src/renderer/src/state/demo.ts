import { makeEffect } from '@shared/effects'
import { DEFAULT_SYNTH, newId, PPQ, TRACK_COLORS, type Note, type Project, type Track } from '@shared/model'

const EIGHTH = PPQ / 2
const BAR = PPQ * 4

function note(startEighths: number, pitch: number, lengthEighths: number, velocity = 0.8): Note {
  return { id: newId(), pitch, start: startEighths * EIGHTH, length: lengthEighths * EIGHTH - 20, velocity }
}

export function emptyProject(): Project {
  return {
    version: 1,
    name: 'Untitled',
    bpm: 120,
    beatsPerBar: 4,
    loop: { enabled: false, start: 0, end: BAR * 4 },
    tracks: [],
    assets: {}
  }
}

/** A four-bar sketch so a fresh window makes sound straight away. */
export function demoProject(): Project {
  // Am – F – C – G
  const roots = [45, 41, 48, 43]
  const chords = [
    [57, 60, 64],
    [53, 57, 60],
    [55, 60, 64],
    [55, 59, 62]
  ]
  const melody: [number, number, number][] = [
    [0, 76, 2], [2, 72, 1], [3, 69, 3], [6, 72, 2],
    [8, 77, 2], [10, 72, 1], [11, 69, 3], [14, 72, 2],
    [16, 79, 2], [18, 76, 1], [19, 72, 3], [22, 76, 2],
    [24, 74, 3], [27, 71, 2], [29, 67, 3]
  ]

  const reverb: Track = {
    id: newId(),
    name: 'Reverb',
    kind: 'bus',
    color: TRACK_COLORS[5],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    effects: [makeEffect('reverb', { mix: 1, decay: 2.2 })],
    clips: []
  }

  // General MIDI drum notes from C1: kick 36, snare 38, closed hat 42, open hat 46.
  const drums: Track = {
    id: newId(),
    name: 'Drums',
    kind: 'midi',
    instrument: 'drums',
    color: TRACK_COLORS[4],
    volume: 0.85,
    pan: 0,
    mute: false,
    solo: false,
    synth: { ...DEFAULT_SYNTH },
    sends: [{ busId: reverb.id, level: 0.08 }],
    clips: [
      {
        id: newId(),
        kind: 'midi',
        name: 'Beat',
        start: 0,
        length: BAR * 4,
        notes: [0, 1, 2, 3].flatMap((bar) => [
          ...[0, 3, 4].map((i) => note(bar * 8 + i, 36, 1, 0.95)),
          ...[2, 6].map((i) => note(bar * 8 + i, 38, 1, 0.85)),
          ...[0, 1, 2, 3, 4, 5, 6].map((i) => note(bar * 8 + i, 42, 1, i % 2 ? 0.45 : 0.7)),
          note(bar * 8 + 7, 46, 1, 0.6)
        ])
      }
    ]
  }

  const bass: Track = {
    id: newId(),
    name: 'Bass',
    kind: 'midi',
    color: TRACK_COLORS[0],
    volume: 0.9,
    pan: 0,
    mute: false,
    solo: false,
    synth: { ...DEFAULT_SYNTH, wave: 'sawtooth', cutoff: 600, resonance: 4, release: 0.08 },
    clips: [
      {
        id: newId(),
        kind: 'midi',
        name: 'Bass line',
        start: 0,
        length: BAR * 4,
        notes: roots.flatMap((root, bar) =>
          [0, 1, 2, 3, 4, 5, 6, 7].map((i) => note(bar * 8 + i, i === 6 ? root + 12 : root, 1, i % 2 ? 0.6 : 0.9))
        )
      }
    ]
  }

  const keys: Track = {
    id: newId(),
    name: 'Keys',
    kind: 'midi',
    color: TRACK_COLORS[1],
    volume: 0.7,
    pan: -0.2,
    mute: false,
    solo: false,
    synth: { ...DEFAULT_SYNTH, wave: 'triangle', attack: 0.03, sustain: 0.8, release: 0.5, cutoff: 3000 },
    sends: [{ busId: reverb.id, level: 0.3 }],
    clips: [
      {
        id: newId(),
        kind: 'midi',
        name: 'Chords',
        start: 0,
        length: BAR * 4,
        notes: chords.flatMap((chord, bar) => chord.map((pitch) => note(bar * 8, pitch, 8, 0.6)))
      }
    ]
  }

  const lead: Track = {
    id: newId(),
    name: 'Lead',
    kind: 'midi',
    color: TRACK_COLORS[2],
    volume: 0.6,
    pan: 0.2,
    mute: false,
    solo: false,
    synth: { ...DEFAULT_SYNTH, wave: 'square', cutoff: 1800, resonance: 2, release: 0.25 },
    effects: [makeEffect('delay', { time: 60 / 110 / 2, feedback: 0.3, mix: 0.2 })],
    sends: [{ busId: reverb.id, level: 0.35 }],
    clips: [
      {
        id: newId(),
        kind: 'midi',
        name: 'Melody',
        start: 0,
        length: BAR * 4,
        notes: melody.map(([start, pitch, length]) => note(start, pitch, length))
      }
    ]
  }

  const audio: Track = {
    id: newId(),
    name: 'Audio 1',
    kind: 'audio',
    color: TRACK_COLORS[3],
    volume: 1,
    pan: 0,
    mute: false,
    solo: false,
    clips: []
  }

  return {
    ...emptyProject(),
    name: 'Demo',
    bpm: 110,
    loop: { enabled: true, start: 0, end: BAR * 4 },
    tracks: [drums, bass, keys, lead, audio, reverb]
  }
}
