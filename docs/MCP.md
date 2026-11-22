# Letting an assistant work in mtstudio

mtstudio can let an assistant such as Claude work on the open project, over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). You ask in words ("put a drill pattern on the drums with a bass line that locks to it", "give the keys an electric piano and some reverb", "make the bass line busier in the second half"); the assistant reads the project and changes it, and you watch the window change as it goes.

It is off until you turn it on.

## Turning it on

1. In mtstudio, choose **Assistant › Assistant Access…** and click **Turn On**.
2. The same window now shows an address and a token. Click **Copy Command for Claude Code**.
3. Paste the command into a terminal and run it. It looks like this:

   ```bash
   claude mcp add --transport http mtstudio http://127.0.0.1:47821/mcp --header "Authorization: Bearer <your token>"
   ```

4. Start Claude Code and ask it something about your project.

For another assistant, give it the address, and the token as an `Authorization: Bearer` header. One that takes a command to run instead of an address can go through a bridge such as `mcp-remote`.

Access stays on, across restarts, until you choose **Turn Off** in the same window. **New Token** shuts out anything set up with the old one.

## What the assistant can do

| Tool | What it does |
| --- | --- |
| `get_project` | Reads the project: tempo, time signature, key, loop, playhead, and each track with its clips |
| `get_clip` | Reads one clip's notes, and the chord sounding in each of its bars |
| `add_track`, `update_track`, `remove_track` | Adds a track; renames it, sets its fader, pan, mute and solo; deletes it |
| `add_clip`, `update_clip`, `remove_clips`, `duplicate_clips` | Adds a clip of notes; renames, moves or resizes one, or moves it to another track; deletes; copies |
| `set_clip_notes`, `add_notes`, `remove_notes` | Replaces a clip's notes, adds to them, or deletes some |
| `set_tempo`, `set_time_signature`, `set_key`, `set_loop` | Sets the tempo, time signature and key the song starts in, and the loop |
| `transport` | Plays, stops, and moves the playhead |
| `get_track` | Reads one track in full: instrument, effects, sends, automation, and which note is which drum |
| `list_instruments`, `set_instrument` | Searches every instrument the app has (built in, General MIDI, SFZ, Surge XT, plugins) and gives one to a track |
| `set_synth` | Sets the built-in synth's wave, envelope and filter |
| `add_effect`, `update_effect`, `remove_effect` | Adds an EQ, compressor, delay or reverb; changes its settings or bypasses it; removes it |
| `set_send` | Sends a track to a bus at a level |
| `set_automation` | Writes a volume or pan curve |
| `list_patterns`, `apply_pattern` | Finds a drum pattern by style or name and writes it into a clip, with the kit its style calls for |
| `list_parts`, `apply_part` | Finds a bass line, chord part or synth figure and writes it into a clip, following the song's chords |
| `save_project` | Saves the project where it lives; for one never saved, mtstudio asks you where |
| `list_recent_projects`, `open_project`, `new_project` | Opens a project you have opened or saved before, or one you pick in a dialog; starts an empty one |
| `export_mixdown` | Renders the song to a WAV beside the project, and reports its length and level |
| `list_packs`, `install_pack` | Lists the free instrument packs and starts installing one |
| `screenshot` | Takes a picture of mtstudio's window |
| `undo`, `redo` | Steps back and forward through the project's changes |

Positions and lengths are in beats (quarter notes), so a bar of 4/4 is four beats; pitches are MIDI note numbers.

Each change to the project is one step of undo, the same undo as your own edits: **Edit › Undo** takes back what the assistant did. Saving, exporting, opening and installing are not edits and are not undone that way.

## What it cannot do

- Record, or import audio files
- Change a plugin's settings, or the sampler's sample
- Remove an instrument pack, or delete any file
- Hear anything. It works from the notes, and from the level figures of an export; you are the one who listens.

## What keeps it safe

- **Only this computer.** The app listens on `127.0.0.1`, which other machines cannot reach.
- **Only with the token.** A request without it is refused. The token is kept in mtstudio's settings folder, in a file only your user account can read.
- **Not from web pages.** A request that comes from a page in a browser is refused, whatever it carries.
- **It never names a place on your disk.** No tool takes a path to write to. Saving goes where the project already is, or where you choose in mtstudio's own dialog. An export goes in an `exports` folder beside the project. It can open only projects you have opened or saved in mtstudio yourself, or one you pick in the dialog.
- **Your unsaved work is guarded.** Opening another project or starting a new one is refused while there are unsaved changes, unless the assistant says outright that they may be discarded; it is told to ask you first.
- **It goes online for one thing.** Installing an instrument pack downloads it from the address pinned in mtstudio's own list. Nothing else is fetched or sent.
- **It can see the window.** A screenshot shows mtstudio's window only, never the rest of your screen.

Anything on your computer that you give the token to can change the open project, so treat the token like a password.

## If it does not work

| What you see | What to do |
| --- | --- |
| "Assistant access could not start" | Another program is using port 47821, most likely a second copy of mtstudio. Quit it, then **Try Again**. |
| The assistant cannot connect | Check mtstudio is running and access is on. If you made a new token, run the copied command again (remove the old entry first: `claude mcp remove mtstudio`). |
| "mtstudio's window is not open" | The app is running without a window. Click its Dock icon to bring the window back. |
| A tool says an id does not exist | Ids change when a project is opened or a clip is recreated; the assistant should call `get_project` again. |

## For developers

The server is `src/main/mcp.ts`: plain HTTP on a fixed port, each request a POST of JSON-RPC answered with JSON, with no session and no stream. The tools are listed in `src/shared/mcp.ts` and carried out in the window by `src/renderer/src/mcp.ts`, through the actions in `state/actions.ts`. A new tool is an entry in each of those two files.
