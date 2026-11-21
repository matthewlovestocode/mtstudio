#include "Model.h"
#include "Stream.h"
#include "Stretch.h"

#include <algorithm>

namespace studio
{
static double num (const juce::var& object, const char* key, double fallback)
{
    const auto& value = object[key];
    return (value.isInt() || value.isInt64() || value.isDouble() || value.isBool()) ? (double) value : fallback;
}

static const juce::Array<juce::var>& list (const juce::var& object, const char* key)
{
    static const juce::Array<juce::var> empty;
    const auto* array = object[key].getArray();
    return array != nullptr ? *array : empty;
}

// ── Time map ───────────────────────────────────────────────────────────────

TimeMap::TimeMap (const juce::var& project)
{
    tempos.push_back ({ 0, std::max (1.0, num (project, "bpm", 120)), 0 });
    std::vector<std::pair<double, double>> changes;
    for (const auto& change : list (project, "tempoChanges"))
        if (num (change, "tick", 0) > 0)
            changes.push_back ({ num (change, "tick", 0), std::max (1.0, num (change, "bpm", 120)) });
    std::stable_sort (changes.begin(), changes.end(), [] (auto& a, auto& b) { return a.first < b.first; });
    for (const auto& [tick, bpm] : changes)
    {
        const auto last = tempos.back();
        const double seconds = last.seconds + (tick - last.tick) / PPQ * (60.0 / last.bpm);
        // Two changes on the same tick: the later one wins.
        if (tick == last.tick) tempos.pop_back();
        tempos.push_back ({ tick, bpm, seconds });
    }

    const auto meter = [] (double bar, double tick, double numerator, double denominator)
    {
        const double beatTicks = PPQ * 4.0 / std::max (1.0, denominator);
        return Meter { bar, tick, std::max (1.0, numerator), std::max (1.0, numerator) * beatTicks, beatTicks };
    };
    meters.push_back (meter (0, 0, num (project, "beatsPerBar", 4), num (project, "beatUnit", 4)));
    struct Change { double bar, numerator, denominator; };
    std::vector<Change> meterChanges;
    for (const auto& change : list (project, "meterChanges"))
        if (num (change, "bar", 0) > 0)
            meterChanges.push_back ({ num (change, "bar", 0), num (change, "numerator", 4), num (change, "denominator", 4) });
    std::stable_sort (meterChanges.begin(), meterChanges.end(), [] (auto& a, auto& b) { return a.bar < b.bar; });
    for (const auto& change : meterChanges)
    {
        const auto last = meters.back();
        if (change.bar == last.bar)
            meters.back() = meter (last.bar, last.tick, change.numerator, change.denominator);
        else
            meters.push_back (meter (change.bar, last.tick + (change.bar - last.bar) * last.barTicks, change.numerator, change.denominator));
    }
}

double TimeMap::tickToSeconds (double tick) const
{
    const Tempo* segment = &tempos.front();
    for (const auto& candidate : tempos)
    {
        if (candidate.tick > tick) break;
        segment = &candidate;
    }
    return segment->seconds + (tick - segment->tick) / PPQ * (60.0 / segment->bpm);
}

double TimeMap::secondsToTick (double seconds) const
{
    const Tempo* segment = &tempos.front();
    for (const auto& candidate : tempos)
    {
        if (candidate.seconds > seconds) break;
        segment = &candidate;
    }
    return segment->tick + (seconds - segment->seconds) * (segment->bpm / 60.0) * PPQ;
}

double TimeMap::bpmAt (double tick) const
{
    const Tempo* segment = &tempos.front();
    for (const auto& candidate : tempos)
    {
        if (candidate.tick > tick) break;
        segment = &candidate;
    }
    return segment->bpm;
}

TimeMap::Bar TimeMap::barAt (double tick) const
{
    tick = std::max (0.0, tick);
    const Meter* meter = &meters.front();
    for (const auto& candidate : meters)
    {
        if (candidate.tick > tick) break;
        meter = &candidate;
    }
    const double index = std::floor ((tick - meter->tick) / meter->barTicks);
    return { meter->tick + index * meter->barTicks, meter->barTicks, meter->beatTicks, (int) meter->beats };
}

// ── Snapshots ──────────────────────────────────────────────────────────────

static SynthParams synthParams (const juce::var& synth)
{
    SynthParams p;
    if (! synth.isObject()) return p;
    const auto wave = synth["wave"].toString();
    p.wave = wave == "sine" ? Wave::sine : wave == "triangle" ? Wave::triangle : wave == "square" ? Wave::square : Wave::sawtooth;
    p.attack = num (synth, "attack", p.attack);
    p.decay = num (synth, "decay", p.decay);
    p.sustain = num (synth, "sustain", p.sustain);
    p.release = num (synth, "release", p.release);
    p.cutoff = num (synth, "cutoff", p.cutoff);
    p.resonance = num (synth, "resonance", p.resonance);
    return p;
}

/** An effect's type and its parameters in order, with the defaults from src/shared/effects.ts. */
static bool effectSettings (const juce::var& effect, EffectType& type, EffectParams& params)
{
    struct Def { const char* name; EffectType type; int count; const char* keys[5]; double defaults[5]; };
    static const Def defs[] = {
        { "eq", EffectType::eq, 4, { "low", "mid", "midFreq", "high" }, { 0, 0, 1000, 0 } },
        { "compressor", EffectType::compressor, 5, { "threshold", "ratio", "attack", "release", "makeup" }, { -18, 4, 0.01, 0.15, 0 } },
        { "delay", EffectType::delay, 3, { "time", "feedback", "mix" }, { 0.3, 0.35, 0.3 } },
        { "reverb", EffectType::reverb, 3, { "decay", "tone", "mix" }, { 2, 6000, 0.3 } },
    };
    const auto name = effect["type"].toString();
    for (const auto& def : defs)
    {
        if (name != def.name) continue;
        type = def.type;
        for (int i = 0; i < def.count; ++i) params.v[i] = num (effect["params"], def.keys[i], def.defaults[i]);
        return true;
    }
    return false;
}

std::shared_ptr<const Snapshot> SnapshotBuilder::build (const juce::var& project, const AssetStore& assets, double rate, const PluginLookup& plugins)
{
    auto snapshot = std::make_shared<Snapshot>();
    snapshot->map = TimeMap (project);

    const auto& loop = project["loop"];
    snapshot->loopStart = num (loop, "start", 0);
    snapshot->loopEnd = num (loop, "end", 0);
    // Loops shorter than a sixteenth note are ignored, as in the Web Audio engine.
    snapshot->looping = (bool) loop["enabled"] && snapshot->loopEnd - snapshot->loopStart >= PPQ / 4;

    const auto& tracks = list (project, "tracks");
    bool anySolo = false;
    for (const auto& track : tracks) anySolo = anySolo || (bool) track["solo"];

    std::vector<std::pair<juce::String, std::shared_ptr<Strip>>> next;
    std::map<juce::String, std::shared_ptr<EffectUnit>> nextEffects;
    wanted.clear();
    for (const auto& track : tracks)
    {
        const auto id = track["id"].toString();
        const auto kind = track["kind"].toString();
        std::shared_ptr<Strip> strip;
        for (auto& [existingId, existing] : current)
            if (existingId == id) strip = existing;
        if (strip == nullptr) strip = std::make_shared<Strip> (nextUid++);
        next.push_back ({ id, strip });

        TrackSnapshot out;
        out.strip = strip;
        out.volume = (float) num (track, "volume", 1);
        out.pan = (float) juce::jlimit (-1.0, 1.0, num (track, "pan", 0));
        // Buses stay open under solo, as in the Web Audio engine.
        out.audible = ! (bool) track["mute"] && (! anySolo || (bool) track["solo"] || kind == "bus");
        out.bus = kind == "bus";
        for (const auto& point : list (track["automation"], "volume"))
            out.volumeCurve.push_back ({ num (point, "tick", 0), juce::jlimit (0.0, 1.5, num (point, "value", 1)) });
        for (const auto& point : list (track["automation"], "pan"))
            out.panCurve.push_back ({ num (point, "tick", 0), juce::jlimit (-1.0, 1.0, num (point, "value", 0)) });
        for (const auto& effect : list (track, "effects"))
        {
            EffectType type {};
            EffectSlot slot;
            if (effect["type"].toString() == "plugin")
            {
                // A plugin that is not loaded (it failed to, or nothing hosts plugins here) is passed over.
                if (! (bool) effect["bypass"] && plugins) slot.plugin = plugins (id + "/" + effect["id"].toString());
                if (slot.plugin != nullptr) out.effects.push_back (std::move (slot));
                continue;
            }
            // A bypassed effect is left out altogether, so it starts clean when switched back in.
            if ((bool) effect["bypass"] || ! effectSettings (effect, type, slot.params)) continue;
            const auto key = id + "/" + effect["id"].toString();
            if (const auto existing = effects.find (key); existing != effects.end() && existing->second->type == type)
                slot.unit = existing->second;
            else
                slot.unit = std::make_shared<EffectUnit> (type, rate);
            nextEffects[key] = slot.unit;
            out.effects.push_back (std::move (slot));
        }
        const auto instrument = track["instrument"].toString();
        if (kind == "midi")
            out.instrument = instrument == "drums" ? Instrument::drums : instrument == "sampler" ? Instrument::sampler
                           : instrument == "plugin" ? Instrument::plugin : Instrument::synth;
        if (out.instrument == Instrument::plugin)
        {
            if (plugins) out.plugin = plugins (id + "/instrument");
            // Silent if the plugin is not loaded.
            if (out.plugin == nullptr) out.instrument = Instrument::none;
        }
        out.params = synthParams (track["synth"]);
        if (const auto& sampler = track["sampler"]; sampler.isObject())
        {
            out.sampler.root = num (sampler, "root", 60);
            out.sampler.attack = num (sampler, "attack", 0.002);
            out.sampler.release = num (sampler, "release", 0.15);
            // A sampler needs its sample in memory; the app loads those that way.
            if (const auto found = assets.find (sampler["assetId"].toString()); found != assets.end() && found->second->stream == nullptr)
            {
                out.sample = found->second;
                out.sampler.sample = out.sample.get();
            }
        }

        for (const auto& clip : list (track, "clips"))
        {
            if (clip["kind"].toString() != "audio") continue;
            // As clipStretch in model.ts: stretch the file by `ratio`, then read it at `speed`.
            const double speed = std::pow (2.0, num (clip, "pitch", 0) / 12.0);
            const double ratio = std::round (num (clip, "stretch", 1) * speed * 1000.0) / 1000.0;
            const auto assetId = clip["assetId"].toString();
            if (assets.find (assetId) == assets.end()) continue;
            const auto found = assets.find (ratio == 1.0 ? assetId : stretchKey (assetId, ratio));
            if (found == assets.end())
            {
                // Silent until its stretched copy has been made.
                bool listed = false;
                for (const auto& job : wanted) listed = listed || (job.assetId == assetId && job.ratio == ratio);
                if (! listed) wanted.push_back ({ assetId, ratio });
                continue;
            }
            ClipSnapshot c;
            c.ratio = ratio;
            c.rate = speed;
            const double start = num (clip, "start", 0);
            c.start = snapshot->map.tickToSeconds (start);
            c.duration = snapshot->map.duration (start, start + num (clip, "length", 0));
            c.offset = std::max (0.0, num (clip, "offset", 0));
            c.gain = num (clip, "gain", 1);
            c.fadeIn = std::min (std::max (0.0, num (clip, "fadeIn", 0)), c.duration);
            c.fadeOut = std::min (std::max (0.0, num (clip, "fadeOut", 0)), c.duration - c.fadeIn);
            c.sample = found->second;
            if (c.duration > 0) out.clips.push_back (std::move (c));
        }

        if (out.instrument != Instrument::none)
        {
            for (const auto& clip : list (track, "clips"))
            {
                if (clip["kind"].toString() != "midi") continue;
                const double clipStart = num (clip, "start", 0), clipLength = num (clip, "length", 0);
                for (const auto& note : list (clip, "notes"))
                {
                    const double start = num (note, "start", 0);
                    // Notes outside the clip's bounds (after trimming) are kept but silent.
                    if (start < 0 || start >= clipLength) continue;
                    const double tick = clipStart + start;
                    const double length = std::min (num (note, "length", 0), clipLength - start);
                    out.notes.push_back ({ tick,
                                           std::max (0.01, snapshot->map.duration (tick, tick + length)),
                                           (int) num (note, "pitch", 60),
                                           (float) num (note, "velocity", 0.8) });
                }
            }
            std::stable_sort (out.notes.begin(), out.notes.end(), [] (auto& a, auto& b) { return a.tick < b.tick; });
        }
        snapshot->tracks.push_back (std::move (out));
    }
    current = std::move (next);
    effects = std::move (nextEffects);

    // Delay compensation: what each strip's plugins hold its audio back by, and what the others must wait to match.
    std::vector<int> own (snapshot->tracks.size(), 0);
    int most[2] = { 0, 0 }; // [0] among tracks, [1] among buses
    for (size_t t = 0; t < snapshot->tracks.size(); ++t)
    {
        const auto& out = snapshot->tracks[t];
        if (out.plugin != nullptr) own[t] += pluginLatency (*out.plugin);
        for (const auto& slot : out.effects)
            if (slot.plugin != nullptr) own[t] += pluginLatency (*slot.plugin);
        own[t] = juce::jlimit (0, CompDelay::longest, own[t]);
        most[out.bus ? 1 : 0] = std::max (most[out.bus ? 1 : 0], own[t]);
    }
    std::map<juce::String, std::shared_ptr<CompDelay>> nextDelays;
    for (size_t t = 0; t < snapshot->tracks.size(); ++t)
    {
        auto& out = snapshot->tracks[t];
        if (most[out.bus ? 1 : 0] == 0) continue;
        auto& line = nextDelays[current[t].first];
        if (const auto existing = delays.find (current[t].first); existing != delays.end()) line = existing->second;
        else line = std::make_shared<CompDelay>();
        out.delay = line;
        out.delayFrames = most[out.bus ? 1 : 0] - own[t];
    }
    delays = std::move (nextDelays);
    snapshot->busLatency = most[1];
    snapshot->latency = lastLatency = most[0] + most[1];

    // Sends, now that every bus has its strip.
    for (int t = 0; t < tracks.size(); ++t)
    {
        auto& out = snapshot->tracks[(size_t) t];
        if (out.bus) continue;
        for (const auto& send : list (tracks[t], "sends"))
        {
            const auto level = (float) num (send, "level", 0);
            const auto busId = send["busId"].toString();
            if (level <= 0 || (int) out.sends.size() == Strip::maxSends) continue;
            for (size_t b = 0; b < snapshot->tracks.size(); ++b)
                if (snapshot->tracks[b].bus && current[b].first == busId)
                    out.sends.push_back ({ snapshot->tracks[b].strip.get(), level });
        }
    }
    return snapshot;
}

std::shared_ptr<const Snapshot> buildWithStretches (SnapshotBuilder& builder, const juce::var& project, AssetStore& assets, double rate,
                                                    const PluginLookup& plugins)
{
    auto snapshot = builder.build (project, assets, rate, plugins);
    if (builder.missing().empty()) return snapshot;
    for (const auto job : builder.missing())
    {
        // Stretching needs the whole file, so a streamed one is read in for the purpose.
        auto source = assets[job.assetId];
        if (source->stream != nullptr) source = source->stream->readAll();
        if (source != nullptr) assets[stretchKey (job.assetId, job.ratio)] = timeStretch (*source, job.ratio);
    }
    return builder.build (project, assets, rate, plugins);
}

Strip* SnapshotBuilder::find (const juce::String& trackId) const
{
    for (auto& [id, strip] : current)
        if (id == trackId) return strip.get();
    return nullptr;
}
} // namespace studio
