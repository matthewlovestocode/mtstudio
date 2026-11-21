import { useState } from 'react'
import { Button, IconButton, Segmented, Toggle } from './controls/buttons'
import { Fader } from './controls/Fader'
import { Knob } from './controls/Knob'
import { Picker } from './controls/Picker'
import { MenuButton, useMenu, type MenuItem } from './controls/Popover'
import { VOLUME_CURVE, VOLUME_TICKS, decibels } from './mixing'

/**
 * Every token and control of the reworked interface on one page, for looking
 * over and trying out. It is here for the rework only: when the controls have
 * moved over, this tab goes.
 */

const SURFACES = ['surface-well', 'surface-window', 'surface-panel', 'surface-raised', 'surface-hover']
const LINES = ['border-soft', 'border', 'border-strong']
const INKS = ['ink', 'ink-muted', 'ink-faint']
const MEANINGS = ['accent', 'ok', 'warn', 'danger']
const SPACES = [1, 2, 3, 4, 5, 6, 7]
const TYPE = [
  ['text-xs', 'Extra small · meter scales, strip kinds'],
  ['text-sm', 'Small · readouts, panel headings'],
  ['text-md', 'Medium · the interface’s text'],
  ['text-lg', 'Large · a clip’s or panel’s name']
]

const EFFECTS = [
  { label: 'Built in', options: ['EQ', 'Compressor', 'Delay', 'Reverb'].map((label) => ({ value: label, label })) },
  {
    label: 'Plugins',
    options: [
      ['AUBandpass', 'Apple'],
      ['AUDistortion', 'Apple'],
      ['AUGraphicEQ', 'Apple'],
      ['AUMatrixReverb', 'Apple'],
      ['AUPeakLimiter', 'Apple'],
      ['AUPitch', 'Apple'],
      ['Gain', 'JUCE'],
      ['Multi-stage DSP', 'JUCE'],
      ['Noise Gate', 'JUCE']
    ].map(([label, detail]) => ({ value: label, label, detail }))
  }
]

function Card({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="kit-card">
      <h3>{title}</h3>
      {children}
    </section>
  )
}

function Swatches({ names }: { names: string[] }): React.JSX.Element {
  return (
    <div className="kit-swatches">
      {names.map((name) => (
        <div key={name} className="kit-swatch">
          <span style={{ background: `var(--${name})` }} />
          <code>{name}</code>
        </div>
      ))}
    </div>
  )
}

export function Kit(): React.JSX.Element {
  const [toggles, setToggles] = useState({ mute: true, solo: false, arm: false, on: true })
  const [view, setView] = useState<'editor' | 'mixer' | 'both'>('editor')
  const [cutoff, setCutoff] = useState(0.62)
  const [pan, setPan] = useState(-0.25)
  const [volume, setVolume] = useState(0.8)
  const [picked, setPicked] = useState<string | null>(null)
  const [said, setSaid] = useState('Nothing chosen yet.')
  const [menu, openMenu] = useMenu()

  const items: MenuItem[] = [
    { label: 'Split at Playhead', shortcut: '⌘E', onSelect: () => setSaid('Split at Playhead') },
    { label: 'Duplicate', shortcut: '⌘D', onSelect: () => setSaid('Duplicate') },
    { label: 'Rename…', onSelect: () => setSaid('Rename'), disabled: true },
    { separator: true },
    { heading: 'Show' },
    { label: 'Follow playhead', checked: toggles.on, onSelect: () => setToggles((t) => ({ ...t, on: !t.on })) },
    { separator: true },
    { label: 'Delete', shortcut: '⌫', danger: true, onSelect: () => setSaid('Delete') }
  ]

  return (
    <div className="kit">
      <Card title="Surfaces and lines">
        <Swatches names={SURFACES} />
        <Swatches names={LINES} />
      </Card>

      <Card title="Ink and meaning">
        <Swatches names={INKS} />
        <Swatches names={MEANINGS} />
      </Card>

      <Card title="Type">
        {TYPE.map(([name, use]) => (
          <p key={name} className="kit-type" style={{ fontSize: `var(--${name})` }}>
            {use} <code>{name}</code>
          </p>
        ))}
      </Card>

      <Card title="Space">
        <div className="kit-spaces">
          {SPACES.map((n) => (
            <div key={n}>
              <span style={{ width: `var(--space-${n})` }} />
              <code>space-{n}</code>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Buttons">
        <div className="kit-row">
          <Button onClick={() => setSaid('Plain button')}>Plain</Button>
          <Button kind="primary" onClick={() => setSaid('Primary button')}>
            Primary
          </Button>
          <Button kind="danger" onClick={() => setSaid('Danger button')}>
            Delete
          </Button>
          <Button disabled onClick={() => {}}>
            Disabled
          </Button>
        </div>
        <div className="kit-row">
          <Toggle label="Mute" tone="warn" size="sm" pressed={toggles.mute} onChange={(mute) => setToggles({ ...toggles, mute })}>
            M
          </Toggle>
          <Toggle label="Solo" tone="accent" size="sm" pressed={toggles.solo} onChange={(solo) => setToggles({ ...toggles, solo })}>
            S
          </Toggle>
          <Toggle label="Arm for recording" tone="danger" size="sm" pressed={toggles.arm} onChange={(arm) => setToggles({ ...toggles, arm })}>
            R
          </Toggle>
          <Toggle label="Effect on" tone="ok" pressed={toggles.on} onChange={(on) => setToggles({ ...toggles, on })}>
            On
          </Toggle>
          <IconButton label="An icon button" onClick={() => setSaid('Icon button')}>
            <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden>
              <path d="M4 2.5v11l9-5.5z" />
            </svg>
          </IconButton>
        </div>
        <div className="kit-row">
          <Segmented
            label="Dock shows"
            value={view}
            onChange={setView}
            options={[
              ['editor', 'Editor'],
              ['mixer', 'Mixer'],
              ['both', 'Both']
            ]}
          />
        </div>
      </Card>

      <Card title="Knob">
        <div className="kit-row kit-dials">
          <label>
            <Knob label="Cutoff" min={0} max={1} reset={0.5} value={cutoff} text={`${Math.round(cutoff * 100)}%`} onChange={setCutoff} />
            <span>Cutoff</span>
            <output>{Math.round(cutoff * 100)}%</output>
          </label>
          <label>
            <Knob label="Pan" bipolar min={-1} max={1} snap={0.05} reset={0} value={pan} onChange={setPan} />
            <span>Pan</span>
            <output>{pan === 0 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`}</output>
          </label>
          <label>
            <Knob label="Large" size={44} min={0} max={1} reset={0.5} value={cutoff} onChange={setCutoff} />
            <span>Large</span>
          </label>
          <label>
            <Knob label="Disabled" disabled min={0} max={1} value={0.3} onChange={() => {}} />
            <span>Off</span>
          </label>
        </div>
        <p className="kit-note">Drag up and down. Shift for fine. Double-click to reset. Arrow keys when focused.</p>
      </Card>

      <Card title="Fader">
        <div className="kit-row kit-fader">
          <Fader label="Volume" min={0} max={1.5} reset={0.8} curve={VOLUME_CURVE} ticks={VOLUME_TICKS} value={volume} text={`${decibels(volume)} dB`} onChange={setVolume} />
          <output>{decibels(volume)} dB</output>
        </div>
      </Card>

      <Card title="Menus">
        <div className="kit-row">
          <MenuButton label="Menu" items={items} />
        </div>
        <div className="kit-target" onContextMenu={(e) => openMenu(e, items)}>
          Right-click here
        </div>
        <p className="kit-note">{said}</p>
        {menu}
      </Card>

      <Card title="Picker">
        <Picker
          wide
          label={picked ?? 'Add effect…'}
          placeholder="Search effects"
          groups={EFFECTS}
          onPick={setPicked}
          actions={[{ label: 'Look for plugins…', onSelect: () => setSaid('Look for plugins') }]}
        />
        <p className="kit-note">Type to narrow the list. Arrow keys and Enter to choose.</p>
      </Card>
    </div>
  )
}
