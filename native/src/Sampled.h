// Instruments played from sound content on disk (a SoundFont preset, an SFZ
// instrument) rather than by the engine's own voices. The engine treats them
// alike: it sends each the notes for a chunk and asks for the chunk's audio.
#pragma once

#include <juce_core/juce_core.h>

namespace studio
{
struct PluginEvent;

class SampledInstrument
{
public:
    virtual ~SampledInstrument() = default;

    /**
     * Renders a chunk, adding to what is in `left` and `right`. `events` are
     * note-ons and note-offs as for a plugin instrument, each taking effect
     * on its exact frame; they need not be in order. Audio thread.
     */
    virtual void process (float* left, float* right, int frames, const PluginEvent* events, int count) = 0;

    /**
     * What it plays, and at what sample rate: two instruments with the same
     * key sound the same, so a track keeps the one it has (and its sounding
     * notes) for as long as its key does not change.
     */
    juce::String key;

    /** The folder sound content is in: `STUDIO_CONTENT`, or `content/` beside the engine's `bin/`. */
    static juce::File contentFolder()
    {
        const auto named = juce::SystemStats::getEnvironmentVariable ("STUDIO_CONTENT", {});
        if (named.isNotEmpty()) return juce::File (named);
        return juce::File::getSpecialLocation (juce::File::currentExecutableFile).getParentDirectory().getSiblingFile ("content");
    }

protected:
    /**
     * Fills `order` with the positions of `count` events in order of frame.
     * They arrive as they were thought of (note-ons as the sequencer found
     * them, then the note-offs due in the chunk); equal frames keep that order.
     */
    static void sortByFrame (const PluginEvent* events, int count, int* order);
};
} // namespace studio
