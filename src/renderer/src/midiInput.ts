/** Live note input: hardware MIDI devices and the computer keyboard. */
import type { Id } from '@shared/model'
import { engine } from './engine'
import { captureNoteOff, captureNoteOn } from './recording'
import { useSyncExternalStore } from 'react'
import { useStudio } from './state/store'
import { isTyping } from './util'

/** Which track each sounding pitch was sent to, so its note-off goes to the same place. */
const held = new Map<number, Id>()

/** Notes go to the armed synth track, or failing that the selected one. */
function targetTrack(): Id | null {
  const { project, armedTrackId, selectedTrackId } = useStudio.getState()
  const isSynth = (id: Id | null): boolean => project.tracks.some((t) => t.id === id && t.kind === 'midi')
  return isSynth(armedTrackId) ? armedTrackId : isSynth(selectedTrackId) ? selectedTrackId : null
}

export function noteOn(pitch: number, velocity: number): void {
  const trackId = targetTrack()
  if (!trackId || pitch < 0 || pitch > 127) return
  noteOff(pitch)
  held.set(pitch, trackId)
  engine.noteOn(trackId, pitch, velocity)
  captureNoteOn(trackId, pitch, velocity)
}

export function noteOff(pitch: number): void {
  const trackId = held.get(pitch)
  if (!trackId) return
  held.delete(pitch)
  engine.noteOff(trackId, pitch)
  captureNoteOff(trackId, pitch)
}

// ── Hardware ─────────────────────────────────────────────────────────────

function onMidiMessage(event: MIDIMessageEvent): void {
  const [status, pitch, value] = event.data ?? []
  const command = status & 0xf0
  if (command === 0x90 && value > 0) noteOn(pitch, value / 127)
  else if (command === 0x80 || command === 0x90) noteOff(pitch)
}

async function initHardware(): Promise<void> {
  if (!navigator.requestMIDIAccess) return
  try {
    const access = await navigator.requestMIDIAccess()
    const attach = (): void => {
      for (const input of access.inputs.values()) input.onmidimessage = onMidiMessage
    }
    attach()
    access.onstatechange = attach
  } catch {
    // No MIDI access; the computer keyboard still works.
  }
}

// ── Computer keyboard ────────────────────────────────────────────────────

/** Two rows laid out like a piano: A = C, W = C#, S = D … K = C an octave up. */
const KEY_SEMITONES: Record<string, number> = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15
}
/** The octave the A key's C is in: 4 is middle C. */
let octave = 4
const octaveListeners = new Set<() => void>()

/**
 * Moves the typing keyboard to an octave (0 to 8). Z and X do this a step at
 * a time; the browser does it when an instrument is chosen, so that a bass
 * is played where a bass sounds and not up at middle C.
 */
export function setTypingOctave(next: number): void {
  const to = Math.min(8, Math.max(0, Math.round(next)))
  if (to === octave) return
  octave = to
  for (const listener of octaveListeners) listener()
}

/** The typing keyboard's octave, for showing. */
export function useTypingOctave(): number {
  return useSyncExternalStore(
    (listener) => {
      octaveListeners.add(listener)
      return () => octaveListeners.delete(listener)
    },
    () => octave
  )
}
const keyPitches = new Map<string, number>()

function initKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    if (!useStudio.getState().typingKeys || e.metaKey || e.ctrlKey || e.altKey || e.repeat || isTyping(e.target)) return
    const key = e.key.toLowerCase()
    if (key === 'z') setTypingOctave(octave - 1)
    else if (key === 'x') setTypingOctave(octave + 1)
    else if (key in KEY_SEMITONES && !keyPitches.has(key)) {
      const pitch = (octave + 1) * 12 + KEY_SEMITONES[key]
      keyPitches.set(key, pitch)
      noteOn(pitch, 0.8)
    }
  })
  window.addEventListener('keyup', (e) => {
    const key = e.key.toLowerCase()
    const pitch = keyPitches.get(key)
    if (pitch === undefined) return
    keyPitches.delete(key)
    noteOff(pitch)
  })
}

export function initMidiInput(): void {
  void initHardware()
  initKeyboard()
}
