// Transposes every Note On/Off event's note number by a fixed number of semitones. Unlike
// simplifyMidiFile (which reconstructs a minimal new file from parsed note on/off pairs and drops
// everything else - other tracks, channels, program changes, CCs), this walks the original Standard
// MIDI File bytes directly and only ever overwrites the note-number byte of a Note On/Off event, so
// every other track, channel and event is preserved byte-for-byte.

function readVarLen(bytes: Uint8Array, pos: number): {value: number, next: number} {
    let value = 0;
    let p = pos;
    // A MIDI variable-length quantity is at most 4 bytes for any value this walk cares about
    // (track/file lengths), but the loop condition is the continuation bit, not a byte count.
    while (true) {
        const b = bytes[p++];
        value = (value << 7) | (b & 0x7f);
        if ((b & 0x80) === 0) {
            break;
        }
    }
    return {next: p, value};
}

function clampNote(note: number, semitones: number): number {
    return Math.max(0, Math.min(127, note + semitones));
}

export function transposeMidiFile(bytes: Uint8Array, semitones: number): Uint8Array {
    if (semitones === 0) {
        return bytes.slice();
    }
    if (bytes.length < 14 || bytes[0] !== 0x4d || bytes[1] !== 0x54 || bytes[2] !== 0x68 || bytes[3] !== 0x64) {
        throw new Error('Not a Standard MIDI File (missing MThd header)');
    }
    // A mutable copy - every other byte in it is left exactly as read.
    const out = Uint8Array.from(bytes);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const numTracks = view.getUint16(10);

    let pos = 14;
    for (let t = 0; t < numTracks; t++) {
        if (out[pos] !== 0x4d || out[pos + 1] !== 0x54 || out[pos + 2] !== 0x72 || out[pos + 3] !== 0x6b) {
            throw new Error(`Malformed track chunk at track ${t}`);
        }
        const trackLen = view.getUint32(pos + 4);
        const trackEnd = pos + 8 + trackLen;
        let p = pos + 8;
        // Running status: a data byte where a status byte was expected means "reuse the last
        // channel status byte" - required to walk the file correctly, not just for note events.
        let runningStatus = 0;
        while (p < trackEnd) {
            p = readVarLen(out, p).next; // delta time, irrelevant to transposing
            let status = out[p];
            if (status < 0x80) {
                status = runningStatus;
            } else {
                p++;
                runningStatus = status;
            }
            if (status === 0xff) {
                // Meta event: 0xFF <type> <varlen length> <data>
                p++; // meta type
                const len = readVarLen(out, p);
                p = len.next + len.value;
                runningStatus = 0;
            } else if (status === 0xf0 || status === 0xf7) {
                // Sysex: <varlen length> <data>
                const len = readVarLen(out, p);
                p = len.next + len.value;
                runningStatus = 0;
            } else {
                const type = status & 0xf0;
                if (type === 0x80 || type === 0x90) {
                    // Note off / Note on: <note> <velocity> - only byte this function ever writes.
                    out[p] = clampNote(out[p], semitones);
                    p += 2;
                } else if (type === 0xa0 || type === 0xb0 || type === 0xe0) {
                    // Poly aftertouch, control change, pitch bend: two data bytes, untouched.
                    p += 2;
                } else if (type === 0xc0 || type === 0xd0) {
                    // Program change, channel aftertouch: one data byte, untouched.
                    p += 1;
                } else {
                    throw new Error(`Unexpected MIDI status byte 0x${status.toString(16)} at track ${t}`);
                }
            }
        }
        pos = trackEnd;
    }
    return out;
}
