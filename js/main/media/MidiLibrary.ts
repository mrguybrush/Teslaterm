import * as fs from "fs";
import * as MidiPlayer from "midi-player-js";
import * as path from "path";
import {MidiLibraryEntry, MidiPlaylistEntry, MidiPolyphonyClass} from "../../common/MidiPlaylistTypes";

export const MIDI_DIR = "midis";
const LIBRARY_INDEX_FILE = path.join(MIDI_DIR, "index.json");
const PLAYLIST_FILE = path.join(MIDI_DIR, "playlist.json");
const SAVED_PLAYLISTS_DIR = path.join(MIDI_DIR, "playlists");

function ensureDir() {
    if (!fs.existsSync(MIDI_DIR)) {
        fs.mkdirSync(MIDI_DIR, {recursive: true});
    }
}

// midi-player-js's getEvents() is documented as Event[] but actually returns one array of events
// per track, so it needs flattening before use.
export function fixBrokenArray<T>(reallyTwoDimArray: T[]): T[] {
    const result: T[] = [];
    for (const subarray of reallyTwoDimArray) {
        result.push(...(subarray as unknown as T[]));
    }
    return result;
}

export function analyzeMidiFile(bytes: Uint8Array): { durationSeconds: number, polyphony: MidiPolyphonyClass } {
    const player = new MidiPlayer.Player();
    (player as any).defaultTempo = 120;
    player.loadArrayBuffer(bytes);
    const durationSeconds = player.getSongTime();
    const events = fixBrokenArray(player.getEvents());

    // Build a list of note-start/note-end deltas (+1/-1) over time, skipping the percussion
    // channel (MIDI channel 10, 0-indexed as 9) since drum hits aren't melodic polyphony.
    interface Delta {
        tick: number;
        delta: number;
        // Note-offs are ordered before note-ons at the same tick, so a note ending exactly when
        // the next one starts isn't counted as a brief overlap.
        order: number;
    }
    const deltas: Delta[] = [];
    for (const ev of events) {
        if (ev.channel === 9) {
            continue;
        }
        if (ev.name === 'Note on' && (ev.velocity || 0) > 0) {
            deltas.push({delta: 1, order: 1, tick: ev.tick});
        } else if (ev.name === 'Note off' || (ev.name === 'Note on' && !(ev.velocity || 0))) {
            deltas.push({delta: -1, order: 0, tick: ev.tick});
        }
    }
    deltas.sort((a, b) => (a.tick - b.tick) || (a.order - b.order));

    let active = 0;
    let lastTick = deltas.length > 0 ? deltas[0].tick : 0;
    let soundingTicks = 0;
    let monoTicks = 0;
    let lowTicks = 0;
    for (const d of deltas) {
        const dt = d.tick - lastTick;
        if (dt > 0 && active > 0) {
            soundingTicks += dt;
            if (active <= 1) {
                monoTicks += dt;
            }
            if (active <= 3) {
                lowTicks += dt;
            }
        }
        lastTick = d.tick;
        active += d.delta;
    }

    let polyphony: MidiPolyphonyClass;
    if (soundingTicks === 0 || monoTicks / soundingTicks >= 0.9) {
        polyphony = 'mono';
    } else if (lowTicks / soundingTicks >= 0.9) {
        polyphony = 'low';
    } else {
        polyphony = 'high';
    }
    return {durationSeconds, polyphony};
}

function readLibraryIndex(): Record<string, MidiLibraryEntry> {
    try {
        const entries: MidiLibraryEntry[] = JSON.parse(fs.readFileSync(LIBRARY_INDEX_FILE, {encoding: "utf-8"}));
        const result: Record<string, MidiLibraryEntry> = {};
        for (const entry of entries) {
            result[entry.filename] = entry;
        }
        return result;
    } catch (e) {
        return {};
    }
}

function writeLibraryIndex(index: Record<string, MidiLibraryEntry>) {
    ensureDir();
    fs.writeFileSync(LIBRARY_INDEX_FILE, JSON.stringify(Object.values(index), null, 2));
}

export function getMidiFilePath(filename: string): string {
    return path.join(MIDI_DIR, filename);
}

function analyzeAndCache(filename: string, index: Record<string, MidiLibraryEntry>): MidiLibraryEntry {
    try {
        const bytes = fs.readFileSync(getMidiFilePath(filename));
        const {durationSeconds, polyphony} = analyzeMidiFile(new Uint8Array(bytes));
        const entry: MidiLibraryEntry = {durationSeconds, filename, polyphony};
        index[filename] = entry;
        return entry;
    } catch (e) {
        console.warn("Failed to analyze MIDI file", filename, e);
        const entry: MidiLibraryEntry = {durationSeconds: 0, filename, polyphony: 'mono'};
        index[filename] = entry;
        return entry;
    }
}

export function listLibrary(): MidiLibraryEntry[] {
    ensureDir();
    const filesOnDisk = fs.readdirSync(MIDI_DIR).filter((f) => /\.midi?$/i.test(f));
    const index = readLibraryIndex();
    let changed = false;
    for (const filename of filesOnDisk) {
        if (!index[filename]) {
            analyzeAndCache(filename, index);
            changed = true;
        }
    }
    for (const filename of Object.keys(index)) {
        if (!filesOnDisk.includes(filename)) {
            delete index[filename];
            changed = true;
        }
    }
    if (changed) {
        writeLibraryIndex(index);
    }
    return filesOnDisk.map((f) => index[f]).sort((a, b) => a.filename.localeCompare(b.filename));
}

export function importMidiFile(sourcePath: string): string {
    ensureDir();
    const ext = path.extname(sourcePath);
    const base = path.basename(sourcePath, ext);
    let filename = base + ext;
    let target = path.join(MIDI_DIR, filename);
    let counter = 1;
    while (fs.existsSync(target)) {
        filename = `${base}_${counter}${ext}`;
        target = path.join(MIDI_DIR, filename);
        counter++;
    }
    fs.copyFileSync(sourcePath, target);
    const index = readLibraryIndex();
    analyzeAndCache(filename, index);
    writeLibraryIndex(index);
    return filename;
}

export function saveSimplifiedVariant(originalFilename: string, algorithm: string, bytes: Uint8Array): string {
    ensureDir();
    const ext = path.extname(originalFilename);
    const base = path.basename(originalFilename, ext);
    const suffix = `_simplified-${algorithm}`;
    let filename = base + suffix + ext;
    let target = path.join(MIDI_DIR, filename);
    let counter = 1;
    while (fs.existsSync(target)) {
        filename = `${base}${suffix}_${counter}${ext}`;
        target = path.join(MIDI_DIR, filename);
        counter++;
    }
    fs.writeFileSync(target, bytes);
    const index = readLibraryIndex();
    analyzeAndCache(filename, index);
    writeLibraryIndex(index);
    return filename;
}

export function deleteMidiFile(filename: string) {
    try {
        fs.unlinkSync(getMidiFilePath(filename));
    } catch (e) {
        console.warn("Failed to delete MIDI file", filename, e);
    }
    const index = readLibraryIndex();
    delete index[filename];
    writeLibraryIndex(index);
    setPlaylist(listPlaylist().filter((e) => e.filename !== filename));
}

export function listPlaylist(): MidiPlaylistEntry[] {
    ensureDir();
    try {
        return JSON.parse(fs.readFileSync(PLAYLIST_FILE, {encoding: "utf-8"}));
    } catch (e) {
        return [];
    }
}

export function setPlaylist(entries: MidiPlaylistEntry[]) {
    ensureDir();
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(entries, null, 2));
}

function ensureSavedPlaylistsDir() {
    if (!fs.existsSync(SAVED_PLAYLISTS_DIR)) {
        fs.mkdirSync(SAVED_PLAYLISTS_DIR, {recursive: true});
    }
}

function sanitizePlaylistName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_");
}

function savedPlaylistPath(name: string): string {
    return path.join(SAVED_PLAYLISTS_DIR, sanitizePlaylistName(name) + ".json");
}

export function listSavedPlaylists(): string[] {
    ensureSavedPlaylistsDir();
    return fs.readdirSync(SAVED_PLAYLISTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.substring(0, f.length - 5))
        .sort((a, b) => a.localeCompare(b));
}

export function savePlaylistAs(name: string, entries: MidiPlaylistEntry[]) {
    ensureSavedPlaylistsDir();
    fs.writeFileSync(savedPlaylistPath(name), JSON.stringify({entries, name}, null, 2));
}

export function loadSavedPlaylist(name: string): MidiPlaylistEntry[] {
    try {
        const info = JSON.parse(fs.readFileSync(savedPlaylistPath(name), {encoding: "utf-8"}));
        return info.entries || [];
    } catch (e) {
        return [];
    }
}

export function deleteSavedPlaylist(name: string) {
    try {
        fs.unlinkSync(savedPlaylistPath(name));
    } catch (e) {
        console.warn("Failed to delete saved playlist", name, e);
    }
}
