# What the engine is built from, and the sound it plays

None of this is in the repository. The code is fetched when the engine is
built (`native/CMakeLists.txt`), or used from a checkout in `native/deps/`;
the sound is fetched by `npm run fetch:content` (`native/content/manifest.json`).
Anyone passing the app on must pass these licences on with it.

| What | Version | Licence | Used for |
| --- | --- | --- | --- |
| [JUCE](https://github.com/juce-framework/JUCE) | 9.0.6 | AGPL-3.0 (or JUCE's commercial licence) | Audio devices, audio files, plugin hosting |
| [FluidSynth](https://github.com/FluidSynth/fluidsynth) | 2.6.2 | LGPL-2.1-or-later | Playing SoundFont instruments; linked statically |
| [gcem](https://github.com/kthohr/gcem) | as pinned by FluidSynth 2.6.2 | Apache-2.0 | Compile-time maths inside FluidSynth; headers only |
| [sfizz](https://github.com/sfztools/sfizz) | 1.2.3 | BSD-2-Clause | Playing SFZ instruments; linked statically |
| sfizz's own dependencies, in its `external/` and `src/external/` | as pinned by sfizz 1.2.3 | Apache-2.0 (Abseil), MIT, MIT-0, BSD-3-Clause, BSL-1.0, WTFPL and others, all permissive; listed in sfizz's README | Parsing, audio file decoding, DSP |
| MuseScore General (SoundFont) | 0.2 | MIT | The General MIDI instruments; see `content/licenses/MuseScore_General_License.md` |

The app itself is AGPL-3.0-or-later (`LICENSE`).
