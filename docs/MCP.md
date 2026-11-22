# Letting an assistant work in mtstudio

mtstudio can let an assistant such as Claude work on the open project, over the [Model Context Protocol](https://modelcontextprotocol.io) (MCP). You ask in words ("add a pad under the chords from bar 5", "make the bass line busier in the second half"); the assistant reads the project and changes it, and you watch the window change as it goes.

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
| `undo`, `redo` | Steps back and forward through the project's changes |

Positions and lengths are in beats (quarter notes), so a bar of 4/4 is four beats; pitches are MIDI note numbers.

Each call is one step of undo, the same undo as your own edits: **Edit › Undo** takes back what the assistant did.

## What it cannot do yet

- Choose instruments, add effects or sends, or draw automation
- Use the drum patterns and the bass, chord and synth parts
- Save, open or export, or install instrument packs
- Record
- Hear anything. It works from the notes, and you are the one who listens.

## What keeps it safe

- **Only this computer.** The app listens on `127.0.0.1`, which other machines cannot reach.
- **Only with the token.** A request without it is refused. The token is kept in mtstudio's settings folder, in a file only your user account can read.
- **Not from web pages.** A request that comes from a page in a browser is refused, whatever it carries.
- **Only the project.** No tool reads or writes a file, runs a program or goes online.

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
