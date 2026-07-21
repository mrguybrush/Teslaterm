import {dialog} from "electron";
import * as fs from "fs";
import * as path from "path";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
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
        this.processIPC = processIPC;
    }

    private sendSessionList() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionList, listSessions());
    }

    private async loadRecording(data: Buffer) {
        const [flightEvents, initialState] = await parseEventsFromFile(data);
        const minEvents = parseMINEvents(flightEvents);
        const displayEvents = parseEventsForDisplay(minEvents, false);
        this.processIPC.send(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.fullList, {events: displayEvents, initial: initialState},
        );
    }

    private async openSession(filename: string) {
        const data = await fs.promises.readFile(filename);
        await this.loadRecording(data);
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
}
