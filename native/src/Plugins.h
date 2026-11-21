// Hosting of VST3 and Audio Unit plugins, as insert effects and as
// instruments. A plugin is created, shown and deleted on the message thread;
// the audio thread only calls `PluginSlot::process`.
#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <functional>
#include <map>

#include "Model.h"

namespace studio
{
/** One loaded plugin, set up for stereo and ready to process. Kept alive by the snapshots that use it. */
struct PluginSlot
{
    /** `offline` tells the plugin it is rendering faster than real time. Message thread, or with the message thread running. */
    PluginSlot (std::unique_ptr<juce::AudioPluginInstance> instanceIn, double rate, juce::AudioPlayHead* playHead, bool offline);
    /** The plugin itself is always deleted on the message thread, whichever thread lets go of the slot. */
    ~PluginSlot();

    /**
     * Audio thread. As an effect (`add` false) the plugin processes the block
     * in place; as an instrument it is given `events` and its output is added
     * to the block. If the plugin is busy (its state is being set) the block
     * is left as it is.
     */
    void process (float* left, float* right, int frames, const PluginEvent* events, int eventCount, bool add);

    std::unique_ptr<juce::AudioPluginInstance> instance;

private:
    int inputs = 0, outputs = 0;
    std::vector<int> sources;
    /** Room for every channel the plugin has, since it works on its inputs and outputs in one buffer. */
    juce::AudioBuffer<float> buffer;
    juce::MidiBuffer midi;
};

/** The key a plugin is known by: its track, and its effect id or "instrument". */
inline juce::String pluginKey (const juce::String& trackId, const juce::String& effectId)
{
    return trackId + "/" + (effectId.isEmpty() ? juce::String ("instrument") : effectId);
}

/** A plugin's whole state as base64 text, and back. */
juce::String pluginState (juce::AudioPluginInstance& instance);
void setPluginState (juce::AudioPluginInstance& instance, const juce::String& state);

/** Loads the plugin a project refers to (`description` is the text a scan gave). Null, with `error` set, if it cannot. */
std::shared_ptr<PluginSlot> createPlugin (const juce::AudioPluginFormatManager& formats, const juce::String& description, double rate,
                                          juce::AudioPlayHead* playHead, bool offline, juce::String& error);

/** One use of a plugin in a project. `effectId` is empty for a track's instrument. */
struct PluginUse
{
    juce::String trackId, effectId, trackName, name, description, state;
};
std::vector<PluginUse> pluginUses (const juce::var& project);

/**
 * Loads every plugin a project uses, for an offline render: fresh instances,
 * each given the state in `states` (by key) if it is there, otherwise the
 * state saved in the project. Failures are added to `errors`.
 */
std::map<juce::String, std::shared_ptr<PluginSlot>> createProjectPlugins (const juce::AudioPluginFormatManager& formats, const juce::var& project,
                                                                          double rate, juce::AudioPlayHead* playHead,
                                                                          const std::map<juce::String, juce::String>* states, juce::StringArray& errors);

/**
 * The plugins of the project being played: their instances, windows and
 * state. Message thread only.
 */
class PluginHost
{
public:
    PluginHost (const juce::AudioPluginFormatManager& formatsIn, juce::AudioPlayHead* playHeadIn);
    ~PluginHost();

    /** Loads the plugins the project has gained and lets go of the ones it has lost. */
    void sync (const juce::var& project, double rate);
    std::shared_ptr<PluginSlot> find (const juce::String& key) const;
    /** Gives a plugin the state the project holds; an empty state means the one it was created with. */
    void setState (const juce::String& key, const juce::String& state);
    /** Sets a parameter by its position in the plugin's list, 0 to 1. */
    void setParameter (const juce::String& key, int index, float value);
    /** Opens the plugin's window, or brings it to the front. Returns false if there is no such plugin. */
    bool show (const juce::String& key);
    /** Plugin windows float above everything while the app is in front, and not otherwise. */
    void setFocused (bool focused);
    /** Call regularly: reports plugins whose state has changed since it was last reported. */
    void poll();
    /** Every loaded plugin's state as it is now, by key. */
    std::map<juce::String, juce::String> states() const;

    /** A plugin's state changed (in its window, say) and the project should record it. */
    std::function<void (const juce::String& trackId, const juce::String& effectId, const juce::String& state)> onState;
    /** A plugin's latency changed, so the snapshot (which holds the delays that make up for it) is out of date. */
    std::function<void()> onLatency;
    /** A plugin was loaded (empty error) or could not be. */
    std::function<void (const juce::String& trackId, const juce::String& effectId, const juce::String& error)> onStatus;

private:
    struct Entry;
    void close (const juce::String& key);

    const juce::AudioPluginFormatManager& formats;
    juce::AudioPlayHead* playHead;
    std::map<juce::String, std::unique_ptr<Entry>> entries;
    bool appFocused = true;
    int ticks = 0;
};

/** One plugin a scan found. `description` is what `createPlugin` needs. */
struct ScannedPlugin
{
    juce::String name, manufacturer, format, description;
    bool instrument = false;
};

/**
 * Finds every installed plugin. Each is examined in a child process (this
 * executable run with `--scan-plugins`), so one that crashes or hangs only
 * loses itself; those are listed in `failed`. Slow, and blocking: call it
 * from a thread of its own.
 */
std::vector<ScannedPlugin> scanPlugins (juce::StringArray& failed);

/** The child process's side of `scanPlugins`: examines the plugins listed in `list` from line `start` on. */
int scanPluginsChild (const juce::File& list, int start);
} // namespace studio
