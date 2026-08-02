// How many notes tend to sound at once in a MIDI file, used to color-code library/playlist rows.
export type MidiPolyphonyClass = 'mono' | 'low' | 'high';

export interface MidiLibraryEntry {
    filename: string;
    durationSeconds: number;
    polyphony: MidiPolyphonyClass;
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
