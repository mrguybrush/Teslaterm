/**
 * A per-coil "equalizer" for the coil's own sound, not for any recording. A Tesla coil has no audio
 * signal to filter - the note's pitch comes from the interrupter timing, not a waveform - so the
 * equivalent of an EQ band's gain is scaling how loud (i.e. what MIDI velocity) notes in that pitch
 * range are sent at. This only touches Note On velocity in the outgoing MIDI stream; TR, the bus,
 * and every other coil control are entirely separate from it and are left untouched (see
 * applyEq below).
 *
 * The curve itself is freely editable, not fixed bands: each point is a bell shaped boost/cut
 * (frequency, gain, Q, same three parameters a real parametric EQ node has), and overlapping points
 * sum in dB the way real EQ bands do. It is not literally a biquad filter response - there is no
 * signal to filter - but the shape and the controls are deliberately the same as a real one, since
 * that is the mental model this is standing in for.
 */

export const MIN_FREQ_HZ = 25;
export const MAX_FREQ_HZ = 4200;
export const MIN_GAIN_PERCENT = 0;
export const MAX_GAIN_PERCENT = 200;
export const UNITY_GAIN_PERCENT = 100;
export const MIN_Q = 0.2;
export const MAX_Q = 10;
export const DEFAULT_Q = 1.5;

export interface EqPoint {
    // Stable across edits/drags so the renderer can track which circle is being dragged and React
    // can key the list - not meaningful beyond one session (points are never persisted or sent
    // anywhere that would need it to stay stable longer than that).
    id: number;
    freqHz: number;
    // 100 = unity (no change). Kept as a percent, not dB, so it lines up with the MIDI velocity
    // it ultimately scales.
    gainPercent: number;
    // Higher = narrower peak, same sense as a real parametric EQ's Q.
    q: number;
}

export interface MidiEqState {
    enabled: boolean;
    points: EqPoint[];
}

export function defaultEqState(): MidiEqState {
    return {enabled: false, points: []};
}

export function noteToFrequencyHz(note: number): number {
    return 440 * Math.pow(2, (note - 69) / 12);
}

// One point's contribution at a given frequency: a bell curve in dB, centered on the point's own
// frequency, in log-frequency space (so it looks and behaves symmetrically in octaves the way a
// real parametric EQ's bell does, rather than being lopsided towards the high end on a linear
// frequency axis).
function pointGainDbAt(point: EqPoint, freqHz: number): number {
    const peakDb = 20 * Math.log10(Math.max(point.gainPercent, 1) / 100);
    if (peakDb === 0) {
        return 0;
    }
    const octavesAway = Math.log2(freqHz / point.freqHz);
    // Empirically chosen so Q's practical range (0.2-10) spans "affects almost the whole visible
    // range" to "a couple of semitones wide", matching what the slider feels like to drag.
    const widthOctaves = 2.5 / point.q;
    return peakDb * Math.exp(-0.5 * Math.pow(octavesAway / widthOctaves, 2));
}

/** The combined gain (percent, 100 = unity) of every point at a given frequency. */
export function gainPercentAt(points: EqPoint[], freqHz: number): number {
    if (points.length === 0) {
        return UNITY_GAIN_PERCENT;
    }
    const totalDb = points.reduce((sum, p) => sum + pointGainDbAt(p, freqHz), 0);
    return UNITY_GAIN_PERCENT * Math.pow(10, totalDb / 20);
}

// A Note On status nibble across all 16 channels, i.e. 0x90-0x9F.
function isNoteOnStatus(statusByte: number): boolean {
    return (statusByte & 0xf0) === 0x90;
}

/**
 * Rescales a Note On's velocity by the curve's gain at that note's frequency; every other message
 * (including a Note On sent with velocity 0, which is a note-off under the MIDI running-status
 * convention) passes through unchanged. Returns `data` itself when nothing needs to change, so
 * callers that skip the copy in the common case stay cheap.
 */
export function applyEq(state: MidiEqState, data: number[] | Uint8Array): number[] | Uint8Array {
    if (!state.enabled || data.length < 3 || !isNoteOnStatus(data[0]) || data[2] === 0) {
        return data;
    }
    const gain = gainPercentAt(state.points, noteToFrequencyHz(data[1]));
    if (Math.abs(gain - UNITY_GAIN_PERCENT) < 0.5) {
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
