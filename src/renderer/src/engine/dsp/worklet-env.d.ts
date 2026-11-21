/** The globals available inside an AudioWorklet, which TypeScript's DOM library does not describe. */
declare const sampleRate: number
declare const currentTime: number
declare const currentFrame: number

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}

declare function registerProcessor(name: string, processor: new (options: never) => AudioWorkletProcessor): void
