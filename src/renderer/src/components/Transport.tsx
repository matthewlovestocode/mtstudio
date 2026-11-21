import { useRef, useState, useSyncExternalStore } from 'react'
import { ADD_MENU, MENUS } from '@shared/menu'
import { PPQ } from '@shared/model'
import type { NativeLatency } from '@shared/nativeEngine'
import { timeMap } from '@shared/timemap'
import { engine, nativeEngine } from '../engine'
import { bridge, runCommand } from '../platform'
import { toggleMonitor, togglePlay, toggleRecord } from '../recording'
import { setLoop, setTempo } from '../state/actions'
import { MAX_ZOOM, MIN_ZOOM, useStudio } from '../state/store'
import { formatBars, formatTime, useFrame } from '../util'
import { MenuButton, Meter, NumberField } from './controls'

const ms = (seconds: number): string => `${(seconds * 1000).toFixed(1)} ms`

/**
 * Says that the native engine is in use (and if it has stopped). Clicking it
 * opens the recording-latency panel.
 */
function NativeBadge({ native }: { native: NonNullable<typeof nativeEngine> }): React.JSX.Element {
  const status = useSyncExternalStore(
    (listener) => native.onStatus(listener),
    () => native.status()
  )
  const [panel, setPanel] = useState<{ left: number; top: number } | null>(null)
  const [latency, setLatency] = useState<NativeLatency | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const detail = [status.device ? `Output: ${status.device}.` : 'Starting…', status.error].filter(Boolean).join(' ')

  const toggle = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (panel) return setPanel(null)
    const box = event.currentTarget.getBoundingClientRect()
    // Placed against the window, so it stays on screen wherever the bar's wrapping has put the badge.
    setPanel({ left: Math.max(8, Math.min(box.left, window.innerWidth - 348)), top: box.bottom + 6 })
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
      <button
        className={`engine-badge ${status.error ? 'error' : ''}`}
        title={`Native audio engine (preview). ${detail} Click for recording latency.`}
        onClick={toggle}
      >
        Native{status.error ? ' — stopped' : ''}
      </button>
      {panel && (
        <div className="engine-panel" style={panel}>
          <div className="engine-panel-title">Recording latency</div>
          <p>
            {latency?.measured != null
              ? `${ms(latency.measured)}, measured`
              : latency?.reported != null
                ? `${ms(latency.reported)}, as reported by the device (not measured)`
                : 'Not measured. The device’s own figure is used until it is.'}
            {latency?.measured != null && latency.reported != null && ` (the device reports ${ms(latency.reported)})`}
          </p>
          <p className="engine-panel-note">
            Recordings are shifted by this much to line up with the music. Measuring plays two seconds of clicks and listens for
            them, so the input must hear the output: turn the volume up with the microphone near the speakers, or join an output
            to an input with a cable. Headphones will not work.
          </p>
          {latency && (latency.output || latency.input) && (
            <p className="engine-panel-note">
              {latency.output ?? 'Unknown output'} → {latency.input ?? 'default input'}
            </p>
          )}
          {message && <p className="engine-panel-error">{message}</p>}
          <div className="group">
            <button disabled={busy || !!status.error} onClick={() => void measure()}>
              {busy ? 'Listening…' : latency?.measured != null ? 'Measure again' : 'Measure'}
            </button>
            {latency?.measured != null && (
              <button disabled={busy} onClick={() => void native.clearLatency().then(setLatency)}>
                Use the device’s figure
              </button>
            )}
            <button onClick={() => setPanel(null)}>Close</button>
          </div>
        </div>
      )}
    </>
  )
}

export function Transport(): React.JSX.Element {
  const playing = useStudio((s) => s.playing)
  const metronome = useStudio((s) => s.metronome)
  // The tempo in force at the playhead; editing it edits that tempo change.
  const [tempo, setTempoShown] = useState(() => timeMap(useStudio.getState().project).tempoAt(0))
  const loopOn = useStudio((s) => s.project.loop.enabled)
  const pxPerBeat = useStudio((s) => s.pxPerBeat)
  const recording = useStudio((s) => s.recordingFrom !== null)
  const monitor = useStudio((s) => s.monitor)
  const typingKeys = useStudio((s) => s.typingKeys)
  const follow = useStudio((s) => s.follow)

  const bars = useRef<HTMLSpanElement>(null)
  const time = useRef<HTMLSpanElement>(null)
  useFrame(() => {
    const { project } = useStudio.getState()
    const position = engine.getPosition()
    if (bars.current) bars.current.textContent = formatBars(position, project)
    if (time.current) time.current.textContent = formatTime(position, project)
    const now = timeMap(project).tempoAt(position)
    setTempoShown((shown) => (shown.id === now.id && shown.bpm === now.bpm ? shown : now))
  })

  return (
    <header className="transport">
      {/* File, Edit and Track commands live in the application menu; a browser tab has none, so it gets this one. */}
      {!bridge && <MenuButton label="Menu" title="Project, edit and track commands" sections={MENUS} shortcuts={false} onCommand={runCommand} />}

      <div className="group">
        <button className="icon" title="Return to start" onClick={() => engine.seek(0)}>
          <svg viewBox="0 0 16 16"><path d="M3 3h2v10H3zM13 3v10L6 8z" /></svg>
        </button>
        <button className={`icon play ${playing ? 'on' : ''}`} title="Play / stop (Space)" onClick={togglePlay}>
          {playing ? (
            <svg viewBox="0 0 16 16"><path d="M3.5 3.5h9v9h-9z" /></svg>
          ) : (
            <svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z" /></svg>
          )}
        </button>
        <button className={`icon record ${recording ? 'on' : ''}`} title="Record on the armed track (R)" onClick={() => void toggleRecord()}>
          <svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" /></svg>
        </button>
      </div>

      <div className="group">
        <button className={`toggle ${loopOn ? 'on' : ''}`} title="Loop (shift-drag the ruler to set)" onClick={() => setLoop({ enabled: !loopOn })}>
          Loop
        </button>
        <button
          className={`toggle ${metronome ? 'on' : ''}`}
          title="Metronome"
          onClick={() => useStudio.setState({ metronome: !metronome })}
        >
          Click
        </button>
        <button className={`toggle ${monitor ? 'on' : ''}`} title="Hear the audio input through the armed track (use headphones)" onClick={() => void toggleMonitor()}>
          Monitor
        </button>
        <button
          className={`toggle ${typingKeys ? 'on' : ''}`}
          title="Play notes from the computer keyboard: A–K are white keys, W E T Y U black keys, Z / X change octave"
          onClick={() => useStudio.setState({ typingKeys: !typingKeys })}
        >
          Keys
        </button>
        <button className={`toggle ${follow ? 'on' : ''}`} title="Keep the playhead in view while playing" onClick={() => useStudio.setState({ follow: !follow })}>
          Follow
        </button>
      </div>

      <div className="readout">
        <span className="readout-bars" ref={bars}>1.1.1</span>
        <span className="readout-time" ref={time}>0:00.00</span>
      </div>

      <label className="field">
        <NumberField className="bpm" label="Tempo at the playhead" value={tempo.bpm} onCommit={(bpm) => setTempo(tempo.id, bpm)} />
        <span>BPM</span>
      </label>

      <div className="spacer" />

      <MenuButton
        label="+ Track"
        title="Add a track, or bring in audio files (also in the Track and File menus)"
        sections={ADD_MENU}
        shortcuts={!!bridge}
        onCommand={runCommand}
      />

      <label className="field zoom" title="Zoom (or pinch / Cmd-scroll over the timeline)">
        <span>Zoom</span>
        <input
          type="range"
          aria-label="Zoom"
          min={Math.log2(MIN_ZOOM)}
          max={Math.log2(MAX_ZOOM)}
          step={0.01}
          value={Math.log2(pxPerBeat)}
          onChange={(e) => useStudio.setState({ pxPerBeat: 2 ** Number(e.target.value) })}
        />
      </label>

      {nativeEngine && <NativeBadge native={nativeEngine} />}

      <div className="master" title="Master output">
        <Meter target="master" />
      </div>
    </header>
  )
}

export const SNAP_OPTIONS: [string, number][] = [
  ['1/4', PPQ],
  ['1/8', PPQ / 2],
  ['1/16', PPQ / 4],
  ['1/32', PPQ / 8]
]
