import * as MidiPlayer from "midi-player-js";
import {MidiSimplifyAlgorithm} from "../../common/MidiPlaylistTypes";
import {fixBrokenArray} from "./MidiLibrary";

interface NoteEvent {
    tick: number;
    track: number;
    channel: number;
    note: number;
    on: boolean;
}

interface OutputNote {
    tick: number;
    type: 'on' | 'off';
    note: number;
}

function collectNoteEvents(events: MidiPlayer.Event[]): NoteEvent[] {
    const result: NoteEvent[] = [];
    for (const ev of events) {
        if (ev.name === 'Note on' && (ev.velocity || 0) > 0) {
            result.push({channel: ev.channel, note: ev.noteNumber, on: true, tick: ev.tick, track: ev.track});
        } else if (ev.name === 'Note off' || (ev.name === 'Note on' && !(ev.velocity || 0))) {
            result.push({channel: ev.channel, note: ev.noteNumber, on: false, tick: ev.tick, track: ev.track});
        }
    }
    return result;
}

// Collapses arbitrarily many simultaneous notes down to a single monophonic voice, picking one
// "winner" note out of whatever's currently held down at any moment via `pickWinner`, and only
// emitting a new on/off pair when that winner actually changes.
function reduceToMonophonic(noteEvents: NoteEvent[], pickWinner: (active: number[]) => number | undefined): OutputNote[] {
    const sorted = [...noteEvents].sort((a, b) => a.tick - b.tick || (a.on === b.on ? 0 : a.on ? 1 : -1));
    const active = new Map<number, number>();
    let currentSounding: number | undefined;
    const result: OutputNote[] = [];
    for (const ev of sorted) {
        if (ev.on) {
            active.set(ev.note, (active.get(ev.note) || 0) + 1);
        } else {
            const count = active.get(ev.note) || 0;
            if (count <= 1) {
                active.delete(ev.note);
            } else {
                active.set(ev.note, count - 1);
            }
        }
        const winner = pickWinner([...active.keys()]);
        if (winner !== currentSounding) {
            if (currentSounding !== undefined) {
                result.push({note: currentSounding, tick: ev.tick, type: 'off'});
            }
            if (winner !== undefined) {
                result.push({note: winner, tick: ev.tick, type: 'on'});
            }
            currentSounding = winner;
        }
    }
    if (currentSounding !== undefined) {
        const lastTick = sorted.length ? sorted[sorted.length - 1].tick : 0;
        result.push({note: currentSounding, tick: lastTick, type: 'off'});
    }
    return result;
}

const highest = (active: number[]) => active.length ? Math.max(...active) : undefined;
const lowest = (active: number[]) => active.length ? Math.min(...active) : undefined;

function simplifyMelodyTop(events: NoteEvent[]): OutputNote[] {
    return reduceToMonophonic(events.filter((e) => e.channel !== 9), highest);
}

function simplifyMelodyBottom(events: NoteEvent[]): OutputNote[] {
    return reduceToMonophonic(events.filter((e) => e.channel !== 9), lowest);
}

function simplifyDominantTrack(events: NoteEvent[]): OutputNote[] {
    const counts = new Map<number, number>();
    for (const e of events) {
        if (e.on && e.channel !== 9) {
            counts.set(e.track, (counts.get(e.track) || 0) + 1);
        }
    }
    let bestTrack: number | undefined;
    let bestCount = -1;
    for (const [track, count] of counts) {
        if (count > bestCount) {
            bestCount = count;
            bestTrack = track;
        }
    }
    const filtered = bestTrack === undefined ? [] : events.filter((e) => e.track === bestTrack);
    return reduceToMonophonic(filtered, highest);
}

function encodeVarLen(value: number): number[] {
    const bytes: number[] = [value & 0x7f];
    value >>= 7;
    while (value > 0) {
        bytes.unshift((value & 0x7f) | 0x80);
        value >>= 7;
    }
    return bytes;
}

function numberToBytes(value: number, byteCount: number): number[] {
    const bytes: number[] = [];
    for (let i = byteCount - 1; i >= 0; --i) {
        bytes.push((value >> (i * 8)) & 0xff);
    }
    return bytes;
}

// Emits a minimal Standard MIDI File (format 0, single track) - just enough structure to carry a
// tempo and a note-on/off sequence. No writer library is depended on for this.
function buildStandardMidiFile(notes: OutputNote[], division: number, microsecondsPerQuarter: number): Uint8Array {
    const trackBytes: number[] = [];
    trackBytes.push(...encodeVarLen(0), 0xff, 0x51, 0x03, ...numberToBytes(microsecondsPerQuarter, 3));

    let lastTick = 0;
    for (const n of notes) {
        const delta = Math.max(0, n.tick - lastTick);
        lastTick = n.tick;
        trackBytes.push(...encodeVarLen(delta));
        trackBytes.push(n.type === 'on' ? 0x90 : 0x80, n.note & 0x7f, n.type === 'on' ? 100 : 0);
    }
    trackBytes.push(...encodeVarLen(0), 0xff, 0x2f, 0x00);

    const header = [
        0x4d, 0x54, 0x68, 0x64, // "MThd"
        0, 0, 0, 6,
        0, 0, // format 0
        0, 1, // 1 track
        ...numberToBytes(division, 2),
    ];
    const track = [
        0x4d, 0x54, 0x72, 0x6b, // "MTrk"
        ...numberToBytes(trackBytes.length, 4),
        ...trackBytes,
    ];
    return new Uint8Array([...header, ...track]);
}

export function simplifyMidiFile(bytes: Uint8Array, algorithm: MidiSimplifyAlgorithm): Uint8Array {
    const player = new MidiPlayer.Player();
    (player as any).defaultTempo = 120;
    player.loadArrayBuffer(bytes);
    const events = fixBrokenArray(player.getEvents());
    const noteEvents = collectNoteEvents(events);

    const tempoEvent = events.find((e) => e.name === 'Set Tempo');
    const bpm = tempoEvent?.data || 120;
    const microsecondsPerQuarter = Math.round(60000000 / bpm);

    let notes: OutputNote[];
    switch (algorithm) {
        case 'melody-top':
            notes = simplifyMelodyTop(noteEvents);
            break;
        case 'melody-bottom':
            notes = simplifyMelodyBottom(noteEvents);
            break;
        case 'dominant-track':
            notes = simplifyDominantTrack(noteEvents);
            break;
    }
    return buildStandardMidiFile(notes, player.division, microsecondsPerQuarter);
}
