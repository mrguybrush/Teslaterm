import {dialog} from "electron";
import * as fs from "fs";
import {DroppedFile, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {
    deleteMidiFile,
    deletePlaylist,
    getMidiFilePath,
    importMidiFile,
    listMidiFiles,
    listPlaylists,
    renamePlaylist,
    savePlaylist,
} from "../media/MidiLibrary";
import {loadMediaFile, media_state, onSongEnded} from "../media/media_player";
import {mainWindow} from "../main_electron";
import {MainIPC} from "./IPCProvider";

export class MidiPlaylistIPC {
    private readonly processIPC: MainIPC;

    public constructor(processIPC: MainIPC) {
        this.processIPC = processIPC;
        processIPC.onAsync(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestImport, () => this.importFiles());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestFileList, () => this.sendFileList());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteFile, (filename) => {
            deleteMidiFile(filename);
            this.sendFileList();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylistList, () => this.sendPlaylistList());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.savePlaylist, (info) => {
            savePlaylist(info);
            this.sendPlaylistList();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deletePlaylist, (name) => {
            deletePlaylist(name);
            this.sendPlaylistList();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.renamePlaylist, ({oldName, newName}) => {
            renamePlaylist(oldName, newName);
            this.sendPlaylistList();
        });
        processIPC.onAsync(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playFile, (filename) => this.playFile(filename));
        onSongEnded(() => this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.songEnded, undefined));
    }

    private async importFiles() {
        const result = await dialog.showOpenDialog(mainWindow, {
            filters: [{extensions: ["mid", "midi"], name: "MIDI files"}],
            properties: ["openFile", "multiSelections"],
        });
        if (!result.canceled) {
            for (const filePath of result.filePaths) {
                importMidiFile(filePath);
            }
        }
        this.sendFileList();
    }

    private sendFileList() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.fileList, listMidiFiles());
    }

    private sendPlaylistList() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playlistList, listPlaylists());
    }

    private async playFile(filename: string) {
        const filePath = getMidiFilePath(filename);
        const bytes = await fs.promises.readFile(filePath);
        const file: DroppedFile = {bytes: [...new Uint8Array(bytes)], name: filename, path: filePath};
        await loadMediaFile(file);
        await media_state.startPlaying();
    }
}
