#include "SoundFont.h"
#include "Model.h"

#include <fluidsynth.h>
#include <mutex>

namespace studio
{
namespace
{
std::mutex failureLock;
juce::String failure;

void fail (const juce::String& why)
{
    const std::lock_guard lock (failureLock);
    failure = why;
}

/**
 * How loud a player is. FluidSynth's own default (0.2) leaves headroom for a
 * whole General MIDI song on one synthesiser; here each track has its own.
 * Measured across the 128 General MIDI presets at a velocity of 0.8, this
 * puts the typical note's peak at about 0.25 and the loudest preset's at
 * about 0.6: in the range of a note from the engine's own synth.
 */
constexpr double gain = 1.2;

/** Enough for dense chords with long releases; a note often takes two or three voices. */
constexpr int polyphony = 128;

/** FluidSynth reports to stderr by default; only its errors are wanted there. */
void quietenOnce()
{
    static std::once_flag once;
    std::call_once (once, []
    {
        for (const int level : { FLUID_WARN, FLUID_INFO, FLUID_DBG }) fluid_set_log_function (level, nullptr, nullptr);
    });
}
} // namespace

juce::File SoundFontPlayer::file()
{
    const auto named = juce::SystemStats::getEnvironmentVariable ("STUDIO_SOUNDFONT", {});
    if (named.isNotEmpty()) return juce::File (named);
    return contentFolder().getChildFile ("MuseScore_General.sf2");
}

juce::String SoundFontPlayer::problem()
{
    const std::lock_guard lock (failureLock);
    return failure;
}

std::shared_ptr<SoundFontPlayer> SoundFontPlayer::create (int bankNumber, int program, double rate)
{
    quietenOnce();
    const auto from = file();
    if (! from.existsAsFile())
    {
        fail ("No SoundFont was found at " + from.getFullPathName() + ". Run `npm run fetch:content` to download it.");
        return nullptr;
    }

    auto player = std::shared_ptr<SoundFontPlayer> (new SoundFontPlayer());
    player->key = "soundfont:" + juce::String (bankNumber) + ":" + juce::String (program) + "@" + juce::String (rate);
    auto* settings = player->settings = new_fluid_settings();
    fluid_settings_setnum (settings, "synth.sample-rate", rate);
    fluid_settings_setnum (settings, "synth.gain", gain);
    fluid_settings_setint (settings, "synth.polyphony", polyphony);
    // The track's own effects and sends do this work; the SoundFont's built-in reverb and chorus would be a second, unasked-for layer.
    fluid_settings_setint (settings, "synth.reverb.active", 0);
    fluid_settings_setint (settings, "synth.chorus.active", 0);
    // A player sounds one preset, so only that preset's samples are read in, not the whole file.
    fluid_settings_setint (settings, "synth.dynamic-sample-loading", 1);
    // After this function only the audio thread touches the synthesiser, so it need not lock, and renders on that thread alone.
    fluid_settings_setint (settings, "synth.threadsafe-api", 0);
    fluid_settings_setint (settings, "synth.cpu-cores", 1);

    auto* synth = player->synth = new_fluid_synth (settings);
    if (synth == nullptr)
    {
        fail ("The SoundFont player could not be started.");
        return nullptr;
    }
    const int font = fluid_synth_sfload (synth, from.getFullPathName().toRawUTF8(), 0);
    if (font == FLUID_FAILED)
    {
        fail (from.getFileName() + " could not be read as a SoundFont.");
        return nullptr;
    }
    if (fluid_synth_program_select (synth, 0, font, bankNumber, program) == FLUID_FAILED)
    {
        fail ("The SoundFont has no preset " + juce::String (program) + " in bank " + juce::String (bankNumber) + ".");
        return nullptr;
    }
    player->buffer = std::make_unique<float[]> ((size_t) Strip::maxBlock * 2);
    return player;
}

SoundFontPlayer::~SoundFontPlayer()
{
    if (synth != nullptr) delete_fluid_synth (synth);
    if (settings != nullptr) delete_fluid_settings (settings);
}

void SoundFontPlayer::process (float* left, float* right, int frames, const PluginEvent* events, int count)
{
    int order[Strip::maxPluginEvents];
    count = std::min (count, Strip::maxPluginEvents);
    sortByFrame (events, count, order);

    auto* l = buffer.get();
    auto* r = l + Strip::maxBlock;
    int done = 0;
    const auto renderTo = [&] (int to)
    {
        if (to <= done) return;
        const int n = to - done;
        fluid_synth_write_float (synth, n, l, 0, 1, r, 0, 1);
        for (int i = 0; i < n; ++i)
        {
            left[done + i] += l[i];
            right[done + i] += r[i];
        }
        done = to;
    };

    for (int i = 0; i < count; ++i)
    {
        const auto& event = events[order[i]];
        renderTo (juce::jlimit (0, frames, event.frame));
        if ((event.data[0] & 0xf0) == 0x90 && event.data[2] > 0) fluid_synth_noteon (synth, 0, event.data[1], event.data[2]);
        else fluid_synth_noteoff (synth, 0, event.data[1]);
    }
    renderTo (frames);
}
} // namespace studio
