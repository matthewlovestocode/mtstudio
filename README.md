# mtstudio

A digital audio workstation for the desktop: tracks, a piano roll, a step sequencer with drum patterns by style, bass, chord and synth parts, mic recording, effects, and SoundFont, SFZ and plugin instruments.

## Download the app

For Macs with Apple silicon (M1 or later), macOS 13 or later. On an Intel Mac, Windows or Linux, [run it from source](#run-from-source).

**The short way.** Paste this into Terminal. It downloads the latest release, puts mtstudio in Applications and opens it:

```bash
curl -fsSL https://raw.githubusercontent.com/matthewlovestocode/mtstudio/main/scripts/install.sh | bash
```

**By hand.**

1. Download `mtstudio-…-mac-arm64.zip` from the [latest release](https://github.com/matthewlovestocode/mtstudio/releases/latest).
2. Unzip it and drag mtstudio into Applications.
3. Open it. macOS will say it cannot verify the app, because mtstudio is not signed with an Apple developer certificate. Click **Done**, then go to System Settings › Privacy & Security, scroll down, and click **Open Anyway**. This is needed once. (The short way above does not meet this warning.)

Either way, the first time mtstudio starts it downloads its instrument sounds (216 MB), showing how far it has got. After that it opens straight to a demo project; press Space to play.

To update, do the same again with the newer release. macOS may ask about the microphone again after an update.

## Run from source

For development, or for machines the download does not cover. It takes about fifteen minutes the first time, most of it waiting for the audio engine to build.

mtstudio is developed on macOS. The code has paths for Windows and Linux, but they have not been tried.

### What you need first

| What | Why | How to get it (macOS) |
| --- | --- | --- |
| [Node.js](https://nodejs.org) 22 or newer | Runs the app | Installer from nodejs.org, or `brew install node` |
| Git | Downloads the source, and the engine's libraries when it is built | Comes with Xcode's command line tools |
| A C++ compiler | Builds the audio engine | `xcode-select --install` |
| [CMake](https://cmake.org) 3.22 or newer | Builds the audio engine | `brew install cmake` |

You also need about 2 GB of free disk space and an internet connection for the first build.

### Get it and run it

1. **Get the source.**

   ```bash
   git clone https://github.com/matthewlovestocode/mtstudio.git
   ```

   ```bash
   cd mtstudio
   ```

   Without Git, use **Code › Download ZIP** on the [project page](https://github.com/matthewlovestocode/mtstudio), unzip it and `cd` into the folder.

2. **Install the app's own dependencies.**

   ```bash
   npm install
   ```

3. **Build the audio engine.** This downloads JUCE, FluidSynth and sfizz and compiles them. Expect five to ten minutes the first time; later builds take seconds.

   ```bash
   npm run build:native
   ```

4. **Download the instrument sounds.** One 216 MB SoundFont (MuseScore General), which gives you the General MIDI instruments and drum kits. The file is checked against a checksum after it downloads.

   ```bash
   npm run fetch:content
   ```

5. **Start the app.**

   ```bash
   npm run dev:native
   ```

The very first start downloads Electron itself (about 100 MB), so it takes a minute longer. Then a window opens with a demo project. Press Space to play.

From then on, step 5 is all you need. Leave the terminal open while you use the app; closing it, or pressing Ctrl+C in it, quits mtstudio.

### The quick way, without the audio engine

If you only want a look, skip steps 3 and 4:

```bash
npm install
```

```bash
npm run dev
```

This runs on the browser's own audio. The built-in synth, sampler and drum machine work, but there are no SoundFont, SFZ or plugin instruments, no drum kits by style and no mic recording.

## Optional extras

- **More instruments.** The browser inside the app offers free SFZ packs (basses, pianos, drums and others) and installs them for you. Each is a few hundred megabytes.
- **Surge XT.** If the free [Surge XT](https://surge-synthesizer.github.io) synthesizer is installed, its patches appear in mtstudio's instrument picker.
- **Microphone.** The first time you record, macOS asks whether to allow the microphone. Run from source, the app is started from a terminal, so the permission may be asked for under your terminal's name. If recording is refused, allow it in System Settings › Privacy & Security › Microphone.

## Making a release

For whoever maintains the project. Set the new version in `package.json`, commit, then tag it and push the tag:

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

GitHub Actions ([release.yml](.github/workflows/release.yml)) builds the engine and the app and attaches the zip to a release of that name. `npm run dist` builds the same zip locally, into `dist/`.

## If something goes wrong running from source

| What you see | What to do |
| --- | --- |
| A message at start-up that there is no engine | Step 3 did not finish. Run `npm run build:native` again and read the last lines it prints. |
| `cmake: command not found` | Install CMake (`brew install cmake`). |
| The build stops with compiler errors about missing headers | Run `xcode-select --install`, then build again. |
| Instruments are silent, or the picker shows no SoundFont presets | Step 4 did not finish. Run `npm run fetch:content` again. |
| `fetch:content` says a file does not match its checksum | The download was cut short. Run it again; it removes the bad file itself. |
| The engine build is broken beyond repair | Delete `native/build` and run `npm run build:native` again. |

## Licence

mtstudio is free software under the GNU Affero General Public License, version 3 or later; see [LICENSE](LICENSE). The libraries the engine is built from and the sounds it plays have their own licences, listed in [native/THIRD_PARTY.md](native/THIRD_PARTY.md).
