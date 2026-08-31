import * as fs from "fs";
import * as path from "path";
import {FlightSessionInfo} from "../../../common/FlightRecorderTypes";
import {videoMetaPathForSession, videoPathForSession} from "../../../common/FlightVideoPaths";

export const SESSIONS_DIR = 'flight_recordings';
const INDEX_FILE = path.join(SESSIONS_DIR, 'index.json');

export function ensureSessionsDir() {
    if (!fs.existsSync(SESSIONS_DIR)) {
        fs.mkdirSync(SESSIONS_DIR, {recursive: true});
    }
}

function readIndex(): FlightSessionInfo[] {
    ensureSessionsDir();
    try {
        return JSON.parse(fs.readFileSync(INDEX_FILE, {encoding: 'utf-8'}));
    } catch (e) {
        return [];
    }
}

function writeIndex(entries: FlightSessionInfo[]) {
    ensureSessionsDir();
    fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 2));
}

export function addSessionToIndex(entry: FlightSessionInfo) {
    const entries = readIndex();
    entries.push(entry);
    writeIndex(entries);
}

export function listSessions(): FlightSessionInfo[] {
    return readIndex()
        .map((entry) => {
            const videoPath = videoPathForSession(entry.filename);
            return fs.existsSync(videoPath) ? {...entry, videoPath} : entry;
        })
        .sort((a, b) => b.startIso.localeCompare(a.startIso));
}

export function deleteSession(filename: string): boolean {
    const entries = readIndex();
    const idx = entries.findIndex((e) => e.filename === filename);
    if (idx === -1) {
        return false;
    }
    entries.splice(idx, 1);
    writeIndex(entries);
    // The webcam video and its sidecar are separate files derived from this one, so deleting the
    // session has to take them along - they are simply absent for sessions recorded without video.
    for (const file of [filename, videoPathForSession(filename), videoMetaPathForSession(filename)]) {
        try {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        } catch (e) {
            console.warn('Failed to delete flight session file', file, e);
        }
    }
    return true;
}
