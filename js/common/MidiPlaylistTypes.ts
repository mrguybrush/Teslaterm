// How many notes tend to sound at once in a MIDI file, used to color-code library/playlist rows.
export type MidiPolyphonyClass = 'mono' | 'low' | 'high';

export interface MidiLibraryEntry {
    filename: string;
    durationSeconds: number;
    polyphony: MidiPolyphonyClass;
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
}
