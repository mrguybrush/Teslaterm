import * as fs from "fs";
import * as path from "path";
import {MidiPlaylistInfo} from "../../common/MidiPlaylistTypes";

export const MIDI_DIR = "midis";
export const MIDI_PLAYLIST_DIR = "midi_playlists";

function ensureDir(dir: string) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
}

export function listMidiFiles(): string[] {
    ensureDir(MIDI_DIR);
    return fs.readdirSync(MIDI_DIR)
        .filter((f) => /\.midi?$/i.test(f))
        .sort((a, b) => a.localeCompare(b));
}

export function importMidiFile(sourcePath: string): string {
    ensureDir(MIDI_DIR);
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
    return filename;
}

export function getMidiFilePath(filename: string): string {
    return path.join(MIDI_DIR, filename);
}

export function deleteMidiFile(filename: string) {
    try {
        fs.unlinkSync(getMidiFilePath(filename));
    } catch (e) {
        console.warn("Failed to delete MIDI file", filename, e);
    }
}

function sanitizeFilename(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, "_");
}

function playlistFilePath(name: string): string {
    return path.join(MIDI_PLAYLIST_DIR, sanitizeFilename(name) + ".json");
}

export function listPlaylists(): MidiPlaylistInfo[] {
    ensureDir(MIDI_PLAYLIST_DIR);
    const result: MidiPlaylistInfo[] = [];
    for (const f of fs.readdirSync(MIDI_PLAYLIST_DIR)) {
        if (!f.endsWith(".json")) {
            continue;
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(path.join(MIDI_PLAYLIST_DIR, f), {encoding: "utf-8"}));
            result.push(parsed);
        } catch (e) {
            console.warn("Failed to read MIDI playlist", f, e);
        }
    }
    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

export function savePlaylist(info: MidiPlaylistInfo) {
    ensureDir(MIDI_PLAYLIST_DIR);
    fs.writeFileSync(playlistFilePath(info.name), JSON.stringify(info, null, 2));
}

export function deletePlaylist(name: string) {
    try {
        fs.unlinkSync(playlistFilePath(name));
    } catch (e) {
        console.warn("Failed to delete MIDI playlist", name, e);
    }
}

export function renamePlaylist(oldName: string, newName: string) {
    const existing = listPlaylists().find((p) => p.name === oldName);
    if (existing) {
        deletePlaylist(oldName);
        savePlaylist({...existing, name: newName});
    }
}
