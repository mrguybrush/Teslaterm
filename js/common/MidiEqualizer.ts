/**
 * A per-coil "equalizer" for the coil's own sound, not for any recording. A Tesla coil has no audio
 * signal to filter - the note's pitch comes from the interrupter timing, not a waveform - so the
 * equivalent of an EQ band's gain is scaling how loud (i.e. what MIDI velocity) notes in that pitch
 * range are sent at. This only touches Note On velocity in the outgoing MIDI stream; TR, the bus,
 * and every other coil control are entirely separate from it and are left untouched (see
 * applyEq below).
 */

// Octave-aligned so the bands read naturally: C1, C2, C3 (middle C), C4, C5, C6, C7.
export const EQ_BAND_BOUNDARIES = [24, 36, 48, 60, 72, 84, 96];
export const EQ_BAND_COUNT = EQ_BAND_BOUNDARIES.length - 1;

export interface MidiEqState {
    enabled: boolean;
    // One gain per band, in percent - 100 leaves that band's notes unchanged. Index-aligned with
    // the bands EQ_BAND_BOUNDARIES describes.
    gainPercent: number[];
}

export function defaultEqState(): MidiEqState {
    return {enabled: false, gainPercent: new Array(EQ_BAND_COUNT).fill(100)};
}

export function noteToFrequencyHz(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
}

export function bandIndexForNote(note: number): number {
    let band = 0;
    while (band < EQ_BAND_COUNT - 1 && note >= EQ_BAND_BOUNDARIES[band + 1]) {
        band++;
    }
    return band;
}

export function bandLabel(band: number): string {
    const lowHz = noteToFrequencyHz(EQ_BAND_BOUNDARIES[band]);
    const highHz = noteToFrequencyHz(EQ_BAND_BOUNDARIES[band + 1]);
    return `${lowHz.toFixed(0)}-${highHz.toFixed(0)} Hz`;
}

// A Note On status nibble across all 16 channels, i.e. 0x90-0x9F.
function isNoteOnStatus(statusByte: number): boolean {
    return (statusByte & 0xf0) === 0x90;
}

/**
 * Rescales a Note On's velocity by its band's gain; every other message (including a Note On sent
 * with velocity 0, which is a note-off under the MIDI running-status convention) passes through
 * unchanged. Returns `data` itself when nothing needs to change, so callers that skip the copy in
 * the common case stay cheap.
 */
export function applyEq(state: MidiEqState, data: number[] | Uint8Array): number[] | Uint8Array {
    if (!state.enabled || data.length < 3 || !isNoteOnStatus(data[0]) || data[2] === 0) {
        return data;
    }
    const band = bandIndexForNote(data[1]);
    const gain = state.gainPercent[band] ?? 100;
    if (gain === 100) {
        return data;
    }
    const scaled = Math.round(data[2] * gain / 100);
    // Never let a real note-on collapse to 0 (which MIDI reads as note-off) or overflow the 7-bit
    // velocity field.
    const clamped = Math.max(1, Math.min(127, scaled));
    const copy = Array.from(data);
    copy[2] = clamped;
    return copy;
}
