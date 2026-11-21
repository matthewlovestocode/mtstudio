// Time-stretching by waveform-similarity overlap-add (WSOLA): a port of
// timeStretch in src/renderer/src/engine/dsp/stretch.ts. The sound is cut
// into short overlapping grains that are laid down closer together or further
// apart, each nudged to where it lines up best with the last, so the length
// changes but the pitch does not. Keep it in step with the TypeScript.
#pragma once

#include <cmath>
#include <limits>
#include <memory>

#include "Voices.h"

namespace studio
{
/** Returns `input` made `ratio` times as long at the same pitch. Slow: not for the audio or message thread. */
inline std::shared_ptr<const Sample> timeStretch (const Sample& input, double ratio)
{
    const int channels = input.stereo ? 2 : 1;
    // Grains of about 40 ms, half overlapping.
    const auto size = (int) std::pow (2.0, std::round (std::log2 (input.rate * 0.04)));
    const int hop = size / 2, search = size / 4;
    const int inLength = input.length;
    const auto outLength = (int) std::floor (inLength * ratio);

    auto output = std::make_shared<Sample>();
    output->rate = input.rate;
    output->stereo = input.stereo;
    if (inLength < size * 2)
    {
        output->length = inLength;
        for (int c = 0; c < channels; ++c) output->channels[c] = input.channels[c];
        return output;
    }

    // Grain alignment is judged on a mono mix so the channels stay in step.
    std::vector<float> mix;
    const float* mono = input.channels[0].data();
    if (channels > 1)
    {
        mix.assign ((size_t) inLength, 0.0f);
        for (int c = 0; c < channels; ++c)
            for (int i = 0; i < inLength; ++i)
                mix[(size_t) i] = (float) ((double) mix[(size_t) i] + (double) input.channels[c][(size_t) i] / channels);
        mono = mix.data();
    }

    // A periodic Hann window: half-overlapped copies sum to exactly 1.
    std::vector<float> window ((size_t) size);
    for (int i = 0; i < size; ++i) window[(size_t) i] = (float) (0.5 - 0.5 * std::cos (6.283185307179586 * i / size));

    for (int c = 0; c < channels; ++c) output->channels[c].assign ((size_t) (outLength + size), 0.0f);
    const int lastStart = inLength - size;
    int previous = 0;

    for (int outPos = 0; outPos < outLength; outPos += hop)
    {
        const int ideal = std::min (lastStart, (int) std::floor (outPos / ratio + 0.5));
        int start = ideal;
        // What would have come next had the previous grain simply carried on.
        const int natural = previous + hop;
        if (outPos > 0 && natural <= lastStart)
        {
            double best = -std::numeric_limits<double>::infinity();
            for (int shift = -search; shift <= search; shift += 2)
            {
                const int candidate = ideal + shift;
                if (candidate < 0 || candidate > lastStart) continue;
                double match = 0;
                for (int i = 0; i < hop; i += 4) match += (double) mono[candidate + i] * (double) mono[natural + i];
                if (match > best)
                {
                    best = match;
                    start = candidate;
                }
            }
        }
        for (int c = 0; c < channels; ++c)
        {
            const float* source = input.channels[c].data();
            float* target = output->channels[c].data();
            for (int i = 0; i < size; ++i)
                target[outPos + i] = (float) ((double) target[outPos + i] + (double) source[start + i] * (double) window[(size_t) i]);
        }
        previous = start;
    }
    for (int c = 0; c < channels; ++c) output->channels[c].resize ((size_t) outLength);
    output->length = outLength;
    return output;
}
} // namespace studio
