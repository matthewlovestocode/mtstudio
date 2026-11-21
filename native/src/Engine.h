// The audio side of the engine: transport, sequencing, channel strips and
// meters. `render` has no knowledge of the audio device, so the same code
// runs live and in the offline debug render.
#pragma once

#include <juce_audio_devices/juce_audio_devices.h>

#include "Model.h"

namespace studio
{
class Engine final : public juce::AudioIODeviceCallback,
                     public juce::AudioPlayHead
{
public:
    // ── Control thread ────────────────────────────────────────────────────
    void prepare (double sampleRateIn);
    void setSnapshot (std::shared_ptr<const Snapshot> snapshot);
    /** Transport commands carry the caller's sequence number, echoed back by `appliedSeq`. */
    /**
     * With `ignoreLoop` the loop region is passed over until the next stop, as
     * when recording. With `capture` the audio input is recorded from the very
     * frame the transport starts on; call `prepareCapture` first.
     */
    void play (int seq, bool ignoreLoop = false, bool capture = false)
    {
        push ({ Command::play, seq, 0, (ignoreLoop ? 1 : 0) | (capture ? 2 : 0), 0, 0 });
    }
    void stop (int seq)              { push ({ Command::stop, seq, 0, 0, 0, 0 }); }
    void seek (double tick, int seq) { push ({ Command::seek, seq, 0, 0, 0, tick }); }
    void noteOn (uint32_t strip, int pitch, float velocity) { push ({ Command::noteOn, 0, strip, pitch, velocity, 0 }); }
    void noteOff (uint32_t strip, int pitch)                { push ({ Command::noteOff, 0, strip, pitch, 0, 0 }); }
    void setMetronome (bool enabled) { metronome.store (enabled); }

    /** The strip the audio input is heard through (0 for none). */
    void setMonitor (uint32_t strip) { monitorStrip.store (strip); }
    /** Makes room for a take of `channels` channels (1 or 2). Only while nothing is being captured. */
    void prepareCapture (int channels);
    /**
     * Plays `signal` straight to the output while capturing the input, then
     * stops by itself. Call `prepareCapture` first; `signal` must outlive the
     * run. `isCalibrating` turns false when it is over.
     */
    void startCalibration (const std::vector<float>* signal)
    {
        calibrationSignal = signal;
        calibrating.store (true);
        push ({ Command::calibrate, 0, 0, 0, 0, 0 });
    }
    bool isCalibrating() const { return calibrating.load(); }
    /** Stops capturing at the next block, leaving the transport alone. `isCapturing` turns false once it has. */
    void endCapture()        { push ({ Command::endCapture, 0, 0, 0, 0, 0 }); }
    bool isCapturing() const { return capturing.load(); }
    /** Timeline position of the first captured frame. */
    double captureStart() const { return captureTick.load(); }
    /** Frames lost because `drainCapture` was not called often enough. */
    int captureDropped() const  { return dropped.load(); }
    /** Frames of streamed audio that were not in memory when they were due, since the last call. */
    int takeUnderruns()         { return underruns.exchange (0); }
    /** Moves what has been captured so far (interleaved) onto the end of `into`. Call it regularly during a take. */
    void drainCapture (std::vector<float>& into);

    bool isPlaying() const   { return playing.load(); }
    double position() const  { return publishedTick.load(); }
    int appliedSeq() const   { return lastSeq.load(); }
    float takeMasterPeak()   { return masterPeak.exchange (0); }
    double getSampleRate() const { return sampleRate; }

    // ── Audio thread ──────────────────────────────────────────────────────
    /** Renders the next `frames` frames of stereo output. `inLeft`/`inRight` are the audio input, if one is open. */
    void render (float* left, float* right, int frames, const float* inLeft = nullptr, const float* inRight = nullptr);

    void audioDeviceIOCallbackWithContext (const float* const* input, int numInputs, float* const* output, int numOutputs, int frames,
                                           const juce::AudioIODeviceCallbackContext&) override;
    void audioDeviceAboutToStart (juce::AudioIODevice* device) override;
    void audioDeviceStopped() override {}

    /** For hosted plugins: where the transport is at the start of the chunk being rendered. Audio thread. */
    juce::Optional<PositionInfo> getPosition() const override { return playHeadInfo; }

private:
    struct Command
    {
        enum Type { play, stop, seek, noteOn, noteOff, endCapture, calibrate } type;
        int seq;
        uint32_t strip;
        int pitch;
        float velocity;
        double tick;
    };

    struct Click
    {
        bool active = false;
        double phase = 0, step = 0, level = 0, decay = 0;
        int remaining = 0;
    };

    void push (const Command& command);
    void renderChunk (float* left, float* right, int frames, const float* inLeft, const float* inRight);
    void apply (const Command& command, const Snapshot& snapshot);
    void sequence (const Snapshot& snapshot, int frames);
    void startVoice (const TrackSnapshot& track, int pitch, float velocity, bool live, double seconds, int offset, int frames);
    void startClick (bool accent, int offset, int delay);
    void mixStrip (const TrackSnapshot& track, int frames);
    void writeCurve (const Snapshot& snapshot, const std::vector<AutoPoint>& points, float* target, int frame, int count, double fromTick, double toTick, double startSeconds);
    void renderClips (const TrackSnapshot& track, int frame, int count, double startSeconds);
    void renderStreamedClip (Strip& strip, const ClipSnapshot& clip, int frame, int count, double startSeconds);
    void wantStreams (const Snapshot& snapshot, double seconds);
    void silence (const Snapshot& snapshot);
    void anchorAt (const Snapshot& snapshot, double tick);

    double sampleRate = 48000;

    // Snapshot hand-over: the control thread leaves the new one in `pending`;
    // the audio thread swaps it in, so the old one is freed by whoever next
    // replaces `pending`, never on the audio thread.
    juce::SpinLock snapshotLock;
    std::shared_ptr<const Snapshot> pending;
    std::atomic<bool> hasPending { false };
    std::shared_ptr<const Snapshot> current;

    static constexpr int queueSize = 512;
    juce::AbstractFifo queue { queueSize };
    Command commands[queueSize];

    // Transport. Position is measured from an anchor so it does not drift:
    // the playhead is at `anchorSeconds + anchorFrames / sampleRate` on the
    // project's clock.
    std::atomic<bool> playing { false };
    bool loopSuspended = false;
    /** The transport ran for the chunk being rendered, so automated strips follow their curves. */
    bool automating = false;
    double tick = 0;
    double anchorSeconds = 0;
    int64_t anchorFrames = 0;
    /** Frames rendered since the engine started; voices time their release against it. */
    int64_t blockFrame = 0;

    // Audio input: heard through one strip, and captured into a queue the control thread empties.
    std::atomic<uint32_t> monitorStrip { 0 };
    std::atomic<bool> capturing { false };
    std::atomic<double> captureTick { 0 };
    std::atomic<int> dropped { 0 };
    int captureChannels = 1;
    std::unique_ptr<juce::AbstractFifo> captureFifo;
    std::vector<float> captureQueue;

    // Latency measurement: a test signal added to the output while the input is captured.
    std::atomic<bool> calibrating { false };
    const std::vector<float>* calibrationSignal = nullptr;
    /** Frames of the signal played so far; negative until the audio thread has begun. */
    int64_t calibrationFrame = -1;

    std::atomic<bool> metronome { false };
    Click clicks[32];
    /** Holds the tracks' sum back by the buses' plugin latency (see `Snapshot::busLatency`). */
    CompDelay trackDelay;
    float masterL[Strip::maxBlock] {};
    float masterR[Strip::maxBlock] {};
    double limiterEnv = 0;

    PositionInfo playHeadInfo;

    /** A millisecond clock read once per chunk, for telling streams what is wanted. */
    uint32_t chunkTime = 0;
    std::atomic<int> underruns { 0 };

    std::atomic<double> publishedTick { 0 };
    std::atomic<int> lastSeq { 0 };
    std::atomic<float> masterPeak { 0 };
};
} // namespace studio
