import * as path from "path";
import {Worker} from "worker_threads";
import {CoilID} from "../../../common/constants";
import {
    FlightEventType,
    FlightRecordingBuffer,
    FlightSessionInfo,
    FR_HEADER_BYTES,
} from "../../../common/FlightRecorderTypes";
import {videoMetaPathForSession, videoPathForSession} from "../../../common/FlightVideoPaths";
import {getToRenderIPCPerCoil, IPC_CONSTANTS_TO_RENDERER, ToastSeverity} from "../../../common/IPCConstantsToRenderer";
import {ipcs, processIPC} from "../../ipc/IPCProvider";
import {getOptionalUD3Connection} from "../connection";
import {isExportDoneMessage, makeFlightRecorderWorker, WorkerMessage} from "./FlightRecordingWorker";
import {addSessionToIndex, ensureSessionsDir, SESSIONS_DIR} from "./SessionIndex";

export interface FlightRecorderEvent {
    type: FlightEventType;
    data: Uint8Array;
    // Absolute wall-clock time in milliseconds since the Unix epoch (Date.now()), not relative to
    // the recording.
    time_ms: number;
}

const MAX_STORED_BYTES = 5e6;

// A recording stops on its own once the coil has been idle this long, so forgetting to press Stop
// does not quietly fill the disk with a recording of nothing happening.
const IDLE_TIMEOUT_MS = 60_000;

function makeFlightRecordingBuffer(coil: CoilID): FlightRecordingBuffer {
    return {
        buffer: new SharedArrayBuffer(MAX_STORED_BYTES),
        initialMeterConfig: ipcs.meters(coil).getCurrentConfigs(),
        initialScopeConfig: ipcs.scope(coil).getCurrentConfigs(),
        writeIndex: 0,
    };
}

function addEventTo(buffer: FlightRecordingBuffer, type: FlightEventType, data: ArrayLike<number>): boolean {
    const totalBytes = FR_HEADER_BYTES + data.length;
    const newWriterIndex = buffer.writeIndex + totalBytes;
    if (newWriterIndex > buffer.buffer.byteLength) {
        return false;
    }
    const bufferView = new DataView(buffer.buffer, buffer.writeIndex, totalBytes);
    bufferView.setUint8(0, type);
    bufferView.setBigUint64(1, BigInt(Date.now()));
    bufferView.setUint32(9, data.length);
    for (let i = 0; i < data.length; ++i) {
        bufferView.setUint8(FR_HEADER_BYTES + i, data[i]);
    }
    buffer.writeIndex = newWriterIndex;
    return true;
}

interface PendingSession {
    coil: CoilID;
    startIso: string;
    durationMs: number;
}

export class FlightRecorder {
    private readonly worker: Worker;
    private readonly coil: CoilID;
    private activeBuffer: FlightRecordingBuffer;
    private oldBuffer: FlightRecordingBuffer;
    private sessionActive: boolean = false;
    private sessionStartWallClock: number = 0;
    private sessionFilename: string = '';
    // Last moment the coil actually did something. While TR is on the coil counts as busy
    // continuously, so only the gaps between activity are measured.
    private lastActivityWallClock: number = 0;
    private transientActive: boolean = false;
    private readonly pendingSessions: Map<string, PendingSession> = new Map();

    public constructor(coil: CoilID) {
        this.coil = coil;
        this.worker = makeFlightRecorderWorker((msg) => this.onWorkerMessage(msg));
        this.activeBuffer = makeFlightRecordingBuffer(coil);
        this.oldBuffer = makeFlightRecordingBuffer(coil);
    }

    public addEventString(type: FlightEventType, data: string) {
        this.addEvent(type, new TextEncoder().encode(data));
    }

    public addEvent(type: FlightEventType, data?: ArrayLike<number>) {
        if (!addEventTo(this.activeBuffer, type, data || [])) {
            this.oldBuffer = this.activeBuffer;
            this.activeBuffer = makeFlightRecordingBuffer(this.coil);
            addEventTo(this.activeBuffer, type, data || []) ;
        }
    }

    public exportAsFile() {
        this.worker.postMessage([this.oldBuffer, this.activeBuffer]);
    }

    public isSessionActive(): boolean {
        return this.sessionActive;
    }

    /** MIDI output or TR being switched on; resets the idle timeout. */
    public notifyActivity() {
        this.lastActivityWallClock = Date.now();
    }

    public setTransientActive(active: boolean) {
        this.transientActive = active;
        // Also on the way down: the coil was busy right up to this moment, so the idle period
        // starts now. Timing from the last *activation* instead would expire immediately after a
        // long TR run with no MIDI in it.
        this.notifyActivity();
    }

    /** Stops a running recording once the coil has been idle past the timeout. */
    public checkIdleTimeout() {
        if (!this.sessionActive || this.transientActive) {
            return;
        }
        if (Date.now() - this.lastActivityWallClock > IDLE_TIMEOUT_MS) {
            ipcs.coilMisc(this.coil).openToast(
                'Flight Recorder',
                'Recording stopped: the coil was idle for a minute.',
                ToastSeverity.info,
                'flight-record',
            );
            this.stopSession();
        }
    }

    /** Started explicitly from the Video tab; recording is never triggered automatically. */
    public startSession() {
        if (this.sessionActive) {
            return;
        }
        this.sessionActive = true;
        this.notifyActivity();
        this.sessionStartWallClock = Date.now();
        ensureSessionsDir();
        this.sessionFilename = path.join(SESSIONS_DIR, 'tt-session-' + this.sessionStartWallClock + '.zip');
        // The renderer owns webcam capture (MediaRecorder is a DOM API), so it only learns about
        // the session from here. It decides on its own whether video recording is switched on.
        processIPC.send(IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionStarted, {
            videoMetaPath: videoMetaPathForSession(this.sessionFilename),
            videoPath: videoPathForSession(this.sessionFilename),
        });
        this.sendState();
        // Buffers are never trimmed as events are recorded (export always reads from byte 0), so
        // starting a new session with fresh buffers is what actually scopes the eventual export to
        // just this session - otherwise every session's export would still contain everything
        // recorded since these buffers were last reset (i.e. all previous sessions too).
        this.oldBuffer = makeFlightRecordingBuffer(this.coil);
        this.activeBuffer = makeFlightRecordingBuffer(this.coil);
    }

    /** Called when TR is switched off while automatic flight recording is enabled; exports the session to disk. */
    public stopSession() {
        if (!this.sessionActive) {
            return;
        }
        this.sessionActive = false;
        this.sendState();
        processIPC.send(IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionStopped, undefined);
        const startIso = new Date(this.sessionStartWallClock).toISOString();
        const durationMs = Date.now() - this.sessionStartWallClock;
        ensureSessionsDir();
        const filename = this.sessionFilename;
        this.pendingSessions.set(filename, {coil: this.coil, durationMs, startIso});
        this.worker.postMessage([this.oldBuffer, this.activeBuffer, filename]);
    }

    public sendState() {
        processIPC.send(getToRenderIPCPerCoil(this.coil).flightRecorderActive, this.sessionActive);
    }

    private onWorkerMessage(msg: WorkerMessage) {
        if (isExportDoneMessage(msg)) {
            const pending = this.pendingSessions.get(msg.filename);
            if (pending) {
                this.pendingSessions.delete(msg.filename);
                if (msg.success) {
                    const info: FlightSessionInfo = {
                        coil: pending.coil,
                        coilName: getOptionalUD3Connection(pending.coil)?.getUDName(),
                        durationMs: pending.durationMs,
                        filename: msg.filename,
                        startIso: pending.startIso,
                    };
                    addSessionToIndex(info);
                }
            }
        } else {
            ipcs.coilMisc(this.coil).openToast(
                'Flight Recorder', msg.text, msg.level || ToastSeverity.info, 'flight-record',
            );
        }
    }
}

const flightRecorder = new Map<CoilID, FlightRecorder>();

export function getFlightRecorder(coil: CoilID) {
    if (!flightRecorder.has(coil)) {
        flightRecorder.set(coil, new FlightRecorder(coil));
    }
    return flightRecorder.get(coil);
}

/** Only recorders that already exist - asking for one would create it for no reason. */
export function tickFlightRecorders() {
    flightRecorder.forEach((recorder) => recorder.checkIdleTimeout());
}
