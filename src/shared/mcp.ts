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
  'Pitches are MIDI note numbers (60 is middle C). Call get_project first to learn the track and clip ids. To start a beat or a part, prefer apply_pattern and apply_part, which write in the feel of the style, and edit the notes afterwards if asked. On a drum track, get_track says which note is which drum. You cannot hear the result: say what you wrote and let the user listen.'

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
  tool(
    'get_track',
    "One track in full: its instrument and that instrument's settings, effects with their parameters, sends, automation, and (for drums) which note plays which drum.",
    { track_id: trackId },
    ['track_id']
  ),
  tool(
    'list_instruments',
    'Searches the instruments a track can be given: the built-in synth, drum machine and sampler, General MIDI sounds and drum kits, installed SFZ instruments, Surge XT patches and plugins. Narrow it with words from the name, a family or a source; at most `limit` come back, with how many matched.',
    {
      search: { type: 'string', description: 'Words to find in the name, e.g. "electric piano" or "808".' },
      family: { type: 'string', enum: ['Keys', 'Organ', 'Mallets', 'Guitar', 'Bass', 'Strings', 'Brass', 'Winds', 'Leads', 'Pads', 'Plucks', 'Synth', 'Drums', 'Percussion', 'Sequences', 'FX', 'World', 'Other'] },
      source: { type: 'string', enum: ['Built in', 'General MIDI', 'SFZ', 'Surge XT', 'Plugins'] },
      limit: { type: 'integer', minimum: 1, maximum: 200, description: '40 if left out.' }
    }
  ),
  tool("set_instrument", "Gives an instrument track one of the instruments list_instruments found, by its id.", { track_id: trackId, instrument_id: { type: 'string' } }, ['track_id', 'instrument_id']),
  tool(
    'set_synth',
    "Sets the built-in synth's sound on a track that plays it. Only what is given changes. Times are in seconds.",
    {
      track_id: trackId,
      wave: { type: 'string', enum: ['sine', 'triangle', 'sawtooth', 'square'] },
      attack: { type: 'number', minimum: 0.001, maximum: 1 },
      decay: { type: 'number', minimum: 0.01, maximum: 2 },
      sustain: { type: 'number', minimum: 0, maximum: 1, description: 'The level held after the decay, 0 to 1.' },
      release: { type: 'number', minimum: 0.01, maximum: 3 },
      cutoff: { type: 'number', minimum: 80, maximum: 16000, description: 'Low-pass filter cutoff in Hz.' },
      resonance: { type: 'number', minimum: 0.1, maximum: 20 }
    },
    ['track_id']
  ),
  tool(
    'add_effect',
    'Adds an effect to the end of a track\'s or bus\'s chain. Parameters left out start at their defaults. eq: low, mid, high (dB, -18 to 18), midFreq (Hz, 200 to 8000). compressor: threshold (dB, -60 to 0), ratio (1 to 20), attack (s, 0.001 to 0.2), release (s, 0.02 to 1), makeup (dB, 0 to 24). delay: time (s, 0.02 to 1.5), feedback (0 to 0.9), mix (0 to 1). reverb: decay (s, 0.3 to 6), tone (Hz, 800 to 16000), mix (0 to 1). Returns its id.',
    { track_id: trackId, type: { type: 'string', enum: ['eq', 'compressor', 'delay', 'reverb'] }, params: { type: 'object', additionalProperties: { type: 'number' } } },
    ['track_id', 'type']
  ),
  tool(
    'update_effect',
    "Changes an effect's parameters (see add_effect for each kind's), or bypasses it. Only what is given changes.",
    { track_id: trackId, effect_id: { type: 'string', description: 'From get_track.' }, params: { type: 'object', additionalProperties: { type: 'number' } }, bypass: { type: 'boolean' } },
    ['track_id', 'effect_id']
  ),
  tool('remove_effect', 'Removes an effect from a track.', { track_id: trackId, effect_id: { type: 'string' } }, ['track_id', 'effect_id']),
  tool(
    'set_send',
    'Sends a copy of a track, after its fader, to a bus, at a level from 0 to 1; 0 removes the send. Put a reverb or delay on the bus with its mix at 1 to share it between tracks.',
    { track_id: trackId, bus_id: { type: 'string', description: 'The id of a track whose kind is "bus".' }, level: { type: 'number', minimum: 0, maximum: 1 } },
    ['track_id', 'bus_id', 'level']
  ),
  tool(
    'set_automation',
    "Replaces a track's volume or pan curve: points joined by straight lines, which the fader or pan follows while playing. Volume runs 0 to 1.5 (1 is unity), pan -1 to 1. An empty list removes the curve and hands control back to the fader.",
    {
      track_id: trackId,
      target: { type: 'string', enum: ['volume', 'pan'] },
      points: {
        type: 'array',
        maxItems: 2000,
        items: { type: 'object', properties: { at: { type: 'number', minimum: 0, description: 'Beats from the start of the song.' }, value: { type: 'number' } }, required: ['at', 'value'], additionalProperties: false }
      }
    },
    ['track_id', 'target', 'points']
  ),
  tool(
    'list_patterns',
    'The drum patterns mtstudio knows. With nothing given, the styles and how many each holds; with a style or words to search for, the patterns themselves, each with a tempo it suits.',
    { style: { type: 'string', description: 'A style from the bare list, e.g. "Dancehall".' }, search: { type: 'string' } }
  ),
  tool(
    'apply_pattern',
    "Replaces a clip's notes on a drum track with one of the patterns, written out with fills and a second half that builds. By default the clip is made eight bars long where there is room, and the track is moved to the drum kit the pattern's style calls for.",
    {
      clip_id: clipId,
      pattern: { type: 'string', description: 'A name from list_patterns.' },
      style: { type: 'string', description: 'Needed only where two styles have a pattern of the same name.' },
      grow: { type: 'boolean', description: 'Make the clip eight bars long if it is shorter. True if left out.' },
      match_kit: { type: 'boolean', description: 'Move the track to the kit the pattern suits. True if left out.' }
    },
    ['clip_id', 'pattern']
  ),
  tool(
    'list_parts',
    'The bass lines, chord parts and synth figures mtstudio knows. With nothing given, the styles and how many of each kind they hold; with a style, a kind or words to search for, the parts themselves.',
    { style: { type: 'string' }, kind: { type: 'string', enum: ['bass', 'chords', 'lead'] }, search: { type: 'string' } }
  ),
  tool(
    'apply_part',
    "Replaces a clip's notes on a pitched instrument track with one of the parts, written to follow the song's key and chords (a chord part keeps the clip's own chords; a bass line locks to the kick where there are drums). By default the clip is made eight bars long where there is room.",
    {
      clip_id: clipId,
      part: { type: 'string', description: 'A name from list_parts.' },
      style: { type: 'string', description: 'Needed only where two styles have a part of the same name.' },
      grow: { type: 'boolean', description: 'Make the clip eight bars long if it is shorter. True if left out.' }
    },
    ['clip_id', 'part']
  ),
  tool('undo', 'Undoes the last change to the project, whoever made it.'),
  tool('redo', 'Redoes the change last undone.')
]
