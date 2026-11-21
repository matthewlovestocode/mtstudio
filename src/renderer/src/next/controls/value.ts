import { useRef } from 'react'

/** How a control's travel (0 at the bottom, 1 at the top) maps onto its value. */
export interface Curve {
  toPosition: (value: number) => number
  toValue: (position: number) => number
}

/** What every control that sets a number takes: knobs and faders alike. */
export interface ValueProps {
  label: string
  value: number
  min: number
  max: number
  /** How far an arrow key moves the value. A hundredth of the range when absent. */
  step?: number
  /** Round the value to a multiple of this. */
  snap?: number
  /** The value a double-click restores. */
  reset?: number
  /** A straight line from `min` to `max` when absent. */
  curve?: Curve
  /** The value in words, for a screen reader and the tooltip: "-6.0 dB". */
  text?: string
  disabled?: boolean
  onChange: (value: number) => void
  /** The end of a drag or a run of key presses: one undo step. */
  onEnd?: () => void
}

/** Equal travel per octave: for frequencies and times, where each doubling should feel the same. */
export function logCurve(min: number, max: number): Curve {
  const span = Math.log(max / min)
  return { toPosition: (value) => Math.log(Math.max(value, min) / min) / span, toValue: (position) => min * Math.exp(position * span) }
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function curveOf(props: ValueProps): Curve {
  const { min, max } = props
  return props.curve ?? { toPosition: (value) => (value - min) / (max - min), toValue: (position) => min + position * (max - min) }
}

const KEY_STEPS: Record<string, number> = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }

/**
 * The behaviour knobs and faders share. Drag up and down to change the value
 * (hold Shift for a tenth of the speed), double-click to reset, or focus and
 * use the arrow keys, Page Up/Down, Home and End. `travel` is the distance in
 * pixels a drag covers from one end of the range to the other.
 *
 * Listeners go on the element itself, with the pointer captured, so it works
 * the same in a panel's own window.
 */
export function useValueControl(props: ValueProps, travel: () => number): { position: number; bind: React.HTMLAttributes<HTMLElement> } {
  const latest = useRef(props)
  latest.current = props

  const set = (value: number): void => {
    const { min, max, snap, onChange } = latest.current
    const snapped = snap ? Math.round(value / snap) * snap : value
    // Rounded so that snapping to 0.05 gives 0.15 and not 0.15000000000000002.
    const next = Math.min(max, Math.max(min, Number(snapped.toFixed(6))))
    if (next !== latest.current.value) onChange(next)
  }

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (latest.current.disabled || event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget
    el.focus()
    el.setPointerCapture(event.pointerId)
    el.classList.add('dragging')
    // Kept here rather than read back from the value, so snapping does not make the drag sticky.
    let position = clamp01(curveOf(latest.current).toPosition(latest.current.value))
    let lastY = event.clientY
    const move = (e: PointerEvent): void => {
      const delta = (lastY - e.clientY) / Math.max(1, travel())
      lastY = e.clientY
      position = clamp01(position + delta * (e.shiftKey ? 0.1 : 1))
      set(curveOf(latest.current).toValue(position))
    }
    const up = (): void => {
      el.classList.remove('dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      latest.current.onEnd?.()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const { min, max, value, disabled } = latest.current
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return
    const step = latest.current.step ?? latest.current.snap ?? (max - min) / 100
    if (event.key in KEY_STEPS) set(value + KEY_STEPS[event.key] * step)
    else if (event.key === 'Home') set(min)
    else if (event.key === 'End') set(max)
    else return
    // Handled here: the arrow keys must not also reach the app's own shortcuts.
    event.preventDefault()
    event.stopPropagation()
  }

  const onKeyUp = (event: React.KeyboardEvent): void => {
    if (event.key in KEY_STEPS || event.key === 'Home' || event.key === 'End') latest.current.onEnd?.()
  }

  const onDoubleClick = (): void => {
    const { reset, disabled, onEnd } = latest.current
    if (disabled || reset === undefined) return
    set(reset)
    onEnd?.()
  }

  return {
    position: clamp01(curveOf(props).toPosition(props.value)),
    bind: {
      role: 'slider',
      tabIndex: props.disabled ? -1 : 0,
      title: props.text ? `${props.label}: ${props.text}` : props.label,
      'aria-label': props.label,
      'aria-valuemin': props.min,
      'aria-valuemax': props.max,
      'aria-valuenow': props.value,
      'aria-valuetext': props.text,
      'aria-disabled': props.disabled || undefined,
      onPointerDown,
      onKeyDown,
      onKeyUp,
      onDoubleClick
    }
  }
}
