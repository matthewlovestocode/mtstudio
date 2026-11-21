import { useValueControl, type ValueProps } from './value'

// The dial sweeps three quarters of a turn, from lower left round to lower right.
const START = 135
const SWEEP = 270

function point(centre: number, radius: number, degrees: number): string {
  const radians = (degrees * Math.PI) / 180
  return `${(centre + radius * Math.cos(radians)).toFixed(2)} ${(centre + radius * Math.sin(radians)).toFixed(2)}`
}

function arc(centre: number, radius: number, from: number, to: number): string {
  const [a, b] = from <= to ? [from, to] : [to, from]
  return `M ${point(centre, radius, a)} A ${radius} ${radius} 0 ${b - a > 180 ? 1 : 0} 1 ${point(centre, radius, b)}`
}

/**
 * A rotary control. The lit arc runs from the low end up to the value, or,
 * for a `bipolar` knob such as pan, from the middle out to it.
 */
export function Knob(props: ValueProps & { size?: number; bipolar?: boolean }): React.JSX.Element {
  const { size = 28, bipolar = false } = props
  // A full sweep takes a drag of 160 pixels whatever the knob's size.
  const { position, bind } = useValueControl(props, () => 160)
  const centre = size / 2
  const radius = centre - 2.5
  const angle = START + position * SWEEP
  const from = bipolar ? START + SWEEP / 2 : START
  return (
    <div {...bind} className={`knob ${props.disabled ? 'disabled' : ''}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
        <path className="knob-track" d={arc(centre, radius, START, START + SWEEP)} />
        {Math.abs(angle - from) > 0.5 && <path className="knob-value" d={arc(centre, radius, from, angle)} />}
        <circle className="knob-cap" cx={centre} cy={centre} r={radius - 3.5} />
        <path className="knob-pointer" d={`M ${point(centre, radius - 8, angle)} L ${point(centre, radius - 4, angle)}`} />
      </svg>
    </div>
  )
}
