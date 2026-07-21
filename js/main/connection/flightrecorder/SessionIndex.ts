import * as fs from "fs";
import * as path from "path";
import {FlightSessionInfo} from "../../../common/FlightRecorderTypes";

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
    return readIndex().sort((a, b) => b.startIso.localeCompare(a.startIso));
}

export function deleteSession(filename: string): boolean {
    const entries = readIndex();
    const idx = entries.findIndex((e) => e.filename === filename);
    if (idx === -1) {
        return false;
    }
    entries.splice(idx, 1);
    writeIndex(entries);
    try {
        fs.unlinkSync(filename);
    } catch (e) {
        console.warn('Failed to delete flight session file', filename, e);
    }
    return true;
}
