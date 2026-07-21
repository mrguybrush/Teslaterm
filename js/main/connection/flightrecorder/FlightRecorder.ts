import * as path from "path";
import {Worker} from "worker_threads";
import {CoilID} from "../../../common/constants";
import {
    FlightEventType,
    FlightRecordingBuffer,
    FlightSessionInfo,
    FR_HEADER_BYTES,
} from "../../../common/FlightRecorderTypes";
import {ToastSeverity} from "../../../common/IPCConstantsToRenderer";
import {ipcs} from "../../ipc/IPCProvider";
import * as microtime from "../../microtime";
import {getOptionalUD3Connection} from "../connection";
import {isExportDoneMessage, makeFlightRecorderWorker, WorkerMessage} from "./FlightRecordingWorker";
import {addSessionToIndex, ensureSessionsDir, SESSIONS_DIR} from "./SessionIndex";

export interface FlightRecorderEvent {
    type: FlightEventType;
    data: Uint8Array;
    time_us: number;
}

const MAX_STORED_BYTES = 5e6;

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
    bufferView.setUint32(1, microtime.now());
    bufferView.setUint32(5, data.length);
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

    /** Called when TR is switched on while automatic flight recording is enabled. */
    public startSession() {
        this.sessionActive = true;
        this.sessionStartWallClock = Date.now();
    }

    /** Called when TR is switched off while automatic flight recording is enabled; exports the session to disk. */
    public stopSession() {
        if (!this.sessionActive) {
            return;
        }
        this.sessionActive = false;
        const startIso = new Date(this.sessionStartWallClock).toISOString();
        const durationMs = Date.now() - this.sessionStartWallClock;
        ensureSessionsDir();
        const filename = path.join(SESSIONS_DIR, 'tt-session-' + this.sessionStartWallClock + '.zip');
        this.pendingSessions.set(filename, {coil: this.coil, durationMs, startIso});
        this.worker.postMessage([this.oldBuffer, this.activeBuffer, filename]);
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
