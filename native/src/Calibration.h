// Measuring the round trip from the output to the input: the engine plays a
// short pattern of noise bursts while recording the input, and the delay at
// which the recording best matches the pattern is how late a recorded sound
// lands in a take.
#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

namespace studio
{
/** The test signal: bursts of noise at uneven intervals, so only one delay lines them all up. */
inline std::vector<float> calibrationSignal (double rate)
{
    // Leaves room after the last burst for a round trip of up to half a second.
    static constexpr double starts[] = { 0.10, 0.31, 0.47, 0.72, 0.89, 1.13, 1.30, 1.52 };
    std::vector<float> signal ((size_t) (rate * 2.2), 0.0f);
    const auto length = (int) (rate * 0.008);
    uint32_t seed = 0x2545f491u;
    for (const double start : starts)
    {
        const auto at = (size_t) (start * rate);
        for (int i = 0; i < length; ++i)
        {
            seed = seed * 1664525u + 1013904223u;
            const double white = (double) (seed >> 8) / 8388608.0 - 1.0;
            // A raised-cosine window keeps each burst from clicking at its edges.
            const double window = 0.5 - 0.5 * std::cos (6.283185307179586 * i / (length - 1));
            signal[at + (size_t) i] = (float) (white * window * 0.6);
        }
    }
    return signal;
}

struct DelayMeasurement
{
    /** The delay, in frames, at which the recording best matches the signal. */
    int frames = 0;
    /** How far that match stands above the rest: the peak over the typical value at other delays. */
    double clarity = 0;
};

/** Finds the delay of `signal` within `recorded` (mono), searching up to `maxDelay` frames. */
inline DelayMeasurement measureDelay (const std::vector<float>& signal, const std::vector<float>& recorded, int maxDelay)
{
    // Only the bursts matter; skipping the silence between them keeps this quick.
    std::vector<int> active;
    for (size_t n = 0; n < signal.size(); ++n)
        if (signal[n] != 0.0f) active.push_back ((int) n);

    DelayMeasurement best;
    double peak = 0, sumSquares = 0;
    int counted = 0;
    for (int delay = 0; delay <= maxDelay; ++delay)
    {
        double sum = 0;
        for (const int n : active)
            if ((size_t) (n + delay) < recorded.size()) sum += (double) signal[(size_t) n] * recorded[(size_t) (n + delay)];
        // A microphone or speaker may flip the polarity, so the size of the match is what counts.
        const double match = std::abs (sum);
        sumSquares += match * match;
        ++counted;
        if (match > peak) { peak = match; best.frames = delay; }
    }
    const double typical = counted > 0 ? std::sqrt (sumSquares / counted) : 0.0;
    best.clarity = typical > 0 ? peak / typical : 0.0;
    return best;
}
} // namespace studio
