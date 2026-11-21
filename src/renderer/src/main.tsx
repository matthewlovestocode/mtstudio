import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { engine, nativeEngine } from './engine'
import { initMidiInput } from './midiInput'
import * as platform from './platform'
import { APP_NAME } from '@shared/menu'
import { bridge, initAutosave, runCommand } from './platform'
import { disarmIfGone } from './recording'
import { setPluginState } from './state/actions'
import { useStudio } from './state/store'
import './styles.css'

// Keep the engine in step with the store.
engine.setProject(useStudio.getState().project)
useStudio.setState({ selectedTrackId: useStudio.getState().project.tracks[0]?.id ?? null })
useStudio.subscribe((state, previous) => {
  if (state.project !== previous.project) {
    engine.setProject(state.project)
    disarmIfGone()
  }
  if (state.metronome !== previous.metronome) engine.setMetronome(state.metronome)
  if (state.filePath !== previous.filePath || state.dirty !== previous.dirty || state.project.name !== previous.project.name) {
    const name = state.filePath?.split(/[\\/]/).pop() ?? state.project.name
    const title = `${state.dirty ? '• ' : ''}${name} — ${APP_NAME}`
    document.title = title
    bridge?.setDocumentState({ title, dirty: state.dirty })
  }
})
nativeEngine?.onPluginState(setPluginState)
engine.onTransport((playing) => useStudio.setState(playing ? { playing } : { playing, recordingFrom: null }))
initMidiInput()
void initAutosave()
bridge?.onMenuCommand(runCommand)

// Handy in the dev tools console.
if (import.meta.env.DEV) Object.assign(window, { __studio: { engine, store: useStudio, platform } })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
