/**
 * The tools the app offers over the Model Context Protocol, so that an
 * assistant such as Claude can work on the open project. The main process
 * serves this list (src/main/mcp.ts); the window carries each call out
 * through the same actions its own controls use (src/renderer/src/mcp.ts).
 *
 * Positions and lengths are in beats (quarter notes) from the start of the
 * song or, for notes, of their clip: a bar of 4/4 is four beats.
 */

export interface McpTool {
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean }
}

/** What the window answers a call with: a value to hand back, or why it could not be done. */
export type McpAnswer = { ok: true; value: unknown } | { ok: false; error: string }

export interface McpStatus {
  enabled: boolean
  /** Why the server is not listening although it is switched on; null otherwise. */
  problem: string | null
  address: string
  token: string
}

export const MCP_INSTRUCTIONS =
  'mtstudio is a digital audio workstation. These tools act on the project open in its window, which the user sees change as you work; every change is one step of undo. ' +
  'Positions and lengths are in beats (quarter notes): a bar of 4/4 is 4 beats, a sixteenth note is 0.25. Clip positions count from the start of the song, note positions from the start of their clip. ' +
  'Pitches are MIDI note numbers (60 is middle C). Call get_project first to learn the track and clip ids. You cannot hear the result: say what you wrote and let the user listen.'

const note = {
  type: 'object',
  properties: {
    pitch: { type: 'integer', minimum: 0, maximum: 127, description: 'MIDI note number; 60 is middle C.' },
    start: { type: 'number', minimum: 0, description: 'Beats from the start of the clip.' },
    length: { type: 'number', exclusiveMinimum: 0, description: 'Beats.' },
    velocity: { type: 'number', minimum: 0, maximum: 1, description: 'How hard it is played, 0 to 1. 0.8 if left out.' }
  },
  required: ['pitch', 'start', 'length'],
  additionalProperties: false
}
const notes = { type: 'array', items: note, maxItems: 5000 }
const trackId = { type: 'string', description: 'A track id from get_project.' }
const clipId = { type: 'string', description: 'A clip id from get_project.' }

const tool = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []): McpTool => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false }
})

export const MCP_TOOLS: McpTool[] = [
  tool('get_project', 'The open project: tempo, time signature, key, loop, playhead, and every track with its clips (ids, positions, how many notes). Call this first.'),
  tool('get_clip', "One clip's notes, and the chord sounding in each bar it covers (read from this clip, or from the other tracks where it holds a single line).", { clip_id: clipId }, ['clip_id']),
  tool(
    'add_track',
    'Adds a track at the bottom: "instrument" plays notes, "audio" holds recordings, "bus" receives sends from other tracks. Returns its id.',
    { kind: { type: 'string', enum: ['instrument', 'audio', 'bus'] }, name: { type: 'string', maxLength: 80 } },
    ['kind']
  ),
  tool(
    'update_track',
    "Changes a track's name, fader (0 to 1.5, 1 is unity), pan (-1 left to 1 right), mute or solo. Only what is given changes.",
    {
      track_id: trackId,
      name: { type: 'string', maxLength: 80 },
      volume: { type: 'number', minimum: 0, maximum: 1.5 },
      pan: { type: 'number', minimum: -1, maximum: 1 },
      mute: { type: 'boolean' },
      solo: { type: 'boolean' }
    },
    ['track_id']
  ),
  tool('remove_track', 'Deletes a track and everything on it.', { track_id: trackId }, ['track_id']),
  tool(
    'add_clip',
    'Adds a clip of notes to an instrument track, optionally with its notes. Returns its id.',
    {
      track_id: trackId,
      start: { type: 'number', minimum: 0, description: 'Beats from the start of the song.' },
      length: { type: 'number', exclusiveMinimum: 0, description: 'Beats.' },
      name: { type: 'string', maxLength: 80 },
      notes
    },
    ['track_id', 'start', 'length']
  ),
  tool(
    'update_clip',
    'Renames, moves or resizes a clip, or moves it to another track of the same kind. Only what is given changes. Notes keep their place within the clip.',
    {
      clip_id: clipId,
      name: { type: 'string', maxLength: 80 },
      start: { type: 'number', minimum: 0, description: 'Beats from the start of the song.' },
      length: { type: 'number', exclusiveMinimum: 0, description: 'Beats.' },
      track_id: { type: 'string', description: 'The track to move it to.' }
    },
    ['clip_id']
  ),
  tool('remove_clips', 'Deletes clips.', { clip_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['clip_ids']),
  tool('duplicate_clips', 'Copies clips, each copy placed straight after its original. Returns the new ids.', { clip_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['clip_ids']),
  tool('set_clip_notes', "Replaces all of a clip's notes with these.", { clip_id: clipId, notes }, ['clip_id', 'notes']),
  tool('add_notes', 'Adds notes to a clip, keeping those it has. Returns the new note ids.', { clip_id: clipId, notes }, ['clip_id', 'notes']),
  tool('remove_notes', 'Deletes notes from a clip, by the ids get_clip gives.', { clip_id: clipId, note_ids: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['clip_id', 'note_ids']),
  tool('set_tempo', 'Sets the tempo the song starts at, in beats per minute.', { bpm: { type: 'number', minimum: 20, maximum: 300 } }, ['bpm']),
  tool(
    'set_time_signature',
    'Sets the time signature the song starts in.',
    { numerator: { type: 'integer', minimum: 1, maximum: 32 }, denominator: { type: 'integer', enum: [2, 4, 8, 16] } },
    ['numerator', 'denominator']
  ),
  tool(
    'set_key',
    'Sets the key the song starts in, which guides the editors and changes nothing that is heard. Leave both out to clear it.',
    {
      root: { type: 'string', description: 'A note name: C, F#, Bb …' },
      scale: { type: 'string', enum: ['major', 'minor', 'harmonicMinor', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'majorPentatonic', 'minorPentatonic', 'blues'] }
    }
  ),
  tool(
    'set_loop',
    'Switches looping on or off, and sets the stretch that loops. Only what is given changes.',
    { enabled: { type: 'boolean' }, start: { type: 'number', minimum: 0, description: 'Beats.' }, end: { type: 'number', exclusiveMinimum: 0, description: 'Beats.' } }
  ),
  tool(
    'transport',
    'Plays, stops, or moves the playhead. "seek" needs a position; "play" may take one to start from.',
    { action: { type: 'string', enum: ['play', 'stop', 'seek'] }, position: { type: 'number', minimum: 0, description: 'Beats from the start of the song.' } },
    ['action']
  ),
  tool('undo', 'Undoes the last change to the project, whoever made it.'),
  tool('redo', 'Redoes the change last undone.')
]
