#include "Sfz.h"
#include "Model.h"

#include <mutex>
#include <sfizz.h>

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

/** Enough for dense chords with long releases and layered instruments. */
constexpr int voices = 96;
} // namespace

void SampledInstrument::sortByFrame (const PluginEvent* events, int count, int* order)
{
    for (int i = 0; i < count; ++i)
    {
        int at = i;
        for (; at > 0 && events[order[at - 1]].frame > events[i].frame; --at) order[at] = order[at - 1];
        order[at] = i;
    }
}

juce::String SfzPlayer::problem()
{
    const std::lock_guard lock (failureLock);
    return failure;
}

std::shared_ptr<SfzPlayer> SfzPlayer::create (const juce::String& file, double rate, bool offline)
{
    const auto folder = contentFolder();
    const auto from = folder.getChildFile (file);
    // A project names its instrument by a path within the content folder, and nothing outside it is opened.
    if (file.isEmpty() || ! from.isAChildOf (folder) || ! from.existsAsFile())
    {
        fail ("The SFZ instrument " + file + " was not found in " + folder.getFullPathName() + ".");
        return nullptr;
    }

    auto player = std::shared_ptr<SfzPlayer> (new SfzPlayer());
    player->key = "sfz:" + file + "@" + juce::String (rate);
    auto* synth = player->synth = sfizz_create_synth();
    sfizz_set_sample_rate (synth, (float) rate);
    sfizz_set_samples_per_block (synth, Strip::maxBlock);
    sfizz_set_num_voices (synth, voices);
    if (offline) sfizz_enable_freewheeling (synth);
    if (! sfizz_load_file (synth, from.getFullPathName().toRawUTF8()) || sfizz_get_num_regions (synth) == 0)
    {
        fail (from.getFileName() + " could not be read as an SFZ instrument, or has no samples that could be found.");
        return nullptr;
    }
    player->buffer = std::make_unique<float[]> ((size_t) Strip::maxBlock * 2);
    return player;
}

SfzPlayer::~SfzPlayer()
{
    if (synth != nullptr) sfizz_free (synth);
}

void SfzPlayer::process (float* left, float* right, int frames, const PluginEvent* events, int count)
{
    // sfizz takes each note with how far into the coming chunk it falls, and renders the chunk in one go.
    int order[Strip::maxPluginEvents];
    count = std::min (count, Strip::maxPluginEvents);
    sortByFrame (events, count, order);
    for (int i = 0; i < count; ++i)
    {
        const auto& event = events[order[i]];
        const int delay = juce::jlimit (0, std::max (0, frames - 1), event.frame);
        if ((event.data[0] & 0xf0) == 0x90 && event.data[2] > 0) sfizz_send_note_on (synth, delay, event.data[1], event.data[2]);
        else sfizz_send_note_off (synth, delay, event.data[1], 0);
    }

    float* channels[2] = { buffer.get(), buffer.get() + Strip::maxBlock };
    sfizz_render_block (synth, channels, 2, frames);
    for (int i = 0; i < frames; ++i)
    {
        left[i] += channels[0][i];
        right[i] += channels[1][i];
    }
}
} // namespace studio
