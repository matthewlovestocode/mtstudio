// The engine's view of a Studio project: an immutable snapshot built from the
// JSON the app sends (src/shared/model.ts), with everything the audio thread
// needs worked out in advance so it never parses, allocates or locks.
#pragma once

#include <juce_core/juce_core.h>
#include <atomic>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <vector>

#include "Effects.h"
#include "Voices.h"

namespace studio
{
constexpr double PPQ = 960.0;

/** A port of TimeMap in src/shared/timemap.ts. Tempo changes are steps. */
class TimeMap
{
public:
    struct Tempo { double tick, bpm, seconds; };
    struct Meter { double bar, tick, beats, barTicks, beatTicks; };
    struct Bar { double start, length, beatTicks; int beats; };

    TimeMap() { tempos.push_back ({ 0, 120, 0 }); meters.push_back ({ 0, 0, 4, PPQ * 4, PPQ }); }
    explicit TimeMap (const juce::var& project);

    double tickToSeconds (double tick) const;
    double secondsToTick (double seconds) const;
    double duration (double from, double to) const { return tickToSeconds (to) - tickToSeconds (from); }
    /** The tempo in force at a tick. */
    double bpmAt (double tick) const;
    Bar barAt (double tick) const;

private:
    std::vector<Tempo> tempos;
    std::vector<Meter> meters;
};

/** A note with its position on the timeline and its length in seconds at the tempo it plays at. */
struct TimedNote
{
    double tick;
    double seconds;
    int pitch;
    float velocity;
};

/** A MIDI message for a plugin instrument, `frame` frames into the chunk being rendered. */
struct PluginEvent
{
    int frame;
    uint8_t data[3];
};

/** A note a plugin instrument is sounding, and the absolute frame at which it is to be let go. */
struct PluginNote
{
    int pitch;
    int64_t offFrame;
    /** Played by hand rather than by the sequencer, so stopping the transport leaves it alone. */
    bool live;
};

/**
 * What persists for a track from one snapshot to the next: its sounding
 * voices and the smoothed state of its channel strip. Created on the control
 * thread, then touched only by the audio thread (apart from `peak`).
 */
struct Strip
{
    static constexpr int maxVoices = 64;
    static constexpr int maxBlock = 2048;

    explicit Strip (uint32_t uidIn) : uid (uidIn) {}

    const uint32_t uid;
    Voice voices[maxVoices];
    uint64_t voiceCounter = 0;
    float left[maxBlock] {};
    float right[maxBlock] {};
    /** Smoothed fader, pan and mute/solo gate; negative until first used. */
    float volume = -1, pan = 0, gate = -1;
    /** The automated fader and pan for each frame of the current chunk, written while the transport runs. */
    float autoVolume[maxBlock] {};
    float autoPan[maxBlock] {};
    /** Smoothed send levels, by position in the track's list of sends. */
    static constexpr int maxSends = 8;
    struct SendState { uint32_t bus = 0; float gain = 0; } sends[maxSends];
    /** For a track whose instrument is a plugin or a SoundFont: the notes it holds, and the messages for it in this chunk. */
    static constexpr int maxPluginNotes = 128, maxPluginEvents = 512;
    PluginNote pluginNotes[maxPluginNotes];
    int pluginNoteCount = 0;
    PluginEvent pluginEvents[maxPluginEvents];
    int pluginEventCount = 0;

    void pluginEvent (int frame, int status, int pitch, int velocity)
    {
        if (pluginEventCount < maxPluginEvents)
            pluginEvents[pluginEventCount++] = { frame, { (uint8_t) status, (uint8_t) pitch, (uint8_t) velocity } };
    }
    /** Lets go of sounding notes of a pitch (any pitch if negative), `frame` frames into the chunk. With `sequencedOnly`, held live notes stay. */
    void pluginRelease (int pitch, int frame, bool sequencedOnly = false)
    {
        for (int n = 0; n < pluginNoteCount;)
        {
            const auto& note = pluginNotes[n];
            if ((pitch >= 0 && note.pitch != pitch) || (sequencedOnly && note.live)) { ++n; continue; }
            pluginEvent (frame, 0x80, note.pitch, 0);
            pluginNotes[n] = pluginNotes[--pluginNoteCount];
        }
    }
    /** Highest output level since the control thread last read it. */
    std::atomic<float> peak { 0 };
};

/** An audio clip, placed in seconds on the project's clock (clips keep their length in seconds). */
struct ClipSnapshot
{
    /** When the clip starts on the timeline and how long it lasts, in seconds. */
    double start = 0, duration = 0;
    /** Seconds into the original file at which the clip begins. */
    double offset = 0;
    /**
     * For a stretched or repitched clip `sample` is the file time-stretched
     * to `ratio` times its length, read at `rate` times normal speed: the
     * length changes by ratio / rate and the pitch by rate. Both are 1 for
     * a plain clip.
     */
    double ratio = 1, rate = 1;
    double gain = 1, fadeIn = 0, fadeOut = 0;
    /** Kept alive by the snapshot, so the audio thread can read it for as long as it has the snapshot. */
    std::shared_ptr<const Sample> sample;
};

/** A breakpoint of an automation curve. */
struct AutoPoint
{
    double tick, value;
};

/** The value of a curve at a tick: straight lines between points, flat beyond the ends. A port of automationValue in model.ts. */
inline double automationValue (const std::vector<AutoPoint>& points, double tick)
{
    if (tick <= points.front().tick) return points.front().value;
    for (size_t i = 1; i < points.size(); ++i)
    {
        const auto& b = points[i];
        if (tick <= b.tick)
        {
            const auto& a = points[i - 1];
            return b.tick == a.tick ? b.value : a.value + (b.value - a.value) * (tick - a.tick) / (b.tick - a.tick);
        }
    }
    return points.back().value;
}

struct PluginSlot;
class SoundFontPlayer;
/** How many frames late a plugin's output is, by its own account. Message thread. */
int pluginLatency (const PluginSlot& plugin);

/**
 * A stereo delay that makes up for plugin latency elsewhere in the mix. It is
 * written to on every chunk, so the delay can change without a gap.
 */
struct CompDelay
{
    /** Frames of history kept; the longest delay is this less a chunk. */
    static constexpr int size = 1 << 17;
    static constexpr int longest = size - Strip::maxBlock;

    std::vector<float> left = std::vector<float> (size, 0.0f), right = std::vector<float> (size, 0.0f);
    int write = 0;

    /** Delays a block in place by `frames` frames. */
    void process (float* l, float* r, int count, int frames)
    {
        for (int i = 0; i < count; ++i)
        {
            left[(size_t) write] = l[i];
            right[(size_t) write] = r[i];
            const auto read = (size_t) ((write - frames) & (size - 1));
            l[i] = left[read];
            r[i] = right[read];
            write = (write + 1) & (size - 1);
        }
    }
};
/** Finds the loaded plugin for a key (see `pluginKey` in Plugins.h); null if it is not loaded. */
using PluginLookup = std::function<std::shared_ptr<PluginSlot> (const juce::String& key)>;

/** An active insert effect: one of the engine's own with the settings it should have, or a hosted plugin. */
struct EffectSlot
{
    std::shared_ptr<EffectUnit> unit;
    EffectParams params;
    std::shared_ptr<PluginSlot> plugin;
};

/** A copy of a track's output, after its fader and gate, into a bus. */
struct SendSnapshot
{
    /** The bus's strip, kept alive by the bus's own entry in the same snapshot. */
    Strip* bus = nullptr;
    float level = 0;
};

struct TrackSnapshot
{
    std::shared_ptr<Strip> strip;
    float volume = 1, pan = 0;
    bool audible = true;
    /** A bus has no clips; it is fed by other tracks' sends and mixed after them. */
    bool bus = false;
    /** Insert effects that are not bypassed, in signal order. */
    std::vector<EffectSlot> effects;
    /**
     * Delay compensation: after its effects the strip is held back by
     * `delayFrames`, so that it lines up with strips whose plugins are
     * slower. Null when no strip of its kind needs it.
     */
    std::shared_ptr<CompDelay> delay;
    int delayFrames = 0;
    std::vector<SendSnapshot> sends;
    /** Automation curves, sorted by tick; empty when the fader or pan control is in charge. */
    std::vector<AutoPoint> volumeCurve, panCurve;
    /** What a MIDI track plays; `none` for audio tracks and buses. */
    Instrument instrument = Instrument::none;
    /** The instrument, when it is a hosted plugin. */
    std::shared_ptr<PluginSlot> plugin;
    /** The instrument, when it is a SoundFont preset. It is sent notes as a plugin is. */
    std::shared_ptr<SoundFontPlayer> soundfont;
    /** Whether the instrument is sent notes as messages (a plugin or a SoundFont) rather than played by the engine's own voices. */
    bool takesEvents() const { return instrument == Instrument::plugin || instrument == Instrument::soundfont; }
    SynthParams params;
    SamplerParams sampler;
    /** Keeps the sampler's sample alive for as long as this snapshot is. */
    std::shared_ptr<const Sample> sample;
    /** Every playable note on the track, sorted by tick. */
    std::vector<TimedNote> notes;
    /** The track's playable audio clips: unstretched, with their audio loaded. */
    std::vector<ClipSnapshot> clips;
};

struct Snapshot
{
    TimeMap map;
    bool looping = false;
    double loopStart = 0, loopEnd = 0;
    std::vector<TrackSnapshot> tracks;
    /**
     * Delay compensation. Every track is held back to match the track with
     * the most plugin latency, and their sum by `busLatency`, the most any
     * bus has, with each bus held back by what it has less than that. The
     * whole mix therefore comes out `latency` frames late, in step.
     */
    int latency = 0, busLatency = 0;
};

/**
 * Decoded audio files by asset id, and time-stretched copies of them under
 * `stretchKey`.
 */
using AssetStore = std::map<juce::String, std::shared_ptr<const Sample>>;

/** A time-stretched copy of a file that a clip needs and the store does not have. */
struct StretchJob
{
    juce::String assetId;
    double ratio;
};

/** Where the copy of `assetId` stretched to `ratio` times its length is kept in an AssetStore. */
inline juce::String stretchKey (const juce::String& assetId, double ratio)
{
    return assetId + "|" + juce::String (ratio, 3);
}

/** Builds snapshots, keeping each track's Strip and effects alive across them by id. */
class SnapshotBuilder
{
public:
    /** `rate` is the engine's sample rate, which sizes the effects' delay lines. */
    std::shared_ptr<const Snapshot> build (const juce::var& project, const AssetStore& assets, double rate, const PluginLookup& plugins = {});
    /** The strip for a track id, or null. Control thread only. */
    Strip* find (const juce::String& trackId) const;
    const std::vector<std::pair<juce::String, std::shared_ptr<Strip>>>& strips() const { return current; }
    /** Stretched copies the last build wanted and did not find; their clips were left silent. */
    const std::vector<StretchJob>& missing() const { return wanted; }
    /** How many frames late the last snapshot built plays, to keep plugins with latency in step. */
    int latency() const { return lastLatency; }

private:
    std::vector<std::pair<juce::String, std::shared_ptr<Strip>>> current;
    /** Effects in use, by track id and effect id, so each keeps its tail when the project is edited. */
    std::map<juce::String, std::shared_ptr<EffectUnit>> effects;
    std::vector<StretchJob> wanted;
    /** SoundFont players by track id, kept so their notes ring on across edits. */
    std::map<juce::String, std::shared_ptr<SoundFontPlayer>> soundfonts;
    /** Compensation delays by track id, kept so they hold their audio across edits. */
    std::map<juce::String, std::shared_ptr<CompDelay>> delays;
    int lastLatency = 0;
    uint32_t nextUid = 1;
};

/**
 * Builds a snapshot with every stretched clip playable, doing any missing
 * stretching on the spot and adding the results to `assets`. Slow: for
 * offline rendering, not the message thread.
 */
std::shared_ptr<const Snapshot> buildWithStretches (SnapshotBuilder& builder, const juce::var& project, AssetStore& assets, double rate,
                                                    const PluginLookup& plugins = {});
} // namespace studio
