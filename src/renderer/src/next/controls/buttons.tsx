/** What a lit toggle means, which decides its colour. */
export type Tone = 'accent' | 'ok' | 'warn' | 'danger'

/** A button that stays on or off: mute, solo, loop. */
export function Toggle(props: {
  pressed: boolean
  onChange: (pressed: boolean) => void
  /** What it does, for the tooltip and a screen reader. */
  label: string
  tone?: Tone
  size?: 'sm' | 'md'
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`tg tg-${props.size ?? 'md'} tone-${props.tone ?? 'accent'} ${props.pressed ? 'on' : ''}`}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.pressed)}
    >
      {props.children}
    </button>
  )
}

/** A button that is only an icon; `label` says what it does. */
export function IconButton(props: {
  label: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  size?: 'sm' | 'md'
  disabled?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className={`icon-btn tg-${props.size ?? 'md'}`} title={props.label} aria-label={props.label} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

/** An ordinary button with words on it. `primary` is the one a panel most wants pressed; `danger` destroys something. */
export function Button(props: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  kind?: 'plain' | 'primary' | 'danger'
  disabled?: boolean
  title?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button type="button" className={`btn btn-${props.kind ?? 'plain'}`} title={props.title} disabled={props.disabled} onClick={props.onClick}>
      {props.children}
    </button>
  )
}

/** A row of choices of which exactly one is on. */
export function Segmented<T extends string>(props: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
}): React.JSX.Element {
  return (
    <div className="seg" role="radiogroup" aria-label={props.label}>
      {props.options.map(([value, label]) => (
        <button key={value} type="button" role="radio" aria-checked={props.value === value} className={props.value === value ? 'on' : ''} onClick={() => props.onChange(value)}>
          {label}
        </button>
      ))}
    </div>
  )
}
