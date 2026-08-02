import {dialog} from "electron";
import * as fs from "fs";
import {DroppedFile, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {
    deleteMidiFile,
    deleteSavedPlaylist,
    getMidiFilePath,
    importMidiFile,
    listLibrary,
    listPlaylist,
    listSavedPlaylists,
    loadSavedPlaylist,
    savePlaylistAs,
    setPlaylist,
} from "../media/MidiLibrary";
import {loadMediaFile, media_state, onSongEnded} from "../media/media_player";
import {getMidiPlayerState, seekMidi, setInPoint, setOutPoint} from "../midi/midi";
import {mainWindow} from "../main_electron";
import {MainIPC} from "./IPCProvider";

export class MidiPlaylistIPC {
    private readonly processIPC: MainIPC;

    public constructor(processIPC: MainIPC) {
        this.processIPC = processIPC;
        processIPC.onAsync(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestImport, () => this.importFiles());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestLibrary, () => this.sendLibrary());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteLibraryFile, (filename) => {
            deleteMidiFile(filename);
            this.sendLibrary();
            this.sendPlaylist();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylist, () => this.sendPlaylist());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setPlaylist, (files) => {
            setPlaylist(files);
            this.sendPlaylist();
        });
        processIPC.onAsync(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playFile, (filename) => this.playFile(filename));
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.pause, () => media_state.pausePlaying());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.resume, () => media_state.resumePlaying());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.seek, (seconds) => seekMidi(seconds));
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, (seconds) => setInPoint(seconds));
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, (seconds) => setOutPoint(seconds));
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestSavedPlaylists, () => this.sendSavedPlaylists());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.savePlaylistAs, (name) => {
            savePlaylistAs(name, listPlaylist());
            this.sendSavedPlaylists();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadSavedPlaylist, (name) => {
            setPlaylist(loadSavedPlaylist(name));
            this.sendPlaylist();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteSavedPlaylist, (name) => {
            deleteSavedPlaylist(name);
            this.sendSavedPlaylists();
        });
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile,
            (filename) => this.sendPreviewFile(filename),
        );
        onSongEnded(() => this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.songEnded, undefined));
    }

    public tick100() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playerState, getMidiPlayerState());
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
        this.sendLibrary();
    }

    private sendLibrary() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.library, listLibrary());
    }

    private sendPlaylist() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playlist, listPlaylist());
    }

    private sendSavedPlaylists() {
        this.processIPC.send(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.savedPlaylists, listSavedPlaylists());
    }

    private async sendPreviewFile(filename: string) {
        const filePath = getMidiFilePath(filename);
        const bytes = await fs.promises.readFile(filePath);
        this.processIPC.send(
            IPC_CONSTANTS_TO_RENDERER.midiPlaylist.previewFile,
            {bytes: [...new Uint8Array(bytes)], filename},
        );
    }

    private async playFile(filename: string) {
        const filePath = getMidiFilePath(filename);
        const bytes = await fs.promises.readFile(filePath);
        const file: DroppedFile = {bytes: [...new Uint8Array(bytes)], name: filename, path: filePath};
        await loadMediaFile(file);
        await media_state.startPlaying();
    }
}
