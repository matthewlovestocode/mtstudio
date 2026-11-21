import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContentPack, ContentProgress } from '@shared/bridge'
import { engine } from '../engine'
import { FAMILIES, SOURCES, currentItemId, useLibrary, type Family, type LibraryItem, type Source } from '../library'
import { setTypingOctave, useTypingOctave } from '../midiInput'
import { bridge } from '../platform'
import { scanPlugins, usePlugins } from '../plugins'
import { refreshSfzInstruments } from '../soundfont'
import { addTrack } from '../state/actions'
import { useStudio } from '../state/store'
import { Button, Toggle } from './controls/buttons'
import { MenuButton } from './controls/Popover'
import { setLayout, useBrowserFocus, useLayout } from './layout'

/** The most rows drawn at once; typing or choosing a family brings the rest within reach. */
const MAX_ROWS = 300
const FAVOURITES = 'Favourites'

/** The undo step that a run of instruments tried from the keyboard shares. */
const BROWSING = 'browse-instruments'
/** How long the keyboard must rest on a row before its instrument is loaded, so holding an arrow key does not load every one it passes. */
const SETTLE_MS = 140

/**
 * The browser: every instrument there is, from every source, to search, sort
 * by kind and try. Choosing one gives it to the selected instrument track
 * (or makes a track for it) and plays a note. Below the list is the library:
 * packs of sound that can be downloaded, each with its size and licence.
 *
 * It can be worked from the keyboard alone. Find Instrument (Cmd/Ctrl-F)
 * goes to the search box; the down arrow goes into the list, and from then
 * on each arrow key moves to the next instrument and plays it, while the
 * typing keyboard (A to K) plays whatever is loaded. Enter keeps the one
 * that is playing; Escape puts back what the track had before. However many
 * are tried on the way, it is one step to undo.
 */
export function Browser(): React.JSX.Element {
  const library = useLibrary()
  const favourites = useLayout((s) => s.favourites)
  const audition = useLayout((s) => s.audition)
  const [query, setQuery] = useState('')
  const [family, setFamily] = useState<Family | typeof FAVOURITES | null>(null)
  const [source, setSource] = useState<Source | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const octave = useTypingOctave()
  /** The row the keyboard is on; -1 when it is not in the list. */
  const [active, setActive] = useState(-1)
  const search = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const settle = useRef<number | undefined>(undefined)
  /** Whether instruments have been tried from the keyboard since the last one was kept: Escape then has something to put back. */
  const tried = useRef(false)

  // Find Instrument: the keyboard goes to the search box, in whichever window the browser is.
  const asked = useBrowserFocus((s) => s.asked)
  useEffect(() => {
    if (!asked || !search.current) return
    search.current.ownerDocument.defaultView?.focus()
    search.current.focus()
    search.current.select()
  }, [asked])

  const track = useStudio((s) => s.project.tracks.find((t) => t.id === s.selectedTrackId))
  const target = track?.kind === 'midi' ? track : undefined
  const current = currentItemId(target, library.items)

  // Every word typed must be in the name, the detail or the family.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const searched = useMemo(
    () => library.items.filter((each) => (!source || each.source === source) && words.every((word) => `${each.name} ${each.detail} ${each.family}`.toLowerCase().includes(word))),
    // `words` is made afresh each time; the text it comes from is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [library.items, source, query]
  )
  const counts = new Map<string, number>()
  for (const each of searched) counts.set(each.family, (counts.get(each.family) ?? 0) + 1)
  const starred = searched.filter((each) => favourites.includes(each.id))
  const matches = family === FAVOURITES ? starred : family ? searched.filter((each) => each.family === family) : searched
  const shown = matches.slice(0, MAX_ROWS)

  const choose = async (chosen: LibraryItem, gesture?: string): Promise<void> => {
    setFailure(null)
    let trackId = target?.id
    if (!trackId) {
      // Nothing to give it to: it gets a track of its own, which `addTrack` selects.
      addTrack('midi')
      trackId = useStudio.getState().selectedTrackId ?? undefined
    }
    if (!trackId) return
    try {
      await chosen.apply(trackId, gesture)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : `${chosen.name} could not be loaded.`)
      return
    }
    // The typing keyboard goes to where this kind of instrument is played: down for a bass, back up for a lead.
    setTypingOctave(chosen.octave)
    if (!audition) return
    // A moment for the engine to have the instrument ready, then a short note on it.
    const id = trackId
    window.setTimeout(() => {
      engine.noteOn(id, chosen.auditionPitch, 0.8)
      window.setTimeout(() => engine.noteOff(id, chosen.auditionPitch), 450)
    }, 250)
  }

  const pickFamily = (next: typeof family): void => {
    setFamily(next)
    setActive(-1)
  }

  const row = (index: number): HTMLButtonElement | null => list.current?.querySelector<HTMLButtonElement>(`[data-row="${index}"]`) ?? null

  /** Moves the keyboard to a row and, once it has rested there a moment, loads and plays that instrument. */
  const browseTo = (index: number): void => {
    if (!shown.length) return
    const next = Math.min(shown.length - 1, Math.max(0, index))
    setActive(next)
    row(next)?.focus()
    row(next)?.scrollIntoView({ block: 'nearest' })
    window.clearTimeout(settle.current)
    settle.current = window.setTimeout(() => {
      tried.current = true
      void choose(shown[next], BROWSING)
    }, SETTLE_MS)
  }

  /** Ends a run of trying instruments, keeping the one that is loaded. */
  const keep = (): void => {
    if (tried.current) useStudio.getState().endGesture()
    tried.current = false
  }

  /** Puts back the instrument the track had before the keyboard started trying others. */
  const putBack = (): void => {
    window.clearTimeout(settle.current)
    if (tried.current) {
      useStudio.getState().endGesture()
      useStudio.getState().undo()
    }
    tried.current = false
  }

  const onSearchKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') browseTo(0)
    else if (event.key === 'Enter') browseTo(0)
    else if (event.key === 'Escape' && query) setQuery('')
    else return
    event.preventDefault()
    // Enter and Escape mean other things to the app outside a text box.
    event.stopPropagation()
  }

  const onListKey = (event: React.KeyboardEvent): void => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const at = active < 0 ? 0 : active
    const page = Math.max(1, Math.floor((list.current?.clientHeight ?? 240) / 24) - 1)
    if (event.key === 'ArrowDown') browseTo(at + 1)
    else if (event.key === 'ArrowUp') {
      // Up from the top goes back to the search box.
      if (at === 0) {
        keep()
        setActive(-1)
        search.current?.focus()
      } else browseTo(at - 1)
    } else if (event.key === 'PageDown') browseTo(at + page)
    else if (event.key === 'PageUp') browseTo(at - page)
    else if (event.key === 'Home') browseTo(0)
    else if (event.key === 'End') browseTo(shown.length - 1)
    else if (event.key === 'Enter') {
      // Keeps what is loaded and plays it once more, as a yes.
      window.clearTimeout(settle.current)
      void choose(shown[at], tried.current ? BROWSING : undefined).then(keep)
    } else if (event.key === 'Escape') putBack()
    else if (event.key === '/') {
      keep()
      search.current?.focus()
      search.current?.select()
    } else return
    event.preventDefault()
    // The arrow keys, Enter and Home mean other things to the app outside the list.
    event.stopPropagation()
  }

  /** Left and right step through the kinds, as through a row of radio buttons. */
  const onChipKey = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    const chips = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    const at = chips.indexOf(event.currentTarget.ownerDocument.activeElement as HTMLButtonElement)
    const next = chips[(at + (event.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length]
    next?.focus()
    next?.click()
    event.preventDefault()
    event.stopPropagation()
  }

  const star = (id: string): void => setLayout({ favourites: favourites.includes(id) ? favourites.filter((each) => each !== id) : [...favourites, id] })

  return (
    <div className="br">
      <div className="br-tools">
        <input
          ref={search}
          className="br-search"
          aria-label="Search instruments"
          placeholder={`Search ${library.items.length.toLocaleString()} instruments`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(-1)
          }}
          onKeyDown={onSearchKey}
        />
        <div className="br-row">
          <MenuButton
            label={source ?? 'All sources'}
            title="Show instruments from one source only"
            items={[{ label: 'All sources', checked: source === null, onSelect: () => setSource(null) }, { separator: true }, ...SOURCES.map((each) => ({ label: each, checked: source === each, onSelect: () => setSource(each) }))]}
          />
          <span className="br-space" />
          <Toggle label="Audition: play a note on an instrument when it is chosen" size="sm" pressed={audition} onChange={(on) => setLayout({ audition: on })}>
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 6.5v3h2.5L9 12.5v-9L5.5 6.5zM11.5 6a3 3 0 0 1 0 4" />
            </svg>
          </Toggle>
        </div>
        <div className="br-families" role="radiogroup" aria-label="Kind of instrument" onKeyDown={onChipKey}>
          <Chip label="All" count={searched.length} on={family === null} onClick={() => pickFamily(null)} />
          {starred.length > 0 && <Chip label="★" title="Favourites" count={starred.length} on={family === FAVOURITES} onClick={() => pickFamily(family === FAVOURITES ? null : FAVOURITES)} />}
          {FAMILIES.filter((each) => counts.has(each)).map((each) => (
            <Chip key={each} label={each} count={counts.get(each)!} on={family === each} onClick={() => pickFamily(family === each ? null : each)} />
          ))}
        </div>
      </div>

      <div className="br-target">
        {target ? `Choosing one sets the instrument of “${target.name}”.` : 'Choosing one makes a new instrument track for it.'}
        <span className="br-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd> try · <kbd>A</kbd>–<kbd>K</kbd> play from C{octave} · <kbd>Z</kbd>
          <kbd>X</kbd> octave · <kbd>↵</kbd> keep · <kbd>esc</kbd> put back
        </span>
      </div>
      {library.nativeOnly && <div className="br-note">Only the three built-in instruments can be heard with this audio engine; the rest need the native engine.</div>}
      {library.surgeNeedsScan && <ScanNote />}
      {failure && <div className="br-note br-error">{failure}</div>}

      <div
        className="br-list"
        role="listbox"
        aria-label="Instruments"
        ref={list}
        onKeyDown={onListKey}
        onBlur={(event) => {
          // The keyboard has left the list: what is loaded stays.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) keep()
        }}
      >
        {shown.map((each, index) => (
          <div key={each.id} className={`br-item ${each.id === current ? 'current' : ''} ${index === active ? 'active' : ''}`} role="option" aria-selected={each.id === current}>
            <button
              type="button"
              className="br-pick"
              data-row={index}
              // One stop for Tab; the arrow keys move within the list.
              tabIndex={index === Math.max(0, active) ? 0 : -1}
              title={`${each.name} · ${each.detail}`}
              onClick={() => {
                keep()
                setActive(index)
                void choose(each)
              }}
            >
              <span className="br-name">{each.name}</span>
              <span className="br-detail">{each.detail}</span>
            </button>
            <button
              type="button"
              className={`br-star ${favourites.includes(each.id) ? 'on' : ''}`}
              title={favourites.includes(each.id) ? 'Remove from favourites' : 'Add to favourites'}
              aria-label={favourites.includes(each.id) ? `Remove ${each.name} from favourites` : `Add ${each.name} to favourites`}
              aria-pressed={favourites.includes(each.id)}
              tabIndex={-1}
              onClick={() => star(each.id)}
            >
              ★
            </button>
          </div>
        ))}
        {matches.length === 0 && <div className="br-none">Nothing matches.</div>}
        {matches.length > shown.length && <div className="br-none">{(matches.length - shown.length).toLocaleString()} more. Search, or choose a kind, to narrow the list.</div>}
      </div>

      <Packs />
    </div>
  )
}

function Chip(props: { label: string; title?: string; count: number; on: boolean; onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" role="radio" aria-checked={props.on} className={`br-chip ${props.on ? 'on' : ''}`} title={props.title} onClick={props.onClick}>
      {props.label} <span>{props.count.toLocaleString()}</span>
    </button>
  )
}

/** Surge XT's patches are found on disk, but nothing plays them until a scan has found Surge XT. */
function ScanNote(): React.JSX.Element {
  const { scanning } = usePlugins()
  return (
    <div className="br-note">
      Surge XT is installed. Its patches will be listed once the app has looked for plugins.{' '}
      <Button disabled={scanning} onClick={scanPlugins}>
        {scanning ? 'Looking…' : 'Look for plugins'}
      </Button>
    </div>
  )
}

// ── The library: packs to download ───────────────────────────────────────

const LICENCES: Record<string, string> = {
  'CC0-1.0': 'Public domain (CC0)',
  'CC-BY-3.0': 'Free with credit (CC BY 3.0)',
  'CC-BY-4.0': 'Free with credit (CC BY 4.0)',
  MIT: 'MIT',
  Unlicense: 'Public domain (Unlicense)'
}

function megabytes(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)} GB` : `${Math.round(count)} MB`
}

const progressListeners = new Set<(report: ContentProgress) => void>()
let listening = false

function Packs(): React.JSX.Element | null {
  const [packs, setPacks] = useState<ContentPack[]>([])
  const [progress, setProgress] = useState<Record<string, ContentProgress>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string | null>(null)
  const [bySize, setBySize] = useState(false)

  const refresh = (): void => void bridge?.contentPacks().then(setPacks, () => {})
  useEffect(() => {
    refresh()
    const listener = (report: ContentProgress): void => setProgress((all) => ({ ...all, [report.id]: report }))
    progressListeners.add(listener)
    // The bridge can be listened to but not unlistened from, so it is listened to once and shared out.
    if (!listening) {
      listening = true
      bridge?.onContentProgress((report) => progressListeners.forEach((each) => each(report)))
    }
    return () => void progressListeners.delete(listener)
  }, [])

  if (!bridge || packs.length === 0) return null

  const install = async (pack: ContentPack): Promise<void> => {
    setFailure(null)
    setBusy((all) => ({ ...all, [pack.id]: true }))
    const problem = await bridge!.installPack(pack.id).catch(() => `${pack.name} could not be installed.`)
    setBusy((all) => ({ ...all, [pack.id]: false }))
    setProgress(({ [pack.id]: _done, ...rest }) => rest)
    if (problem) setFailure(problem)
    refresh()
    refreshSfzInstruments()
  }
  const remove = async (pack: ContentPack): Promise<void> => {
    if (await bridge!.removePack(pack.id)) {
      refresh()
      refreshSfzInstruments()
    }
  }

  const installed = packs.filter((pack) => pack.installed).length
  const kinds = [...new Set(packs.map((pack) => pack.kind))].sort()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const listed = packs
    .filter((pack) => (!kind || pack.kind === kind) && words.every((word) => `${pack.name} ${pack.kind} ${pack.description} ${pack.credit}`.toLowerCase().includes(word)))
    // What is installed comes first, then the order asked for.
    .sort((a, b) => Number(b.installed) - Number(a.installed) || (bySize ? a.megabytes - b.megabytes : a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)))
  return (
    <section className={`br-packs ${open ? 'open' : ''}`}>
      <button type="button" className="br-packs-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden style={{ transform: open ? undefined : 'rotate(-90deg)' }}>
          <path d="M2 4.25 6 8l4-3.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Get more sounds
        <span className="br-space" />
        <span className="br-packs-count">
          {installed} of {packs.length} installed
        </span>
      </button>
      {open && (
        <div className="br-packs-tools">
          <input className="br-search" aria-label="Search packs" placeholder={`Search ${packs.length} packs`} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <div className="br-row">
            <MenuButton
              label={kind ?? 'All kinds'}
              title="Show packs of one kind of instrument"
              items={[{ label: 'All kinds', checked: kind === null, onSelect: () => setKind(null) }, { separator: true }, ...kinds.map((each) => ({ label: each, checked: kind === each, onSelect: () => setKind(each) }))]}
            />
            <MenuButton
              label={bySize ? 'Smallest first' : 'By kind'}
              title="The order packs are listed in"
              items={[
                { label: 'By kind', checked: !bySize, onSelect: () => setBySize(false) },
                { label: 'Smallest first', checked: bySize, onSelect: () => setBySize(true) }
              ]}
            />
          </div>
        </div>
      )}
      {open && (
        <div className="br-packs-body">
          {failure && <div className="br-note br-error">{failure}</div>}
          {listed.length === 0 && <div className="br-none">No pack matches.</div>}
          {listed.map((pack) => {
            const working = busy[pack.id] || pack.installing
            const report = progress[pack.id]
            return (
              <div key={pack.id} className="br-pack">
                <div className="br-pack-head">
                  <strong>
                    {pack.name} <span className="br-pack-kind">{pack.kind}</span>
                  </strong>
                  {pack.installed ? (
                    <Button kind="danger" title="Delete this pack's files from this computer" onClick={() => void remove(pack)}>
                      Remove
                    </Button>
                  ) : (
                    <Button kind="primary" disabled={working} title={`Download from ${pack.source}`} onClick={() => void install(pack)}>
                      {working ? (report?.stage === 'unpacking' ? 'Unpacking…' : `${megabytes(report?.megabytes ?? 0)}…`) : `Install · ${megabytes(pack.megabytes)}`}
                    </Button>
                  )}
                </div>
                <p>{pack.description}</p>
                <p className="br-pack-terms">
                  {LICENCES[pack.license] ?? pack.license} · {pack.credit} · {pack.source}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
