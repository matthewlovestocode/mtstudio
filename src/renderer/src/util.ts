import { useEffect, useRef } from 'react'
import type { Project } from '@shared/model'
import { timeMap } from '@shared/timemap'
import { useStudio } from './state/store'

/** Runs `callback` on every animation frame while mounted. */
export function useFrame(callback: () => void): void {
  const ref = useRef(callback)
  ref.current = callback
  useEffect(() => {
    let id = requestAnimationFrame(function loop() {
      ref.current()
      id = requestAnimationFrame(loop)
    })
    return () => cancelAnimationFrame(id)
  }, [])
}

/**
 * Tracks a pointer drag from a pointerdown event. `onMove` receives the
 * distance travelled since the drag began. Ends the undo gesture on release.
 */
export function startDrag(
  event: React.PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd?: (moved: boolean) => void
): void {
  if (event.button !== 0) return
  event.preventDefault()
  const startX = event.clientX
  const startY = event.clientY
  let moved = false
  const move = (e: PointerEvent): void => {
    const dx = e.clientX - startX
    const dy = e.clientY - startY
    if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
    moved = true
    onMove(dx, dy)
  }
  // The window the drag began in, which for a panel in a window of its own is not this one.
  const view = (event.currentTarget as Element).ownerDocument.defaultView ?? window
  const up = (): void => {
    view.removeEventListener('pointermove', move)
    view.removeEventListener('pointerup', up)
    useStudio.getState().endGesture()
    onEnd?.(moved)
  }
  view.addEventListener('pointermove', move)
  view.addEventListener('pointerup', up)
}

export function snapTo(tick: number, grid: number, mode: 'round' | 'floor' = 'round'): number {
  if (grid <= 0) return Math.round(tick)
  return (mode === 'floor' ? Math.floor(tick / grid) : Math.round(tick / grid)) * grid
}

/** "bar.beat.division", 1-based; the division is a quarter of a beat. */
export function formatBars(tick: number, project: Project): string {
  const bar = timeMap(project).barAt(tick)
  const inBar = Math.max(0, tick - bar.start)
  const beat = Math.floor(inBar / bar.beatTicks)
  const division = Math.floor((inBar - beat * bar.beatTicks) / (bar.beatTicks / 4))
  return `${bar.index + 1}.${beat + 1}.${division + 1}`
}

export function formatTime(tick: number, project: Project): string {
  const seconds = timeMap(project).tickToSeconds(Math.max(0, tick))
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${m}:${s.toFixed(2).padStart(5, '0')}`
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export function pitchName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

export function isBlackKey(pitch: number): boolean {
  return NOTE_NAMES[pitch % 12].includes('#')
}

/** True when a key press belongs to a text field rather than to the app's shortcuts. */
export function isTyping(target: EventTarget | null): boolean {
  // By tag name rather than `instanceof`: an element in another window (a panel
  // in a window of its own) is not an instance of this window's classes.
  const el = target as Partial<HTMLInputElement> | null
  if (typeof el?.tagName !== 'string') return false
  if (el.tagName === 'INPUT') return el.type !== 'range'
  return el.tagName === 'TEXTAREA' || el.tagName === 'SELECT'
}
