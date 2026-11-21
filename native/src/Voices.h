// The drum machine and sampler voices (ports of DrumVoice and SampleVoice in
// src/renderer/src/engine/dsp/voices.ts) and `Voice`, the slot a channel
// strip keeps for whichever instrument its track plays. Keep the ports in
// step with the TypeScript so both engines sound the same.
#pragma once

#include <algorithm>
#include <memory>
#include <vector>

#include "Synth.h"

namespace studio
{
class DiskStream;

/**
 * An audio file: decoded into memory, or (when `stream` is set) played from
 * disk a block at a time, with `channels` left empty. Immutable once made,
 * so the audio thread reads it freely.
 */
struct Sample
{
    double rate = 48000;
    /** One or two channels of equal length. */
    std::vector<float> channels[2];
    bool stereo = false;
    int length = 0;
    /** See Stream.h. Only audio clips can play a streamed file. */
    std::shared_ptr<DiskStream> stream;
};

struct SamplerParams
{
    /** Null until the track's sample has been loaded. */
    const Sample* sample = nullptr;
    double root = 60, attack = 0.002, release = 0.15;
};

/** A second-order filter of the three kinds the drum machine uses (Audio EQ Cookbook). */
struct NoiseFilter
{
    enum Type { lowpass, highpass, bandpass };
    double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;

    void set (Type type, double frequency, double rate)
    {
        const double w0 = 6.283185307179586 * std::min (std::max (frequency, 10.0), rate * 0.49) / rate;
        const double c = std::cos (w0), alpha = std::sin (w0) / 2.0; // q = 1
        const double a0 = 1.0 + alpha;
        if (type == lowpass)       { b0 = (1 - c) / 2; b1 = 1 - c;    b2 = b0; }
        else if (type == highpass) { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
        else                       { b0 = alpha;       b1 = 0;        b2 = -alpha; }
        b0 /= a0; b1 /= a0; b2 /= a0;
        a1 = -2 * c / a0;
        a2 = (1 - alpha) / a0;
        z1 = z2 = 0;
    }

    double tick (double x)
    {
        const double y = b0 * x + z1;
        z1 = b1 * x - a1 * y + z2;
        z2 = b2 * x - a2 * y;
        return y;
    }
};

// ── Drums ──────────────────────────────────────────────────────────────────

/** One layer of a drum sound: a swept tone, or a burst of filtered noise. */
struct DrumLayer
{
    enum Kind { sine, triangle, square, noise } kind;
    double delay, level, decay;
    /** Tone: start and end frequency and the sweep time between them. */
    double from, to, sweep;
    /** Noise: filter type and frequency. */
    NoiseFilter::Type filter;
    double frequency;
};

struct DrumRecipe
{
    int count;
    DrumLayer layers[4];
};

inline constexpr DrumLayer drumTone (DrumLayer::Kind wave, double from, double to, double sweep, double level, double decay)
{
    return { wave, 0, level, decay, from, to, sweep, NoiseFilter::lowpass, 0 };
}
inline constexpr DrumLayer drumNoise (NoiseFilter::Type type, double frequency, double level, double decay, double delay = 0)
{
    return { DrumLayer::noise, delay, level, decay, 0, 0, 0, type, frequency };
}
inline constexpr DrumRecipe tom (double f) { return { 1, { drumTone (DrumLayer::sine, f * 1.5, f, 0.08, 0.8, 0.35) } }; }

/** The kit, by pitch class (C, C#, D …), following General MIDI from C1. Names are DRUM_NAMES in model.ts. */
inline constexpr DrumRecipe drumKit[12] = {
    { 2, { drumTone (DrumLayer::sine, 160, 45, 0.11, 1, 0.42), drumNoise (NoiseFilter::lowpass, 2500, 0.25, 0.015) } },         // kick
    { 2, { drumTone (DrumLayer::triangle, 820, 400, 0.02, 0.5, 0.05), drumNoise (NoiseFilter::bandpass, 2400, 0.4, 0.03) } },   // rim
    { 2, { drumTone (DrumLayer::triangle, 220, 150, 0.06, 0.5, 0.13), drumNoise (NoiseFilter::highpass, 1400, 0.55, 0.2) } },   // snare
    { 4, { drumNoise (NoiseFilter::bandpass, 1300, 0.6, 0.02), drumNoise (NoiseFilter::bandpass, 1300, 0.6, 0.02, 0.012),       // clap
           drumNoise (NoiseFilter::bandpass, 1300, 0.6, 0.02, 0.024), drumNoise (NoiseFilter::bandpass, 1300, 0.5, 0.22, 0.034) } },
    { 2, { drumTone (DrumLayer::triangle, 220, 150, 0.06, 0.5, 0.13), drumNoise (NoiseFilter::highpass, 2200, 0.55, 0.2) } },   // snare 2
    tom (95),
    { 1, { drumNoise (NoiseFilter::highpass, 7500, 0.35, 0.05) } },                                                             // closed hat
    tom (135),
    { 1, { drumNoise (NoiseFilter::highpass, 7500, 0.35, 0.09) } },                                                             // hat 2
    tom (185),
    { 1, { drumNoise (NoiseFilter::highpass, 7000, 0.32, 0.38) } },                                                             // open hat
    { 2, { drumTone (DrumLayer::square, 540, 540, 0.01, 0.2, 0.28), drumTone (DrumLayer::square, 800, 800, 0.01, 0.2, 0.28) } } // cowbell
};

/** A synthesised drum hit. Plays out on its own; note-off does nothing. */
struct DrumVoice
{
    void start (int pitch, double velocity, double rateIn)
    {
        recipe = &drumKit[((pitch % 12) + 12) % 12];
        rate = rateIn;
        gain = velocity;
        killCoef = 0;
        frame = 0;
        double longest = 0;
        for (int i = 0; i < recipe->count; ++i)
        {
            const auto& layer = recipe->layers[i];
            longest = std::max (longest, layer.delay + layer.decay);
            phase[i] = 0;
            if (layer.kind == DrumLayer::noise) filters[i].set (layer.filter, layer.frequency, rate);
        }
        length = (int64_t) (longest * rate);
        // Each hit gets its own noise, as with Math.random in the original.
        seed = seed * 1664525u + 1013904223u + (uint32_t) pitch;
    }

    void kill() { killCoef = approach (SynthVoice::killSeconds, rate); }

    /** Adds frames [from, to); returns false once the hit has finished. */
    bool render (float* left, float* right, int from, int to)
    {
        for (int i = from; i < to; ++i)
        {
            if (frame >= length) return false;
            if (killCoef > 0)
            {
                gain -= gain * killCoef;
                if (gain < SynthVoice::silence) return false;
            }
            const double t = (double) frame / rate;
            double sample = 0;
            for (int l = 0; l < recipe->count; ++l)
            {
                const auto& layer = recipe->layers[l];
                const double local = t - layer.delay;
                if (local < 0 || local > layer.decay) continue;
                // Exponential fall from `level` to 0.001 over `decay`.
                const double envelope = layer.level * std::pow (0.001 / layer.level, local / layer.decay);
                if (layer.kind == DrumLayer::noise)
                {
                    seed = seed * 1664525u + 1013904223u;
                    const double white = (double) (seed >> 8) / 8388608.0 - 1.0;
                    sample += filters[l].tick (white) * envelope;
                }
                else
                {
                    const double frequency = local >= layer.sweep ? layer.to : layer.from * std::pow (layer.to / layer.from, local / layer.sweep);
                    const double p = phase[l];
                    const double value = layer.kind == DrumLayer::sine ? std::sin (6.283185307179586 * p)
                                       : layer.kind == DrumLayer::triangle ? 4.0 * std::abs (p - 0.5) - 1.0
                                       : (p < 0.5 ? 1.0 : -1.0);
                    phase[l] = std::fmod (p + frequency / rate, 1.0);
                    sample += value * envelope;
                }
            }
            const auto out = (float) (sample * gain);
            left[i] += out;
            right[i] += out;
            ++frame;
        }
        return true;
    }

private:
    const DrumRecipe* recipe = &drumKit[0];
    NoiseFilter filters[4];
    double phase[4] {};
    double rate = 48000, gain = 0, killCoef = 0;
    int64_t frame = 0, length = 0;
    uint32_t seed = 0x9e3779b9u;
};

// ── Sampler ────────────────────────────────────────────────────────────────

/** Plays a sample at a speed set by the note, with a simple attack and release. */
struct SampleVoice
{
    void start (int pitch, double velocityIn, const SamplerParams& settings, double rateIn)
    {
        sample = settings.sample;
        rate = rateIn;
        velocity = velocityIn;
        position = 0;
        level = 0;
        releasing = false;
        step = std::pow (2.0, (pitch - settings.root) / 12.0) * (sample->rate / rate);
        attackStep = velocity / std::max (1.0, settings.attack * rate);
        releaseCoef = approach (settings.release / 3.0, rate);
    }

    void kill()
    {
        releasing = true;
        releaseCoef = approach (SynthVoice::killSeconds, rate);
    }

    /** Adds frames [from, to); returns false once the voice has finished. */
    bool render (float* left, float* right, int from, int to, int64_t blockFrame, int64_t offFrame)
    {
        const float* a = sample->channels[0].data();
        const float* b = sample->stereo ? sample->channels[1].data() : a;
        const double last = sample->length - 1;
        for (int i = from; i < to; ++i)
        {
            if (position >= last) return false;
            if (! releasing && blockFrame + i >= offFrame) releasing = true;
            if (releasing)
            {
                level -= level * releaseCoef;
                if (level < SynthVoice::silence) return false;
            }
            else if (level < velocity)
            {
                level = std::min (velocity, level + attackStep);
            }
            // Linear interpolation between neighbouring samples.
            const auto index = (int) position;
            const double mix = position - index;
            left[i] += (float) ((a[index] + (a[index + 1] - a[index]) * mix) * level);
            right[i] += (float) ((b[index] + (b[index + 1] - b[index]) * mix) * level);
            position += step;
        }
        return true;
    }

private:
    const Sample* sample = nullptr;
    double rate = 48000, velocity = 0, position = 0, step = 1, level = 0, attackStep = 0, releaseCoef = 0;
    bool releasing = false;
};

// ── A voice of any instrument ──────────────────────────────────────────────

/** `plugin` is a hosted instrument plugin: it is sent notes rather than played by a `Voice`. */
enum class Instrument { none, synth, drums, sampler, plugin };

struct Voice
{
    static constexpr int64_t held = SynthVoice::held;

    bool active = false;
    /** Played by hand rather than by the sequencer, so stopping the transport leaves it alone. */
    bool live = false;
    int pitch = 0;
    /** Order of starting, for stealing the oldest. */
    uint64_t order = 0;
    /** Absolute frame at which the note is released; `held` until then. */
    int64_t offFrame = held;

    /** Returns false if the instrument cannot play (a sampler with no sample). */
    bool start (Instrument instrument, const SamplerParams& sampler, int pitchIn, double velocity, bool liveIn, double rate, uint64_t orderIn)
    {
        if (instrument == Instrument::none) return false;
        if (instrument == Instrument::sampler && (sampler.sample == nullptr || sampler.sample->length < 2)) return false;
        kind = instrument;
        active = true;
        // A drum hit always plays out, so it is never a held note.
        live = liveIn && instrument != Instrument::drums;
        pitch = pitchIn;
        order = orderIn;
        offFrame = held;
        if (kind == Instrument::drums) drum.start (pitchIn, velocity, rate);
        else if (kind == Instrument::sampler) sample.start (pitchIn, velocity, sampler, rate);
        else synth.start (pitchIn, velocity, liveIn, rate, orderIn);
        return true;
    }

    /** Fade out almost at once. */
    void kill()
    {
        if (kind == Instrument::drums) drum.kill();
        else if (kind == Instrument::sampler) sample.kill();
        else synth.kill();
    }

    /** Adds frames [from, to) of a block whose first frame is absolute frame `blockFrame`. Clears `active` when done. */
    void render (float* left, float* right, int from, int to, int64_t blockFrame, const SynthParams& params)
    {
        if (kind == Instrument::drums) active = drum.render (left, right, from, to);
        else if (kind == Instrument::sampler) active = sample.render (left, right, from, to, blockFrame, offFrame);
        else
        {
            synth.offFrame = offFrame;
            synth.render (left, right, from, to, blockFrame, params);
            active = synth.active;
        }
    }

private:
    Instrument kind = Instrument::synth;
    SynthVoice synth;
    DrumVoice drum;
    SampleVoice sample;
};
} // namespace studio
