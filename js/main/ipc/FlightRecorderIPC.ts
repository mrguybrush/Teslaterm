import {dialog} from "electron";
import * as fs from "fs";
import * as path from "path";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {FlightVideoMeta, videoMetaPathForSession, videoPathForSession} from "../../common/FlightVideoPaths";
import {FRFullListPayload, IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {
    parseEventsForDisplay,
    parseEventsFromFile,
    parseMINEvents,
} from "../connection/flightrecorder/FlightRecordingParser";
import {deleteSession as deleteSessionFromIndex, listSessions} from "../connection/flightrecorder/SessionIndex";
import {mainWindow} from "../main_electron";
import {MainIPC} from "./IPCProvider";

export class FlightRecorderIPC {
    private readonly processIPC: MainIPC;

    public constructor(processIPC: MainIPC) {
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.loadFlightRecording,
            (data) => this.loadRecording(Buffer.from(data)),
        );
        processIPC.on(
            IPC_CONSTANTS_TO_MAIN.flightRecorder.requestSessionList,
            () => this.sendSessionList(),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.flightRecorder.openSession,
            (filename) => this.openSession(filename),
        );
        processIPC.on(
            IPC_CONSTANTS_TO_MAIN.flightRecorder.deleteSession,
            (filename) => this.deleteSession(filename),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.flightRecorder.exportSession,
            (filename) => this.exportSession(filename),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.flightRecorder.requestVideoSavePath,
            (suggestedName) => this.requestVideoSavePath(suggestedName),
        );
        this.processIPC = processIPC;
    }

    private sendSessionList() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionList, listSessions());
    }

    private async loadRecording(data: Buffer, sessionFilename?: string) {
        const [flightEvents, initialState] = await parseEventsFromFile(data);
        const minEvents = parseMINEvents(flightEvents);
        const displayEvents = parseEventsForDisplay(minEvents, false);
        const payload: FRFullListPayload = {events: displayEvents, initial: initialState};
        // Only sessions opened from the session list can have a video: a recording dropped in as a
        // bare zip has no known location to look next to.
        if (sessionFilename) {
            Object.assign(payload, readVideoInfo(sessionFilename));
        }
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.flightRecorder.fullList, payload);
    }

    private async openSession(filename: string) {
        const data = await fs.promises.readFile(filename);
        await this.loadRecording(data, filename);
    }

    private deleteSession(filename: string) {
        deleteSessionFromIndex(filename);
        this.sendSessionList();
    }

    private async exportSession(filename: string) {
        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: path.basename(filename),
            filters: [{extensions: ['zip'], name: 'Flight recording'}],
        });
        if (!result.canceled && result.filePath) {
            await fs.promises.copyFile(filename, result.filePath);
        }
    }

    private async requestVideoSavePath(suggestedName: string) {
        const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: suggestedName,
            filters: [{extensions: ['mp4'], name: 'Video'}],
        });
        this.processIPC.send(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.videoSavePath,
            result.canceled ? undefined : result.filePath,
        );
    }
}

function readVideoInfo(sessionFilename: string): Partial<FRFullListPayload> {
    const videoPath = videoPathForSession(sessionFilename);
    if (!fs.existsSync(videoPath)) {
        return {};
    }
    try {
        const meta: FlightVideoMeta = JSON.parse(
            fs.readFileSync(videoMetaPathForSession(sessionFilename), {encoding: 'utf-8'}),
        );
        return {videoPath, videoStartEpochMs: meta.startEpochMs};
    } catch (e) {
        // Without the sidecar there is no way to line the video up with the telemetry timeline,
        // and showing it unsynchronised would be worse than not showing it at all.
        console.warn('Flight session has a video but no usable metadata', sessionFilename, e);
        return {};
    }
}
