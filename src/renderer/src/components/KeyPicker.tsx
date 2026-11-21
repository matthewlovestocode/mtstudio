import { useEffect, useRef, useState } from 'react'
import { keySegments, segmentAt } from '@shared/keymap'
import type { Id, Project } from '@shared/model'
import { SCALES, guessKeys, keyName, pitchClassName, relatedKeys, type Key, type KeyGuess, type ScaleId } from '@shared/theory'
import { isDrumTrack } from '../drums'
import { removeKeyChange, setKey, setKeyOf } from '../state/actions'
import { useStudio } from '../state/store'
import { Button, Toggle } from './controls/buttons'
import { Caret, Popover, type Origin } from './controls/Popover'
import { setLayout, useLayout } from './layout'

const ROOTS = Array.from({ length: 12 }, (_, i) => i)
const SCALE_IDS = Object.keys(SCALES) as ScaleId[]

/**
 * Keys to begin in for someone who does not yet know which they want: the two
 * that use only a piano's white keys, and the two a step from them.
 */
export const STARTER_KEYS: { key: Key; why: string }[] = [
  { key: { root: 0, scale: 'major' }, why: 'bright; the white keys only' },
  { key: { root: 9, scale: 'minor' }, why: 'dark; the white keys only' },
  { key: { root: 7, scale: 'major' }, why: 'bright; one black key' },
  { key: { root: 4, scale: 'minor' }, why: 'dark; one black key' }
]

/** The key that best fits the notes in the project, best first. Drums are left out: their notes are sounds, not pitches. */
export function guessProjectKey(project: Project = useStudio.getState().project): KeyGuess[] {
  return guessKeys(project.tracks.filter((track) => track.kind === 'midi' && !isDrumTrack(track)).flatMap((track) => track.clips.flatMap((clip) => (clip.kind === 'midi' ? clip.notes : []))))
}

/**
 * Shows the key of one stretch of the song and lets it be chosen. The key the
 * song starts in is worked out from the notes unless one is chosen, and
 * choosing fixes it; for a change of key, the keys that sit near the one
 * before it are offered. The key changes nothing that is heard; it is what
 * the piano roll goes by to show which notes belong.
 */
export function KeyPicker(props: {
  /** A tick in the stretch whose key this shows and sets; the start of the song when absent. */
  at?: number
  /** A shorter button, for an editor's bar; or a small one that sits in the timeline's Key row. */
  look?: 'bar' | 'compact' | 'marker'
  /** Open the panel at once (once): the change of key has just been made, and wants its key choosing. */
  openNow?: boolean
}): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const scaleKeys = useLayout((s) => s.scaleKeys)
  const [origin, setOrigin] = useState<Origin | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  const segments = keySegments(project)
  const segment = segmentAt(segments, props.at ?? 0)
  const key = segment?.key ?? null
  /** The key is the one the notes are in, not one that was chosen: it will follow them. */
  const auto = segment?.auto ?? false
  const id: Id | null = segment?.id ?? null
  const before = id === null ? null : (segments[segments.indexOf(segment!) - 1]?.key ?? null)
  // Choosing a root with no scale yet starts from major, the commonest; a scale with no root, from C.
  const current: Key = key ?? { root: 0, scale: 'major' }
  const choose = (next: Key): void => setKeyOf(id, next)
  // What the notes suggest, for the key the song starts in: worked out as the panel opens.
  const found = origin && id === null ? guessProjectKey(project) : []

  useEffect(() => {
    if (props.openNow && button.current) setOrigin({ el: button.current })
    // Only when it first appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const look = props.look ?? 'bar'
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`key-button ${key ? 'set' : ''} ${look}`}
        title={
          key
            ? `${id === null ? (segments.length > 1 ? 'The song starts in' : 'The song is in') : 'From here the song is in'} ${keyName(key)}${auto ? ', worked out from your notes; it will follow them as they change' : ''}. Click to choose the key.`
            : 'The key is worked out from your notes once there are a few. Click to choose one now.'
        }
        aria-haspopup="dialog"
        aria-expanded={!!origin}
        onClick={(event) => {
          setOrigin(origin ? null : { el: event.currentTarget })
        }}
        // In the timeline's row a double-click adds a change of key; one on a key already there is not that.
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {key ? keyName(key) : look === 'bar' ? 'Key' : 'Choose…'}
        {auto && <span className="key-auto">auto</span>}
        <Caret />
      </button>
      {origin && (
        <Popover origin={origin} onClose={() => setOrigin(null)} className="key-panel">
          {id === null && (
            <>
              {/* The key is found, not asked for: what the notes are in comes first, or with no notes a few easy places to start. Choosing any of them fixes the key. */}
              <div className="key-head">{found.length ? 'What your notes are in' : 'A key to start in'}</div>
              <div className="key-guesses key-near">
                {found.length
                  ? found.slice(0, 3).map((guess, i) => (
                      <button key={keyName(guess.key)} type="button" className={key && keyName(key) === keyName(guess.key) ? 'on' : ''} onClick={() => choose(guess.key)}>
                        {keyName(guess.key)}
                        <span>{i === 0 ? (guess.fit > 0.6 ? 'the best fit' : 'the best guess') : 'also fits'}</span>
                      </button>
                    ))
                  : STARTER_KEYS.map((starter) => (
                      <button key={keyName(starter.key)} type="button" className={key && keyName(key) === keyName(starter.key) ? 'on' : ''} onClick={() => choose(starter.key)}>
                        {keyName(starter.key)}
                        <span>{starter.why}</span>
                      </button>
                    ))}
              </div>
              <p className="key-note key-or">{auto ? 'The key follows your notes. To fix it, choose one:' : 'Or choose one yourself:'}</p>
            </>
          )}

          <div className="key-head">Root</div>
          <div className="key-roots" role="radiogroup" aria-label="Root">
            {ROOTS.map((root) => (
              <button key={root} type="button" role="radio" aria-checked={key?.root === root} className={key?.root === root ? 'on' : ''} onClick={() => choose({ ...current, root })}>
                {pitchClassName(root, { ...current, root })}
              </button>
            ))}
          </div>
          <div className="key-head">Scale</div>
          <div className="key-scales" role="radiogroup" aria-label="Scale">
            {SCALE_IDS.map((scale) => (
              <button key={scale} type="button" role="radio" aria-checked={key?.scale === scale} className={key?.scale === scale ? 'on' : ''} onClick={() => choose({ ...current, scale })}>
                {SCALES[scale].name}
              </button>
            ))}
          </div>

          {before && (
            <>
              <div className="key-head">Near {keyName(before)}</div>
              <div className="key-guesses key-near">
                {relatedKeys(before).map((related) => (
                  <button key={keyName(related.key)} type="button" className={key && keyName(key) === keyName(related.key) ? 'on' : ''} onClick={() => choose(related.key)}>
                    {keyName(related.key)}
                    <span>{related.why}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="key-foot">
            <Toggle label="Play the scale from the typing keyboard: A to K go up the key's notes, so no key is a wrong note" size="sm" pressed={scaleKeys} onChange={(on) => setLayout({ scaleKeys: on })}>
              A–K play the scale
            </Toggle>
            <span className="key-space" />
            {id === null ? (
              <Button disabled={!project.key} title="Stop fixing the key: let it be worked out from the notes, and follow them as they change" onClick={() => setKey(null)}>
                {project.key ? 'Automatic' : 'Following your notes'}
              </Button>
            ) : (
              <Button
                kind="danger"
                title="Take this change of key out: the key before it carries on"
                onClick={() => {
                  setOrigin(null)
                  removeKeyChange(id)
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
