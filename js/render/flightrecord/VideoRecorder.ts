import * as fs from "fs";
import {FlightVideoMeta} from "../../common/FlightVideoPaths";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {FlightSessionVideoTarget} from "../../common/IPCConstantsToRenderer";
import {processIPC} from "../ipc/IPCProvider";

// Chromium always has the first of these; the rest are only listed so a future build with
// different codec support still records something rather than failing outright.
const PREFERRED_MIME_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
];

function pickMimeType(): string | undefined {
    return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Records the webcam (with audio) to disk for the duration of a flight recording session.
 *
 * Capture has to live in the renderer because MediaRecorder is a DOM API, but the session it
 * belongs to is started and stopped by the main process. Writing goes straight to disk from here
 * rather than through IPC: the app runs with nodeIntegration, and streaming a multi-megabyte
 * video through the IPC channel that also carries live telemetry would be a poor trade.
 *
 * Chunks are appended as they arrive instead of being buffered until the end, so a crash mid
 * session still leaves a playable file for everything recorded up to that point.
 */
export class FlightVideoRecorder {
    private recorder?: MediaRecorder;
    private stream?: MediaStream;
    private writeStream?: fs.WriteStream;
    // Chunks arrive as Blobs and have to be converted before they can be written, so a write is
    // always still in flight when the next one is queued. Chaining them keeps the file in order
    // and, more importantly, gives close a single thing to wait for - the final chunk from stop()
    // would otherwise be dropped while its conversion was still pending.
    private writeChain: Promise<void> = Promise.resolve();
    private target?: FlightSessionVideoTarget;
    private startEpochMs?: number;
    // Bumped by every start() and stop(). getUserMedia() can take arbitrarily long (device wake-up,
    // a permission prompt), and the session may well have ended by the time it resolves - comparing
    // against the generation captured before the await is what tells that apart. A boolean
    // "cancelled" flag could not: the stop that set it also resets state for the next session.
    private generation: number = 0;
    private onStateChange?: () => void;

    public constructor(onStateChange?: () => void) {
        this.onStateChange = onStateChange;
    }

    public get recording(): boolean {
        return this.recorder !== undefined;
    }

    public async start(target: FlightSessionVideoTarget) {
        if (this.recorder) {
            return;
        }
        const generation = ++this.generation;
        this.target = target;
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
        } catch (e) {
            if (generation === this.generation) {
                this.reportError(`Could not open the webcam: ${e?.message || e}`);
                this.reset();
            }
            return;
        }
        // The session can end while getUserMedia is still waiting on the user or the device.
        if (generation !== this.generation) {
            stopTracks(stream);
            return;
        }
        const mimeType = pickMimeType();
        if (!mimeType) {
            stopTracks(stream);
            this.reportError('No supported video format available for recording.');
            this.reset();
            return;
        }
        try {
            this.stream = stream;
            this.writeStream = fs.createWriteStream(target.videoPath);
            const recorder = new MediaRecorder(stream, {mimeType});
            recorder.ondataavailable = (ev) => this.onChunk(ev.data);
            recorder.onerror = (ev) => this.reportError(`Recording failed: ${(ev as any)?.error?.message || ev.type}`);
            // The first frame is only captured once the recorder actually starts, which is well
            // after the session began - playback lines the video up using exactly this timestamp.
            // Written out immediately rather than on stop: if the app dies mid-session the chunks
            // already on disk still form a playable file, and without this sidecar it could not be
            // synchronised and would be ignored entirely.
            recorder.onstart = () => {
                this.startEpochMs = Date.now();
                const meta: FlightVideoMeta = {startEpochMs: this.startEpochMs};
                fs.promises.writeFile(target.videoMetaPath, JSON.stringify(meta))
                    .catch((e) => this.reportError(`Could not save video metadata: ${e?.message || e}`));
            };
            this.recorder = recorder;
            // One chunk per second keeps the on-disk file close to what has been captured without
            // producing an excessive number of small writes.
            recorder.start(1000);
            this.onStateChange?.();
        } catch (e) {
            this.reportError(`Could not start recording: ${e?.message || e}`);
            this.stopEverything();
        }
    }

    public async stop() {
        ++this.generation;
        const recorder = this.recorder;
        if (!recorder) {
            // Either nothing was running or the camera never opened; make sure a start still in
            // flight does not survive this stop.
            this.reset();
            return;
        }
        // requestData() flushes whatever has accumulated since the last timeslice chunk, so the
        // final partial second is not lost.
        await new Promise<void>((resolve) => {
            recorder.onstop = () => resolve();
            try {
                if (recorder.state !== 'inactive') {
                    recorder.requestData();
                    recorder.stop();
                } else {
                    resolve();
                }
            } catch (e) {
                console.error('Stopping video recording', e);
                resolve();
            }
        });
        await this.closeWriteStream();
        stopTracks(this.stream);
        this.reset();
    }

    private onChunk(chunk: Blob) {
        if (!chunk || chunk.size === 0 || !this.writeStream) {
            return;
        }
        const stream = this.writeStream;
        this.writeChain = this.writeChain
            .then(() => chunk.arrayBuffer())
            .then((buffer) => {
                if (stream.writable) {
                    stream.write(Buffer.from(buffer));
                }
            })
            .catch((e) => console.error('Writing video chunk', e));
    }

    private async closeWriteStream() {
        const stream = this.writeStream;
        this.writeStream = undefined;
        if (!stream) {
            return;
        }
        // MediaRecorder emits its last dataavailable before stop resolves, so waiting on the chain
        // here is what actually gets that final chunk onto disk.
        await this.writeChain;
        await new Promise<void>((resolve) => stream.end(() => resolve()));
    }

    private stopEverything() {
        try {
            if (this.recorder && this.recorder.state !== 'inactive') {
                this.recorder.stop();
            }
        } catch (e) {
            console.error('Stopping video recording', e);
        }
        stopTracks(this.stream);
        this.closeWriteStream().catch((e) => console.error('Closing video file', e));
        this.reset();
    }

    private reset() {
        this.recorder = undefined;
        this.stream = undefined;
        this.target = undefined;
        this.startEpochMs = undefined;
        this.writeChain = Promise.resolve();
        this.onStateChange?.();
    }

    private reportError(message: string) {
        console.error('Flight video recording:', message);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.videoError, message);
    }
}

function stopTracks(stream?: MediaStream) {
    stream?.getTracks().forEach((track) => track.stop());
}
