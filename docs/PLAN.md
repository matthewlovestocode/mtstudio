# Studio — plan

A general-purpose DAW in Electron: an arrangement timeline holding MIDI clips
(piano roll, built-in instruments) and audio clips (import, record, edit),
mixed through per-track channel strips.

## Decisions

| Area | Choice | Why |
| --- | --- | --- |
| Product shape | Balanced MIDI + audio, linear arrangement | Classic DAW; both clip kinds share one timeline model |
| Audio engine | Web Audio now, behind an interface a native engine can replace | Fast to build; keeps the door open for low latency and VST3/AU hosting |
| Native engine | C++ with JUCE (9.0.6), as a sidecar process speaking JSON lines over stdio | See Milestone 5 |
| UI | React + TypeScript + Vite (electron-vite) | Ecosystem; fast HMR |
| State | Zustand store holding one immutable `Project` | Cheap undo/redo, trivial save/load, easy to snapshot to an engine |
| Musical time | Ticks, 960 PPQ | Integer positions, tempo-independent editing |

## Architecture

```
┌────────────── Electron main (src/main) ──────────────┐
│ window, app menu, file dialogs, disk I/O              │
└──────────────▲────────────────────────────────────────┘
               │ IPC through a narrow preload bridge (src/preload, src/shared/bridge.ts)
┌──────────────┴─────────── Renderer (src/renderer) ────┐
│ UI (React)  ──edits──▶  Store (Project + history)     │
│      ▲                        │ project snapshots     │
│      │ position, meters       ▼                       │
│      └──────────────  AudioEngine (interface)         │
│                        └─ WebAudioEngine (default)    │
│                        └─ NativeEngine ─ IPC ─▶ main ─ stdio ─▶ studio-engine (native/)
└────────────────────────────────────────────────────────┘
```

### The rule that keeps "native later" possible

The UI never touches Web Audio. It talks only to `AudioEngine`
(`src/renderer/src/engine/types.ts`), and everything crossing that boundary is
plain serialisable data:

- **Down:** whole `Project` snapshots (`setProject`), transport commands, raw
  audio file bytes (`loadAsset`), live note on/off.
- **Up:** playhead position, peak meters, waveform peaks, transport events.

The native engine (Milestone 5) implements the same interface from a separate
process: `setProject` becomes a message, position and meters come back as a
stream of small events. Nothing in the UI changes apart from a badge in the
transport bar saying which engine is in use.

### Project model (`src/shared/model.ts`)

`Project → Track[] → Clip[]`, plus an `assets` table for audio files.

- `MidiClip` holds `Note[]` with positions relative to the clip.
- `AudioClip` references an asset and an offset into it; audio plays at its
  natural speed (no time-stretch yet), so the clip's tick length is a window
  onto the file.
- `bpm` and `beatsPerBar` are the tempo and time signature at the start;
  `tempoChanges` (by tick) and `meterChanges` (by bar) hold later ones. Code
  never does tempo arithmetic itself: it asks `timeMap(project)`.
- On disk a project is a folder: `My Song/My Song.studio` (this structure as
  JSON) plus `My Song/audio/`. Saving gathers every audio file the clips use
  into `audio/` and stores relative paths, so the folder can be moved or
  shared. Recordings made before the first save wait in the app's data
  folder and are moved in on save.
- A snapshot of unsaved work is written to the app's data folder every 15
  seconds and offered back on the next launch if the app did not close
  cleanly.

### Interface (`src/renderer/src/components`, `styles/`)

- **Layout (`Shell.tsx`):** the transport bar across the top; under it the
  inspector down the left, the arrangement, and a dock beneath the
  arrangement with the clip editor and the mixer as tabs. Panels resize and
  fold away (`layout.ts` remembers how), and the inspector and each dock tab
  can be brought out into a window of its own (`PopOut.tsx`): an empty
  window the page fills in, so it shares the store and the engine. The main
  process allows only those windows to be opened.
- **Controls (`components/controls`):** knob, fader, buttons and toggles,
  menus and context menus, and a searchable picker. Knobs and faders share
  one behaviour (`value.ts`): drag, Shift for fine, double-click to reset,
  arrow keys. Sizes and colours come from the tokens in `styles/tokens.css`.
- **Arrangement (`Timeline.tsx`):** one snap setting that every drag obeys;
  drag across empty lanes to select; a loop region to drag and resize in
  the ruler; a menu on right-click for clips, lanes, the ruler and markers.
- **Clip editors:** the piano roll (`PianoRoll.tsx`) and, for audio clips,
  a waveform with the clip's settings beside it (`AudioClipEditor.tsx`).

Left over:
- Tempo is typed, not dragged; there is no way to bypass snap while dragging
- Panel windows are not remembered between sessions, and their meters stop
  while the main window is minimised
- No settings window (devices, buffer size, which engine); no browser panel
  for instruments, plugins and files
- The mixer has no sends, effect slots or master fader

### Instruments and sound content

The native engine is where instruments are heading: new ones are written
once, in C++, and the Web Audio engine's three (synth, drum machine,
sampler) stay as they are. A track whose instrument needs the native engine
is silent in the Web Audio engine, and the inspector says so.

- **SoundFont (`native/src/SoundFont.h`):** a track's instrument can be a
  preset of a General MIDI SoundFont, played by FluidSynth (LGPL-2.1, the
  reference player, built as a static library with its optional parts
  switched off; see `native/CMakeLists.txt`). Each track has a synthesiser
  of its own, which reads in only the samples its preset uses: the grand
  piano, the largest, costs about 120 MB and most presets far less. It is
  sent notes as plugin instruments are, on the exact sample. The
  SoundFont's own reverb and chorus are off; the track's effects and sends
  do that work. The app lists the presets by reading the file's index
  itself (`src/main/soundfont.ts`). TinySoundFont was tried first and
  dropped: it does not apply a SoundFont's modulators, which MuseScore
  General's pianos are built on, and they came out 20 dB too quiet at
  middle velocities.
- **SFZ (`native/src/Sfz.h`):** a track's instrument can be an SFZ
  instrument, played by sfizz (BSD-2-Clause, built into the engine as
  static libraries). A project names it by its path within the content
  folder (`sfz/Pack/Instrument.sfz`), and nothing outside that folder is
  opened. Each track has a player of its own; long samples are streamed
  from disk, and an offline render makes the player read them as needed
  instead (`SnapshotBuilder::offline`). The app lists what is installed by
  walking `content/sfz` (`src/main/sfz.ts`); the folder under `sfz/` is the
  pack, and each pack is a group in the instrument picker. SoundFont and
  SFZ players share one interface (`Sampled.h`), so the engine's note and
  mixing code does not tell them apart.
- **Surge XT:** not part of the app, but made much of where it is
  installed. It is hosted as any plugin instrument is; beyond that, the
  app lists its patches itself (`src/main/surge.ts`, some 3,000 of them
  under Surge's own folders) and offers them in the instrument picker by
  category. A Surge patch file holds exactly what Surge saves as its
  plugin state, so choosing one sets the track's instrument to Surge XT
  with `Track.pluginState` made from the file, in the wrapping JUCE's
  VST3 host uses; the engine needs to know nothing about patches. The
  picker draws at most 300 rows of a long list and relies on typing to
  narrow it.
- **Content (`native/content`):** sound files are not in the repository.
  `manifest.json` lists each with where it comes from, its SHA-256, its
  licence and whom to credit; `npm run fetch:content` downloads and checks
  them; the licence texts in `licenses/` are committed and must go wherever
  the files go. So far: MuseScore General (MIT), 128 General MIDI
  instruments, 37 drum kits and about 140 variations.
- **Licences:** the app is AGPL-3.0-or-later (JUCE's open-source terms).
  Content is taken under CC0, MIT or CC-BY; non-commercial licences are
  not; share-alike is decided case by case.

Left over:
- SFZ has only been played from a one-sample test instrument (pitch,
  timing to the sample, release and failure cases checked offline). No
  real pack is installed yet: the open ones are large (Salamander piano
  about 700 MB, VSCO 2 CE about 2.3 GB as repositories), and
  `fetch-content` only knows single files, not packs
- sfizz is left at its own output level, which for the test instrument is
  some 10 dB under the SoundFont's; to be judged against real instruments
- Surge XT must be installed by the user, and found by a plugin scan,
  before its patches are offered; shipping it with the app is a packaging
  job. Only its VST3 is given patches this way. The track's label keeps
  the patch's name even after the sound is changed in Surge's window
- Levels have been checked (every General MIDI preset rises evenly with
  velocity at middle C, none is silent); tone has not been listened to
- Two tracks on the same preset each read its samples in; whether
  FluidSynth shares them has not been measured
- The live path (playing from the keyboard, the piano roll's audition) has
  only been exercised through the offline render, which shares the mixing
  but not the note commands
- The piano roll shows note names, not drum names, for a SoundFont drum kit
- A library to browse and download content from, and Surge XT as a
  bundled synth

### Web Audio engine (`engine/WebAudioEngine.ts`)

- **Lookahead scheduler:** a 25 ms timer schedules everything in the next
  120 ms against `AudioContext.currentTime`, so timing is sample-accurate and
  immune to UI jank. It reads the latest project snapshot each pass, so edits
  made during playback are heard.
- **Transport:** a list of `(contextTime, tick)` anchors; looping and tempo
  changes just push a new anchor.
- **Channel strip per track:** input → insert effects → volume → pan →
  mute/solo gate → master, with a meter tap and send gains to buses. Master
  goes through a safety limiter.
- **DSP in AudioWorklets (`engine/dsp/`):** instruments (synth, drum machine,
  sampler), insert effects (EQ, compressor, delay, reverb) and meters run on
  the audio thread as three processors, bundled from TypeScript into one
  script. The DSP itself (`voices.ts`, `effects.ts`, `biquad.ts`) is plain
  arithmetic on sample arrays with no Web Audio calls, which is what makes it
  portable to WASM or a native engine. `worklets.ts` holds the main-thread
  handles; `protocol.ts` the messages.
- **Sample-accurate notes:** the scheduler posts each note to its track's
  instrument stamped with its start time; the processor begins it on the
  exact sample. An offline render hands instruments their whole performance
  at creation, because messages cannot be relied on to arrive in time when
  rendering faster than real time.
- Still native nodes: faders, pan, sends, audio-clip playback, the metronome
  and the master limiter (which adds 6 ms of latency to everything equally;
  its automatic make-up gain is trimmed back out so it is level-neutral).

## Milestones

### 1 — Playable slice (done)
- Electron shell, menu, save/open project
- Transport: play/stop, seek, tempo, loop region, metronome
- MIDI and audio tracks with volume, pan, mute, solo, meters
- Timeline: create, move, resize, duplicate, delete clips; drop audio files
- Piano roll: add, move, resize, delete notes with snapping and audition
- Synth parameter panel
- Undo/redo

### 2 — Recording and project hygiene (done)
- Audio recording: arm a track, record; input captured in an AudioWorklet and
  written as 32-bit float WAV; optional input monitoring; takes are shifted
  by the reported round-trip latency
- MIDI input via Web MIDI and the computer keyboard: live play and recording
  to clips
- Project folders with audio gathered on save; autosave and crash recovery;
  unsaved-changes prompt on close
- Clip editing: split at playhead, trim either edge, fades and gain on audio
  clips, drag clips between tracks, multi-select (shift/cmd-click)
- Export mixdown to 24-bit WAV (same graph on an `OfflineAudioContext`)

Left over from this milestone:
- Latency compensation trusts what the browser reports; a loopback
  calibration and a manual offset setting would make it exact
- No input device picker (the system default input is used)
- Velocity for keyboard-played notes
- Packaged builds need a microphone usage description (and signing) before
  macOS will grant input access

### 3 — Mixing and instruments (done)
- Insert effects per track: 3-band EQ, compressor, feedback delay, algorithmic
  reverb, with bypass; parameters defined once in `src/shared/effects.ts`
- Buses and post-fader sends (buses stay audible when another track is soloed)
- Instruments per track: synth, a synthesised drum machine (General MIDI note
  layout, drum names in the piano roll) and a sampler (one sample repitched
  from a root note)
- Automation lanes for volume and pan, drawn over the track lane; applied by
  the scheduler and in mixdowns
- All of the above render in the offline mixdown
- Tempo map and time-signature changes: a Tempo row and a Signature row under
  the ruler; every tick↔seconds conversion goes through `timeMap(project)`
  (`src/shared/timemap.ts`). Tempo changes are steps, not ramps. Audio clips
  keep their length in seconds when the tempo changes or they are moved

- DSP moved into AudioWorklets: instruments, effects and meters

Left over from this milestone:
- Compile the DSP to WASM (Rust or C++) if CPU becomes a limit; today it is
  TypeScript running in the worklet
- Smooth effect parameter changes (EQ and mix changes are applied at once)
- Tempo ramps; dragging tempo and signature markers; tap tempo
- Route a track's output to a bus (group buses), not just sends
- Automation for effect and instrument parameters
- Sampler: multi-sample zones and looping; sample-based drum kits

### 4 — Scale and polish (done)
- Timeline virtualisation: only bars, clips and the slice of each waveform
  near the visible stretch are rendered, in a window that moves in steps.
  The timeline is still DOM plus per-clip canvases rather than one big
  canvas; virtualising it gave the scaling without rewriting every drag
  interaction. Revisit only if a profile shows the DOM is the bottleneck
- Zoom around the pointer (pinch or Cmd/Ctrl-scroll), scroll-follow, markers
- Time-stretch and pitch-shift for audio clips: WSOLA in a web worker
  (`engine/dsp/stretch.ts`), cached per file and ratio; pitch is done by
  stretching and then playing at a different speed
- MIDI tools: note selection, quantise, transpose, velocity lane

- Streaming of long files (Electron only): files of a minute or more are
  played from disk in two-second pieces read a few seconds ahead and
  cross-faded at the joins (`engine/stream.ts`), so memory does not grow with
  file length. WAVs are streamed as they are; large compressed files are
  decoded once to a float WAV in the app's `audio-cache` folder and streamed
  from that. Short files and sampler samples stay in memory
- Waveform peak cache on disk, keyed by file content so a copy of a file in
  a project folder reuses it

Left over from this milestone:
- The audio cache is never cleaned up, and a conformed copy is large (about
  23 MB a minute in stereo)
- Stretching a streamed clip, and exporting a project that uses one, still
  loads that whole file into memory for the duration
- The first decode of a long compressed file happens in memory; only after
  that is it streamed
- Stretch quality: WSOLA softens sharp transients such as drum hits; a
  transient-preserving or phase-vocoder mode would fix that. Stretched
  copies are never evicted from memory
- Quantise strength and swing

### 5 — Native engine (started)

Decisions:

- **C++ with JUCE.** Plugin hosting is the main reason to go native, and JUCE
  has VST3 and AU hosting, scanning and plugin windows ready-made. Tracktion
  Engine was passed over because it brings its own project model and sound;
  Rust with cpal because it has no mature VST3/AU host. JUCE is AGPLv3 or
  commercial: distributing Studio closed-source would need a JUCE licence.
  JUCE is not vendored: `native/CMakeLists.txt` uses a checkout in
  `native/deps/JUCE` if there is one and otherwise fetches the pinned tag.
- **A sidecar process over stdio**, not an addon and not (yet) a socket with
  shared memory. The main process starts `native/bin/studio-engine` and
  relays one JSON object per line: commands to its stdin, events from its
  stdout (`src/shared/nativeEngine.ts` defines both). The engine sends the
  playhead and meters 60 times a second and the renderer carries the
  playhead on between reports. A plugin crash cannot take the app down,
  nothing is rebuilt per Electron version, and the engine quits when its
  stdin closes. Shared memory needs an addon on the Electron side anyway, so
  it waits until a profile asks for it.
- **Choosing the engine:** `STUDIO_ENGINE=native` at start-up
  (`npm run dev:native`), after `npm run build:native` (needs CMake and
  Xcode's compiler). Web Audio is the default; if the native binary is
  missing the app says so and falls back to it. `STUDIO_ENGINE_PATH`
  overrides where the binary is looked for. A plain browser tab always gets
  Web Audio.

What it covers so far (`native/src`, `src/main/nativeEngine.ts`,
`engine/NativeEngine.ts`):

- Opens the default audio output; the input is only opened when an audio
  track is armed, so there is no microphone prompt before then
- Takes whole `Project` snapshots; the audio thread swaps them in without
  locking or allocating, and edits made during playback are heard
- Plays MIDI clips on all three instruments, each note started on its exact
  sample from a port of `TimeMap`, including tempo changes and the loop
  region. The synth, drum machine and sampler are ports of the voices in
  `engine/dsp/voices.ts` (`native/src/Synth.h`, `Voices.h`); rendered
  offline, the sampler and the noise-free drums match the TypeScript to
  within rounding, and the noisy drums match in level and length
- `loadAsset`: the main process hands the bytes over as a temporary file,
  the engine decodes it with `juce_audio_formats` (WAV, AIFF, FLAC, Ogg,
  MP3, and what Core Audio reads), converts it to the device's sample rate
  (windowed sinc), keeps it in memory and returns the waveform overview
- Audio clips: offset, gain and fades, keeping their length in seconds
  across tempo changes. A clip's audio is worked out from the project clock
  on every block rather than started and stopped, so seeking, looping and
  edits during playback need no bookkeeping
- Time-stretched and pitch-shifted clips: a port of the WSOLA stretcher
  (`native/src/Stretch.h`) makes a stretched copy of the file on a
  background thread, cached per file and ratio; the clip is silent until
  it is ready (under half a second for a 70-second file) and is then read
  at the speed the pitch change calls for. A mixdown does any missing
  stretching itself. Output matches the TypeScript stretcher to within
  rounding
- Streaming of long files: `loadAssetStream` gives the engine the path of
  the WAV (the file itself or its conformed copy) and the engine plays it
  from disk in blocks of about two thirds of a second (`native/src/Stream.h`).
  The audio thread only ever takes a block that is already in memory and
  notes what it wanted; a loader thread reads those blocks and three
  seconds beyond, and lets go of blocks unused for five seconds. Clips
  about to start, and clips under the playhead while stopped, are read in
  ahead. A 100-second stereo file costs about 6 MB instead of over 70 MB,
  and sounds within milliseconds of pressing play. Mixdowns and stretching
  read the file directly. A file that is not at the device's sample rate
  is declined and loaded into memory instead, where it is converted
- Per-track fader, pan (Web Audio's panning law), mute and solo; a master
  limiter; per-track and master peak meters
- Insert effects (EQ, compressor, delay, reverb: ports of
  `engine/dsp/effects.ts` in `native/src/Effects.h`), with bypass. Each
  keeps its tail across edits by effect id. Rendered offline, each effect,
  a chain of four and a send through a reverb bus match the TypeScript to
  within rounding
- Buses and post-fader sends; buses are mixed after the tracks that feed
  them and stay open under solo
- Volume and pan automation: while the transport runs, a parameter with
  points follows its curve sample by sample (straight lines in time between
  breakpoints, instant steps where two points share a tick); when it stops,
  the parameter eases back to its control
- Play, stop, seek, metronome, live notes (piano roll audition, MIDI and
  typing keyboard), and MIDI recording (the transport ignores the loop)
- Mixdown: the engine renders the whole project plus a four-second tail to
  a stereo 24-bit WAV on a thread of its own, with a fresh set of strips
  and effects, so playback carries on and neither affects the other. The
  loop and the metronome are left out. The demo renders in about 0.1 s
- Audio input: arming an audio track reopens the device with the default
  input (the main process asks macOS for microphone access first and
  refuses plainly if it is denied). With monitoring on, the input joins the
  armed track's strip ahead of its effects and fader
- Audio recording: the take starts on the very frame the transport does, so
  its first sample belongs at the start tick with no pre-roll. The audio
  thread queues the raw input; the engine's message thread collects it and
  writes a float WAV on stop. The offset handed back with the take is the
  device's reported input latency plus output latency plus one block. A
  plain stop abandons the take
- Latency calibration: the "Native" badge opens a panel with a Measure
  button. The engine plays two seconds of noise bursts at uneven intervals
  while recording the input, and the delay at which the recording best
  matches is the round trip (`native/src/Calibration.h`). A result is only
  accepted if the match stands well clear of the rest. It is stored per
  output and input device in `native-engine.json` in the app's data folder
  and used for takes in place of the device's figure. On the built-in
  speakers and microphone it measured 77.1 ms four times running, where the
  device reports 86.5 ms
- Plugin hosting: VST3 and Audio Unit plugins as insert effects (on tracks
  and buses) and as a MIDI track's instrument (`native/src/Plugins.h`,
  `.cpp`, with `juce_audio_processors`). In the project a plugin effect is
  an `Effect` of type `'plugin'` with a `plugin` record, and a plugin
  instrument is `instrument: 'plugin'` with `Track.plugin`; the record's
  `description` is the engine's own text, which is what it loads from.
  The Web Audio engine passes plugin effects over and leaves a plugin
  instrument's track silent, and the inspector says so
  - Scanning: "Look for plugins…" at the foot of the Add effect list. Each
    plugin is loaded to be examined in a child process (the engine run with
    `--scan-plugins`), so one that crashes or hangs (30 s) only loses
    itself and is reported as not examined. The list is kept in
    `plugins.json` in the app's data folder; nothing is scanned until asked
    for. Audio Unit mixers, panners and generators are left out
  - Each plugin is set to stereo in and out with its other buses off, and
    is told the tempo, time signature and position. Instruments get their
    notes on the exact sample, from the sequencer and from live playing
  - Windows: "Open window" shows the plugin's own editor (or a plain list
    of its parameters if it has none) in a window owned by the engine
    process, which runs as an application without a Dock icon. Plugin
    windows float above everything while Studio's window is in front
  - Settings: when a plugin's parameters change, the engine reads its whole
    state (at most twice a second) and reports it; the app records it in the
    project (`Effect.state`, `Track.pluginState`, base64), a run of reports
    being one undo step. States are left out of `setProject` and sent with
    `pluginState` only when they differ from what the engine has, since
    they can be large. Undoing to before any change puts back the state the
    plugin started with
  - A mixdown loads its own instances and gives them the state the playing
    ones are in at that moment
  - A plugin that cannot be loaded is reported in the inspector and the
    track plays without it
  - Delay compensation: a plugin that reports latency (a look-ahead
    limiter, a pitch shifter) no longer puts its track late. Every track
    is held back, after its effects and before its fader, to match the
    track whose plugins take longest; the tracks' sum is held back by the
    most any bus's plugins take, and each bus by what it takes less than
    that (`CompDelay` in `native/src/Model.h`, worked out when a snapshot
    is built). The metronome is held back by the same total, a mixdown
    leaves that much off its start, and a take's offset grows by it, since
    the player heard the music that much later. A plugin whose latency
    changes while loaded is noticed within half a second. Rendered offline
    with Apple's Audio Units (96 to 4096 frames of latency), a dry track
    beside a slow one comes out delayed by exactly the reported figure,
    and the processed sound lines up with it
  - The engine's events go out on a private copy of its stdout, so nothing
    a plugin prints can corrupt the protocol
  - A side-chain input is fed the track's own audio, so a gate or
    compressor that listens to it behaves as an ordinary one (switched off,
    it would be keyed by silence and shut for good). Extra outputs are off
  - Setting a plugin's state is done with the audio thread standing aside,
    and is followed by a reset: some plugins only take restored settings
    into their processing when prepared or reset
  - `STUDIO_PLUGIN_PATH` names extra folders to scan (colon-separated), for
    VST3 plugins kept outside the usual places
  - Tried with Apple's built-in Audio Units and with seven of JUCE's
    example plugins built as VST3 (none of them a commercial plugin): a
    plain gain, a multi-stage effect with a large custom editor, a
    side-chain gate, a surround tester, a MIDI arpeggiator, a synth with an
    audio input and an on-screen keyboard, and a sixteen-output synth. All
    load, play, save and restore their state and open their windows, in the
    engine and from the app. A VST3 is described by the scan without being
    loaded, so nothing is known of its channels until it is used
  - Two of those examples (the gain and the synth) were also installed as
    Audio Units in `~/Library/Audio/Plug-Ins/Components`, as third-party
    Audio Units are: found by the scan, they behave as their VST3 versions
    do, and the synth's window shows the tempo, time signature and position
    the engine gives plugins
- `studio-engine --list-plugins` scans and prints what it finds;
  `--plugin-info description.xml [index=value …]` loads one plugin, sets
  parameters and prints its parameters and state
- `studio-engine --calibrate-test …` runs the measurement against a
  simulated loop; `--capture …` plays a project with a file standing in for
  the input, for testing monitoring and takes without a microphone
- `studio-engine --render project.json <seconds> out.wav` renders offline
  through the same code to a float WAV, for checking timing and levels
  without a sound card
- Every method of `AudioEngine` is implemented and nothing a project can
  hold is left unplayed

Remaining:

- Stretch quality is the Web Audio engine's: WSOLA softens sharp
  transients. A native engine could use a better stretcher (a library such
  as Rubber Band, licence permitting), at the cost of the two engines
  sounding different. Stretched copies are never freed
- Seeking to a part of a streamed file that is not in memory gives a few
  tens of milliseconds of silence on that clip while it is read (logged by
  the engine). The Web Audio engine instead delays every seek by 30 ms.
  Streamed files at other sample rates need a resampling reader rather
  than the fall-back to memory. Streams are never closed
- Assets are decoded on the engine's message thread (meters pause during a
  long decode) and are never freed
- Clips cut off abruptly on stop and seek (as in the Web Audio engine); a
  few milliseconds of fade would avoid clicks
- Effects are sized for the sample rate in force when they are created; if
  the output device changes rate they should be rebuilt
- Audio input has been run once against the built-in microphone (arm,
  record three seconds, take appears as a clip and plays back); capture and
  monitoring are otherwise tested with a file standing in for the input.
  Whether takes line up with the music is unmeasured. Still to do: choosing the input and output device
  and buffer size; a manual trim on top of the measured latency; measuring
  the monitoring latency this milestone exists for. A recording made after
  calibrating has not been checked against the music end to end. When input and output are
  different devices JUCE joins them with a resampling buffer whose delay is
  not in the reported figures
- Opening or closing the input restarts the audio device: a short dropout,
  and possibly a new sample rate, which loaded audio and effects are not
  rebuilt for
- A take is held in memory until stop, then crosses to the app through a
  temporary file; long takes should be written to disk as they go
- Plugins:
  - No commercial plugin has been tried, nor an Audio Unit of the newer
    (v3, app-extension) kind. Plugin windows have been seen in screen captures, Audio Unit
    and VST3, drawn properly and floating above Studio, but none has been
    clicked or typed in (the engine still pumps its run loop by hand rather than running a
    real `NSApplication` loop, which some editors may not like)
  - Delay compensation trusts what each plugin reports, and has limits:
    everything, live notes and input monitoring included, is as late as
    the slowest plugin (there is no low-latency mode that sets slow
    plugins aside while playing in); the playhead and meters are not held
    back to match; fader and pan automation act on audio that is late by
    the tracks' share of the delay; turning a slow plugin on or off, or a
    change in its latency, shifts the sound with a click; a track's
    latency counts even if the track is muted; at most 2.7 seconds are
    made up for. The longer take offset and the noticing of a latency
    change have not been exercised
  - Plugin parameters cannot be automated or shown in the inspector; the
    `pluginParam` command exists but only tests send it
  - A plugin runs inside the engine process, so one that crashes takes
    playback with it (the app survives and the badge turns red). Loading a
    plugin or setting its state blocks the engine's message thread, so
    meters pause while a heavy one loads
  - Plugins are prepared for the sample rate in force when they load, and
    are not told if the device changes
  - Scanning examines plugins one after another; with hundreds installed
    the first scan will take minutes, and there is no progress display or
    way to choose folders. The Add effect list can be
    searched, but has no folders, favourites or recently used
  - Mono or surround plugins are only handled by fitting them to stereo.
    There is no routing of another track into a side chain, and a
    multi-output instrument is heard through its first output only
  - Plugins that work on notes rather than audio (arpeggiators, chord
    tools) are listed among the effects when they are VST3, and do nothing
    there: a plugin's MIDI output goes nowhere, and effects are sent no
    notes
  - Plugin windows are not remembered between sessions, and a plugin's
    state is not reported until something changes it
- Protocol: send project changes rather than whole snapshots if large
  projects make that slow; restart the engine if it dies (today the badge
  turns red and playback is refused until the app is restarted); report
  the playhead as heard rather than as rendered (output latency is known
  but not yet subtracted)
- The master limiter differs from Web Audio's: it adds no latency and
  clamps down the instant a peak arrives, where Web Audio's looks 6 ms
  ahead. Mixes that reach it (the demo does) come out at a similar level
  but not sample for sample. A mixdown could afford a look-ahead limiter
  even if live playback keeps the instant one
- A mixdown comes back through a temporary file and is held in memory by
  the app before it is saved, as with the Web Audio engine; the engine
  could write straight to the chosen path. Temporary folders are left
  behind (empty unless a transfer was under way) if the app is killed
- Packaging: ship and sign the binary in the app's resources; Windows and
  Linux builds are untried
- An engine setting in the UI instead of an environment variable
- Some callers' alerts are worded for other failures ("Could not read…"
  when the native engine declines an import)

## Risks to watch

- **Latency:** Web Audio output latency on macOS is typically 10–25 ms. Fine
  for sequencing, marginal for monitoring live input — the main trigger for
  Milestone 5.
- **Memory:** fully decoded audio is ~10 MB per stereo minute. Long sessions
  need the streaming work in Milestone 4.
- **Plugin hosting** is impossible in the renderer; it only arrives with the
  native engine.
- **Two engines to keep in step:** the instruments and effects exist in
  TypeScript and in C++ (`native/src/Synth.h`, `Voices.h`, `Effects.h`, `Stretch.h`). Until the native engine takes
  over, a change to one must be made to the other.
