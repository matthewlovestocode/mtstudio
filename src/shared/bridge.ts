/** The API the preload script exposes to the renderer as `window.studio`. */
import type { NativeEngineBridge } from './nativeEngine'
import type { StreamInfo } from './pcm'

import type { MenuCommand } from './menu'

export type { MenuCommand }

/**
 * A project on disk is a folder:
 *
 *   My Song/
 *     My Song.studio    the project (JSON)
 *     audio/            every audio file the project uses
 *
 * A "project path" below is always the path of the `.studio` file.
 */
export interface OpenedProject {
  path: string
  json: string
}

export interface SaveRequest {
  /** Where the project currently lives, or null if it has never been saved. */
  path: string | null
  /** Ask for a new location even if `path` is set. */
  saveAs: boolean
  json: string
}

export interface SaveResult {
  path: string
  name: string
  /** New asset paths, by asset id, after files were gathered into the project folder. */
  assetPaths: Record<string, string>
}

export interface StudioBridge {
  /** Writes the project and copies its audio into the project folder. Null if cancelled. */
  saveProject(request: SaveRequest): Promise<SaveResult | null>
  openProject(): Promise<OpenedProject | null>
  /** Reads an audio file; `assetPath` may be relative to the project folder. Null if missing. */
  readAudioFile(projectPath: string | null, assetPath: string): Promise<ArrayBuffer | null>
  /**
   * Whether a file can be played from disk a piece at a time (`stream` is
   * null if not), and its size. Compressed files become streamable once
   * `conformAudio` has stored a decoded copy.
   */
  probeAudio(projectPath: string | null, assetPath: string): Promise<{ stream: StreamInfo | null; bytes: number } | null>
  /** Raw PCM bytes for a range of frames of a streamable file. */
  readAudioRange(projectPath: string | null, assetPath: string, frame: number, count: number): Promise<ArrayBuffer>
  /** A streamable file's waveform overview, computed once and then cached on disk. */
  audioPeaks(projectPath: string | null, assetPath: string): Promise<{ peaks: ArrayBuffer; secondsPerPeak: number; duration: number } | null>
  /** Stores a decoded copy of a compressed file: 'begin', any number of 'data' steps, then 'end'. */
  conformAudio(projectPath: string | null, assetPath: string, step: ConformStep): Promise<void>
  /**
   * Stores a new recording, in the project folder if there is one, otherwise
   * in a holding area until the project is first saved. Resolves to the asset path.
   */
  writeRecording(projectPath: string | null, name: string, data: ArrayBuffer): Promise<string>
  /** Asks where to save a file and writes it. Resolves to the path, or null if cancelled. */
  exportFile(defaultName: string, data: ArrayBuffer): Promise<string | null>
  /** Crash-recovery snapshot; null clears it. */
  writeAutosave(data: string | null): Promise<void>
  readAutosave(): Promise<string | null>
  /** Absolute path of a File chosen or dropped by the user. */
  pathForFile(file: File): string
  onMenuCommand(handler: (command: MenuCommand) => void): void
  setDocumentState(state: { title: string; dirty: boolean }): void
  /** The link to the native audio engine; null when the app is running on the Web Audio engine. */
  nativeEngine: NativeEngineBridge | null
}

export const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'aif', 'aiff', 'opus', 'webm']

export type ConformStep =
  | { type: 'begin'; sampleRate: number; channels: number; frames: number }
  /** Interleaved 32-bit float samples. */
  | { type: 'data'; data: ArrayBuffer }
  | { type: 'end' }
