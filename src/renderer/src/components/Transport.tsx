import { useRef, useState, useSyncExternalStore } from 'react'
import { ADD_MENU, MENUS, acceleratorLabel, type MenuSection } from '@shared/menu'
import type { NativeInput, NativeLatency } from '@shared/nativeEngine'
import { timeMap } from '@shared/timemap'
import { Meter, NumberField } from './controls/fields'
import { engine, nativeEngine } from '../engine'
import { bridge, runCommand } from '../platform'
import { chooseInput, toggleMonitor, togglePlay, toggleRecord } from '../recording'
import { setLoop, setTempo } from '../state/actions'
import { MAX_ZOOM, MIN_ZOOM, useStudio } from '../state/store'
import { formatBars, formatTime, useFrame } from '../util'
import { Button, IconButton, Toggle } from './controls/buttons'
import { useLayout } from './layout'
import { Caret, MenuButton, Popover, useMenu, type MenuItem, type Origin } from './controls/Popover'

const IS_MAC = navigator.platform.startsWith('Mac')

/** The app's shared menu definition as items for a pop-up menu. */
function menuItems(sections: MenuSection[], shortcuts: boolean): MenuItem[] {
  return sections.flatMap((section, index) => [
    ...(index ? [{ separator: true } as MenuItem] : []),
    ...(sections.length > 1 ? [{ heading: section.label } as MenuItem] : []),
    ...section.items.map(
      (item): MenuItem =>
        item ? { label: item.label, shortcut: shortcuts ? acceleratorLabel(item.accelerator, IS_MAC) : undefined, onSelect: () => runCommand(item.command) } : { separator: true }
    )
  ])
}

/**
 * The bar across the top, in three parts. On the left, what the project is
 * made of (the menu, adding tracks). In the middle, playing it: the transport
 * buttons, where the playhead is, the tempo, loop and click. On the right,
 * how you hear and see it: input options, following, zoom, the engine and
 * the output level. It stays on one row: when the window is narrow the
 * toggles lose their words and keep their icons.
 */
export function Transport(): React.JSX.Element {
  const playing = useStudio((s) => s.playing)
  const recording = useStudio((s) => s.recordingFrom !== null)
  const metronome = useStudio((s) => s.metronome)
  const loopOn = useStudio((s) => s.project.loop.enabled)
  const monitor = useStudio((s) => s.monitor)
  const typingKeys = useStudio((s) => s.typingKeys)
  const follow = useStudio((s) => s.follow)
  const pxPerBeat = useStudio((s) => s.pxPerBeat)
  // The tempo and time signature in force at the playhead; editing the tempo edits that tempo change.
  const [tempo, setTempoShown] = useState(() => timeMap(useStudio.getState().project).tempoAt(0))
  const [meter, setMeterShown] = useState('4/4')

  const bars = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  useFrame(() => {
    const { project } = useStudio.getState()
    const position = engine.getPosition()
    if (bars.current) bars.current.textContent = formatBars(position, project)
    if (time.current) time.current.textContent = formatTime(position, project)
    const map = timeMap(project)
    const now = map.tempoAt(position)
    setTempoShown((shown) => (shown.id === now.id && shown.bpm === now.bpm ? shown : now))
    const signature = map.meterAt(position)
    setMeterShown(`${signature.numerator}/${signature.denominator}`)
  })

  const zoom = (factor: number): void => useStudio.setState({ pxPerBeat: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pxPerBeat * factor)) })

  return (
    <header className="tb">
      <div className="tb-part tb-left">
        {/* File, Edit and Track commands live in the application menu; a browser tab has none, so it gets this one. */}
        {!bridge && <MenuButton label="Menu" title="Project, edit and track commands" items={menuItems(MENUS, false)} />}
        <MenuButton label="Add" title="Add a track, or bring in audio files" items={menuItems(ADD_MENU, !!bridge)} />
      </div>

      <div className="tb-part tb-middle">
        <div className="tb-group">
          <IconButton label="Return to start (Home)" onClick={() => engine.seek(0)}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
              <path d="M3 3h2v10H3zM13 3v10L6 8z" />
            </svg>
          </IconButton>
          <button type="button" className={`tb-play ${playing ? 'on' : ''}`} title="Play / stop (Space)" aria-label={playing ? 'Stop' : 'Play'} aria-pressed={playing} onClick={togglePlay}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden>
              {playing ? <path d="M4 4h8v8H4z" /> : <path d="M5 2.75v10.5l8.5-5.25z" />}
            </svg>
          </button>
          <button type="button" className={`tb-rec ${recording ? 'on' : ''}`} title="Record on the armed track (R)" aria-label="Record" aria-pressed={recording} onClick={() => void toggleRecord()}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
              <circle cx="8" cy="8" r="4.5" />
            </svg>
          </button>
        </div>

        <div className="tb-readout" title="Where the playhead is: bar, beat and division, and the time">
          <span className="tb-bars" ref={bars}>
            1.1.1
          </span>
          <span className="tb-time" ref={time}>
            0:00.00
          </span>
        </div>

        <label className="tb-tempo" title="Tempo at the playhead">
          <NumberField className="tb-bpm" label="Tempo at the playhead, in beats per minute" value={tempo.bpm} onCommit={(bpm) => setTempo(tempo.id, bpm)} />
          <span>bpm</span>
          <span className="tb-meter" title="Time signature at the playhead (change it in the Signature row)">
            {meter}
          </span>
        </label>

        <div className="tb-group">
          <Toggle label="Loop the marked region (shift-drag the ruler to mark it)" pressed={loopOn} onChange={(enabled) => setLoop({ enabled })}>
            <Icon d="M4 6.5V6a2 2 0 0 1 2-2h6.5M10.5 2l2 2-2 2M12 9.5v.5a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2" />
            <span className="tb-word">Loop</span>
          </Toggle>
          <Toggle label="Metronome" pressed={metronome} onChange={(on) => useStudio.setState({ metronome: on })}>
            <Icon d="M5.5 14h5l-1.6-11.5H7.1zM8 10.5l3.5-5.5M5.9 11h4.2" />
            <span className="tb-word">Click</span>
          </Toggle>
        </div>
      </div>

      <div className="tb-part tb-right">
        <div className="tb-group">
          {nativeEngine && <InputMenu native={nativeEngine} />}
          <Toggle label="Monitor: hear the audio input through the armed track (use headphones)" pressed={monitor} onChange={() => void toggleMonitor()}>
            <Icon d="M3 10V8a5 5 0 0 1 10 0v2M3 9.5h1.5v4H3zM11.5 9.5H13v4h-1.5z" />
            <span className="tb-word">Monitor</span>
          </Toggle>
          <Toggle
            label="Keys: play notes from the computer keyboard. A–K are white keys, W E T Y U black keys, Z / X change octave"
            pressed={typingKeys}
            onChange={(on) => useStudio.setState({ typingKeys: on })}
          >
            <Icon d="M2.5 4.5h11v7h-11zM5.5 4.5v4M8 4.5v4M10.5 4.5v4" />
            <span className="tb-word">Keys</span>
          </Toggle>
          <Toggle label="Follow: keep the playhead in view while playing" pressed={follow} onChange={(on) => useStudio.setState({ follow: on })}>
            <Icon d="M8 2.5v11M3 5.5 5.5 8 3 10.5M13 5.5 10.5 8 13 10.5" />
            <span className="tb-word">Follow</span>
          </Toggle>
        </div>

        <div className="tb-zoom" title="Zoom (or pinch / Cmd-scroll over the timeline)">
          <IconButton label="Zoom out" size="sm" onClick={() => zoom(1 / 1.25)}>
            <Icon d="M4 8h8" />
          </IconButton>
          <input
            type="range"
            aria-label="Zoom"
            min={Math.log2(MIN_ZOOM)}
            max={Math.log2(MAX_ZOOM)}
            step={0.01}
            value={Math.log2(pxPerBeat)}
            onChange={(e) => useStudio.setState({ pxPerBeat: 2 ** Number(e.target.value) })}
          />
          <IconButton label="Zoom in" size="sm" onClick={() => zoom(1.25)}>
            <Icon d="M4 8h8M8 4v8" />
          </IconButton>
        </div>

        {nativeEngine && <EngineStatus native={nativeEngine} />}

        <div className="tb-out" title="Master output level">
          <span>Out</span>
          <Meter target="master" />
        </div>
      </div>
    </header>
  )
}

/**
 * Which microphone is recorded from. The list is asked for when the pointer
 * or the keyboard arrives at the button, so it is there, and current, by
 * the time the button is pressed.
 */
function InputMenu({ native }: { native: NonNullable<typeof nativeEngine> }): React.JSX.Element {
  const chosen = useLayout((s) => s.inputDevice)
  const [inputs, setInputs] = useState<NativeInput[]>([])
  const [menu, openMenu] = useMenu()
  const refresh = (): void => void native.inputs().then(setInputs)
  const usual = inputs.find((each) => each.isDefault)
  const using = inputs.find((each) => each.name === chosen) ?? usual
  return (
    <>
      <button
        type="button"
        className={`tb-input ${using?.callQuality ? 'warn' : ''}`}
        title={using ? `Recording from ${using.name}${using.callQuality ? ', which cannot be recorded from: choose another' : ''}. Click to choose a microphone.` : 'Choose the microphone to record from'}
        aria-label="Choose the microphone to record from"
        aria-haspopup="menu"
        onPointerEnter={refresh}
        onFocus={refresh}
        onClick={(event) =>
          openMenu(event, [
            { heading: 'Record from' },
            { label: usual ? `System default (${usual.name})` : 'System default', checked: chosen === null, onSelect: () => void chooseInput(null) },
            { separator: true },
            ...inputs.map((each) => ({
              // A Bluetooth headset's microphone is listed, so that it is plain why it is not on offer.
              label: each.callQuality ? `${each.name} · call quality only` : each.name,
              checked: chosen === each.name,
              disabled: each.callQuality,
              onSelect: () => void chooseInput(each.name)
            }))
          ])
        }
      >
        <Icon d="M8 2.5a1.75 1.75 0 0 0-1.75 1.75v3.5a1.75 1.75 0 0 0 3.5 0v-3.5A1.75 1.75 0 0 0 8 2.5zM4.5 7.5a3.5 3.5 0 0 0 7 0M8 11v2.5" />
        <Caret />
      </button>
      {menu}
    </>
  )
}

/** A 16-pixel line icon. */
function Icon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}

const ms = (seconds: number): string => `${(seconds * 1000).toFixed(1)} ms`

/** Says that the native engine is in use, and whether it has stopped. Opens the recording-latency panel. */
function EngineStatus({ native }: { native: NonNullable<typeof nativeEngine> }): React.JSX.Element {
  const status = useSyncExternalStore(
    (listener) => native.onStatus(listener),
    () => native.status()
  )
  const [origin, setOrigin] = useState<Origin | null>(null)
  const [latency, setLatency] = useState<NativeLatency | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const detail = [status.device ? `Output: ${status.device}.` : 'Starting…', status.error].filter(Boolean).join(' ')

  const toggle = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (origin) return setOrigin(null)
    setOrigin({ el: event.currentTarget })
    setMessage(null)
    void native.latency().then(setLatency)
  }
  const measure = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      setLatency(await native.calibrateLatency())
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'The measurement failed.')
    }
    setBusy(false)
  }

  return (
    <>
      <button type="button" className={`tb-engine ${status.error ? 'error' : ''}`} title={`Native audio engine (preview). ${detail} Click for recording latency.`} onClick={toggle}>
        <span className="tb-engine-dot" />
        Native{status.error ? ' · stopped' : ''}
      </button>
      {origin && (
        <Popover origin={origin} onClose={() => setOrigin(null)} className="tb-engine-panel">
          <h4>Recording latency</h4>
          <p>
            {latency?.measured != null
              ? `${ms(latency.measured)}, measured`
              : latency?.reported != null
                ? `${ms(latency.reported)}, as reported by the device (not measured)`
                : 'Not measured. The device’s own figure is used until it is.'}
            {latency?.measured != null && latency.reported != null && ` (the device reports ${ms(latency.reported)})`}
          </p>
          <p className="tb-engine-note">
            Recordings are shifted by this much to line up with the music. Measuring plays two seconds of clicks and listens for them, so the input must hear the
            output: turn the volume up with the microphone near the speakers, or join an output to an input with a cable. Headphones will not work.
          </p>
          {latency && (latency.output || latency.input) && (
            <p className="tb-engine-note">
              {latency.output ?? 'Unknown output'} → {latency.input ?? 'default input'}
            </p>
          )}
          {message && <p className="tb-engine-error">{message}</p>}
          <div className="tb-group">
            <Button kind="primary" disabled={busy || !!status.error} onClick={() => void measure()}>
              {busy ? 'Listening…' : latency?.measured != null ? 'Measure again' : 'Measure'}
            </Button>
            {latency?.measured != null && (
              <Button disabled={busy} onClick={() => void native.clearLatency().then(setLatency)}>
                Use the device’s figure
              </Button>
            )}
          </div>
        </Popover>
      )}
    </>
  )
}
