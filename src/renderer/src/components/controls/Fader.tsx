import { useRef } from 'react'
import { useValueControl, type ValueProps } from './value'

const CAP_HEIGHT = 22

/**
 * A vertical fader. The cap follows the pointer one for one from wherever the
 * drag starts; clicking the track does not jump it, so a stray click cannot
 * throw a level. `ticks` are values to mark and name beside the track.
 */
export function Fader(props: ValueProps & { ticks?: { value: number; label: string }[] }): React.JSX.Element {
  const track = useRef<HTMLDivElement>(null)
  const { position, bind } = useValueControl(props, () => (track.current?.clientHeight ?? 120) - CAP_HEIGHT)
  const place = (at: number): string => `calc(${at} * (100% - ${CAP_HEIGHT}px) + ${CAP_HEIGHT / 2}px)`
  const curve = props.curve
  return (
    <div className={`fader ${props.disabled ? 'disabled' : ''}`}>
      {props.ticks && (
        <div className="fader-ticks" aria-hidden>
          {props.ticks.map((tick) => (
            <span key={tick.label} style={{ bottom: place(curve ? curve.toPosition(tick.value) : (tick.value - props.min) / (props.max - props.min)) }}>
              {tick.label}
            </span>
          ))}
        </div>
      )}
      <div {...bind} className="fader-track" ref={track}>
        <div className="fader-slot" />
        <div className="fader-cap" style={{ bottom: `calc(${position} * (100% - ${CAP_HEIGHT}px))`, height: CAP_HEIGHT }} />
      </div>
    </div>
  )
}
