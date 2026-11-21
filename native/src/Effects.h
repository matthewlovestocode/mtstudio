// Insert effects: ports of the EQ, compressor, delay and reverb in
// src/renderer/src/engine/dsp/effects.ts (and the filter in dsp/biquad.ts).
// Each processes a stereo block in place. Keep them in step with the
// TypeScript so both engines sound the same.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstring>
#include <vector>

namespace studio
{
enum class EffectType { eq, compressor, delay, reverb };

/**
 * An effect's settings, in the order of its parameters in
 * src/shared/effects.ts:
 *   eq          low, mid, midFreq, high
 *   compressor  threshold, ratio, attack, release, makeup
 *   delay       time, feedback, mix
 *   reverb      decay, tone, mix
 */
struct EffectParams
{
    double v[5] {};
    bool operator== (const EffectParams& other) const { return std::memcmp (v, other.v, sizeof (v)) == 0; }
};

/** A second-order filter (Audio EQ Cookbook formulas), transposed direct form II. */
struct Biquad
{
    enum Type { lowshelf, highshelf, peaking };
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;

    void set (Type type, double frequency, double q, double gainDb, double rate)
    {
        const double w0 = 6.283185307179586 * std::min (std::max (frequency, 10.0), rate * 0.49) / rate;
        const double c = std::cos (w0), s = std::sin (w0);
        const double A = std::pow (10.0, gainDb / 40.0);
        double n0, n1, n2, d0, d1, d2;
        if (type == peaking)
        {
            const double alpha = s / (2.0 * std::max (q, 0.01));
            n0 = 1 + alpha * A; n1 = -2 * c; n2 = 1 - alpha * A;
            d0 = 1 + alpha / A; d1 = -2 * c; d2 = 1 - alpha / A;
        }
        else
        {
            // Shelves, with a slope of 1.
            const double k = 2.0 * std::sqrt (A) * (s / 2.0) * 1.4142135623730951;
            if (type == lowshelf)
            {
                n0 = A * (A + 1 - (A - 1) * c + k); n1 = 2 * A * (A - 1 - (A + 1) * c); n2 = A * (A + 1 - (A - 1) * c - k);
                d0 = A + 1 + (A - 1) * c + k;       d1 = -2 * (A - 1 + (A + 1) * c);    d2 = A + 1 + (A - 1) * c - k;
            }
            else
            {
                n0 = A * (A + 1 + (A - 1) * c + k); n1 = -2 * A * (A - 1 + (A + 1) * c); n2 = A * (A + 1 + (A - 1) * c - k);
                d0 = A + 1 - (A - 1) * c + k;       d1 = 2 * (A - 1 - (A + 1) * c);      d2 = A + 1 - (A - 1) * c - k;
            }
        }
        b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0; a1 = d1 / d0; a2 = d2 / d0;
    }

    double tick (double x)
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

/**
 * One insert effect with its delay lines and filter state. Made on the
 * control thread (it allocates); after that only the audio thread touches it.
 */
class EffectUnit
{
public:
    EffectUnit (EffectType typeIn, double rateIn) : type (typeIn), rate (rateIn)
    {
        if (type == EffectType::delay)
        {
            delayL.assign ((size_t) std::ceil (rate * 2) + 2, 0.0f);
            delayR = delayL;
        }
        else if (type == EffectType::reverb)
        {
            // Delay-line lengths of the classic Freeverb design, in samples at 44.1 kHz.
            static constexpr int combTuning[combCount] = { 1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617 };
            static constexpr int allpassTuning[allpassCount] = { 556, 441, 341, 225 };
            // The right channel's lines are slightly longer, which widens the sound.
            const auto length = [this] (int tuning, int channel) { return (size_t) std::lround ((tuning + channel * 23) * rate / 44100.0); };
            for (int ch = 0; ch < 2; ++ch)
            {
                for (int c = 0; c < combCount; ++c) combs[ch][c].buffer.assign (length (combTuning[c], ch), 0.0f);
                for (int a = 0; a < allpassCount; ++a) allpasses[ch][a].buffer.assign (length (allpassTuning[a], ch), 0.0f);
            }
        }
    }

    const EffectType type;

    /** Applies new settings if they differ from the ones in force. Cheap enough for the audio thread. */
    void set (const EffectParams& p)
    {
        if (configured && p == params) return;
        params = p;
        configured = true;
        switch (type)
        {
            case EffectType::eq:
                for (auto& band : eq)
                {
                    band[0].set (Biquad::lowshelf, 200, 1, p.v[0], rate);
                    band[1].set (Biquad::peaking, p.v[2], 1, p.v[1], rate);
                    band[2].set (Biquad::highshelf, 4000, 1, p.v[3], rate);
                }
                break;
            case EffectType::compressor:
                threshold = p.v[0];
                ratio = p.v[1];
                attackCoef = 1.0 - std::exp (-1.0 / (std::max (p.v[2], 0.0005) * rate));
                releaseCoef = 1.0 - std::exp (-1.0 / (std::max (p.v[3], 0.005) * rate));
                makeup = std::pow (10.0, p.v[4] / 20.0);
                break;
            case EffectType::delay:
                delayTarget = std::min (p.v[0] * rate, (double) delayL.size() - 2);
                if (delaySamples == 0) delaySamples = delayTarget;
                feedback = p.v[1];
                mix = p.v[2];
                break;
            case EffectType::reverb:
            {
                mix = p.v[2];
                const double damp = std::exp (-6.283185307179586 * p.v[1] / rate);
                for (auto& channel : combs)
                    for (auto& comb : channel)
                    {
                        // Feedback that makes this comb die away by 60 dB in `decay` seconds.
                        comb.feedback = std::pow (10.0, -3.0 * (double) comb.buffer.size() / rate / p.v[0]);
                        comb.damp = damp;
                    }
                break;
            }
        }
    }

    void process (float* left, float* right, int frames)
    {
        switch (type)
        {
            case EffectType::eq:         processEq (left, right, frames); break;
            case EffectType::compressor: processCompressor (left, right, frames); break;
            case EffectType::delay:      processDelay (left, right, frames); break;
            case EffectType::reverb:     processReverb (left, right, frames); break;
        }
    }

private:
    // Three bands: low shelf at 200 Hz, sweepable mid bell, high shelf at 4 kHz.
    void processEq (float* left, float* right, int frames)
    {
        for (int i = 0; i < frames; ++i)
        {
            left[i] = (float) eq[0][2].tick (eq[0][1].tick (eq[0][0].tick (left[i])));
            right[i] = (float) eq[1][2].tick (eq[1][1].tick (eq[1][0].tick (right[i])));
        }
    }

    // Feed-forward with a soft knee; both channels share one gain so the image stays put.
    void processCompressor (float* left, float* right, int frames)
    {
        const double knee = 6, slope = 1.0 / ratio - 1.0;
        for (int i = 0; i < frames; ++i)
        {
            const double peak = std::max (std::abs (left[i]), std::abs (right[i]));
            const double level = peak > 1e-6 ? 20.0 * std::log10 (peak) : -120.0;
            const double over = level - threshold;
            double target = 0;
            if (over > knee / 2) target = slope * over;
            else if (over > -knee / 2) target = slope * (over + knee / 2) * (over + knee / 2) / (2 * knee);
            // Clamp down fast (attack), let go slowly (release).
            reduction += (target - reduction) * (target < reduction ? attackCoef : releaseCoef);
            const double gain = std::pow (10.0, reduction / 20.0) * makeup;
            left[i] = (float) (left[i] * gain);
            right[i] = (float) (right[i] * gain);
        }
    }

    // Feedback delay with a dry/wet mix.
    void processDelay (float* left, float* right, int frames)
    {
        const auto size = (int) delayL.size();
        float* bl = delayL.data();
        float* br = delayR.data();
        for (int i = 0; i < frames; ++i)
        {
            // Glide to a new delay time rather than jumping, which would click.
            delaySamples += (delayTarget - delaySamples) * 0.0005;
            double read = delayWrite - delaySamples;
            if (read < 0) read += size;
            const auto index = (int) read;
            const int next = index + 1 == size ? 0 : index + 1;
            const double frac = read - index;
            const double dl = bl[index] + (bl[next] - bl[index]) * frac;
            const double dr = br[index] + (br[next] - br[index]) * frac;
            bl[delayWrite] = (float) (left[i] + dl * feedback);
            br[delayWrite] = (float) (right[i] + dr * feedback);
            delayWrite = delayWrite + 1 == size ? 0 : delayWrite + 1;
            left[i] = (float) (left[i] * (1 - mix) + dl * mix);
            right[i] = (float) (right[i] * (1 - mix) + dr * mix);
        }
    }

    // Eight parallel damped comb filters into four all-pass filters per channel.
    void processReverb (float* left, float* right, int frames)
    {
        // Brings the reverb's output up to roughly the level of what went in.
        const double wetGain = 1.5;
        for (int i = 0; i < frames; ++i)
        {
            const double input = ((double) left[i] + (double) right[i]) * 0.015;
            double wl = 0, wr = 0;
            for (int c = 0; c < combCount; ++c)
            {
                wl += combs[0][c].tick (input);
                wr += combs[1][c].tick (input);
            }
            for (int a = 0; a < allpassCount; ++a)
            {
                wl = allpasses[0][a].tick (wl);
                wr = allpasses[1][a].tick (wr);
            }
            left[i] = (float) (left[i] * (1 - mix) + wl * wetGain * mix);
            right[i] = (float) (right[i] * (1 - mix) + wr * wetGain * mix);
        }
    }

    struct Comb
    {
        std::vector<float> buffer;
        size_t index = 0;
        double store = 0, feedback = 0, damp = 0;

        double tick (double input)
        {
            const double output = buffer[index];
            // A low-pass in the loop makes high frequencies die away sooner, as in a real room.
            store = output * (1 - damp) + store * damp;
            buffer[index] = (float) (input + store * feedback);
            if (++index == buffer.size()) index = 0;
            return output;
        }
    };

    struct Allpass
    {
        std::vector<float> buffer;
        size_t index = 0;

        double tick (double input)
        {
            const double delayed = buffer[index];
            buffer[index] = (float) (input + delayed * 0.5);
            if (++index == buffer.size()) index = 0;
            return delayed - input;
        }
    };

    static constexpr int combCount = 8, allpassCount = 4;

    const double rate;
    EffectParams params;
    bool configured = false;

    Biquad eq[2][3];

    double threshold = -18, ratio = 4, attackCoef = 0, releaseCoef = 0, makeup = 1;
    /** Current gain reduction in dB (0 or negative). */
    double reduction = 0;

    std::vector<float> delayL, delayR;
    int delayWrite = 0;
    double delaySamples = 0, delayTarget = 0, feedback = 0, mix = 0.3;

    Comb combs[2][combCount];
    Allpass allpasses[2][allpassCount];
};
} // namespace studio
