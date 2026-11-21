import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { MenuCommand, StudioBridge } from '@shared/bridge'
import type { NativeEngineBridge, NativeEvent } from '@shared/nativeEngine'

// The main process says which engine was chosen at start-up (see createWindow).
const nativeEngine: NativeEngineBridge | null = process.argv.includes('--studio-engine=native')
  ? {
      send: (command) => ipcRenderer.send('engine:command', command),
      loadAsset: (assetId, data) => ipcRenderer.invoke('engine:loadAsset', assetId, data),
      openStream: (assetId, projectPath, assetPath) => ipcRenderer.invoke('engine:openStream', assetId, projectPath, assetPath),
      render: () => ipcRenderer.invoke('engine:render'),
      setInput: (trackId, monitor) => ipcRenderer.invoke('engine:setInput', trackId, monitor),
      stopRecording: () => ipcRenderer.invoke('engine:stopRecording'),
      latency: () => ipcRenderer.invoke('engine:latency'),
      calibrateLatency: () => ipcRenderer.invoke('engine:calibrateLatency'),
      clearLatency: () => ipcRenderer.invoke('engine:clearLatency'),
      plugins: (rescan) => ipcRenderer.invoke('engine:plugins', rescan),
      onEvent: (handler) => {
        ipcRenderer.on('engine:event', (_event, event: NativeEvent) => handler(event))
      }
    }
  : null

const bridge: StudioBridge = {
  saveProject: (request) => ipcRenderer.invoke('project:save', request),
  openProject: () => ipcRenderer.invoke('project:open'),
  readAudioFile: (projectPath, assetPath) => ipcRenderer.invoke('audio:read', projectPath, assetPath),
  probeAudio: (projectPath, assetPath) => ipcRenderer.invoke('audio:probe', projectPath, assetPath),
  readAudioRange: (projectPath, assetPath, frame, count) => ipcRenderer.invoke('audio:readRange', projectPath, assetPath, frame, count),
  audioPeaks: (projectPath, assetPath) => ipcRenderer.invoke('audio:peaks', projectPath, assetPath),
  conformAudio: (projectPath, assetPath, step) => ipcRenderer.invoke('audio:conform', projectPath, assetPath, step),
  writeRecording: (projectPath, name, data) => ipcRenderer.invoke('audio:writeRecording', projectPath, name, data),
  exportFile: (defaultName, data) => ipcRenderer.invoke('file:export', defaultName, data),
  writeAutosave: (data) => ipcRenderer.invoke('autosave:write', data),
  readAutosave: () => ipcRenderer.invoke('autosave:read'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  onMenuCommand: (handler) => {
    ipcRenderer.on('menu', (_event, command: MenuCommand) => handler(command))
  },
  setDocumentState: (state) => ipcRenderer.send('window:document', state),
  nativeEngine
}

contextBridge.exposeInMainWorld('studio', bridge)
