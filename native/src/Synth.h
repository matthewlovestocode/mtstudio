// The built-in synth voice: a port of SynthVoice in
// src/renderer/src/engine/dsp/voices.ts and Biquad in dsp/biquad.ts. Keep the
// two in step so both engines sound the same.
#pragma once

#include <cmath>
#include <cstdint>
#include <limits>

namespace studio
{
enum class Wave { sine, triangle, sawtooth, square };

struct SynthParams
{
    Wave wave = Wave::sawtooth;
    double attack = 0.005, decay = 0.15, sustain = 0.6, release = 0.2;
    double cutoff = 2400, resonance = 1;
};

/** Per-sample coefficient for an exponential approach with time constant `seconds`. */
inline double approach (double seconds, double rate)
{
    return 1.0 - std::exp (-1.0 / (std::max (seconds, 0.0005) * rate));
}

/** A second-order low-pass (Audio EQ Cookbook), transposed direct form II. */
struct LowPass
{
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;

    void set (double frequency, double q, double rate)
    {
        const double pi = 3.14159265358979323846;
        const double w0 = 2.0 * pi * std::min (std::max (frequency, 10.0), rate * 0.49) / rate;
        const double c = std::cos (w0), alpha = std::sin (w0) / (2.0 * std::max (q, 0.01));
        const double a0 = 1.0 + alpha;
        b0 = (1.0 - c) / 2.0 / a0;
        b1 = (1.0 - c) / a0;
        b2 = b0;
        a1 = -2.0 * c / a0;
        a2 = (1.0 - alpha) / a0;
    }

    double tick (double x)
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

/** Oscillator → resonant low-pass → attack/decay/sustain/release envelope. */
struct SynthVoice
{
    static constexpr int64_t held = std::numeric_limits<int64_t>::max();
    static constexpr double silence = 1e-4;
    static constexpr double killSeconds = 0.01;

    bool active = false;
    /** Played by hand rather than by the sequencer, so stopping the transport leaves it alone. */
    bool live = false;
    int pitch = 0;
    /** Order of starting, for stealing the oldest. */
    uint64_t order = 0;
    /** Absolute frame at which the note is released; `held` until then. */
    int64_t offFrame = held;

    void start (int pitchIn, double velocity, bool liveIn, double rateIn, uint64_t orderIn)
    {
        active = true;
        live = liveIn;
        pitch = pitchIn;
        order = orderIn;
        offFrame = held;
        rate = rateIn;
        phase = 0;
        step = 440.0 * std::pow (2.0, (pitchIn - 69) / 12.0) / rateIn;
        peak = velocity * 0.3;
        level = 0;
        stage = Stage::attack;
        filter = {};
        seenCutoff = -1;
    }

    /** Fade out almost at once. */
    void kill()
    {
        stage = Stage::release;
        releaseCoef = approach (killSeconds, rate);
    }

    /**
     * Adds frames [from, to) of a block whose first frame is absolute frame
     * `blockFrame`. Clears `active` once the voice has finished.
     */
    void render (float* left, float* right, int from, int to, int64_t blockFrame, const SynthParams& p)
    {
        if (p.cutoff != seenCutoff || p.resonance != seenResonance)
        {
            seenCutoff = p.cutoff;
            seenResonance = p.resonance;
            // Resonance is in decibels, as on the Web Audio low-pass filter.
            filter.set (p.cutoff, std::pow (10.0, p.resonance / 20.0), rate);
        }
        const double attackStep = peak / std::max (1.0, p.attack * rate);
        const double decayCoef = approach (p.decay / 3.0, rate);
        const double sustain = peak * p.sustain;
        const double twoPi = 6.283185307179586;

        for (int i = from; i < to; ++i)
        {
            if (stage != Stage::release && blockFrame + i >= offFrame)
            {
                stage = Stage::release;
                releaseCoef = approach (p.release / 3.0, rate);
            }
            if (stage == Stage::attack)
            {
                level += attackStep;
                if (level >= peak) { level = peak; stage = Stage::decay; }
            }
            else if (stage == Stage::decay)
            {
                level += (sustain - level) * decayCoef;
            }
            else
            {
                level -= level * releaseCoef;
                if (level < silence) { active = false; return; }
            }

            const double ph = phase;
            double sample;
            switch (p.wave)
            {
                case Wave::sine:     sample = std::sin (twoPi * ph); break;
                case Wave::triangle: sample = 4.0 * std::abs (ph - 0.5) - 1.0; break;
                case Wave::square:   sample = (ph < 0.5 ? 1.0 : -1.0) + polyBlep (ph, step) - polyBlep (std::fmod (ph + 0.5, 1.0), step); break;
                default:             sample = 2.0 * ph - 1.0 - polyBlep (ph, step);
            }
            phase = ph + step >= 1.0 ? ph + step - 1.0 : ph + step;

            const auto out = (float) (filter.tick (sample) * level);
            left[i] += out;
            right[i] += out;
        }
    }

private:
    enum class Stage { attack, decay, release };

    /** Band-limiting correction for the step in a sawtooth or square wave. */
    static double polyBlep (double ph, double st)
    {
        if (ph < st) { const double t = ph / st; return t + t - t * t - 1.0; }
        if (ph > 1.0 - st) { const double t = (ph - 1.0) / st; return t * t + t + t + 1.0; }
        return 0.0;
    }

    double rate = 48000, phase = 0, step = 0, peak = 0, level = 0, releaseCoef = 0;
    double seenCutoff = -1, seenResonance = 0;
    Stage stage = Stage::attack;
    LowPass filter;
};
} // namespace studio
