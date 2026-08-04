// How many notes tend to sound at once in a MIDI file, used to color-code library/playlist rows.
export type MidiPolyphonyClass = 'mono' | 'low' | 'high';

export interface MidiLibraryEntry {
    filename: string;
    durationSeconds: number;
    polyphony: MidiPolyphonyClass;
    // Peak number of notes sounding at the same instant anywhere in the file (percussion excluded,
    // same as the polyphony classification above) - shown next to the polyphony dot so it's not
    // just a rough mono/low/high bucket.
    maxPolyphony: number;
}

// A playlist entry owns its own in/out trim range, so the same file can appear in different
// playlists - or twice in the same one - with different, independently editable clip ranges.
export interface MidiPlaylistEntry {
    filename: string;
    inPointSeconds: number;
    outPointSeconds: number;
}

export const enum MidiPlaybackState {
    stopped,
    playing,
    paused,
}

export interface MidiPlayerState {
    filename?: string;
    state: MidiPlaybackState;
    positionSeconds: number;
    durationSeconds: number;
    inPointSeconds: number;
    outPointSeconds: number;
    // Index into the current playlist this playback was launched from; undefined when launched
    // from the archive (or anywhere else) - only playlist-launched playback has somewhere to
    // persist in/out edits back to, so this also gates whether the timeline's trim handles show.
    sourcePlaylistIndex?: number;
}

export interface MidiPreviewFile {
    filename: string;
    bytes: number[];
}

// Three different heuristics for reducing a (possibly chordal/multi-track) MIDI file down to a
// single melodic line:
// - melody-top: at every moment, keep only the highest-pitched currently-sounding note.
// - melody-bottom: same, but keep the lowest-pitched note (extracts a bass line instead).
// - dominant-track: keep only the single track with the most notes, collapsing any remaining
//   chords within it to their top note.
export type MidiSimplifyAlgorithm = 'melody-top' | 'melody-bottom' | 'dominant-track';
