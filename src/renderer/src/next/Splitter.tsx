/**
 * The line between two panels: drag it to resize, double-click to put the
 * size back, or focus it and use the arrow keys.
 */
export function Splitter(props: {
  /** `vertical` is a vertical line between side-by-side panels. */
  orientation: 'vertical' | 'horizontal'
  label: string
  value: number
  min: number
  max: number
  reset: number
  /** Which way the panel grows: +1 if dragging right/down enlarges it, -1 if left/up does. */
  direction: 1 | -1
  onChange: (value: number) => void
}): React.JSX.Element {
  const clamp = (value: number): number => Math.round(Math.min(props.max, Math.max(props.min, value)))
  const vertical = props.orientation === 'vertical'

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = event.currentTarget
    const origin = vertical ? event.clientX : event.clientY
    const start = props.value
    el.setPointerCapture(event.pointerId)
    el.classList.add('dragging')
    const move = (e: PointerEvent): void => props.onChange(clamp(start + ((vertical ? e.clientX : e.clientY) - origin) * props.direction))
    const up = (): void => {
      el.classList.remove('dragging')
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const grow = vertical ? 'ArrowRight' : 'ArrowDown'
    const shrink = vertical ? 'ArrowLeft' : 'ArrowUp'
    if (event.key !== grow && event.key !== shrink) return
    event.preventDefault()
    event.stopPropagation()
    props.onChange(clamp(props.value + (event.key === grow ? 16 : -16) * props.direction))
  }

  return (
    <div
      className={`splitter ${props.orientation}`}
      role="separator"
      tabIndex={0}
      aria-label={props.label}
      aria-orientation={props.orientation}
      aria-valuenow={props.value}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      title={`${props.label}: drag to resize, double-click to reset`}
      onPointerDown={onPointerDown}
      onDoubleClick={() => props.onChange(clamp(props.reset))}
      onKeyDown={onKeyDown}
    />
  )
}
