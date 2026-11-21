import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Caret, Popover, type Origin } from './Popover'

export interface PickerOption<T> {
  value: T
  label: string
  /** A quieter second piece of text: a plugin's maker, say. Searched too. */
  detail?: string
  /** A heading within its group, shown over a run of options that share it when the group is on its own. Searched too. */
  sub?: string
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
  /**
   * For a long list in many groups: the groups are listed down the left, and
   * choosing one shows only what is in it. Left and Right step through them.
   */
  sections?: boolean
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

/** The group each sectioned picker was last left on, by its button's label, so it opens where it was. */
const lastSection = new Map<string, string | null>()

/** The most rows drawn at once. */
const MAX_ROWS = 300

/** The groups cut off after `limit` options in all. */
function cap<T>(groups: PickerGroup<T>[], limit: number): PickerGroup<T>[] {
  const out: PickerGroup<T>[] = []
  let left = limit
  for (const group of groups) {
    if (left <= 0) break
    out.push(group.options.length <= left ? group : { ...group, options: group.options.slice(0, left) })
    left -= group.options.length
  }
  return out
}

function PickerList<T>(props: {
  origin: Origin
  groups: PickerGroup<T>[]
  onPick: (value: T) => void
  onClose: () => void
  placeholder?: string
  actions?: { label: string; onSelect: () => void; disabled?: boolean }[]
  label: string
  sections?: boolean
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [chosen, setChosen] = useState<string | null>(() => lastSection.get(props.label) ?? null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])

  // Every word typed must be found somewhere in the option's label, detail or group.
  const found = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return props.groups
      .map((group) => ({
        ...group,
        options: group.options.filter((option) => {
          const text = `${option.label} ${option.detail ?? ''} ${option.sub ?? ''} ${group.label ?? ''}`.toLowerCase()
          return words.every((word) => text.includes(word))
        })
      }))
      .filter((group) => group.options.length)
  }, [props.groups, query])
  // The chosen group alone, unless what was typed is not in it.
  const section = props.sections && found.some((group) => group.label === chosen) ? chosen : null
  const groups = section === null ? found : found.filter((group) => group.label === section)
  const choose = (label: string | null): void => {
    lastSection.set(props.label, label)
    setChosen(label)
    setActive(0)
  }
  const matches = groups.reduce((sum, group) => sum + group.options.length, 0)
  // A list of thousands is not drawn whole: the first few hundred are, and typing brings the rest within reach.
  const shown = cap(groups, MAX_ROWS)
  const flat = shown.flatMap((group) => group.options)
  const at = Math.min(active, flat.length - 1)

  useEffect(() => {
    list.current?.querySelector('.picker-row.active')?.scrollIntoView({ block: 'nearest' })
  }, [at, query, section])
  const side = useRef<HTMLDivElement>(null)
  useEffect(() => {
    side.current?.querySelector('.picker-section.on')?.scrollIntoView({ block: 'nearest' })
  }, [section])

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
    else if (props.sections && !query && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      // With nothing typed there is no text to move through, so these step through the groups.
      const labels = [null, ...found.map((group) => group.label ?? null)]
      const to = labels.indexOf(section) + (event.key === 'ArrowRight' ? 1 : -1)
      choose(labels[Math.max(0, Math.min(labels.length - 1, to))])
    } else return
    event.preventDefault()
  }

  let index = -1
  return (
    <Popover origin={props.origin} onClose={props.onClose} className={props.sections ? 'picker sectioned' : 'picker'}>
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
        <div className="picker-body">
          {props.sections && (
            <div className="picker-sections" ref={side}>
              <button type="button" tabIndex={-1} className={`picker-section ${section === null ? 'on' : ''}`} onClick={() => choose(null)}>
                <span className="menu-label">All</span>
                <span className="menu-keys">{found.reduce((sum, group) => sum + group.options.length, 0)}</span>
              </button>
              {found.map((group) => (
                <button
                  key={group.label}
                  type="button"
                  tabIndex={-1}
                  className={`picker-section ${section === group.label ? 'on' : ''}`}
                  onClick={() => choose(group.label ?? null)}
                >
                  <span className="menu-label">{group.label}</span>
                  <span className="menu-keys">{group.options.length}</span>
                </button>
              ))}
            </div>
          )}
          <div className="picker-list" role="listbox" ref={list}>
            {shown.map((group, g) => (
              <div key={group.label ?? g} role="group" aria-label={group.label}>
                {group.label && section === null && <div className="menu-head">{group.label}</div>}
                {group.options.map((option, o) => {
                  index += 1
                  const mine = index
                  const head = section !== null && option.sub && option.sub !== group.options[o - 1]?.sub
                  return (
                    <Fragment key={mine}>
                      {head && <div className="menu-head">{option.sub}</div>}
                      <button
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
                    </Fragment>
                  )
                })}
              </div>
            ))}
            {flat.length === 0 && <div className="picker-none">Nothing matches “{query}”.</div>}
            {matches > flat.length && <div className="picker-none">{matches - flat.length} more. Type to narrow the list.</div>}
          </div>
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
