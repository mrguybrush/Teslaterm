import * as MidiPlayer from "midi-player-js";
import {CoilID} from "../../common/constants";
import {ChannelID} from "../../common/IPCConstantsToRenderer";
import {MediaFileType, PlayerActivity} from "../../common/MediaTypes";
import {MidiPlaybackState, MidiPlayerState} from "../../common/MidiPlaylistTypes";
import {forEachCoil, forEachCoilAsync, getConnectionState, hasUD3Connection} from "../connection/connection";
import {Connected} from "../connection/state/Connected";
import {ipcs} from "../ipc/IPCProvider";
import {checkTransientDisabled, media_state, notifySongEnded} from "../media/media_player";
import * as scripting from "../scripting";
import {maybeRedirectEvent} from "./MidiRedirector";

export const kill_msg = Buffer.of(0xB0, 0x78, 0x00);
export const VOLUME_CC_KEY = 7;

// Initialize player and register event handler
export const player = new MidiPlayer.Player(
    ev => processMidiFromPlayer(ev).catch(err => console.error("playing MIDI", err)),
);

let currentDurationSeconds = 0;
let inPointSeconds = 0;
let outPointSeconds = 0;
// Index into the current playlist that the currently loaded file was launched from, if any -
// undefined for archive/other launches. Only playlist-launched playback has an entry to persist
// in/out edits back into, and only that case exposes the trim handles in the renderer.
let sourcePlaylistIndex: number | undefined;

/** Called once a new file has been loaded into `player`; resets the trim range to the full song. */
export function setMidiDuration(seconds: number) {
    currentDurationSeconds = seconds;
    inPointSeconds = 0;
    outPointSeconds = seconds;
}

export function setPlaybackSourcePlaylistIndex(index: number | undefined) {
    sourcePlaylistIndex = index;
}

export function getPlaybackSourcePlaylistIndex(): number | undefined {
    return sourcePlaylistIndex;
}

export function setInPoint(seconds: number) {
    inPointSeconds = Math.max(0, Math.min(seconds, outPointSeconds));
}

export function setOutPoint(seconds: number) {
    outPointSeconds = Math.min(currentDurationSeconds, Math.max(seconds, inPointSeconds));
    if (getCurrentSeconds() >= outPointSeconds) {
        // The playhead is already at or past the new out point - without this, the very next
        // update() tick would treat this as "reached the end" and could auto-advance to the next
        // playlist entry, making the song being trimmed abruptly disappear instead of just
        // stopping where the user just marked it to stop.
        stopToStartMidiFile();
    }
}

export function getCurrentSeconds(): number {
    if (!player.tracks) {
        return 0;
    }
    return Math.max(0, player.getSongTime() - player.getSongTimeRemaining());
}

export function getMidiPlayerState(): MidiPlayerState {
    const loaded = media_state.type === MediaFileType.midi && !!media_state.currentFile;
    let state: MidiPlaybackState;
    if (!loaded || media_state.state === PlayerActivity.idle) {
        state = MidiPlaybackState.stopped;
    } else if (media_state.state === PlayerActivity.paused) {
        state = MidiPlaybackState.paused;
    } else {
        state = MidiPlaybackState.playing;
    }
    return {
        durationSeconds: currentDurationSeconds,
        filename: loaded ? media_state.currentFile.name : undefined,
        inPointSeconds,
        outPointSeconds,
        positionSeconds: loaded ? getCurrentSeconds() : 0,
        sourcePlaylistIndex: loaded ? sourcePlaylistIndex : undefined,
        state,
    };
}

export async function startCurrentMidiFile() {
    stopMidiOutput();
    player.skipToSeconds(inPointSeconds);
    player.play();
    ipcs.misc.updateMediaInfo();
}

export function stopMidiFile() {
    player.stop();
    stopMidiOutput();
    scripting.onMediaStopped();
}

export function pauseCurrentMidiFile() {
    stopMidiOutput();
    player.pause();
    ipcs.misc.updateMediaInfo();
}

export function resumeCurrentMidiFile() {
    player.play();
    ipcs.misc.updateMediaInfo();
}

// Rewinds to the start of the trim range and silences output, but keeps the file "loaded" (paused
// rather than idle) so the renderer's now-playing bar keeps showing it instead of reverting to
// "nothing loaded".
export function stopToStartMidiFile() {
    stopMidiOutput();
    if (player.isPlaying()) {
        player.pause();
    }
    player.skipToSeconds(inPointSeconds);
    media_state.forcePaused();
    ipcs.misc.updateMediaInfo();
}

/** Seeks the currently loaded MIDI file, keeping playback going if it was already playing. */
export function seekMidi(seconds: number) {
    const clamped = Math.max(0, Math.min(seconds, currentDurationSeconds));
    const wasPlaying = player.isPlaying();
    stopMidiOutput();
    player.skipToSeconds(clamped);
    if (wasPlaying) {
        player.play();
    }
    ipcs.misc.updateMediaInfo();
}

export function stopMidiOutput() {
    playMidiData(kill_msg).catch(err => console.error("Stopping MIDI output", err));
}

async function processMidiFromPlayer(event: MidiPlayer.Event) {
    if (await playMidiEvent(event)) {
        media_state.progress = 100 - player.getSongPercentRemaining();
    }
    ipcs.misc.updateMediaInfo();
}

const expectedByteCounts = {
    0x8: 3,
    0x9: 3,
    0xA: 3,
    0xB: 3,
    0xC: 2,
    0xD: 2,
    0xE: 3,
};

function getVarIntLength(byteArray: Uint8Array, startByte: number) {
    let currentByte = byteArray[startByte];
    let byteCount = 1;

    while (currentByte >= 128) {
        currentByte = byteArray[startByte + byteCount];
        byteCount++;
    }

    return byteCount;
}

let received_event = false;

export function sendProgramChange(voice: ChannelID, program: number) {
    return playMidiData([0xc0 | (voice - 1), program]);
}

export function sendVolume(coil: CoilID, voice: ChannelID, volumePercent: number) {
    return playMidiDataOn(
        coil,
        [
            // Controller change command
            0xb0 | (voice - 1),
            // Volume change
            VOLUME_CC_KEY,
            // Actual volume (0-127)
            volumePercent * 127 / 100,
        ],
    );
}

const lastStatusByTrack = new Map<number, number>();

export async function playMidiEvent(event: MidiPlayer.Event): Promise<boolean> {
    received_event = true;

    const trackObj = player.tracks[event.track - 1];
    // tslint:disable-next-line:no-string-literal
    const track: Uint8Array = trackObj["data"];
    const startIndex = event.byteIndex + getVarIntLength(track, event.byteIndex);
    const firstByte = track[startIndex];
    let argsStartIndex = startIndex;
    if (firstByte >= 0x80) {
        // If the first byte is less than 0x80, the MIDI file is using the "running status" feature where the first byte
        // of a message can be skipped if it is the same as in the previous message.
        lastStatusByTrack.set(event.track, firstByte);
        ++argsStartIndex;
    }
    const data: number[] = [lastStatusByTrack.get(event.track)];
    const len = expectedByteCounts[data[0] >> 4];
    if (!len) {
        return true;
    }
    for (let i = 0; i < len - 1; ++i) {
        data.push(track[argsStartIndex + i]);
    }
    if (await maybeRedirectEvent(event)) {
        return true;
    } else {
        return playMidiData(data);
    }
}

export async function playMidiDataOn(coil: CoilID, data: number[] | Uint8Array): Promise<void> {
    await checkTransientDisabled(coil);
    const connectionState = getConnectionState(coil);
    if (connectionState instanceof Connected) {
        await connectionState.sendMIDI(Buffer.from(data));
    }
}

export async function playMidiData(data: number[] | Uint8Array): Promise<boolean> {
    if (data[0] !== 0x00) {
        await forEachCoilAsync(async (coil) => playMidiDataOn(coil, data));
        return true;
    } else {
        return false;
    }
}

export function update(): void {
    // The MIDI player never outputs multiple events at the same time (always at least 5 ms between). This can result
    // in tones that should start at once starting with a noticeable delay if the main loop runs between the 2 events.
    // This loop forces the MIDI player to output all events that should have played before now
    // It is not necessary to reset received_event before the loop since it isn't necessary to run the loop if no events
    // were processed since the last tick
    if (player.isPlaying()) {
        let i = 0;
        while (received_event && i < 20) {
            ++i;
            received_event = false;
            player.playLoop(false);
        }
        if (media_state.type === MediaFileType.midi && outPointSeconds > 0 && getCurrentSeconds() >= outPointSeconds) {
            // Rewind and pause instead of a full stop, so the now-playing bar keeps showing the
            // song instead of reverting to "nothing loaded" whenever there's no next playlist
            // entry to auto-advance to (notifySongEnded() below still lets that happen first if
            // auto-play is on, which then supersedes this).
            stopToStartMidiFile();
            notifySongEnded();
        }
    } else if (media_state.state === PlayerActivity.playing && media_state.type === MediaFileType.midi) {
        stopToStartMidiFile();
        notifySongEnded();
    }
}
