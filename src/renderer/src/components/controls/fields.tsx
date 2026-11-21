import { useEffect, useRef, useState } from 'react'
import type { Id } from '@shared/model'
import { engine } from '../../engine'
import { useFrame } from '../../util'

/** Peak meter with a fast attack and slow fall. */
export function Meter({ target }: { target: Id | 'master' }): React.JSX.Element {
  const fill = useRef<HTMLDivElement>(null)
  const shown = useRef(0)
  useFrame(() => {
    const peak = engine.getPeak(target)
    // Map -48 dB…0 dB onto 0…1.
    const level = peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 48) / 48)) : 0
    shown.current = Math.max(level, shown.current - 0.025)
    if (fill.current) fill.current.style.transform = `scaleX(${shown.current})`
  })
  return (
    <div className="meter">
      <div className="meter-fill" ref={fill} />
    </div>
  )
}

/** A number input that commits on Enter or blur rather than on every keystroke. */
export function NumberField(props: {
  value: number
  onCommit: (value: number) => void
  className?: string
  label: string
}): React.JSX.Element {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = (): void => {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && text.trim() !== '') props.onCommit(parsed)
    else setText(String(props.value))
  }
  return (
    <input
      className={props.className}
      aria-label={props.label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** A text input that commits on Enter or blur, and snaps back if the commit is not accepted. */
export function TextField(props: {
  value: string
  onCommit: (value: string) => void
  className?: string
  label: string
}): React.JSX.Element {
  const [text, setText] = useState(props.value)
  useEffect(() => setText(props.value), [props.value])
  return (
    <input
      className={props.className}
      aria-label={props.label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== props.value) props.onCommit(text)
        setText(props.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}
