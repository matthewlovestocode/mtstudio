import { Knob } from './Knob'
import type { ValueProps } from './value'

/** A knob with its name under it and its value under that: the unit most parameters are shown in. */
export function Dial(props: ValueProps & { bipolar?: boolean; size?: number; /** The name shown, when shorter than `label`. */ caption?: string }): React.JSX.Element {
  return (
    <div className={`dial ${props.disabled ? 'disabled' : ''}`}>
      <Knob {...props} />
      <span className="dial-name">{props.caption ?? props.label}</span>
      {props.text !== undefined && <output>{props.text}</output>}
    </div>
  )
}
