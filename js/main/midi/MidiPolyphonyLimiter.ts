const MIDI_NOTE_OFF = 0x80;
const MIDI_NOTE_ON = 0x90;
const MIDI_CONTROL_CHANGE = 0xB0;
const CC_ALL_SOUND_OFF = 120;
const CC_ALL_NOTES_OFF = 123;

export type MidiMessage = number[] | Uint8Array;

/**
 * Caps how many MIDI notes may sound at the same time, deciding per message what actually gets
 * forwarded to the coil.
 *
 * The UD3 has a fixed pool of 6 voices (SIGGEN_VOICECOUNT). Once they are all busy its own
 * allocator, VMSW_getNextVoice(), takes the *oldest* sounding note and silences it on the spot -
 * VMS_removeBlocksWithTargetVoice() followed by a zero-volume SigGen_setVoiceVMS(), with no
 * release envelope at all. Keeping the note count below that ceiling means the UD3 never has to
 * do this: when a note has to go we send a regular Note-Off, which runs through VMSW_stopNote()
 * and lets the VMS release envelope play out instead of chopping the note off.
 *
 * Fewer simultaneous voices also thin out pulse collisions in SigGen_task(): when two voices want
 * to fire within the same ontime+offtime window, the later pulse is either pulled forward in time
 * or skipped entirely, which is what makes dense multi-track files sound rough. That window
 * scales with the ontime, so lowering the ontime attacks the same problem from the other side.
 *
 * One instance holds the note state for one coil.
 */
export class MidiPolyphonyLimiter {
    // Notes forwarded to the coil that have not been ended yet.
    private readonly sounding = new Set<number>();
    // Notes dropped (or cut short) on purpose. Their eventual Note-Off has to be swallowed too,
    // otherwise it would reach the UD3 without a matching Note-On and could stop an unrelated
    // note that reused the same voice.
    private readonly dropped = new Set<number>();

    /**
     * @param limit maximum notes allowed to sound at once, 0 or less to forward everything
     * @returns the messages to send: empty if the note is dropped, two if an older note has to
     *          make room for a new one.
     */
    public filter(data: MidiMessage, limit: number): MidiMessage[] {
        const status = data[0] & 0xF0;
        const channel = data[0] & 0x0F;

        if (status === MIDI_CONTROL_CHANGE && (data[1] === CC_ALL_SOUND_OFF || data[1] === CC_ALL_NOTES_OFF)) {
            this.reset();
            return [data];
        }
        if (status !== MIDI_NOTE_ON && status !== MIDI_NOTE_OFF) {
            return [data];
        }

        const note = data[1];
        const key = noteKey(channel, note);
        // A Note-On with velocity 0 means Note-Off - very common in files using running status.
        if (status === MIDI_NOTE_OFF || data[2] === 0) {
            this.sounding.delete(key);
            if (this.dropped.delete(key)) {
                return [];
            }
            return [data];
        }

        if (limit <= 0 || this.sounding.has(key) || this.sounding.size < limit) {
            this.dropped.delete(key);
            this.sounding.add(key);
            return [data];
        }

        // At the limit: give up the lowest note currently sounding, but only in favour of a note
        // above it. Bass notes tend to be held longest, so choosing by pitch keeps the melody
        // audible where choosing by age would just keep whatever is newest.
        let lowestKey: number | undefined;
        let lowestNote = 128;
        for (const soundingKey of this.sounding) {
            const soundingNote = soundingKey & 0xFF;
            if (soundingNote < lowestNote) {
                lowestNote = soundingNote;
                lowestKey = soundingKey;
            }
        }
        if (lowestKey === undefined || lowestNote >= note) {
            this.dropped.add(key);
            return [];
        }
        this.sounding.delete(lowestKey);
        this.sounding.add(key);
        this.dropped.delete(key);
        // The file will still send its own Note-Off for the note we just ended - swallow it.
        this.dropped.add(lowestKey);
        return [
            [MIDI_NOTE_OFF | (lowestKey >> 8), lowestKey & 0xFF, 0],
            data,
        ];
    }

    public reset() {
        this.sounding.clear();
        this.dropped.clear();
    }
}

function noteKey(channel: number, note: number) {
    return (channel << 8) | note;
}
