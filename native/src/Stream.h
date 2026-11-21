// Audio played from disk: a long file is read a block at a time, a few
// seconds ahead of where it is being played, so memory does not grow with
// its length. The audio thread never touches the disk: it asks for a block,
// gets it if it is in memory (silence if not), and leaves a note of what it
// wanted for the loader thread to act on.
#pragma once

#include <juce_audio_formats/juce_audio_formats.h>
#include <atomic>
#include <deque>
#include <memory>
#include <vector>

#include "Voices.h"

namespace studio
{
class DiskStream
{
public:
    static constexpr int blockShift = 15;
    /** About two thirds of a second at 48 kHz. */
    static constexpr int blockFrames = 1 << blockShift;
    /** Seconds kept loaded ahead of anything being played. */
    static constexpr double readAhead = 3.0;

    struct Block
    {
        /** One frame more than a block, so reading between two frames never needs the next block. */
        float data[2][blockFrames + 1];
    };

    /**
     * Opens a file for streaming; null if it cannot be read. A `synchronous`
     * stream loads blocks on demand in the caller's thread: for offline
     * rendering, which cannot wait on a loader.
     */
    static std::shared_ptr<DiskStream> open (const juce::File& file, bool synchronous)
    {
        auto reader = makeReader (file);
        if (reader == nullptr || reader->lengthInSamples <= 1 || reader->lengthInSamples > 0x7fffffff) return nullptr;
        return std::shared_ptr<DiskStream> (new DiskStream (file, std::move (reader), synchronous));
    }

    ~DiskStream()
    {
        for (auto& block : blocks) delete block.load();
        for (auto& [block, when] : retired) delete block;
    }

    const juce::File file;
    const double rate;
    const int length;
    const bool stereo;

    /** A second stream on the same file for offline use. */
    std::shared_ptr<DiskStream> synchronousCopy() const { return open (file, true); }

    /** The whole file in memory: for time-stretching, which needs all of it. Slow. */
    std::shared_ptr<const Sample> readAll() const
    {
        auto reader = makeReader (file);
        if (reader == nullptr) return nullptr;
        auto sample = std::make_shared<Sample>();
        sample->rate = rate;
        sample->length = length;
        sample->stereo = stereo;
        float* channels[2] = { nullptr, nullptr };
        for (int c = 0; c < (stereo ? 2 : 1); ++c)
        {
            sample->channels[c].assign ((size_t) length, 0.0f);
            channels[c] = sample->channels[c].data();
        }
        reader->read (channels, stereo ? 2 : 1, 0, length);
        return sample;
    }

    // ── Audio thread ──────────────────────────────────────────────────────

    /** Says that block `index` is, or soon will be, needed. `now` is a millisecond clock. */
    void want (int index, uint32_t now) const noexcept
    {
        if (index >= 0 && index < (int) wanted.size()) wanted[(size_t) index].store (now, std::memory_order_relaxed);
    }

    /** The block, if it is in memory. Also counts as wanting it. */
    const Block* block (int index, uint32_t now) const
    {
        if (index < 0 || index >= (int) blocks.size()) return nullptr;
        wanted[(size_t) index].store (now, std::memory_order_relaxed);
        auto* found = blocks[(size_t) index].load (std::memory_order_acquire);
        if (found == nullptr && synchronous) found = const_cast<DiskStream*> (this)->loadNow (index);
        return found;
    }

    // ── Loader thread ─────────────────────────────────────────────────────

    /** Loads what has lately been wanted and the stretch after it; lets go of what has not been needed for a while. */
    void service (uint32_t now)
    {
        const int ahead = (int) std::ceil (readAhead * rate / blockFrames);
        const int count = (int) blocks.size();
        for (int i = 0; i < count; ++i)
        {
            if (now - wanted[(size_t) i].load (std::memory_order_relaxed) > 1000) continue;
            for (int b = i; b <= std::min (count - 1, i + ahead); ++b)
            {
                keep[(size_t) b] = now;
                if (blocks[(size_t) b].load() == nullptr) blocks[(size_t) b].store (read (b), std::memory_order_release);
            }
        }
        for (int i = 0; i < count; ++i)
        {
            if (blocks[(size_t) i].load() == nullptr || now - keep[(size_t) i] < 5000) continue;
            // The audio thread may be part-way through this block, so it is freed a little later, not now.
            retired.push_back ({ blocks[(size_t) i].exchange (nullptr), now });
        }
        while (! retired.empty() && now - retired.front().second > 1000)
        {
            delete retired.front().first;
            retired.pop_front();
        }
    }

    /** Blocks in memory right now. */
    int loadedBlocks() const
    {
        int loaded = 0;
        for (const auto& block : blocks) loaded += block.load() != nullptr ? 1 : 0;
        return loaded;
    }

private:
    DiskStream (const juce::File& fileIn, std::unique_ptr<juce::AudioFormatReader> readerIn, bool synchronousIn)
        : file (fileIn), rate (readerIn->sampleRate), length ((int) readerIn->lengthInSamples), stereo (readerIn->numChannels > 1),
          synchronous (synchronousIn), reader (std::move (readerIn)),
          blocks ((size_t) ((length + blockFrames - 1) >> blockShift)), wanted (blocks.size()), keep (blocks.size(), 0)
    {
        // "Long ago", so nothing counts as wanted until the audio thread says so.
        const uint32_t never = juce::Time::getMillisecondCounter() - 0x40000000u;
        for (auto& stamp : wanted) stamp.store (never);
    }

    static std::unique_ptr<juce::AudioFormatReader> makeReader (const juce::File& file)
    {
        juce::AudioFormatManager formats;
        formats.registerBasicFormats();
        auto stream = file.createInputStream();
        if (stream == nullptr) return nullptr;
        return std::unique_ptr<juce::AudioFormatReader> (formats.createReaderFor (std::move (stream)));
    }

    Block* read (int index)
    {
        auto* block = new Block();
        const auto start = (juce::int64) index << blockShift;
        const int frames = (int) std::min<juce::int64> (blockFrames + 1, length - start);
        float* channels[2] = { block->data[0], block->data[1] };
        // Past the end of the file (or if the file has gone) the block stays silent.
        std::fill (block->data[0], block->data[0] + blockFrames + 1, 0.0f);
        std::fill (block->data[1], block->data[1] + blockFrames + 1, 0.0f);
        if (frames > 0) reader->read (channels, stereo ? 2 : 1, start, frames);
        if (! stereo) std::copy (block->data[0], block->data[0] + blockFrames + 1, block->data[1]);
        return block;
    }

    /** Synchronous streams keep only the last few blocks. */
    Block* loadNow (int index)
    {
        auto* block = read (index);
        blocks[(size_t) index].store (block);
        recent.push_back (index);
        if (recent.size() > 8)
        {
            delete blocks[(size_t) recent.front()].exchange (nullptr);
            recent.pop_front();
        }
        return block;
    }

    const bool synchronous;
    std::unique_ptr<juce::AudioFormatReader> reader;
    std::vector<std::atomic<Block*>> blocks;
    /** When each block was last asked for, written by the audio thread. */
    mutable std::vector<std::atomic<uint32_t>> wanted;
    /** When each block was last worth keeping. Loader thread only. */
    std::vector<uint32_t> keep;
    std::deque<std::pair<Block*, uint32_t>> retired;
    std::deque<int> recent;
};
} // namespace studio
