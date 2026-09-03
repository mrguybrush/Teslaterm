import {dialog} from "electron";
import * as fs from "fs";
import {CoilID} from "../../common/constants";
import {
    getToMainIPCPerCoil,
    IPC_CONSTANTS_TO_MAIN,
} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../common/IPCConstantsToRenderer";
import {FirmwareFiletype, handleBootloaderFileDrop} from "../connection/state/Bootloading";
import {getCoilCommands} from "../connection/connection";
import {getFlightRecorder} from "../connection/flightrecorder/FlightRecorder";
import {mainWindow} from "../main_electron";
import {TemporaryIPC} from "./TemporaryIPC";
import {MainIPC} from "./IPCProvider";

interface PickedFirmware {
    name: string;
    path: string;
    bytes: number[];
    type: FirmwareFiletype;
}

export class CommandIPC {
    private readonly coil: CoilID;
    private pickedFirmware?: PickedFirmware;

    constructor(processIPC: TemporaryIPC, coil: CoilID) {
        this.coil = coil;
        const commands = getCoilCommands(coil);
        const channels = getToMainIPCPerCoil(coil);
        processIPC.onAsync(channels.commands.saveEEPROM, () => commands.eepromSave());
        processIPC.on(channels.flightRecorder.startRecording, (name) => getFlightRecorder(coil).startSession(name));
        processIPC.on(channels.flightRecorder.stopRecording, () => getFlightRecorder(coil).stopSession());
        processIPC.on(channels.flightRecorder.requestState, () => getFlightRecorder(coil).sendState());
        processIPC.onAsync(
            channels.commands.pickFirmwareFile,
            () => this.pickFirmwareFile(processIPC),
        );
        processIPC.onAsync(
            channels.commands.confirmFirmwareUpload,
            () => this.confirmFirmwareUpload(processIPC),
        );
        processIPC.onAsync(
            channels.commands.setBusState,
            (enable) => enable ? commands.busOn() : commands.busOff(),
        );
        processIPC.onAsync(
            channels.commands.setKillState,
            (enable) => enable ? commands.setKill() : commands.resetKill(),
        );
        processIPC.onAsync(
            channels.commands.setTRState,
            (enable) => {
                // Recording is started and stopped by hand from the Video tab; TR only tells the
                // recorder whether the coil is busy, which is what holds off the idle timeout.
                getFlightRecorder(coil).setTransientActive(enable);
                return commands.setTransientEnabled(enable);
            },
        );
        processIPC.onAsync(channels.commands.setParms, async (parms) => {
            for (const [key, value] of parms) {
                await commands.setParam(key, value);
            }
        });
    }

    private async pickFirmwareFile(processIPC: TemporaryIPC) {
        const result = await dialog.showOpenDialog(mainWindow, {
            filters: [{extensions: ['cyacd', 'hex'], name: 'UD3/Fibernet firmware'}],
            properties: ['openFile'],
        });
        if (result.canceled || result.filePaths.length === 0) {
            return;
        }
        const filePath = result.filePaths[0];
        const bytes = await fs.promises.readFile(filePath);
        const extension = filePath.substring(filePath.lastIndexOf('.') + 1) as FirmwareFiletype;
        this.pickedFirmware = {
            bytes: [...new Uint8Array(bytes)],
            name: filePath.substring(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1),
            path: filePath,
            type: extension,
        };
        processIPC.send(getToRenderIPCPerCoil(this.coil).firmwarePicked, this.pickedFirmware.name);
    }

    private async confirmFirmwareUpload(processIPC: TemporaryIPC) {
        if (!this.pickedFirmware) {
            return;
        }
        const {bytes, name, path, type} = this.pickedFirmware;
        this.pickedFirmware = undefined;
        processIPC.send(getToRenderIPCPerCoil(this.coil).firmwarePicked, undefined);
        await handleBootloaderFileDrop(type, {bytes, name, path});
    }
}

export function registerCommonCommandsIPC(processIPC: MainIPC) {
    processIPC.distributeTo(IPC_CONSTANTS_TO_MAIN.commands.setAllKillState, (c) => c.commands.setKillState);
    processIPC.distributeTo(IPC_CONSTANTS_TO_MAIN.commands.setBusState, (c) => c.commands.setBusState);
    processIPC.distributeTo(IPC_CONSTANTS_TO_MAIN.commands.setTRState, (c) => c.commands.setTRState);
}
