import { PREVIEW_TOGGLE, acceleratorLabel } from '@shared/menu'
import { setUi, usePreview, type Ui } from './preview'

const OPTIONS: [Ui, string][] = [
  ['current', 'Current'],
  ['next', 'Preview']
]

/**
 * The switch between the two interfaces. Over the current interface it floats
 * in the corner of the window; the reworked one has a place for it in the
 * dock's bar (`inline`), where it covers nothing.
 */
export function Switch({ inline = false }: { inline?: boolean }): React.JSX.Element {
  const ui = usePreview((s) => s.ui)
  const shortcut = acceleratorLabel(PREVIEW_TOGGLE.accelerator, navigator.platform.startsWith('Mac'))
  return (
    <div className={inline ? 'ui-switch inline' : 'ui-switch'} role="group" aria-label="Interface" title={`Switch between the current interface and the reworked one (${shortcut})`}>
      {OPTIONS.map(([value, label]) => (
        <button key={value} className={ui === value ? 'on' : ''} aria-pressed={ui === value} onClick={() => setUi(value)}>
          {label}
        </button>
      ))}
    </div>
  )
}
