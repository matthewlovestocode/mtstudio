import { useEffect, useMemo, useRef, useState } from 'react'
import { Caret, Popover, type Origin } from './Popover'

export interface PickerOption<T> {
  value: T
  label: string
  /** A quieter second piece of text: a plugin's maker, say. Searched too. */
  detail?: string
}

export interface PickerGroup<T> {
  label?: string
  options: PickerOption<T>[]
}

/**
 * A button that opens a list to choose from, with a box to type in that
 * narrows it. For lists too long for a plain menu: effects, instruments,
 * plugins. Arrow keys move, Enter chooses.
 */
export function Picker<T>(props: {
  /** What the button says. */
  label: string
  title?: string
  groups: PickerGroup<T>[]
  onPick: (value: T) => void
  /** The words in the empty search box. */
  placeholder?: string
  /** Commands under the list, such as "Look for plugins…". */
  actions?: { label: string; onSelect: () => void; disabled?: boolean }[]
  wide?: boolean
}): React.JSX.Element {
  const [origin, setOrigin] = useState<Origin | null>(null)
  const close = (): void => setOrigin(null)
  return (
    <>
      <button
        type="button"
        className={`btn btn-plain btn-menu ${props.wide ? 'wide' : ''} ${origin ? 'open' : ''}`}
        title={props.title}
        aria-haspopup="listbox"
        aria-expanded={!!origin}
        onClick={(e) => setOrigin(origin ? null : { el: e.currentTarget })}
      >
        <span className="btn-text">{props.label}</span>
        <Caret />
      </button>
      {origin && <PickerList {...props} origin={origin} onClose={close} />}
    </>
  )
}

function PickerList<T>(props: {
  origin: Origin
  groups: PickerGroup<T>[]
  onPick: (value: T) => void
  onClose: () => void
  placeholder?: string
  actions?: { label: string; onSelect: () => void; disabled?: boolean }[]
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])

  // Every word typed must be found somewhere in the option's label, detail or group.
  const groups = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return props.groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => {
          const text = `${option.label} ${option.detail ?? ''} ${group.label ?? ''}`.toLowerCase()
          return words.every((word) => text.includes(word))
        })
      }))
      .filter((group) => group.options.length)
  }, [props.groups, query])
  const flat = groups.flatMap((group) => group.options)
  const at = Math.min(active, flat.length - 1)

  useEffect(() => {
    list.current?.querySelector('.picker-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [at, query])

  const pick = (option: PickerOption<T> | undefined): void => {
    if (!option) return
    props.onClose()
    props.onPick(option.value)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Nothing typed here is a shortcut for the app behind it.
    event.stopPropagation()
    if (event.key === 'ArrowDown') setActive(Math.min(flat.length - 1, at + 1))
    else if (event.key === 'ArrowUp') setActive(Math.max(0, at - 1))
    else if (event.key === 'Enter') pick(flat[at])
    else return
    event.preventDefault()
  }

  let index = -1
  return (
    <Popover origin={props.origin} onClose={props.onClose} className="picker">
      <div onKeyDown={onKeyDown} onKeyUp={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="picker-search"
          aria-label={props.placeholder ?? 'Search'}
          placeholder={props.placeholder ?? 'Search'}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
        />
        <div className="picker-list" role="listbox" ref={list}>
          {groups.map((group, g) => (
            <div key={group.label ?? g} role="group" aria-label={group.label}>
              {group.label && <div className="menu-head">{group.label}</div>}
              {group.options.map((option) => {
                index += 1
                const mine = index
                return (
                  <button
                    key={mine}
                    type="button"
                    role="option"
                    aria-selected={mine === at}
                    tabIndex={-1}
                    className={`picker-row ${mine === at ? 'active' : ''}`}
                    onPointerMove={() => mine !== at && setActive(mine)}
                    onClick={() => pick(option)}
                  >
                    <span className="menu-label">{option.label}</span>
                    {option.detail && <span className="menu-keys">{option.detail}</span>}
                  </button>
                )
              })}
            </div>
          ))}
          {flat.length === 0 && <div className="picker-none">Nothing matches “{query}”.</div>}
        </div>
        {props.actions && props.actions.length > 0 && (
          <div className="picker-actions">
            {props.actions.map((action) => (
              <button
                key={action.label}
                type="button"
                className="menu-row"
                disabled={action.disabled}
                onClick={() => {
                  props.onClose()
                  action.onSelect()
                }}
              >
                <span className="menu-label">{action.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Popover>
  )
}
