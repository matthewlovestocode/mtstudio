// SoundFont instruments: presets of a General MIDI bank (or any .sf2), played
// by FluidSynth. Every track that plays one has a synthesiser of its own,
// which loads just the samples its preset uses.
#pragma once

#include <juce_core/juce_core.h>
#include <memory>

struct _fluid_synth_t;
struct _fluid_hashtable_t;

namespace studio
{
struct PluginEvent;

/** One track's SoundFont instrument: a preset of the bank, with its own sounding voices. */
class SoundFontPlayer
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
    /** Where the SoundFont is looked for: `STUDIO_SOUNDFONT`, or `content/` beside the engine's `bin/`. */
    static juce::File file();

    ~SoundFontPlayer();

    /**
     * Renders a chunk, adding to what is in `left` and `right`. `events` are
     * note-ons and note-offs as for a plugin instrument, each taking effect
     * on its exact frame; they need not be in order. Audio thread.
     */
    void process (float* left, float* right, int frames, const PluginEvent* events, int count);

    const int bank, program;
    const double rate;

private:
    SoundFontPlayer (int bankIn, int programIn, double rateIn) : bank (bankIn), program (programIn), rate (rateIn) {}

    _fluid_hashtable_t* settings = nullptr;
    _fluid_synth_t* synth = nullptr;
    /** A chunk's worth each of left and right, for FluidSynth to write to. */
    std::unique_ptr<float[]> buffer;
};
} // namespace studio
