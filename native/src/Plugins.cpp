#include "Plugins.h"

#include <atomic>
#include <cstdio>
#include <set>
#include <thread>
#include <unistd.h>

namespace studio
{
// ── A loaded plugin ────────────────────────────────────────────────────────

PluginSlot::PluginSlot (std::unique_ptr<juce::AudioPluginInstance> instanceIn, double rate, juce::AudioPlayHead* playHead, bool offline)
    : instance (std::move (instanceIn))
{
    instance->setPlayHead (playHead);
    instance->setNonRealtime (offline);

    // Stereo in and out on the main buses and extra outputs off. A second input is a side chain: there is
    // nothing to route into one yet, so it is given the track's own audio (a gate or compressor keyed by
    // silence would shut for good). A plugin that refuses an arrangement is offered the next, and in the
    // end keeps its own, which `process` copes with.
    const auto arrangement = [this] (const juce::AudioChannelSet& sideChain)
    {
        auto layout = instance->getBusesLayout();
        for (int i = 0; i < layout.inputBuses.size(); ++i)
            layout.inputBuses.getReference (i) = i == 0 ? juce::AudioChannelSet::stereo() : i == 1 ? sideChain : juce::AudioChannelSet::disabled();
        for (int i = 0; i < layout.outputBuses.size(); ++i)
            layout.outputBuses.getReference (i) = i == 0 ? juce::AudioChannelSet::stereo() : juce::AudioChannelSet::disabled();
        return layout == instance->getBusesLayout() || instance->setBusesLayout (layout);
    };
    if (! arrangement (juce::AudioChannelSet::stereo()) && ! arrangement (juce::AudioChannelSet::mono()))
        arrangement (juce::AudioChannelSet::disabled());

    inputs = instance->getTotalNumInputChannels();
    outputs = instance->getTotalNumOutputChannels();
    // Which of the track's two channels each of the plugin's input channels is fed: 0 left, 1 right, 2 both.
    for (int bus = 0; bus < instance->getBusCount (true); ++bus)
    {
        const int count = instance->getChannelCountOfBus (true, bus);
        for (int c = 0; c < count; ++c) sources.push_back (count == 1 ? 2 : c < 2 ? c : -1);
    }
    buffer.setSize (std::max (1, std::max (inputs, outputs)), Strip::maxBlock);
    midi.ensureSize (8192);
    instance->setRateAndBufferSizeDetails (rate, Strip::maxBlock);
    instance->prepareToPlay (rate, Strip::maxBlock);
}

PluginSlot::~PluginSlot()
{
    instance->setPlayHead (nullptr);
    auto* messages = juce::MessageManager::getInstanceWithoutCreating();
    if (messages == nullptr || messages->isThisTheMessageThread())
    {
        instance->releaseResources();
        return;
    }
    // Let go of on another thread (an offline render's): the plugin is handed to the message thread to delete.
    auto* raw = instance.release();
    juce::MessageManager::callAsync ([raw]
    {
        raw->releaseResources();
        delete raw;
    });
}

void PluginSlot::process (float* left, float* right, int frames, const PluginEvent* events, int eventCount, bool add)
{
    juce::AudioBuffer<float> block (buffer.getArrayOfWritePointers(), buffer.getNumChannels(), frames);
    block.clear();
    if (! add)
    {
        for (int c = 0; c < std::min ((int) sources.size(), block.getNumChannels()); ++c)
        {
            if (sources[(size_t) c] == 0) block.copyFrom (c, 0, left, frames);
            else if (sources[(size_t) c] == 1) block.copyFrom (c, 0, right, frames);
            else if (sources[(size_t) c] == 2)
            {
                block.copyFrom (c, 0, left, frames, 0.5f);
                block.addFrom (c, 0, right, frames, 0.5f);
            }
        }
    }
    midi.clear();
    for (int i = 0; i < eventCount; ++i) midi.addEvent (events[i].data, 3, juce::jlimit (0, frames - 1, events[i].frame));

    {
        // Never wait on the audio thread: if the plugin is being changed, this block goes without it.
        const juce::ScopedTryLock lock (instance->getCallbackLock());
        if (! lock.isLocked() || instance->isSuspended()) return;
        instance->processBlock (block, midi);
    }
    if (outputs == 0) return;

    const float* outL = block.getReadPointer (0);
    const float* outR = block.getReadPointer (outputs >= 2 ? 1 : 0);
    if (add)
    {
        juce::FloatVectorOperations::add (left, outL, frames);
        juce::FloatVectorOperations::add (right, outR, frames);
    }
    else
    {
        juce::FloatVectorOperations::copy (left, outL, frames);
        juce::FloatVectorOperations::copy (right, outR, frames);
    }
}

int pluginLatency (const PluginSlot& plugin)
{
    return std::max (0, plugin.instance->getLatencySamples());
}

juce::String pluginState (juce::AudioPluginInstance& instance)
{
    juce::MemoryBlock data;
    instance.getStateInformation (data);
    return juce::Base64::toBase64 (data.getData(), data.getSize());
}

void setPluginState (juce::AudioPluginInstance& instance, const juce::String& state)
{
    juce::MemoryOutputStream data;
    if (state.isEmpty() || ! juce::Base64::convertFromBase64 (data, state)) return;
    // The audio thread stands aside while the state goes in (`PluginSlot::process` skips the plugin meanwhile).
    // The reset afterwards is for plugins that only take their settings into their processing when prepared
    // or reset, having expected the state to arrive first: without it they show the restored settings and
    // play the old ones.
    instance.suspendProcessing (true);
    {
        const juce::ScopedLock lock (instance.getCallbackLock());
        instance.setStateInformation (data.getData(), (int) data.getDataSize());
        instance.reset();
    }
    instance.suspendProcessing (false);
}

std::shared_ptr<PluginSlot> createPlugin (const juce::AudioPluginFormatManager& formats, const juce::String& description, double rate,
                                          juce::AudioPlayHead* playHead, bool offline, juce::String& error)
{
    juce::PluginDescription found;
    const auto xml = juce::parseXML (description);
    if (xml == nullptr || ! found.loadFromXml (*xml))
    {
        error = "The project's record of the plugin is unreadable.";
        return nullptr;
    }
    auto instance = formats.createPluginInstance (found, rate, Strip::maxBlock, error);
    if (instance == nullptr)
    {
        if (error.isEmpty()) error = "The plugin could not be loaded.";
        return nullptr;
    }
    return std::make_shared<PluginSlot> (std::move (instance), rate, playHead, offline);
}

std::vector<PluginUse> pluginUses (const juce::var& project)
{
    std::vector<PluginUse> uses;
    const auto* tracks = project["tracks"].getArray();
    if (tracks == nullptr) return uses;
    for (const auto& track : *tracks)
    {
        const auto trackId = track["id"].toString(), trackName = track["name"].toString();
        if (track["kind"].toString() == "midi" && track["instrument"].toString() == "plugin" && track["plugin"].isObject())
            uses.push_back ({ trackId, {}, trackName, track["plugin"]["name"].toString(), track["plugin"]["description"].toString(),
                              track["pluginState"].toString() });
        if (const auto* effects = track["effects"].getArray())
            for (const auto& effect : *effects)
                if (effect["type"].toString() == "plugin" && effect["plugin"].isObject())
                    uses.push_back ({ trackId, effect["id"].toString(), trackName, effect["plugin"]["name"].toString(),
                                      effect["plugin"]["description"].toString(), effect["state"].toString() });
    }
    return uses;
}

std::map<juce::String, std::shared_ptr<PluginSlot>> createProjectPlugins (const juce::AudioPluginFormatManager& formats, const juce::var& project,
                                                                          double rate, juce::AudioPlayHead* playHead,
                                                                          const std::map<juce::String, juce::String>* states, juce::StringArray& errors)
{
    std::map<juce::String, std::shared_ptr<PluginSlot>> plugins;
    for (const auto& use : pluginUses (project))
    {
        const auto key = pluginKey (use.trackId, use.effectId);
        juce::String error;
        auto slot = createPlugin (formats, use.description, rate, playHead, true, error);
        if (slot == nullptr)
        {
            errors.add (use.name + ": " + error);
            continue;
        }
        juce::String state = use.state;
        if (states != nullptr)
            if (const auto live = states->find (key); live != states->end()) state = live->second;
        setPluginState (*slot->instance, state);
        plugins[key] = std::move (slot);
    }
    return plugins;
}

// ── The plugins of the project being played ────────────────────────────────

namespace
{
class PluginWindow final : public juce::DocumentWindow
{
public:
    PluginWindow (const juce::String& title, juce::AudioPluginInstance& instance, std::function<void()> onCloseIn)
        : DocumentWindow (title, juce::Colour (0xff2b2b2b), DocumentWindow::closeButton | DocumentWindow::minimiseButton),
          onClose (std::move (onCloseIn))
    {
        juce::AudioProcessorEditor* editor = instance.hasEditor() ? instance.createEditorIfNeeded() : nullptr;
        // A plugin with no window of its own gets a plain list of its parameters.
        if (editor == nullptr) editor = new juce::GenericAudioProcessorEditor (instance);
        setUsingNativeTitleBar (true);
        setContentOwned (editor, true);
        setResizable (editor->isResizable(), false);
        centreWithSize (getWidth(), getHeight());
        setVisible (true);
    }

    ~PluginWindow() override { clearContentComponent(); }

    void closeButtonPressed() override { onClose(); }

private:
    std::function<void()> onClose;
};
} // namespace

struct PluginHost::Entry final : juce::AudioProcessorListener
{
    ~Entry() override
    {
        // The window (and with it the plugin's editor) must go before the plugin can.
        window.reset();
        if (slot != nullptr) slot->instance->removeListener (this);
    }

    // Either may be called on the audio thread, so they only leave a note for `poll`.
    void audioProcessorParameterChanged (juce::AudioProcessor*, int, float) override { dirty.store (true); }
    void audioProcessorChanged (juce::AudioProcessor*, const ChangeDetails&) override { dirty.store (true); }

    PluginUse use;
    /** Null if the plugin could not be loaded. */
    std::shared_ptr<PluginSlot> slot;
    /** The state the plugin was created with, and the one last reported to or received from the app. */
    juce::String initialState, lastState;
    std::unique_ptr<PluginWindow> window;
    std::atomic<bool> dirty { false };
    /** The latency the plugin had when it was last looked at. */
    int latency = 0;
};

PluginHost::PluginHost (const juce::AudioPluginFormatManager& formatsIn, juce::AudioPlayHead* playHeadIn) : formats (formatsIn), playHead (playHeadIn) {}
PluginHost::~PluginHost() = default;

void PluginHost::sync (const juce::var& project, double rate)
{
    std::set<juce::String> wanted;
    for (auto& use : pluginUses (project))
    {
        const auto key = pluginKey (use.trackId, use.effectId);
        wanted.insert (key);
        if (const auto existing = entries.find (key); existing != entries.end())
        {
            auto& entry = *existing->second;
            if (entry.use.description == use.description)
            {
                if (entry.window != nullptr && entry.use.trackName != use.trackName) entry.window->setName (use.name + " — " + use.trackName);
                entry.use.trackName = use.trackName;
                continue;
            }
            entries.erase (existing);
        }

        auto entry = std::make_unique<Entry>();
        entry->use = use;
        // The state arrives separately (see `setState`), so the project's own copy is not applied here.
        entry->use.state = {};
        juce::String error;
        entry->slot = createPlugin (formats, use.description, rate, playHead, false, error);
        if (entry->slot != nullptr)
        {
            entry->initialState = entry->lastState = pluginState (*entry->slot->instance);
            entry->latency = pluginLatency (*entry->slot);
            entry->slot->instance->addListener (entry.get());
        }
        if (onStatus) onStatus (use.trackId, use.effectId, error);
        entries[key] = std::move (entry);
    }
    for (auto it = entries.begin(); it != entries.end();)
        it = wanted.count (it->first) ? std::next (it) : entries.erase (it);
}

std::shared_ptr<PluginSlot> PluginHost::find (const juce::String& key) const
{
    const auto found = entries.find (key);
    return found != entries.end() ? found->second->slot : nullptr;
}

void PluginHost::setState (const juce::String& key, const juce::String& state)
{
    const auto found = entries.find (key);
    if (found == entries.end() || found->second->slot == nullptr) return;
    auto& entry = *found->second;
    const auto& target = state.isEmpty() ? entry.initialState : state;
    // What the app sends back after a report from here is already in force.
    if (target == entry.lastState) return;
    entry.lastState = target;
    setPluginState (*entry.slot->instance, target);
    // Setting the state makes the plugin announce changes; they are not news.
    entry.dirty.store (false);
}

void PluginHost::setParameter (const juce::String& key, int index, float value)
{
    const auto slot = find (key);
    if (slot == nullptr) return;
    const auto& parameters = slot->instance->getParameters();
    if (index >= 0 && index < parameters.size()) parameters[index]->setValueNotifyingHost (juce::jlimit (0.0f, 1.0f, value));
}

bool PluginHost::show (const juce::String& key)
{
    const auto found = entries.find (key);
    if (found == entries.end() || found->second->slot == nullptr) return false;
    auto& entry = *found->second;
    if (entry.window == nullptr)
    {
        entry.window = std::make_unique<PluginWindow> (entry.use.name + " — " + entry.use.trackName, *entry.slot->instance, [this, key]
        {
            // Not from inside the window's own callback.
            juce::MessageManager::callAsync ([this, key] { close (key); });
        });
        // Each new window a little down and to the right of where the last would be, so they do not hide one another.
        int open = 0;
        for (const auto& [other, otherEntry] : entries) open += otherEntry->window != nullptr ? 1 : 0;
        const int step = 28 * ((open - 1) % 8);
        entry.window->setTopLeftPosition (entry.window->getX() + step, entry.window->getY() + step);
        std::cerr << "plugin window opened: " << entry.use.name << " " << entry.window->getWidth() << "x" << entry.window->getHeight() << std::endl;
    }
    entry.window->setAlwaysOnTop (true);
    appFocused = true;
    // The engine is a background process; without this its window would open behind the app's.
    juce::Process::makeForegroundProcess();
    entry.window->toFront (true);
    return true;
}

void PluginHost::close (const juce::String& key)
{
    if (const auto found = entries.find (key); found != entries.end()) found->second->window.reset();
}

void PluginHost::setFocused (bool focused)
{
    if (focused == appFocused) return;
    appFocused = focused;
    for (auto& [key, entry] : entries)
        if (entry->window != nullptr) entry->window->setAlwaysOnTop (focused);
}

void PluginHost::poll()
{
    // Reading a plugin's whole state is not free, so changes are gathered up and looked at twice a second.
    if (++ticks < 30) return;
    ticks = 0;
    bool latencyChanged = false;
    for (auto& [key, entry] : entries)
    {
        if (entry->slot == nullptr) continue;
        // A plugin's latency can change with its settings (a look-ahead time, say); the mix must be lined up again.
        if (const int latency = pluginLatency (*entry->slot); latency != entry->latency)
        {
            entry->latency = latency;
            latencyChanged = true;
        }
    }
    if (latencyChanged && onLatency) onLatency();
    for (auto& [key, entry] : entries)
    {
        if (entry->slot == nullptr || ! entry->dirty.exchange (false)) continue;
        const auto state = pluginState (*entry->slot->instance);
        if (state == entry->lastState) continue;
        entry->lastState = state;
        if (onState) onState (entry->use.trackId, entry->use.effectId, state);
    }
}

std::map<juce::String, juce::String> PluginHost::states() const
{
    std::map<juce::String, juce::String> all;
    for (const auto& [key, entry] : entries)
        if (entry->slot != nullptr) all[key] = pluginState (*entry->slot->instance);
    return all;
}

// ── Scanning ───────────────────────────────────────────────────────────────

/** What the child process prefixes its lines with, to tell them from anything a plugin prints. */
static const char* const scanTag = "STUDIO-SCAN ";
/** How long one plugin may take to describe itself before it is given up on. */
static constexpr juce::uint32 scanTimeoutMs = 30000;

int scanPluginsChild (const juce::File& list, int start)
{
    // Plugins may print whatever they like; the results go out on a private copy of stdout.
    FILE* out = fdopen (dup (STDOUT_FILENO), "w");
    dup2 (STDERR_FILENO, STDOUT_FILENO);

    const juce::ScopedJuceInitialiser_GUI juce;
    juce::AudioPluginFormatManager formats;
    juce::addDefaultFormatsToManager (formats);
    juce::StringArray lines;
    list.readLines (lines);
    lines.removeEmptyStrings();

    std::atomic<juce::uint32> began { juce::Time::getMillisecondCounter() };
    std::atomic<bool> done { false };
    // A plugin that hangs takes this process with it; the parent carries on with the next.
    std::thread ([&]
    {
        while (! done.load())
        {
            juce::Thread::sleep (250);
            if (juce::Time::getMillisecondCounter() - began.load() > scanTimeoutMs) _exit (3);
        }
    }).detach();

    // Audio Units of the newer kind can only be loaded with the message thread free, so the work is done beside it.
    std::thread worker ([&]
    {
        for (int i = start; i < lines.size(); ++i)
        {
            began.store (juce::Time::getMillisecondCounter());
            std::fprintf (out, "%sBEGIN %d\n", scanTag, i);
            std::fflush (out);
            const auto formatName = lines[i].upToFirstOccurrenceOf ("\t", false, false);
            const auto identifier = lines[i].fromFirstOccurrenceOf ("\t", false, false);
            for (auto* format : formats.getFormats())
            {
                if (format->getName() != formatName) continue;
                juce::OwnedArray<juce::PluginDescription> found;
                format->findAllTypesForFile (found, identifier);
                for (const auto* description : found)
                {
                    auto* object = new juce::DynamicObject();
                    const juce::var holder (object);
                    object->setProperty ("name", description->name);
                    object->setProperty ("manufacturer", description->manufacturerName);
                    object->setProperty ("format", description->pluginFormatName);
                    object->setProperty ("instrument", description->isInstrument);
                    object->setProperty ("category", description->category);
                    object->setProperty ("inputs", description->numInputChannels);
                    object->setProperty ("description", description->createXml()->toString (juce::XmlElement::TextFormat().singleLine().withoutHeader()));
                    std::fprintf (out, "%sPLUGIN %s\n", scanTag, juce::JSON::toString (holder, true).toRawUTF8());
                }
            }
            std::fprintf (out, "%sEND %d\n", scanTag, i);
            std::fflush (out);
        }
        done.store (true);
    });
    while (! done.load()) juce::MessageManager::getInstance()->runDispatchLoopUntil (20);
    worker.join();
    std::fflush (out);
    // Straight out: plugins' own clean-up at exit is a common place for them to crash.
    _exit (0);
}

std::vector<ScannedPlugin> scanPlugins (juce::StringArray& failed)
{
    std::vector<ScannedPlugin> plugins;
    juce::StringArray lines;
    {
        juce::AudioPluginFormatManager formats;
        juce::addDefaultFormatsToManager (formats);
        // Besides the usual places, any folders named in STUDIO_PLUGIN_PATH (separated by colons). Audio Units
        // are found through the system's own registry, wherever they are, so this only matters for VST3.
        const auto extra = juce::StringArray::fromTokens (juce::SystemStats::getEnvironmentVariable ("STUDIO_PLUGIN_PATH", {}), ":", {});
        for (auto* format : formats.getFormats())
        {
            auto places = format->getDefaultLocationsToSearch();
            for (const auto& folder : extra)
                if (juce::File::isAbsolutePath (folder)) places.addIfNotAlreadyThere (juce::File (folder));
            for (const auto& identifier : format->searchPathsForPlugins (places, true, false))
                lines.add (format->getName() + "\t" + identifier);
        }
    }
    if (lines.isEmpty()) return plugins;

    const auto list = juce::File::createTempFile ("studio-scan");
    list.replaceWithText (lines.joinIntoString ("\n"));
    const auto self = juce::File::getSpecialLocation (juce::File::currentExecutableFile).getFullPathName();
    int start = 0;
    while (start < lines.size())
    {
        juce::ChildProcess child;
        if (! child.start (juce::StringArray { self, "--scan-plugins", list.getFullPathName(), juce::String (start) }, juce::ChildProcess::wantStdOut))
            break;
        const auto output = juce::StringArray::fromLines (child.readAllProcessOutput());
        child.waitForProcessToFinish (2000);

        int begun = -1, ended = start - 1;
        for (const auto& line : output)
        {
            if (! line.startsWith (scanTag)) continue;
            const auto rest = line.substring ((int) std::strlen (scanTag));
            if (rest.startsWith ("BEGIN ")) begun = rest.substring (6).getIntValue();
            else if (rest.startsWith ("END ")) ended = rest.substring (4).getIntValue();
            else if (rest.startsWith ("PLUGIN "))
            {
                const auto found = juce::JSON::parse (rest.substring (7));
                // A track can use an instrument, or something that processes audio. Audio Unit mixers, panners and
                // generators are for other kinds of host.
                const auto category = found["category"].toString();
                // Only an Audio Unit's record says how many inputs it has: a VST3 is described without being
                // loaded, with no channel counts, so every VST3 is taken.
                const bool usable = (bool) found["instrument"] || found["format"].toString() != "AudioUnit"
                                 || ((int) found["inputs"] > 0 && category != "Mixer" && category != "Panner");
                if (found.isObject() && usable)
                    plugins.push_back ({ found["name"].toString(), found["manufacturer"].toString(), found["format"].toString(),
                                         found["description"].toString(), (bool) found["instrument"] });
            }
        }
        if (ended >= lines.size() - 1) break;
        // The child died part-way: the plugin it was on is at fault. Carry on after it.
        const int culprit = begun > ended ? begun : ended + 1;
        failed.add (lines[culprit].fromFirstOccurrenceOf ("\t", false, false));
        start = culprit + 1;
    }
    list.deleteFile();
    std::sort (plugins.begin(), plugins.end(), [] (const ScannedPlugin& a, const ScannedPlugin& b) { return a.name.compareIgnoreCase (b.name) < 0; });
    return plugins;
}
} // namespace studio
