// studio-engine: Studio's native audio engine, run by the app as a sidecar
// process.
//
// Protocol: one JSON object per line. Commands arrive on stdin and events
// leave on stdout (see src/shared/nativeEngine.ts for both); anything written
// to stderr is a log line for a human. The process exits when stdin closes,
// so it never outlives the app.
//
//   studio-engine                                   run as a sidecar
//   studio-engine --render project.json 8 out.wav   debug: render 8 seconds from the start to a float WAV
//                 [assetId=file ...]                 with these audio files loaded as assets
//                 [assetId=stream:file ...]          or played from disk a block at a time
//                 [click]                            with the metronome on
//                                                   (plugins in the project are loaded with the state saved in it)
//   studio-engine --list-plugins                    debug: scan for plugins and print what was found
//   studio-engine --plugin-info description.xml     debug: load a plugin, set parameters by position (0 to 1)
//                 [index=value ...] [state=file]     (or give it a saved state) and print its parameters and state
//   studio-engine --calibrate-test 1234 0.05 0.01   debug: run the latency measurement with the output fed back to
//                                                   the input 1234 frames late, at gain 0.05, with noise at 0.01
//   studio-engine --capture project.json 2 in.wav out.wav take.wav trackId 960
//                                                   debug: play 2 seconds from tick 960 with in.wav as the audio
//                                                   input, monitored through a track and recorded to take.wav

#include <juce_audio_devices/juce_audio_devices.h>
#include <juce_audio_formats/juce_audio_formats.h>
#include <juce_events/juce_events.h>

#include <cstdio>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <unistd.h>

#include "Calibration.h"
#include "Engine.h"
#include "Plugins.h"
#include "Stream.h"
#include "Stretch.h"

using namespace studio;

/** Where events go. As a sidecar this is a private copy of stdout, so nothing a plugin prints can land in the protocol. */
static FILE* protocol = stdout;

static void emit (const juce::String& line)
{
    std::fputs (line.toRawUTF8(), protocol);
    std::fputc ('\n', protocol);
    std::fflush (protocol);
}

static void emitError (const juce::String& message)
{
    emit ("{\"type\":\"error\",\"message\":" + juce::JSON::toString (juce::var (message), true) + "}");
}

/**
 * Decodes a whole audio file (any format JUCE reads, told by its contents)
 * into memory at `rate`, resampling if the file is at another. Null if it
 * cannot be read.
 */
static std::shared_ptr<const Sample> decode (const juce::File& file, double rate)
{
    juce::AudioFormatManager formats;
    formats.registerBasicFormats();
    auto stream = file.createInputStream();
    if (stream == nullptr) return nullptr;
    std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (std::move (stream)));
    if (reader == nullptr || reader->lengthInSamples <= 0 || reader->lengthInSamples > 0x7fffffff) return nullptr;

    const auto length = (int) reader->lengthInSamples;
    const int channels = std::min (2, (int) reader->numChannels);
    juce::AudioBuffer<float> buffer (channels, length);
    if (! reader->read (&buffer, 0, length, 0, true, true)) return nullptr;

    auto sample = std::make_shared<Sample>();
    sample->stereo = channels > 1;
    if (std::abs (reader->sampleRate - rate) < 0.5)
    {
        sample->rate = reader->sampleRate;
        sample->length = length;
        for (int c = 0; c < channels; ++c)
            sample->channels[c].assign (buffer.getReadPointer (c), buffer.getReadPointer (c) + length);
        return sample;
    }

    // Converted once here, so playback is a plain read at the engine's own rate.
    const double ratio = reader->sampleRate / rate;
    const auto delay = (int) std::lround (juce::WindowedSincInterpolator::getBaseLatency() / ratio);
    sample->rate = rate;
    sample->length = (int) std::ceil (length / ratio);
    for (int c = 0; c < channels; ++c)
    {
        // Zeros after the end let the filter ring out; its delay is then dropped from the front.
        std::vector<float> input ((size_t) length + 1024, 0.0f);
        std::copy (buffer.getReadPointer (c), buffer.getReadPointer (c) + length, input.begin());
        std::vector<float> output ((size_t) (sample->length + delay));
        const auto wanted = (int) std::min ((double) output.size(), std::floor ((double) (input.size() - 256) / ratio));
        juce::WindowedSincInterpolator resampler;
        resampler.process (ratio, input.data(), output.data(), wanted);
        sample->channels[c].assign (output.begin() + delay, output.begin() + delay + sample->length);
    }
    return sample;
}

/** The waveform overview the app draws: min/max pairs of the mono mix, 200 a second, as in the Web Audio engine. */
static std::vector<float> overview (const Sample& sample, double& secondsPerPeak)
{
    const int bucket = std::max (1, (int) std::lround (sample.rate / 200.0));
    const int count = (sample.length + bucket - 1) / bucket;
    std::vector<float> peaks ((size_t) count * 2);
    const float* a = sample.channels[0].data();
    const float* b = sample.stereo ? sample.channels[1].data() : a;
    for (int i = 0; i < count; ++i)
    {
        float low = 0, high = 0;
        const int end = std::min (sample.length, (i + 1) * bucket);
        for (int s = i * bucket; s < end; ++s)
        {
            const float v = (a[s] + b[s]) * 0.5f;
            low = std::min (low, v);
            high = std::max (high, v);
        }
        peaks[(size_t) i * 2] = low;
        peaks[(size_t) i * 2 + 1] = high;
    }
    secondsPerPeak = bucket / sample.rate;
    return peaks;
}

/** Writes interleaved samples as a 32-bit float WAV file. */
static bool writeFloatWav (const juce::File& target, const float* interleaved, juce::int64 frames, int channels, double rate)
{
    target.deleteFile();
    juce::FileOutputStream out (target);
    if (! out.openedOk()) return false;
    const auto bytes = (int) (frames * channels * (juce::int64) sizeof (float));
    out.write ("RIFF", 4); out.writeInt (36 + bytes); out.write ("WAVEfmt ", 8);
    out.writeInt (16); out.writeShort (3); out.writeShort ((short) channels); out.writeInt ((int) rate);
    out.writeInt ((int) rate * channels * 4); out.writeShort ((short) (channels * 4)); out.writeShort (32);
    out.write ("data", 4); out.writeInt (bytes);
    return out.write (interleaved, (size_t) bytes);
}

/** Below this the test signal was not clearly heard, and a measurement is not to be trusted. */
static constexpr double calibrationClarity = 12.0;
/** The longest round trip looked for, in seconds. */
static constexpr double calibrationMaxDelay = 0.5;

/** Mixes an interleaved recording down to one channel. */
static std::vector<float> toMono (const std::vector<float>& interleaved, int channels)
{
    std::vector<float> mono (interleaved.size() / (size_t) channels);
    for (size_t i = 0; i < mono.size(); ++i)
    {
        float sum = 0;
        for (int c = 0; c < channels; ++c) sum += interleaved[i * (size_t) channels + (size_t) c];
        mono[i] = sum / (float) channels;
    }
    return mono;
}

/** A sample that plays `file` from disk; null if it cannot be opened. */
static std::shared_ptr<const Sample> streamed (const juce::File& file, bool synchronous)
{
    auto stream = DiskStream::open (file, synchronous);
    if (stream == nullptr) return nullptr;
    auto sample = std::make_shared<Sample>();
    sample->rate = stream->rate;
    sample->length = stream->length;
    sample->stereo = stream->stereo;
    sample->stream = std::move (stream);
    return sample;
}

/** Seconds of silence rendered after the last clip so release, delay and reverb tails are not cut short. */
static constexpr double mixdownTail = 4.0;

/**
 * Renders the whole project, from the start to the end of its last clip plus
 * a tail, to a stereo 24-bit WAV file. It runs on its own engine with fresh
 * channel strips and effects, so it neither hears nor disturbs what is
 * playing, and ignores the loop region and the metronome. Returns an error
 * message, or an empty string.
 */
static juce::String mixdown (const juce::var& project, AssetStore assets, double rate, const juce::File& target,
                             const std::map<juce::String, juce::String>& pluginStates)
{
    double endTick = 0;
    if (const auto* tracks = project["tracks"].getArray())
        for (const auto& track : *tracks)
            if (const auto* clips = track["clips"].getArray())
                for (const auto& clip : *clips)
                    endTick = std::max (endTick, (double) clip["start"] + (double) clip["length"]);
    if (endTick <= 0) return "There is nothing to export.";

    SnapshotBuilder builder;
    builder.offline = true;
    // An offline render cannot wait on the loader thread: streamed files get streams of their own that read as they go.
    for (auto& [id, sample] : assets)
        if (sample->stream != nullptr)
            if (auto own = streamed (sample->stream->file, true)) sample = own;
    // Stretched clips that are not ready yet are stretched here rather than left out of the file.
    auto engine = std::make_unique<Engine>();
    engine->prepare (rate);
    // Plugins get instances of their own too, in the state the playing ones are in now.
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager (formats);
    juce::StringArray pluginErrors;
    const auto plugins = createProjectPlugins (formats, project, rate, engine.get(), &pluginStates, pluginErrors);
    if (! pluginErrors.isEmpty()) return "A plugin could not be loaded for the export (" + pluginErrors.joinIntoString ("; ") + ").";
    const auto snapshot = buildWithStretches (builder, project, assets, rate, [&plugins] (const juce::String& key)
    {
        const auto found = plugins.find (key);
        return found != plugins.end() ? found->second : nullptr;
    });
    engine->setSnapshot (snapshot);
    engine->play (1, true);

    target.deleteFile();
    juce::FileOutputStream out (target);
    if (! out.openedOk()) return "Could not write the mixdown.";
    const auto frames = (juce::int64) std::ceil ((snapshot->map.tickToSeconds (endTick) + mixdownTail) * rate);
    const auto bytes = frames * 6;
    if (bytes > 0xffffffffLL - 44) return "The project is too long for a WAV file.";
    out.write ("RIFF", 4); out.writeInt ((int) (36 + bytes)); out.write ("WAVEfmt ", 8);
    out.writeInt (16); out.writeShort (1); out.writeShort (2); out.writeInt ((int) rate);
    out.writeInt ((int) rate * 6); out.writeShort (6); out.writeShort (24);
    out.write ("data", 4); out.writeInt ((int) bytes);

    constexpr int block = 512;
    float left[block], right[block];
    unsigned char packed[block * 6];
    // Delay compensation makes everything come out late by the same amount; that much is rendered and left out of the file.
    for (int skip = snapshot->latency; skip > 0; skip -= block) engine->render (left, right, std::min (block, skip));
    for (juce::int64 done = 0; done < frames; done += block)
    {
        const auto count = (int) std::min<juce::int64> (block, frames - done);
        engine->render (left, right, count);
        for (int i = 0; i < count; ++i)
        {
            const float pair[2] = { left[i], right[i] };
            for (int c = 0; c < 2; ++c)
            {
                // The same rounding as the Web Audio engine's encoder (wav.ts).
                const auto value = (int) std::lround (juce::jlimit (-1.0f, 1.0f, pair[c]) * 8388607.0);
                auto* p = packed + (i * 2 + c) * 3;
                p[0] = (unsigned char) (value & 0xff);
                p[1] = (unsigned char) ((value >> 8) & 0xff);
                p[2] = (unsigned char) ((value >> 16) & 0xff);
            }
        }
        if (! out.write (packed, (size_t) count * 6)) return "Could not write the mixdown.";
    }
    out.flush();
    return {};
}

/** Owns the audio device and turns protocol lines into engine calls. Lives on the message thread. */
class Sidecar final : private juce::Timer
{
public:
    Sidecar()
    {
        // Output only until a track is armed: opening an input needs microphone permission.
        const auto error = devices.initialise (0, 2, nullptr, true);
        if (error.isNotEmpty()) deviceError = error;
        else if (devices.getCurrentAudioDevice() == nullptr) deviceError = "No audio output device is available.";
        devices.addAudioCallback (&engine);
        instance = this;
        juce::addDefaultFormatsToManager (formats);
        plugins.onState = [] (const juce::String& trackId, const juce::String& effectId, const juce::String& state)
        {
            emit ("{\"type\":\"pluginState\"," + pluginAddress (trackId, effectId) + ",\"state\":" + juce::JSON::toString (juce::var (state), true) + "}");
        };
        plugins.onLatency = [this] { if (project.isObject()) rebuild(); };
        plugins.onStatus = [] (const juce::String& trackId, const juce::String& effectId, const juce::String& error)
        {
            emit ("{\"type\":\"pluginStatus\"," + pluginAddress (trackId, effectId)
                  + (error.isEmpty() ? juce::String() : ",\"error\":" + juce::JSON::toString (juce::var (error), true)) + "}");
        };
        loader = std::thread ([this] { serviceStreams(); });
        ready();
        startTimerHz (60);
    }

    ~Sidecar() override
    {
        instance = nullptr;
        loading.store (false);
        if (loader.joinable()) loader.join();
        stopTimer();
        devices.removeAudioCallback (&engine);
    }

    void handle (const juce::String& line)
    {
        juce::var message;
        if (juce::JSON::parse (line, message).failed() || ! message.isObject())
            return emitError ("Unreadable command.");
        const auto type = message["type"].toString();
        const int seq = (int) message["seq"];

        if (type == "hello")
        {
            // A new renderer has attached (first start or a reload): begin from a clean transport.
            abandonTake();
            engine.setMonitor (0);
            engine.stop (seq);
            ready();
        }
        else if (type == "setProject")
        {
            project = message["project"];
            // Plugins first, so the snapshot finds them loaded.
            plugins.sync (project, engine.getSampleRate());
            rebuild();
        }
        else if (type == "pluginState") plugins.setState (pluginKey (message["trackId"].toString(), message["effectId"].toString()), message["state"].toString());
        else if (type == "pluginParam")
            plugins.setParameter (pluginKey (message["trackId"].toString(), message["effectId"].toString()), (int) message["index"], (float) (double) message["value"]);
        else if (type == "showPlugin")
        {
            if (! plugins.show (pluginKey (message["trackId"].toString(), message["effectId"].toString())))
                emitError ("The plugin is not loaded, so it has no window to show.");
        }
        else if (type == "appFocus") plugins.setFocused ((bool) message["focused"]);
        else if (type == "scanPlugins") scan (message);
        else if (type == "loadAsset") loadAsset (message);
        else if (type == "openStream") openStream (message);
        else if (type == "render") render (message);
        else if (type == "setInput") setInput (message);
        else if (type == "calibrate") calibrate (message);
        else if (type == "stopRecording") stopRecording (message);
        else if (type == "play")
        {
            // A take can only begin with the transport, with the input open and no other take under way.
            const bool capture = (bool) message["capture"] && inputChannels > 0 && ! recording && ! engine.isCapturing();
            if ((bool) message["capture"] && ! capture) emitError ("Could not record: the audio input is not open.");
            if (capture)
            {
                take.clear();
                engine.prepareCapture (inputChannels);
                recording = true;
            }
            engine.play (seq, (bool) message["ignoreLoop"], capture);
        }
        else if (type == "stop")
        {
            // A plain stop abandons any take in progress.
            abandonTake();
            engine.stop (seq);
        }
        else if (type == "seek") engine.seek ((double) message["tick"], seq);
        else if (type == "setMetronome") engine.setMetronome ((bool) message["enabled"]);
        else if (type == "noteOn" || type == "noteOff")
        {
            if (const auto* strip = builder.find (message["trackId"].toString()))
            {
                if (type == "noteOn") engine.noteOn (strip->uid, (int) message["pitch"], (float) (double) message["velocity"]);
                else engine.noteOff (strip->uid, (int) message["pitch"]);
            }
        }
        else emitError ("Unknown command '" + type + "'.");
    }

private:
    /**
     * Decodes the file at `path` and keeps it under `assetId`. Replies with an
     * `asset` event carrying the same `request` number: the file's length and
     * the path of its waveform overview (raw 32-bit floats, written beside
     * the file), or an error.
     */
    void loadAsset (const juce::var& message)
    {
        auto* reply = new juce::DynamicObject();
        const juce::var holder (reply);
        reply->setProperty ("type", "asset");
        reply->setProperty ("request", message["request"]);
        const juce::File file (message["path"].toString());
        if (const auto sample = decode (file, engine.getSampleRate()))
        {
            double secondsPerPeak = 0;
            const auto peaks = overview (*sample, secondsPerPeak);
            const auto peaksFile = file.getSiblingFile (file.getFileName() + ".peaks");
            if (peaksFile.replaceWithData (peaks.data(), peaks.size() * sizeof (float)))
            {
                storeAsset (message["assetId"].toString(), sample);
                reply->setProperty ("duration", sample->length / sample->rate);
                reply->setProperty ("secondsPerPeak", secondsPerPeak);
                reply->setProperty ("peaksPath", peaksFile.getFullPathName());
            }
            else reply->setProperty ("error", "Could not write the waveform overview.");
        }
        else reply->setProperty ("error", "The file could not be decoded.");
        emit (juce::JSON::toString (holder, true));
    }

    /**
     * Renders the project as it stands to the WAV file at `path`, on a thread
     * of its own so the meters and the transport carry on. Replies with a
     * `rendered` event carrying the same `request` number.
     */
    void render (const juce::var& message)
    {
        const auto request = (int) message["request"];
        const juce::File target (message["path"].toString());
        // The thread works from its own references: the project and the samples are never changed in place.
        std::thread ([request, target, snapshotOf = project, files = assets, rate = engine.getSampleRate(), states = plugins.states()]
        {
            const auto error = snapshotOf.isObject() ? mixdown (snapshotOf, files, rate, target, states) : juce::String ("There is nothing to export.");
            juce::MessageManager::callAsync ([request, error]
            {
                juce::String line;
                line << "{\"type\":\"rendered\",\"request\":" << request;
                if (error.isNotEmpty()) line << ",\"error\":" << juce::JSON::toString (juce::var (error), true);
                emit (line + "}");
            });
        }).detach();
    }

    // ── Plugins ───────────────────────────────────────────────────────────

    /** How events say which plugin they are about: `effectId` is null for a track's instrument. */
    static juce::String pluginAddress (const juce::String& trackId, const juce::String& effectId)
    {
        return "\"trackId\":" + juce::JSON::toString (juce::var (trackId), true) + ",\"effectId\":"
             + (effectId.isEmpty() ? juce::String ("null") : juce::JSON::toString (juce::var (effectId), true));
    }

    /** Looks for installed plugins on a thread of its own (it can take minutes). Replies with a `plugins` event. */
    void scan (const juce::var& message)
    {
        std::thread ([request = (int) message["request"]]
        {
            juce::StringArray failed;
            const auto found = scanPlugins (failed);
            juce::Array<juce::var> list;
            for (const auto& plugin : found)
            {
                auto* object = new juce::DynamicObject();
                object->setProperty ("name", plugin.name);
                object->setProperty ("manufacturer", plugin.manufacturer);
                object->setProperty ("format", plugin.format);
                object->setProperty ("instrument", plugin.instrument);
                object->setProperty ("description", plugin.description);
                list.add (juce::var (object));
            }
            juce::Array<juce::var> failures;
            for (const auto& name : failed) failures.add (name);
            auto* reply = new juce::DynamicObject();
            reply->setProperty ("type", "plugins");
            reply->setProperty ("request", request);
            reply->setProperty ("plugins", list);
            reply->setProperty ("failed", failures);
            const auto line = juce::JSON::toString (juce::var (reply), true);
            juce::MessageManager::callAsync ([line] { emit (line); });
        }).detach();
    }

    // ── Files played from disk ────────────────────────────────────────────

    /**
     * Makes the audio file at `path` playable as `assetId` without loading
     * it. Replies with a `stream` event; `error` is "rate" when the file is
     * not at the device's sample rate, which this cannot do (the caller
     * should load it into memory instead, where it is converted).
     */
    void openStream (const juce::var& message)
    {
        auto* reply = new juce::DynamicObject();
        const juce::var holder (reply);
        reply->setProperty ("type", "stream");
        reply->setProperty ("request", message["request"]);
        const auto assetId = message["assetId"].toString();
        if (const auto sample = streamed (juce::File (message["path"].toString()), false))
        {
            if (std::abs (sample->rate - engine.getSampleRate()) < 0.5)
            {
                {
                    const std::lock_guard<std::mutex> lock (streamsLock);
                    streams.push_back (sample->stream);
                }
                storeAsset (assetId, sample);
                reply->setProperty ("duration", sample->length / sample->rate);
                std::cerr << "playing from disk: " << sample->stream->file.getFileName() << std::endl;
            }
            else reply->setProperty ("error", "rate");
        }
        else reply->setProperty ("error", "The file could not be opened.");
        emit (juce::JSON::toString (holder, true));
    }

    /** Keeps a sample under an asset id, retiring what it replaces, and brings the engine's snapshot up to date. */
    void storeAsset (const juce::String& assetId, std::shared_ptr<const Sample> sample)
    {
        auto& slot = assets[assetId];
        // A voice may still be playing the sample this replaces, so that one is kept rather than freed.
        if (slot != nullptr) retired.push_back (slot);
        slot = std::move (sample);
        // Stretched copies of the old audio no longer apply.
        for (auto it = assets.begin(); it != assets.end();)
        {
            if (it->first.startsWith (assetId + "|")) { retired.push_back (it->second); it = assets.erase (it); }
            else ++it;
        }
        if (project.isObject()) rebuild();
    }

    /** The loader thread: keeps every stream supplied with what the audio thread has lately wanted. */
    void serviceStreams()
    {
        while (loading.load())
        {
            std::vector<std::shared_ptr<DiskStream>> current;
            {
                const std::lock_guard<std::mutex> lock (streamsLock);
                current = streams;
            }
            const auto now = juce::Time::getMillisecondCounter();
            for (auto& stream : current) stream->service (now);
            juce::Thread::sleep (10);
        }
    }

    // ── Snapshots and time-stretching ─────────────────────────────────────

    /** Gives the engine a fresh snapshot of the project, and starts making any stretched audio it lacked. */
    void rebuild()
    {
        engine.setSnapshot (builder.build (project, assets, engine.getSampleRate(), [this] (const juce::String& key) { return plugins.find (key); }));
        for (const auto& job : builder.missing())
        {
            const auto key = stretchKey (job.assetId, job.ratio);
            if (stretching.contains (key)) continue;
            stretching.add (key);
            // Stretching a long file takes a second or more, so it has a thread of its own. The clip
            // stays silent until the copy arrives, as in the Web Audio engine.
            std::thread ([key, source = assets[job.assetId], ratio = job.ratio]
            {
                // Stretching needs the whole file, so a streamed one is read in for the purpose.
                const auto whole = source->stream != nullptr ? source->stream->readAll() : source;
                if (whole == nullptr) return;
                auto stretched = timeStretch (*whole, ratio);
                juce::MessageManager::callAsync ([key, source, stretched]
                {
                    if (instance != nullptr) instance->stretched (key, source, stretched);
                });
            }).detach();
        }
    }

    void stretched (const juce::String& key, const std::shared_ptr<const Sample>& source, std::shared_ptr<const Sample> sample)
    {
        stretching.removeString (key);
        // If the file was replaced while this was being made, the copy is of the old audio: drop it, and
        // the rebuild below asks for a new one.
        const auto current = assets.find (key.upToFirstOccurrenceOf ("|", false, false));
        if (current != assets.end() && current->second == source) assets[key] = sample;
        if (project.isObject()) rebuild();
    }

    // ── Audio input ───────────────────────────────────────────────────────

    /**
     * Opens the default audio input and routes it to a track (heard through
     * it when `monitor` is set), or closes it when there is no `trackId`.
     * Replies with an `input` event carrying the same `request` number.
     */
    void setInput (const juce::var& message)
    {
        auto* reply = new juce::DynamicObject();
        const juce::var holder (reply);
        reply->setProperty ("type", "input");
        reply->setProperty ("request", message["request"]);
        const auto trackId = message["trackId"].toString();

        if (trackId.isEmpty())
        {
            engine.setMonitor (0);
            if (inputChannels > 0)
            {
                abandonTake();
                openInput ({});
            }
        }
        else
        {
            const auto error = inputChannels > 0 ? juce::String() : openInput (defaultInputName());
            if (error.isNotEmpty()) reply->setProperty ("error", error);
            const auto* strip = builder.find (trackId);
            engine.setMonitor (error.isEmpty() && (bool) message["monitor"] && strip != nullptr ? strip->uid : 0);
        }
        if (auto* device = devices.getCurrentAudioDevice())
        {
            reply->setProperty ("device", devices.getAudioDeviceSetup().inputDeviceName);
            reply->setProperty ("channels", inputChannels);
            reply->setProperty ("latency", roundTripSeconds (*device));
        }
        emit (juce::JSON::toString (holder, true));
        // The device was reopened, perhaps at another rate or buffer size.
        ready();
    }

    juce::String defaultInputName()
    {
        if (auto* type = devices.getCurrentDeviceTypeObject())
        {
            const auto names = type->getDeviceNames (true);
            if (! names.isEmpty()) return names[juce::jlimit (0, names.size() - 1, type->getDefaultDeviceIndex (true))];
        }
        return {};
    }

    /** Reopens the audio device with the named input (none if empty). Returns an error message, or an empty string. */
    juce::String openInput (const juce::String& name)
    {
        auto setup = devices.getAudioDeviceSetup();
        const auto previous = setup;
        setup.inputDeviceName = name;
        setup.useDefaultInputChannels = false;
        setup.inputChannels.clear();
        if (name.isNotEmpty()) setup.inputChannels.setRange (0, 2, true);
        inputChannels = 0;
        if (name.isEmpty())
        {
            devices.setAudioDeviceSetup (setup, true);
            return {};
        }
        auto error = devices.setAudioDeviceSetup (setup, true);
        auto* device = devices.getCurrentAudioDevice();
        if (error.isEmpty() && device != nullptr) inputChannels = std::min (2, device->getActiveInputChannels().countNumberOfSetBits());
        if (inputChannels > 0) return {};
        // Fall back to output only, so playback survives a failed attempt.
        devices.setAudioDeviceSetup (previous, true);
        return error.isNotEmpty() ? error : juce::String ("No audio input device is available.");
    }

    /**
     * How much later than the music a recorded sound lands in the take: out
     * through the output's latency, back through the input's, plus the one
     * block the two sides of a callback are apart. As reported by the device.
     */
    static double roundTripSeconds (juce::AudioIODevice& device)
    {
        const auto frames = device.getInputLatencyInSamples() + device.getOutputLatencyInSamples() + device.getCurrentBufferSizeSamples();
        return frames / device.getCurrentSampleRate();
    }

    // ── Latency measurement ───────────────────────────────────────────────

    /**
     * Plays the test signal and listens for it on the open input. Replies
     * with a `calibrated` event: the round trip in seconds and how clearly
     * the signal was heard, or an error.
     */
    void calibrate (const juce::var& message)
    {
        const auto request = (int) message["request"];
        const auto refuse = [request] (const char* why)
        {
            emit ("{\"type\":\"calibrated\",\"request\":" + juce::String (request) + ",\"error\":" + juce::JSON::toString (juce::var (why), true) + "}");
        };
        if (inputChannels == 0) return refuse ("The audio input is not open.");
        if (recording || measuring || engine.isCapturing()) return refuse ("A recording is in progress.");
        engine.stop (0);
        take.clear();
        testSignal = calibrationSignal (engine.getSampleRate());
        engine.prepareCapture (inputChannels);
        engine.startCalibration (&testSignal);
        measuring = true;
        measureRequest = request;
        measureDeadline = juce::Time::getMillisecondCounter() + 5000;
    }

    void finishCalibration()
    {
        engine.drainCapture (take);
        measuring = false;
        const double rate = engine.getSampleRate();
        const auto result = measureDelay (testSignal, toMono (take, takeChannels()), (int) (rate * calibrationMaxDelay));
        take.clear();

        auto* reply = new juce::DynamicObject();
        const juce::var holder (reply);
        reply->setProperty ("type", "calibrated");
        reply->setProperty ("request", measureRequest);
        reply->setProperty ("clarity", result.clarity);
        if (engine.isCalibrating())
            reply->setProperty ("error", "The audio device stopped responding during the measurement.");
        else if (result.clarity < calibrationClarity)
            reply->setProperty ("error", "The test sound was not heard clearly on the input. Turn the volume up and bring the microphone "
                                         "near the speakers (or connect an output to an input with a cable), then try again.");
        else
        {
            reply->setProperty ("seconds", result.frames / rate);
            if (auto* device = devices.getCurrentAudioDevice()) reply->setProperty ("reported", roundTripSeconds (*device));
        }
        emit (juce::JSON::toString (holder, true));
    }

    // ── Recording ─────────────────────────────────────────────────────────

    /** Ends the take and, once the audio thread has let go of it, writes it to `path` and replies with a `take` event. */
    void stopRecording (const juce::var& message)
    {
        if (! recording)
        {
            emit ("{\"type\":\"take\",\"request\":" + juce::String ((int) message["request"]) + ",\"frames\":0}");
            return;
        }
        engine.endCapture();
        finishing = true;
        finishRequest = (int) message["request"];
        finishPath = message["path"].toString();
        // If the device has stalled the audio thread will never answer; do not wait for ever.
        finishDeadline = juce::Time::getMillisecondCounter() + 1000;
    }

    void finishTake()
    {
        engine.drainCapture (take);
        const auto frames = (juce::int64) take.size() / std::max (1, takeChannels());
        auto* reply = new juce::DynamicObject();
        const juce::var holder (reply);
        reply->setProperty ("type", "take");
        reply->setProperty ("request", finishRequest);
        reply->setProperty ("frames", frames);
        if (frames > 0)
        {
            if (writeFloatWav (juce::File (finishPath), take.data(), frames, takeChannels(), engine.getSampleRate()))
            {
                reply->setProperty ("startTick", engine.captureStart());
                auto* device = devices.getCurrentAudioDevice();
                reply->setProperty ("offset", device != nullptr ? roundTripSeconds (*device) : 0.0);
                // The music the player heard was also late by the delay compensation in force.
                reply->setProperty ("compensation", builder.latency() / engine.getSampleRate());
                reply->setProperty ("dropped", engine.captureDropped());
            }
            else reply->setProperty ("error", "Could not write the recording.");
        }
        emit (juce::JSON::toString (holder, true));
        finishing = false;
        recording = false;
        take.clear();
    }

    void abandonTake()
    {
        if (finishing) finishTake();
        recording = false;
        take.clear();
    }

    int takeChannels() const { return juce::jlimit (1, 2, inputChannels); }

    void ready()
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("type", "ready");
        if (auto* device = devices.getCurrentAudioDevice())
        {
            object->setProperty ("device", device->getName());
            object->setProperty ("sampleRate", device->getCurrentSampleRate());
            object->setProperty ("bufferSize", device->getCurrentBufferSizeSamples());
            object->setProperty ("outputLatency", device->getOutputLatencyInSamples() / device->getCurrentSampleRate());
        }
        if (deviceError.isNotEmpty()) object->setProperty ("error", deviceError);
        emit (juce::JSON::toString (juce::var (object), true));
    }

    /** Playhead and meters, sixty times a second. */
    void timerCallback() override
    {
        // A streamed file that was not read in time plays as silence; say so, at most once a second.
        underruns += engine.takeUnderruns();
        if (underruns > 0 && ++sinceUnderrunReport >= 60)
        {
            std::cerr << "streamed audio was not ready for " << underruns << " frames" << std::endl;
            underruns = 0;
            sinceUnderrunReport = 0;
        }

        plugins.poll();

        // The take is moved out of the audio thread's queue as it grows.
        if (recording || measuring) engine.drainCapture (take);
        if (measuring && (! engine.isCalibrating() || juce::Time::getMillisecondCounter() > measureDeadline)) finishCalibration();
        if (finishing && (! engine.isCapturing() || juce::Time::getMillisecondCounter() > finishDeadline)) finishTake();

        juce::String line;
        line << "{\"type\":\"state\",\"seq\":" << engine.appliedSeq()
             << ",\"playing\":" << (engine.isPlaying() ? "true" : "false")
             << ",\"tick\":" << juce::String (engine.position(), 3)
             << ",\"peaks\":{\"master\":" << juce::String (engine.takeMasterPeak(), 4);
        for (const auto& [id, strip] : builder.strips())
            line << "," << juce::JSON::toString (juce::var (id), true) << ":" << juce::String (strip->peak.exchange (0), 4);
        line << "}}";
        emit (line);
    }

    juce::AudioDeviceManager devices;
    Engine engine;
    juce::AudioPluginFormatManager formats;
    /** After the engine, so plugin windows close before anything else goes. */
    PluginHost plugins { formats, &engine };
    SnapshotBuilder builder;
    /** The project as last sent, so a snapshot can be rebuilt when an asset arrives. */
    juce::var project;
    AssetStore assets;
    std::vector<std::shared_ptr<const Sample>> retired;
    /** Files being played from disk, for the loader thread. */
    std::vector<std::shared_ptr<DiskStream>> streams;
    std::mutex streamsLock;
    std::atomic<bool> loading { true };
    std::thread loader;
    int underruns = 0, sinceUnderrunReport = 0;
    /** Keys of stretched copies being made. */
    juce::StringArray stretching;
    /** The one sidecar, for work finishing on other threads to report back to; null once it has gone. */
    static inline Sidecar* instance = nullptr;
    juce::String deviceError;

    /** Channels of audio input open (0 when it is closed). */
    int inputChannels = 0;
    /** A take is being captured, and what has been captured so far (interleaved). */
    bool recording = false;
    std::vector<float> take;
    /** `stopRecording` has been asked for and is waiting on the audio thread. */
    bool finishing = false;
    int finishRequest = 0;
    juce::String finishPath;
    juce::uint32 finishDeadline = 0;

    /** A latency measurement is under way; `testSignal` is what it plays. */
    bool measuring = false;
    int measureRequest = 0;
    juce::uint32 measureDeadline = 0;
    std::vector<float> testSignal;
};

// ── Debug render ───────────────────────────────────────────────────────────

static int renderToFile (const juce::File& projectFile, double seconds, const juce::File& target, AssetStore assets, bool click)
{
    const auto project = juce::JSON::parse (projectFile);
    if (! project.isObject())
    {
        std::cerr << "Could not read " << projectFile.getFullPathName() << std::endl;
        return 1;
    }
    const double rate = 48000;
    // Plugins need the message thread, which here is this one.
    const juce::ScopedJuceInitialiser_GUI juce;
    auto engine = std::make_unique<Engine>();
    SnapshotBuilder builder;
    builder.offline = true;
    engine->prepare (rate);
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager (formats);
    juce::StringArray pluginErrors;
    const auto plugins = createProjectPlugins (formats, project, rate, engine.get(), nullptr, pluginErrors);
    for (const auto& error : pluginErrors) std::cerr << "Could not load a plugin: " << error << std::endl;
    // Some plugins take in a new state through the message thread, which nothing else here would run.
    if (! plugins.empty()) juce::MessageManager::getInstance()->runDispatchLoopUntil (250);
    engine->setSnapshot (buildWithStretches (builder, project, assets, rate, [&plugins] (const juce::String& key)
    {
        const auto found = plugins.find (key);
        return found != plugins.end() ? found->second : nullptr;
    }));
    engine->setMetronome (click);
    engine->play (1);

    const auto frames = (int) (seconds * rate);
    std::vector<float> left ((size_t) frames), right ((size_t) frames), interleaved ((size_t) frames * 2);
    // Device-sized blocks, so block boundaries are exercised as they are live.
    for (int done = 0; done < frames; done += 512)
        engine->render (left.data() + done, right.data() + done, std::min (512, frames - done));
    for (int i = 0; i < frames; ++i)
    {
        interleaved[(size_t) i * 2] = left[(size_t) i];
        interleaved[(size_t) i * 2 + 1] = right[(size_t) i];
    }

    return writeFloatWav (target, interleaved.data(), frames, 2, rate) ? 0 : 1;
}

/** Plays a project with an audio file standing in for the audio input, monitored through a track and captured as a take. */
static int captureToFiles (const juce::File& projectFile, double seconds, const juce::File& inputFile, const juce::File& outFile,
                           const juce::File& takeFile, const juce::String& trackId, double startTick)
{
    const double rate = 48000;
    const auto project = juce::JSON::parse (projectFile);
    const auto input = decode (inputFile, rate);
    if (! project.isObject() || input == nullptr) return 1;

    auto engine = std::make_unique<Engine>();
    SnapshotBuilder builder;
    engine->prepare (rate);
    engine->setSnapshot (builder.build (project, {}, rate));
    if (const auto* strip = builder.find (trackId)) engine->setMonitor (strip->uid);
    const int channels = input->stereo ? 2 : 1;
    engine->prepareCapture (channels);
    engine->seek (startTick, 1);
    engine->play (2, true, true);

    const auto frames = (int) (seconds * rate);
    std::vector<float> inL ((size_t) frames + 512, 0.0f), inR = inL, interleaved ((size_t) frames * 2), take;
    for (int i = 0; i < std::min (frames, input->length); ++i)
    {
        inL[(size_t) i] = input->channels[0][(size_t) i];
        inR[(size_t) i] = input->channels[input->stereo ? 1 : 0][(size_t) i];
    }
    float left[512], right[512];
    for (int done = 0; done < frames; done += 512)
    {
        const int count = std::min (512, frames - done);
        engine->render (left, right, count, inL.data() + done, inR.data() + done);
        engine->drainCapture (take);
        for (int i = 0; i < count; ++i)
        {
            interleaved[(size_t) (done + i) * 2] = left[i];
            interleaved[(size_t) (done + i) * 2 + 1] = right[i];
        }
    }
    std::cout << "{\"startTick\":" << engine->captureStart() << ",\"frames\":" << take.size() / (size_t) channels
              << ",\"channels\":" << channels << ",\"dropped\":" << engine->captureDropped() << "}" << std::endl;
    return writeFloatWav (outFile, interleaved.data(), frames, 2, rate)
        && writeFloatWav (takeFile, take.data(), (juce::int64) take.size() / channels, channels, rate) ? 0 : 1;
}

/**
 * Runs the latency measurement with the engine's output fed back into its
 * input `delay` frames late: quieter (`gain`), dulled as a small speaker and
 * microphone would leave it, upside down, and with noise added.
 */
static int calibrateTest (int delay, double gain, double noise)
{
    const double rate = 48000;
    auto engine = std::make_unique<Engine>();
    SnapshotBuilder builder;
    engine->prepare (rate);
    engine->setSnapshot (builder.build (juce::JSON::parse ("{\"bpm\":120,\"beatsPerBar\":4,\"tracks\":[]}"), {}, rate));
    const auto signal = calibrationSignal (rate);
    engine->prepareCapture (1);
    engine->startCalibration (&signal);

    std::vector<float> played, recorded, input (512);
    float left[512], right[512];
    uint32_t seed = 12345;
    double low = 0;
    for (int block = 0; engine->isCalibrating() && block < 1000; ++block)
    {
        for (int i = 0; i < 512; ++i)
        {
            const auto n = (int) played.size() - 512 * 0 + i - delay; // frame of the output that arrives now
            const double heard = n >= 0 && n < (int) played.size() ? played[(size_t) n] : 0.0;
            low += (heard - low) * 0.35; // a gentle low-pass
            seed = seed * 1664525u + 1013904223u;
            input[(size_t) i] = (float) (-low * gain + ((double) (seed >> 8) / 8388608.0 - 1.0) * noise);
        }
        engine->render (left, right, 512, input.data(), input.data());
        played.insert (played.end(), left, left + 512);
        engine->drainCapture (recorded);
    }
    const auto result = measureDelay (signal, recorded, (int) (rate * calibrationMaxDelay));
    std::cout << "{\"delay\":" << delay << ",\"measured\":" << result.frames << ",\"clarity\":" << result.clarity
              << ",\"accepted\":" << (result.clarity >= calibrationClarity ? "true" : "false") << "}" << std::endl;
    return 0;
}

/** Scans for plugins and prints what it finds, one JSON object per line. */
static int listPlugins()
{
    juce::StringArray failed;
    for (const auto& plugin : scanPlugins (failed))
    {
        auto* object = new juce::DynamicObject();
        const juce::var holder (object);
        object->setProperty ("name", plugin.name);
        object->setProperty ("manufacturer", plugin.manufacturer);
        object->setProperty ("format", plugin.format);
        object->setProperty ("instrument", plugin.instrument);
        object->setProperty ("description", plugin.description);
        std::cout << juce::JSON::toString (holder, true) << std::endl;
    }
    for (const auto& name : failed) std::cerr << "failed: " << name << std::endl;
    return 0;
}

/** Loads a plugin, sets the given parameters and prints its parameters and its state as JSON. */
static int pluginInfo (const juce::File& descriptionFile, const juce::StringArray& settings)
{
    const juce::ScopedJuceInitialiser_GUI juce;
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager (formats);
    juce::String error;
    const auto slot = createPlugin (formats, descriptionFile.loadFileAsString(), 48000, nullptr, true, error);
    if (slot == nullptr)
    {
        std::cerr << error << std::endl;
        return 1;
    }
    const auto& parameters = slot->instance->getParameters();
    for (const auto& setting : settings)
    {
        // `state=file` gives the plugin a state saved earlier (the base64 text this prints).
        if (setting.startsWith ("state="))
        {
            setPluginState (*slot->instance, juce::File::getCurrentWorkingDirectory().getChildFile (setting.substring (6)).loadFileAsString().trim());
            juce::MessageManager::getInstance()->runDispatchLoopUntil (250);
            continue;
        }
        const int index = setting.upToFirstOccurrenceOf ("=", false, false).getIntValue();
        if (index >= 0 && index < parameters.size())
            parameters[index]->setValueNotifyingHost (setting.fromFirstOccurrenceOf ("=", false, false).getFloatValue());
    }
    juce::Array<juce::var> list;
    for (auto* parameter : parameters)
    {
        auto* object = new juce::DynamicObject();
        object->setProperty ("name", parameter->getName (64));
        object->setProperty ("value", parameter->getValue());
        object->setProperty ("text", parameter->getCurrentValueAsText());
        list.add (juce::var (object));
    }
    auto* object = new juce::DynamicObject();
    const juce::var holder (object);
    object->setProperty ("hasEditor", slot->instance->hasEditor());
    object->setProperty ("latency", slot->instance->getLatencySamples());
    // How the plugin ended up after being asked for stereo: its channels in and out, and each bus's arrangement.
    object->setProperty ("inputs", slot->instance->getTotalNumInputChannels());
    object->setProperty ("outputs", slot->instance->getTotalNumOutputChannels());
    juce::StringArray buses;
    for (const bool input : { true, false })
        for (int i = 0; i < slot->instance->getBusCount (input); ++i)
            buses.add (juce::String (input ? "in " : "out ") + slot->instance->getBus (input, i)->getName() + ": "
                       + slot->instance->getChannelLayoutOfBus (input, i).getDescription());
    object->setProperty ("buses", buses.joinIntoString ("; "));
    object->setProperty ("midiEffect", slot->instance->isMidiEffect());
    object->setProperty ("acceptsMidi", slot->instance->acceptsMidi());
    object->setProperty ("parameters", list);
    object->setProperty ("state", pluginState (*slot->instance));
    std::cout << juce::JSON::toString (holder, true) << std::endl;
    return 0;
}

int main (int argc, char* argv[])
{
    if (argc == 4 && juce::String (argv[1]) == "--scan-plugins")
        return scanPluginsChild (juce::File::getCurrentWorkingDirectory().getChildFile (argv[2]), juce::String (argv[3]).getIntValue());
    if (argc == 2 && juce::String (argv[1]) == "--list-plugins") return listPlugins();
    if (argc >= 3 && juce::String (argv[1]) == "--plugin-info")
        return pluginInfo (juce::File::getCurrentWorkingDirectory().getChildFile (argv[2]), juce::StringArray (argv + 3, argc - 3));
    if (argc == 5 && juce::String (argv[1]) == "--calibrate-test")
        return calibrateTest (juce::String (argv[2]).getIntValue(), juce::String (argv[3]).getDoubleValue(), juce::String (argv[4]).getDoubleValue());
    if (argc == 9 && juce::String (argv[1]) == "--capture")
    {
        const auto here = juce::File::getCurrentWorkingDirectory();
        return captureToFiles (here.getChildFile (argv[2]), juce::String (argv[3]).getDoubleValue(), here.getChildFile (argv[4]),
                               here.getChildFile (argv[5]), here.getChildFile (argv[6]), argv[7], juce::String (argv[8]).getDoubleValue());
    }
    if (argc >= 5 && juce::String (argv[1]) == "--render")
    {
        const auto here = juce::File::getCurrentWorkingDirectory();
        AssetStore assets;
        bool click = false;
        for (int i = 5; i < argc; ++i)
        {
            const juce::String pair (argv[i]);
            if (pair == "click") { click = true; continue; }
            const auto source = pair.fromFirstOccurrenceOf ("=", false, false);
            const auto sample = source.startsWith ("stream:") ? streamed (here.getChildFile (source.substring (7)), true)
                                                              : decode (here.getChildFile (source), 48000);
            if (sample == nullptr)
            {
                std::cerr << "Could not decode " << pair << std::endl;
                return 1;
            }
            assets[pair.upToFirstOccurrenceOf ("=", false, false)] = sample;
        }
        return renderToFile (here.getChildFile (argv[2]), juce::String (argv[3]).getDoubleValue(), here.getChildFile (argv[4]), assets, click);
    }

    // From here on stdout proper belongs to whatever plugins care to print (it joins the log on stderr).
    protocol = fdopen (dup (STDOUT_FILENO), "w");
    dup2 (STDERR_FILENO, STDOUT_FILENO);

    const juce::ScopedJuceInitialiser_GUI juce;
    // Plugin windows need this process to be an application, though one with no icon in the Dock.
    juce::Process::setDockIconVisible (false);
    auto sidecar = std::make_unique<Sidecar>();

    // Commands are read on their own thread and handled on the message thread.
    std::thread reader ([&sidecar]
    {
        std::string line;
        while (std::getline (std::cin, line))
        {
            juce::MessageManager::callAsync ([&sidecar, text = juce::String::fromUTF8 (line.c_str())]
            {
                if (sidecar != nullptr) sidecar->handle (text);
            });
        }
        // The app has gone away (or closed the pipe): stop.
        juce::MessageManager::getInstance()->stopDispatchLoop();
    });
    reader.detach();

    // A console app has no NSApplication for runDispatchLoop() to run, so the run loop is pumped directly.
    while (juce::MessageManager::getInstance()->runDispatchLoopUntil (100)) {}
    sidecar.reset();
    return 0;
}
