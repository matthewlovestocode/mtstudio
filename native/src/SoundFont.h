// SoundFont instruments: presets of a General MIDI bank (or any .sf2), played
// by FluidSynth. Every track that plays one has a synthesiser of its own,
// which loads just the samples its preset uses.
#pragma once

#include "Sampled.h"
#include <memory>

struct _fluid_synth_t;
struct _fluid_hashtable_t;

namespace studio
{
/** One track's SoundFont instrument: a preset of the bank, with its own sounding voices. */
class SoundFontPlayer : public SampledInstrument
{
public:
    /**
     * A player for a preset, at the engine's sample rate. Null if there is no
     * SoundFont to play from or it has no such preset; `problem` then says
     * which. Reads the SoundFont's index and the preset's samples from disk,
     * so: any thread but the audio thread.
     */
    static std::shared_ptr<SoundFontPlayer> create (int bank, int program, double rate);
    /** Why the last `create` that returned null did; empty if none has. */
    static juce::String problem();
    /** Where the SoundFont is looked for: `STUDIO_SOUNDFONT`, or MuseScore General in the content folder. */
    static juce::File file();

    ~SoundFontPlayer() override;
    void process (float* left, float* right, int frames, const PluginEvent* events, int count) override;

private:
    SoundFontPlayer() = default;

    _fluid_hashtable_t* settings = nullptr;
    _fluid_synth_t* synth = nullptr;
    /** A chunk's worth each of left and right, for FluidSynth to write to. */
    std::unique_ptr<float[]> buffer;
};
} // namespace studio
