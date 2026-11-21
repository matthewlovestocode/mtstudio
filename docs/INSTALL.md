# Installing mtstudio

mtstudio is a music-making app (a digital audio workstation) for the Mac. This page takes you from nothing to a running app in about five minutes.

## Before you start

You need:

- **A Mac with Apple silicon** (an M1, M2, M3 or later chip). To check, open the Apple menu › About This Mac; "Chip" should say Apple M-something. Intel Macs, Windows and Linux are not covered by the download; see [running from source](../README.md#run-from-source).
- **macOS 13 (Ventura) or later.**
- **About 700 MB of free space**, and an internet connection: the app is a 124 MB download, and it fetches 216 MB of instrument sounds the first time it opens.

mtstudio is free and open source. It is not signed with an Apple developer certificate, which costs money each year, so macOS treats it with more suspicion than an app from the App Store. The two ways of installing below differ only in how they deal with that.

## Way 1: one command (recommended)

1. Open **Terminal** (press Cmd+Space, type "Terminal", press Return).
2. Paste this line and press Return:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/matthewlovestocode/mtstudio/main/scripts/install.sh | bash
   ```

3. Wait for the download bar to finish. mtstudio is put in your Applications folder and opens by itself.

That is all. macOS shows no warning this way.

What the command does: it runs a short script, which you can [read here](../scripts/install.sh) first. The script downloads the latest release from this project's GitHub page, unzips it, moves `mtstudio.app` into Applications (replacing an older copy if there is one) and opens it. It changes nothing else and does not ask for your password.

## Way 2: download it yourself

1. Go to the [latest release](https://github.com/matthewlovestocode/mtstudio/releases/latest) and download the file named `mtstudio-…-mac-arm64.zip`.
2. Double-click the zip in your Downloads folder to unzip it, then drag **mtstudio** into **Applications**.
3. Double-click mtstudio. macOS says it could not verify that the app is free of malware. Click **Done** (not "Move to Trash").
4. Open **System Settings › Privacy & Security** and scroll down to the Security section. Next to the line about mtstudio being blocked, click **Open Anyway**, then confirm with your password or Touch ID.
5. mtstudio opens. You only do steps 3 and 4 once.

If the button in step 4 is not there, try opening mtstudio once more and look again; the button only appears for about an hour after an attempt to open the app.

## The first time it opens

- **A small window downloads the instrument sounds** (216 MB: pianos, basses, drum kits and the rest of a General MIDI set). It shows its progress and happens once. If you close that window, mtstudio opens without those sounds and tries again next time.
- **Then the main window opens with a demo project.** Press the **Space** bar to play it.
- **The first time you record,** macOS asks whether mtstudio may use the microphone. Choose Allow.

## Things worth trying first

- Open the drum clip in the step sequencer and pick from **Choose a pattern…**: about 270 rhythms in twenty styles, each with a matching drum kit.
- Open a bass or keys clip in the piano roll and pick from **Start from a part…**: bass lines, chord parts and synth figures that follow the song's key and chords.
- Open the browser panel to install more free instruments (basses, pianos, drums). Each is a few hundred megabytes.

## Updating

Do the same thing again: run the one command, or download the newer zip and replace the app in Applications. Your projects and settings are kept. After an update macOS may ask about the microphone again, and with Way 2 you repeat the **Open Anyway** step.

mtstudio does not update itself or tell you when there is a new version; check the [releases page](https://github.com/matthewlovestocode/mtstudio/releases).

## Removing it

1. Drag **mtstudio** from Applications to the Trash.
2. To remove its settings and downloaded sounds as well, delete the folder `~/Library/Application Support/studio`. In Finder, choose Go › Go to Folder…, paste that path, and move the `studio` folder to the Trash.

Projects you saved are wherever you saved them, and are not touched.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "mtstudio is damaged and can't be opened" | The download was marked as untrusted. Delete the app and use Way 1 instead. |
| "Apple could not verify…" and no way to open it | That is step 3 of Way 2; carry on to step 4. Or use Way 1, which avoids it. |
| The command says mtstudio is packaged for Apple silicon Macs only | Your Mac has an Intel chip, or is not a Mac. The download does not cover it; see [running from source](../README.md#run-from-source). |
| The command says mtstudio is running | Quit mtstudio (Cmd+Q) and run the command again. |
| The sounds window reports a failed download | Check your connection and open mtstudio again; it retries each time it starts. |
| Instruments are silent, or there are no drum kits to choose | The sounds did not download. Quit and open mtstudio again and let the small window finish. |
| Recording does nothing, or says the microphone is not allowed | System Settings › Privacy & Security › Microphone, and switch mtstudio on. |
| Something else | [Open an issue](https://github.com/matthewlovestocode/mtstudio/issues) and say what you did and what you saw. |

## Good to know

- This is version 0.1, an early release. Save often.
- mtstudio sends nothing about you anywhere. It goes online only to download its sounds, and instrument packs you choose to install.
- It is free software under the GNU AGPL; the source is [on GitHub](https://github.com/matthewlovestocode/mtstudio).
