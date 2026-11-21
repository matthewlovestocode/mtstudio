// SFZ instruments, played by sfizz: a text file that maps samples across the
// keyboard, with the samples beside it. Long samples are streamed from disk.
#pragma once

#include "Sampled.h"
#include <memory>

struct sfizz_synth_t;

namespace studio
{
class SfzPlayer : public SampledInstrument
{
public:
    /**
     * A player for an .sfz file, named by its path within the content folder.
     * Null if the file is missing or defines nothing playable; `problem` then
     * says which. `offline` is for rendering faster than real time: samples
     * are then read in full as they are needed, where a live player starts a
     * note from the part it holds in memory and streams the rest. Any thread
     * but the audio thread.
     */
    static std::shared_ptr<SfzPlayer> create (const juce::String& file, double rate, bool offline);
    /** Why the last `create` that returned null did; empty if none has. */
    static juce::String problem();

    ~SfzPlayer() override;
    void process (float* left, float* right, int frames, const PluginEvent* events, int count) override;

private:
    SfzPlayer() = default;

    sfizz_synth_t* synth = nullptr;
    /** A chunk's worth each of left and right, for sfizz to write to. */
    std::unique_ptr<float[]> buffer;
};
} // namespace studio
