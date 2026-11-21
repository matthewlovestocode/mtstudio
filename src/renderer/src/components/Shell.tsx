import { useEffect, useRef, useState } from 'react'
import { ClipEditor } from './ClipEditor'
import { Inspector } from './Inspector'
import { ARRANGE_MIN, DOCK, SIDE, setFloating, setLayout, showDock, useFloating, useLayout, type DockTab, type PanelId } from './layout'
import { Mixer } from './Mixer'
import { PopOut } from './PopOut'
import { Splitter } from './Splitter'
import { Timeline } from './Timeline'
import { Transport } from './Transport'

/**
 * The window's layout. The transport bar runs across the top. Under it the
 * inspector is a panel down the left side, the arrangement has the rest of
 * the width, and a dock beneath the arrangement holds the clip editor and
 * the mixer. Both panels resize and fold away, and the inspector and each
 * of the dock's tabs can be brought out into a window of its own and put
 * back.
 */
const PANELS: Record<PanelId, { title: string; width: number; height: number }> = {
  inspector: { title: 'Inspector', width: 300, height: 640 },
  editor: { title: 'Editor', width: 960, height: 440 },
  mixer: { title: 'Mixer', width: 760, height: 420 }
}
const PANEL_IDS = Object.keys(PANELS) as PanelId[]

function panelContent(panel: PanelId): React.JSX.Element {
  if (panel === 'mixer') return <Mixer />
  if (panel === 'editor') return <ClipEditor />
  return (
    <div className="insp">
      <Inspector />
    </div>
  )
}

export function Shell(): React.JSX.Element {
  const layout = useLayout()
  const floating = useFloating()
  const sideDocked = layout.sideOpen && !floating.inspector
  const main = useRef<HTMLDivElement>(null)
  // The dock may not squeeze the arrangement out, however small the window gets.
  const [dockMax, setDockMax] = useState(DOCK.default)
  useEffect(() => {
    const el = main.current!
    const measure = (): void => setDockMax(Math.max(DOCK.min, el.clientHeight - ARRANGE_MIN))
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])
  const dockHeight = Math.min(layout.dockHeight, dockMax)

  return (
    <div className="app studio">
      <Transport />
      <div className="next-body">
        {sideDocked ? (
          <>
            <aside className="next-side" style={{ width: layout.sideWidth }}>
              <PanelHead title="Inspector">
                <PopOutButton panel="inspector" />
                <button className="panel-fold" title="Hide the inspector" aria-label="Hide the inspector" onClick={() => setLayout({ sideOpen: false })}>
                  <Chevron direction="left" />
                </button>
              </PanelHead>
              {panelContent('inspector')}
            </aside>
            <Splitter
              orientation="vertical"
              label="Inspector width"
              value={layout.sideWidth}
              min={SIDE.min}
              max={SIDE.max}
              reset={SIDE.default}
              direction={1}
              onChange={(sideWidth) => setLayout({ sideWidth })}
            />
          </>
        ) : (
          <div className="next-rail">
            <button
              className="panel-fold"
              title={floating.inspector ? 'Bring the inspector back from its window' : 'Show the inspector'}
              aria-label={floating.inspector ? 'Bring the inspector back from its window' : 'Show the inspector'}
              onClick={() => setFloating('inspector', false)}
            >
              {floating.inspector ? <DockBackIcon /> : <Chevron direction="right" />}
            </button>
            <span>Inspector{floating.inspector ? ' · in window' : ''}</span>
          </div>
        )}

        <div className="next-main" ref={main}>
          <Timeline />
          {layout.dockOpen && (
            <Splitter
              orientation="horizontal"
              label="Dock height"
              value={dockHeight}
              min={DOCK.min}
              max={dockMax}
              reset={DOCK.default}
              direction={-1}
              onChange={(height) => setLayout({ dockHeight: height })}
            />
          )}
          <section className="next-dock" style={layout.dockOpen ? { height: dockHeight } : undefined}>
            <div className="dock-bar" role="tablist" aria-label="Dock">
              <DockTabButton tab="editor" label="Editor" />
              <DockTabButton tab="mixer" label="Mixer" />
              <div className="spacer" />
              {layout.dockOpen && !floating[layout.dockTab] && <PopOutButton panel={layout.dockTab} />}
              <button
                className="panel-fold"
                title={layout.dockOpen ? 'Hide the dock' : 'Show the dock'}
                aria-label={layout.dockOpen ? 'Hide the dock' : 'Show the dock'}
                onClick={() => setLayout({ dockOpen: !layout.dockOpen })}
              >
                <Chevron direction={layout.dockOpen ? 'down' : 'up'} />
              </button>
            </div>
            {layout.dockOpen && (
              <div className="dock-body" role="tabpanel">
                {floating[layout.dockTab] ? (
                  <div className="ce-empty">
                    <p>The {PANELS[layout.dockTab].title.toLowerCase()} is in its own window.</p>
                    <p>
                      <button onClick={() => setFloating(layout.dockTab, false)}>Bring it back</button>
                    </p>
                  </div>
                ) : (
                  panelContent(layout.dockTab)
                )}
              </div>
            )}
          </section>
        </div>
      </div>
      {PANEL_IDS.filter((panel) => floating[panel]).map((panel) => (
        <PopOut key={panel} name={panel} title={PANELS[panel].title} width={PANELS[panel].width} height={PANELS[panel].height} onClose={() => setFloating(panel, false)}>
          <PanelHead title={PANELS[panel].title}>
            <button className="panel-fold" title="Put back in the main window" aria-label="Put back in the main window" onClick={() => setFloating(panel, false)}>
              <DockBackIcon />
            </button>
          </PanelHead>
          <div className="popout-body">{panelContent(panel)}</div>
        </PopOut>
      ))}
    </div>
  )
}

function PopOutButton({ panel }: { panel: PanelId }): React.JSX.Element {
  const label = `Open the ${PANELS[panel].title.toLowerCase()} in its own window`
  return (
    <button className="panel-fold" title={label} aria-label={label} onClick={() => setFloating(panel, true)}>
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6.5 3.5h-3v9h9v-3M9.5 2.5h4v4M13.5 2.5l-6 6" />
      </svg>
    </button>
  )
}

function DockBackIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6.5 3.5h-3v9h9v-3M13.5 2.5l-5 5M8 3.5v4.5h4.5" />
    </svg>
  )
}

function DockTabButton({ tab, label }: { tab: DockTab; label: string }): React.JSX.Element {
  const active = useLayout((s) => s.dockOpen && s.dockTab === tab)
  const floating = useFloating((s) => s[tab])
  return (
    <button role="tab" aria-selected={active} className={`dock-tab ${active ? 'on' : ''}`} title={floating ? `${label} (in its own window)` : undefined} onClick={() => showDock(tab)}>
      {label}
      {floating && <span className="dock-tab-out"> ↗</span>}
    </button>
  )
}

function PanelHead({ title, children }: { title: string; children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="panel-head">
      <span>{title}</span>
      <div className="spacer" />
      {children}
    </div>
  )
}

const CHEVRON = { left: 'M10 3 5 8l5 5', right: 'M6 3l5 5-5 5', up: 'M3 10l5-5 5 5', down: 'M3 6l5 5 5-5' }

function Chevron({ direction }: { direction: keyof typeof CHEVRON }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={CHEVRON[direction]} />
    </svg>
  )
}
