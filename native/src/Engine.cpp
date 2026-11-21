#include "Engine.h"
#include "Plugins.h"
#include "Stream.h"

namespace studio
{
static constexpr double halfPi = 1.5707963267948966;
static constexpr double twoPi = 6.283185307179586;

// ── Control thread ─────────────────────────────────────────────────────────

void Engine::prepare (double sampleRateIn)
{
    sampleRate = sampleRateIn > 0 ? sampleRateIn : 48000;
}

void Engine::setSnapshot (std::shared_ptr<const Snapshot> snapshot)
{
    {
        const juce::SpinLock::ScopedLockType lock (snapshotLock);
        std::swap (pending, snapshot);
        hasPending.store (true);
    }
    // `snapshot` now holds whatever was waiting or retired, and is freed here.
}

void Engine::prepareCapture (int channels)
{
    captureChannels = juce::jlimit (1, 2, channels);
    // Four seconds of headroom between visits from the control thread.
    const auto size = (int) (sampleRate * 4) * captureChannels;
    if (captureFifo == nullptr || captureFifo->getTotalSize() != size)
    {
        captureQueue.assign ((size_t) size, 0.0f);
        captureFifo = std::make_unique<juce::AbstractFifo> (size);
    }
    captureFifo->reset();
    dropped.store (0);
}

void Engine::drainCapture (std::vector<float>& into)
{
    if (captureFifo == nullptr) return;
    const auto scope = captureFifo->read (captureFifo->getNumReady());
    into.insert (into.end(), captureQueue.begin() + scope.startIndex1, captureQueue.begin() + scope.startIndex1 + scope.blockSize1);
    into.insert (into.end(), captureQueue.begin() + scope.startIndex2, captureQueue.begin() + scope.startIndex2 + scope.blockSize2);
}

void Engine::push (const Command& command)
{
    const auto scope = queue.write (1);
    if (scope.blockSize1 > 0) commands[scope.startIndex1] = command;
    else if (scope.blockSize2 > 0) commands[scope.startIndex2] = command;
}

// ── Audio thread ───────────────────────────────────────────────────────────

void Engine::audioDeviceAboutToStart (juce::AudioIODevice* device)
{
    prepare (device->getCurrentSampleRate());
}

void Engine::audioDeviceIOCallbackWithContext (const float* const* input, int numInputs, float* const* output, int numOutputs, int frames,
                                               const juce::AudioIODeviceCallbackContext&)
{
    if (numOutputs < 1 || output[0] == nullptr) return;
    // A mono input feeds both sides.
    const float* inLeft = numInputs > 0 ? input[0] : nullptr;
    const float* inRight = numInputs > 1 && input[1] != nullptr ? input[1] : inLeft;
    float* left = output[0];
    // A mono device gets the left channel; the right is rendered into scratch space a chunk at a time.
    float* right = numOutputs > 1 && output[1] != nullptr ? output[1] : nullptr;
    render (left, right, frames, inLeft, inRight);
    for (int c = 2; c < numOutputs; ++c)
        if (output[c] != nullptr) juce::FloatVectorOperations::clear (output[c], frames);
}

void Engine::render (float* left, float* right, int frames, const float* inLeft, const float* inRight)
{
    const juce::ScopedNoDenormals noDenormals;
    float scratch[Strip::maxBlock];
    for (int done = 0; done < frames;)
    {
        const int count = std::min (frames - done, (int) Strip::maxBlock);
        renderChunk (left + done, right != nullptr ? right + done : scratch, count,
                     inLeft != nullptr ? inLeft + done : nullptr, inRight != nullptr ? inRight + done : nullptr);
        done += count;
    }
}

void Engine::anchorAt (const Snapshot& snapshot, double newTick)
{
    tick = newTick;
    anchorSeconds = snapshot.map.tickToSeconds (newTick);
    anchorFrames = 0;
}

void Engine::silence (const Snapshot& snapshot)
{
    for (const auto& track : snapshot.tracks)
    {
        for (auto& voice : track.strip->voices)
            if (voice.active && ! voice.live) voice.kill();
        track.strip->pluginRelease (-1, 0, true);
    }
}

void Engine::apply (const Command& command, const Snapshot& snapshot)
{
    switch (command.type)
    {
        case Command::play:
            if (! playing.load())
            {
                anchorAt (snapshot, tick);
                loopSuspended = (command.pitch & 1) != 0;
                if ((command.pitch & 2) != 0 && captureFifo != nullptr)
                {
                    // The take starts on this very frame, so its first sample belongs at this tick.
                    captureTick.store (tick);
                    capturing.store (true);
                }
                playing.store (true);
            }
            lastSeq.store (command.seq);
            break;
        case Command::stop:
            playing.store (false);
            loopSuspended = false;
            capturing.store (false);
            silence (snapshot);
            lastSeq.store (command.seq);
            break;
        case Command::seek:
            if (playing.load()) silence (snapshot);
            anchorAt (snapshot, std::max (0.0, command.tick));
            lastSeq.store (command.seq);
            break;
        case Command::endCapture:
            capturing.store (false);
            break;
        case Command::calibrate:
            // Capture and signal begin on the same frame, so the delay found is the whole round trip.
            if (captureFifo != nullptr && calibrationSignal != nullptr)
            {
                calibrationFrame = 0;
                capturing.store (true);
            }
            else calibrating.store (false);
            break;
        case Command::noteOn:
        case Command::noteOff:
            for (const auto& track : snapshot.tracks)
            {
                if (track.strip->uid != command.strip) continue;
                if (track.instrument == Instrument::plugin)
                {
                    // Starting a note lets go of the same pitch first, in `startVoice`.
                    if (command.type == Command::noteOn) startVoice (track, command.pitch, command.velocity, true, -1, 0, 0);
                    else track.strip->pluginRelease (command.pitch, 0);
                    continue;
                }
                // A held note of the same pitch is let go first.
                for (auto& voice : track.strip->voices)
                    if (voice.active && voice.live && voice.pitch == command.pitch && voice.offFrame == Voice::held)
                        voice.offFrame = blockFrame;
                if (command.type == Command::noteOn)
                    startVoice (track, command.pitch, command.velocity, true, -1, 0, 0);
            }
            break;
    }
}

/**
 * Starts a voice `offset` frames into the current chunk and, when `frames`
 * is given, renders it from there to the end of the chunk. `seconds` is the
 * note's length; negative for a held note.
 */
void Engine::startVoice (const TrackSnapshot& track, int pitch, float velocity, bool live, double seconds, int offset, int frames)
{
    auto& strip = *track.strip;
    if (track.instrument == Instrument::plugin)
    {
        // A plugin is sent the note; it is let go in `mixStrip` when its time comes.
        strip.pluginRelease (pitch, offset);
        if (strip.pluginNoteCount == Strip::maxPluginNotes) return;
        strip.pluginEvent (offset, 0x90, juce::jlimit (0, 127, pitch), juce::jlimit (1, 127, (int) std::lround (velocity * 127.0f)));
        const auto off = seconds >= 0 ? blockFrame + offset + std::max<int64_t> (1, (int64_t) std::llround (seconds * sampleRate)) : Voice::held;
        strip.pluginNotes[strip.pluginNoteCount++] = { pitch, off, live };
        return;
    }
    Voice* chosen = nullptr;
    for (auto& voice : strip.voices)
    {
        if (! voice.active) { chosen = &voice; break; }
        // Out of voices: the oldest makes way.
        if (chosen == nullptr || voice.order < chosen->order) chosen = &voice;
    }
    if (! chosen->start (track.instrument, track.sampler, pitch, velocity, live, sampleRate, ++strip.voiceCounter)) return;
    if (seconds >= 0)
        chosen->offFrame = blockFrame + offset + std::max<int64_t> (1, (int64_t) std::llround (seconds * sampleRate));
    if (frames > offset) chosen->render (strip.left, strip.right, offset, frames, blockFrame, track.params);
}

void Engine::startClick (bool accent, int offset, int delay)
{
    for (auto& click : clicks)
    {
        if (click.active) continue;
        const double level = accent ? 0.3 : 0.18;
        click.active = true;
        click.phase = 0;
        click.step = (accent ? 1760.0 : 1175.0) / sampleRate;
        // Negative while waiting for its start frame. The click is held back as the music is by delay
        // compensation, so the two stay together.
        click.remaining = -(offset + delay);
        click.level = level;
        // Falls to 0.001 over 50 ms, then is cut at 60 ms.
        click.decay = std::pow (0.001 / level, 1.0 / (0.05 * sampleRate));
        return;
    }
}

/**
 * Adds the track's audio clips to frames [frame, frame + count) of its strip,
 * where `frame` is at `startSeconds` on the project's clock. A clip's audio
 * is found from the clock alone, so there is nothing to start, stop or keep
 * in step when the playhead jumps, loops or the project is edited.
 */
void Engine::renderClips (const TrackSnapshot& track, int frame, int count, double startSeconds)
{
    auto& strip = *track.strip;
    const double endSeconds = startSeconds + count / sampleRate;
    for (const auto& clip : track.clips)
    {
        const auto& sample = *clip.sample;
        if (sample.stream != nullptr)
        {
            // A clip about to start has its opening read in ahead of time.
            if (clip.start >= endSeconds && clip.start - endSeconds < 2.0)
                sample.stream->want ((int) (clip.offset * clip.ratio * sample.rate) >> DiskStream::blockShift, chunkTime);
            if (clip.start >= endSeconds || clip.start + clip.duration <= startSeconds) continue;
            renderStreamedClip (strip, clip, frame, count, startSeconds);
            continue;
        }
        if (clip.start >= endSeconds || clip.start + clip.duration <= startSeconds) continue;
        const float* a = sample.channels[0].data();
        const float* b = sample.stereo ? sample.channels[1].data() : a;
        const int last = sample.length - 1;
        // Where the clip begins, in frames from the start of this stretch (negative if it is already under way).
        const double first = (clip.start - startSeconds) * sampleRate;
        for (int k = std::max (0, (int) std::ceil (first - 1e-6)); k < count; ++k)
        {
            const double into = std::max (0.0, (k - first) / sampleRate);
            if (into >= clip.duration) break;
            const double position = (clip.offset * clip.ratio + into * clip.rate) * sample.rate;
            const auto index = (int) position;
            if (index >= last) break;
            // Clip gain with linear fades at either end.
            double level = clip.gain;
            if (clip.fadeIn > 0 && into < clip.fadeIn) level *= into / clip.fadeIn;
            if (clip.fadeOut > 0 && clip.duration - into < clip.fadeOut) level *= (clip.duration - into) / clip.fadeOut;
            const double mix = position - index;
            strip.left[frame + k] += (float) ((a[index] + (a[index + 1] - a[index]) * mix) * level);
            strip.right[frame + k] += (float) ((b[index] + (b[index + 1] - b[index]) * mix) * level);
        }
    }
}

/**
 * Writes an automation curve into frames [frame, frame + count) of `target`,
 * for the stretch of timeline [fromTick, toTick) that starts at
 * `startSeconds`: a straight line in time from each breakpoint to the next,
 * as the Web Audio engine's parameter ramps are.
 */
void Engine::writeCurve (const Snapshot& snapshot, const std::vector<AutoPoint>& points, float* target, int frame, int count,
                         double fromTick, double toTick, double startSeconds)
{
    int at = 0;
    double value = automationValue (points, fromTick);
    // Starting exactly on a step (two points on one tick), take the value the step lands on.
    for (const auto& point : points)
        if (point.tick == fromTick) value = point.value;
    const auto lineTo = [&] (int end, double endValue)
    {
        const double step = end > at ? (endValue - value) / (end - at) : 0.0;
        for (int k = at; k < end; ++k) target[frame + k] = (float) (value + step * (k - at));
        at = end;
        value = endValue;
    };
    for (const auto& point : points)
    {
        if (point.tick <= fromTick) continue;
        if (point.tick >= toTick) break;
        const auto within = (int) std::llround ((snapshot.map.tickToSeconds (point.tick) - startSeconds) * sampleRate);
        lineTo (juce::jlimit (at, count, within), point.value);
    }
    // The last frame stops one step short of the value at `toTick`, which belongs to the next stretch.
    const double endValue = automationValue (points, toTick);
    const int from = at;
    const double step = count > from ? (endValue - value) / (count - from) : 0.0;
    for (int k = from; k < count; ++k) target[frame + k] = (float) (value + step * (k - from));
}

/** As the loop in renderClips, for a clip whose audio comes from disk a block at a time. */
void Engine::renderStreamedClip (Strip& strip, const ClipSnapshot& clip, int frame, int count, double startSeconds)
{
    const auto& sample = *clip.sample;
    const auto& stream = *sample.stream;
    const int last = sample.length - 1;
    const double first = (clip.start - startSeconds) * sampleRate;
    const DiskStream::Block* block = nullptr;
    int blockIndex = -1, missed = 0;
    for (int k = std::max (0, (int) std::ceil (first - 1e-6)); k < count; ++k)
    {
        const double into = std::max (0.0, (k - first) / sampleRate);
        if (into >= clip.duration) break;
        const double position = (clip.offset * clip.ratio + into * clip.rate) * sample.rate;
        const auto index = (int) position;
        if (index >= last) break;
        if ((index >> DiskStream::blockShift) != blockIndex)
        {
            blockIndex = index >> DiskStream::blockShift;
            block = stream.block (blockIndex, chunkTime);
        }
        // Not read in yet: silence rather than a wait.
        if (block == nullptr) { ++missed; continue; }
        double level = clip.gain;
        if (clip.fadeIn > 0 && into < clip.fadeIn) level *= into / clip.fadeIn;
        if (clip.fadeOut > 0 && clip.duration - into < clip.fadeOut) level *= (clip.duration - into) / clip.fadeOut;
        const int at = index & (DiskStream::blockFrames - 1);
        const double mix = position - index;
        const float* a = block->data[0];
        const float* b = block->data[1];
        strip.left[frame + k] += (float) ((a[at] + (a[at + 1] - a[at]) * mix) * level);
        strip.right[frame + k] += (float) ((b[at] + (b[at + 1] - b[at]) * mix) * level);
    }
    if (missed > 0) underruns.fetch_add (missed, std::memory_order_relaxed);
}

/**
 * While stopped: asks every streamed clip under or just ahead of the
 * playhead for the audio there, so that pressing play finds it in memory.
 */
void Engine::wantStreams (const Snapshot& snapshot, double seconds)
{
    for (const auto& track : snapshot.tracks)
        for (const auto& clip : track.clips)
        {
            if (clip.sample->stream == nullptr) continue;
            const double into = seconds - clip.start;
            if (into < -2.0 || into >= clip.duration) continue;
            const double position = (clip.offset * clip.ratio + std::max (0.0, into) * clip.rate) * clip.sample->rate;
            clip.sample->stream->want ((int) position >> DiskStream::blockShift, chunkTime);
        }
}

/** Starts everything that falls within the next `frames` frames of the timeline, and moves the playhead on. */
void Engine::sequence (const Snapshot& snapshot, int frames)
{
    const auto& map = snapshot.map;
    const bool clicking = metronome.load();
    int frame = 0;
    // A loop shorter than the chunk wraps more than once; the cap only guards against a degenerate project.
    for (int pass = 0; frame < frames && pass < 64; ++pass)
    {
        const int remaining = frames - frame;
        const double startSeconds = anchorSeconds + (double) anchorFrames / sampleRate;
        double endTick = map.secondsToTick (anchorSeconds + (double) (anchorFrames + remaining) / sampleRate);
        int count = remaining;
        const bool wrap = snapshot.looping && ! loopSuspended && tick < snapshot.loopEnd && endTick >= snapshot.loopEnd;
        if (wrap)
        {
            endTick = snapshot.loopEnd;
            count = juce::jlimit (0, remaining, (int) std::llround ((map.tickToSeconds (endTick) - startSeconds) * sampleRate));
        }
        const auto frameOf = [&] (double at)
        {
            const auto within = (int) std::llround ((map.tickToSeconds (at) - startSeconds) * sampleRate);
            return frame + juce::jlimit (0, std::max (0, count - 1), within);
        };

        for (const auto& track : snapshot.tracks)
        {
            if (! track.volumeCurve.empty()) writeCurve (snapshot, track.volumeCurve, track.strip->autoVolume, frame, count, tick, endTick, startSeconds);
            if (! track.panCurve.empty()) writeCurve (snapshot, track.panCurve, track.strip->autoPan, frame, count, tick, endTick, startSeconds);
            if (! track.clips.empty()) renderClips (track, frame, count, startSeconds);
            if (track.instrument == Instrument::none) continue;
            auto note = std::lower_bound (track.notes.begin(), track.notes.end(), tick,
                                          [] (const TimedNote& n, double t) { return n.tick < t; });
            for (; note != track.notes.end() && note->tick < endTick; ++note)
                startVoice (track, note->pitch, note->velocity, false, note->seconds, frameOf (note->tick), frames);
        }

        if (clicking)
        {
            // One click per beat of the time signature in force, accented on the bar line.
            for (auto bar = map.barAt (tick); bar.start < endTick; bar = map.barAt (bar.start + bar.length))
                for (int beat = 0; beat < bar.beats; ++beat)
                {
                    const double at = bar.start + beat * bar.beatTicks;
                    if (at >= tick && at < endTick) startClick (beat == 0, frameOf (at), snapshot.latency);
                }
        }

        frame += count;
        anchorFrames += count;
        tick = endTick;
        if (wrap) anchorAt (snapshot, snapshot.loopStart);
    }
}

/**
 * One channel strip for one chunk: insert effects → fader → pan → mute/solo
 * gate, and from there to the master, the meter and the track's sends.
 */
void Engine::mixStrip (const TrackSnapshot& track, int frames)
{
    auto& strip = *track.strip;

    if (track.plugin != nullptr)
    {
        // Notes that end within this chunk are let go on their exact frame.
        for (int n = 0; n < strip.pluginNoteCount;)
        {
            const auto note = strip.pluginNotes[n];
            if (note.offFrame >= blockFrame + frames) { ++n; continue; }
            strip.pluginEvent ((int) std::max<int64_t> (0, note.offFrame - blockFrame), 0x80, note.pitch, 0);
            strip.pluginNotes[n] = strip.pluginNotes[--strip.pluginNoteCount];
        }
        track.plugin->process (strip.left, strip.right, frames, strip.pluginEvents, strip.pluginEventCount, true);
    }
    else strip.pluginNoteCount = 0;
    strip.pluginEventCount = 0;

    // Effects run even with nothing coming in, so delay and reverb tails ring out.
    for (const auto& effect : track.effects)
    {
        if (effect.plugin != nullptr)
        {
            effect.plugin->process (strip.left, strip.right, frames, nullptr, 0, false);
            continue;
        }
        effect.unit->set (effect.params);
        effect.unit->process (strip.left, strip.right, frames);
    }

    // Delay compensation: wait for the strips whose plugins take longer.
    if (track.delay != nullptr) track.delay->process (strip.left, strip.right, frames, track.delayFrames);

    const auto faderCoef = (float) approach (0.015, sampleRate);
    const auto gateCoef = (float) approach (0.01, sampleRate);
    const float gateTarget = track.audible ? 1.0f : 0.0f;
    if (strip.volume < 0)
    {
        strip.volume = track.volume;
        strip.pan = track.pan;
        strip.gate = gateTarget;
    }
    // While the transport runs, a parameter with a curve follows it; otherwise it eases to its control.
    const bool autoVolume = automating && ! track.volumeCurve.empty();
    const bool autoPan = automating && ! track.panCurve.empty();
    float peak = 0, lastPan = 2, gainL = 0, gainR = 1;
    for (int i = 0; i < frames; ++i)
    {
        if (autoVolume) strip.volume = strip.autoVolume[i];
        else strip.volume += (track.volume - strip.volume) * faderCoef;
        if (autoPan) strip.pan = strip.autoPan[i];
        else strip.pan += (track.pan - strip.pan) * faderCoef;
        strip.gate += (gateTarget - strip.gate) * gateCoef;
        if (strip.pan != lastPan)
        {
            lastPan = strip.pan;
            const double x = (lastPan <= 0 ? lastPan + 1.0 : (double) lastPan) * halfPi;
            gainL = (float) std::cos (x);
            gainR = (float) std::sin (x);
        }
        const float inL = strip.left[i] * strip.volume, inR = strip.right[i] * strip.volume;
        // The Web Audio stereo panner's law for a stereo input.
        const float l = (lastPan <= 0 ? inL + inR * gainL : inL * gainL) * strip.gate;
        const float r = (lastPan <= 0 ? inR * gainR : inR + inL * gainR) * strip.gate;
        // The strip's buffer now holds its output, for the sends below.
        strip.left[i] = l;
        strip.right[i] = r;
        masterL[i] += l;
        masterR[i] += r;
        peak = std::max (peak, std::max (std::abs (l), std::abs (r)));
    }
    if (peak > strip.peak.load (std::memory_order_relaxed)) strip.peak.store (peak, std::memory_order_relaxed);

    for (size_t s = 0; s < track.sends.size(); ++s)
    {
        const auto& send = track.sends[s];
        auto& state = strip.sends[s];
        // A send that has just appeared in this slot starts at its level rather than gliding to it.
        if (state.bus != send.bus->uid) state = { send.bus->uid, send.level };
        for (int i = 0; i < frames; ++i)
        {
            state.gain += (send.level - state.gain) * faderCoef;
            send.bus->left[i] += strip.left[i] * state.gain;
            send.bus->right[i] += strip.right[i] * state.gain;
        }
    }
}

void Engine::renderChunk (float* outL, float* outR, int frames, const float* inLeft, const float* inRight)
{
    if (hasPending.load())
    {
        const juce::SpinLock::ScopedTryLockType lock (snapshotLock);
        if (lock.isLocked())
        {
            std::swap (current, pending);
            hasPending.store (false);
            // The tempo may have changed: carry on from the same tick on the new clock.
            if (current != nullptr) anchorAt (*current, tick);
        }
    }
    const Snapshot* snapshot = current.get();
    if (snapshot == nullptr)
    {
        juce::FloatVectorOperations::clear (outL, frames);
        juce::FloatVectorOperations::clear (outR, frames);
        return;
    }

    {
        const auto scope = queue.read (queue.getNumReady());
        for (int i = 0; i < scope.blockSize1; ++i) apply (commands[scope.startIndex1 + i], *snapshot);
        for (int i = 0; i < scope.blockSize2; ++i) apply (commands[scope.startIndex2 + i], *snapshot);
    }

    // The take: the input exactly as it arrived, from the frame the transport started on.
    if (inLeft != nullptr && capturing.load())
    {
        const int wanted = frames * captureChannels;
        // All of the block or none of it, so the channels never fall out of step.
        if (captureFifo->getFreeSpace() < wanted)
        {
            dropped.fetch_add (frames);
        }
        else
        {
            const auto scope = captureFifo->write (wanted);
            const auto put = [&] (int start, int size, int from)
            {
                for (int n = 0; n < size; ++n)
                {
                    const int sample = from + n;
                    captureQueue[(size_t) (start + n)] = captureChannels == 1 ? inLeft[sample] : (sample % 2 == 0 ? inLeft : inRight)[sample / 2];
                }
            };
            put (scope.startIndex1, scope.blockSize1, 0);
            put (scope.startIndex2, scope.blockSize2, scope.blockSize1);
        }
    }

    // What hosted plugins are told about the transport.
    {
        const auto bar = snapshot->map.barAt (tick);
        const double seconds = snapshot->map.tickToSeconds (tick);
        PositionInfo info;
        info.setIsPlaying (playing.load());
        info.setIsRecording (capturing.load());
        info.setIsLooping (snapshot->looping && ! loopSuspended);
        info.setBpm (snapshot->map.bpmAt (tick));
        info.setTimeSignature (TimeSignature { bar.beats, (int) std::lround (PPQ * 4.0 / bar.beatTicks) });
        info.setPpqPosition (tick / PPQ);
        info.setPpqPositionOfLastBarStart (bar.start / PPQ);
        info.setTimeInSeconds (seconds);
        info.setTimeInSamples ((int64_t) std::llround (seconds * sampleRate));
        playHeadInfo = info;
    }

    // Voices already sounding fill the whole chunk.
    const auto monitor = inLeft != nullptr ? monitorStrip.load() : 0u;
    for (const auto& track : snapshot->tracks)
    {
        auto& strip = *track.strip;
        juce::FloatVectorOperations::clear (strip.left, frames);
        juce::FloatVectorOperations::clear (strip.right, frames);
        // Input monitoring: the input joins the strip before its effects and fader.
        if (strip.uid == monitor)
        {
            juce::FloatVectorOperations::add (strip.left, inLeft, frames);
            juce::FloatVectorOperations::add (strip.right, inRight, frames);
        }
        for (auto& voice : strip.voices)
            if (voice.active) voice.render (strip.left, strip.right, 0, frames, blockFrame, track.params);
    }

    // Notes due in this chunk start part-way through it, on their exact sample.
    chunkTime = juce::Time::getMillisecondCounter();
    automating = playing.load();
    if (automating) sequence (*snapshot, frames);
    else wantStreams (*snapshot, snapshot->map.tickToSeconds (tick));

    juce::FloatVectorOperations::clear (masterL, frames);
    juce::FloatVectorOperations::clear (masterR, frames);

    // Tracks first, so that what they send has reached the buses by the time those are mixed.
    for (const auto& track : snapshot->tracks)
        if (! track.bus) mixStrip (track, frames);
    // The tracks' sum waits for the slowest bus.
    trackDelay.process (masterL, masterR, frames, snapshot->busLatency);
    for (const auto& track : snapshot->tracks)
        if (track.bus) mixStrip (track, frames);

    // Metronome, straight into the master.
    for (auto& click : clicks)
    {
        if (! click.active) continue;
        const int limit = (int) (0.06 * sampleRate);
        for (int i = std::max (0, -click.remaining); i < frames; ++i)
        {
            const auto sample = (float) (std::sin (twoPi * click.phase) * click.level);
            masterL[i] += sample;
            masterR[i] += sample;
            click.phase += click.step;
            click.level *= click.decay;
        }
        click.remaining += frames;
        if (click.remaining >= limit) click.active = false;
    }

    // Safety limiter: anything over -3 dB is squeezed 20:1. The Web Audio
    // engine's looks 6 ms ahead to catch peaks; this one adds no latency and
    // instead clamps down the instant a peak arrives, then lets go slowly.
    // The clamp below is only a last resort for absurd levels.
    const double threshold = 0.7079457843841379;
    const double release = approach (0.1, sampleRate);
    float peak = 0;
    for (int i = 0; i < frames; ++i)
    {
        const double level = std::max (std::abs (masterL[i]), std::abs (masterR[i]));
        limiterEnv = level > limiterEnv ? level : limiterEnv + (level - limiterEnv) * release;
        const auto gain = (float) (limiterEnv > threshold ? threshold * std::pow (limiterEnv / threshold, 0.05) / limiterEnv : 1.0);
        outL[i] = juce::jlimit (-1.0f, 1.0f, masterL[i] * gain);
        outR[i] = juce::jlimit (-1.0f, 1.0f, masterR[i] * gain);
        peak = std::max (peak, std::max (std::abs (outL[i]), std::abs (outR[i])));
    }
    if (peak > masterPeak.load (std::memory_order_relaxed)) masterPeak.store (peak, std::memory_order_relaxed);

    // The latency test signal goes out after the limiter, untouched by the mix.
    if (calibrationFrame >= 0)
    {
        const auto total = (int64_t) calibrationSignal->size();
        for (int i = 0; i < frames && calibrationFrame + i < total; ++i)
        {
            const float sample = (*calibrationSignal)[(size_t) (calibrationFrame + i)];
            outL[i] = juce::jlimit (-1.0f, 1.0f, outL[i] + sample);
            outR[i] = juce::jlimit (-1.0f, 1.0f, outR[i] + sample);
        }
        calibrationFrame += frames;
        if (calibrationFrame >= total)
        {
            calibrationFrame = -1;
            capturing.store (false);
            calibrating.store (false);
        }
    }

    blockFrame += frames;
    publishedTick.store (tick);
}
} // namespace studio
