import {dialog} from "electron";
import * as fs from "fs";
import {DroppedFile, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {MidiSimplifyAlgorithm} from "../../common/MidiPlaylistTypes";
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
    saveSimplifiedVariant,
    setPlaylist,
} from "../media/MidiLibrary";
import {loadMediaFile, media_state, onSongEnded} from "../media/media_player";
import {simplifyMidiFile} from "../media/MidiSimplify";
import {
    getMidiPlayerState,
    getPlaybackSourcePlaylistIndex,
    seekMidi,
    setInPoint,
    setOutPoint,
    setPlaybackSourcePlaylistIndex,
    stopToStartMidiFile,
} from "../midi/midi";
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
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.playArchiveFile,
            (filename) => this.playArchiveFile(filename),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.playPlaylistEntry,
            (index) => this.playPlaylistEntry(index),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadArchiveFile,
            (filename) => this.loadArchiveFileOnly(filename),
        );
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadPlaylistEntry,
            (index) => this.loadPlaylistEntryOnly(index),
        );
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.pause, () => media_state.pausePlaying());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.resume, () => media_state.resumePlaying());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.stopToStart, () => stopToStartMidiFile());
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.seek, (seconds) => seekMidi(seconds));
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, (seconds) => {
            setInPoint(seconds);
            this.persistCurrentInOut();
        });
        processIPC.on(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, (seconds) => {
            setOutPoint(seconds);
            this.persistCurrentInOut();
        });
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
        processIPC.onAsync(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.simplifyFile,
            ({filename, algorithm}) => this.simplifyFile(filename, algorithm),
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

    private async playArchiveFile(filename: string) {
        await this.loadAndPlay(filename);
        setPlaybackSourcePlaylistIndex(undefined);
    }

    private async playPlaylistEntry(index: number) {
        const entry = listPlaylist()[index];
        if (!entry) {
            return;
        }
        await this.loadAndPlay(entry.filename);
        setInPoint(entry.inPointSeconds);
        setOutPoint(entry.outPointSeconds);
        setPlaybackSourcePlaylistIndex(index);
    }

    private async loadAndPlay(filename: string) {
        const filePath = getMidiFilePath(filename);
        const bytes = await fs.promises.readFile(filePath);
        const file: DroppedFile = {bytes: [...new Uint8Array(bytes)], name: filename, path: filePath};
        await loadMediaFile(file);
        await media_state.startPlaying();
    }

    // Loads a file into the player and shows it in the now-playing bar without actually starting
    // playback (single-click behavior) - loadMediaFile() alone leaves the generic PlayerActivity
    // wherever it was before (often idle, which would hide the bar), so force it to "paused".
    private async loadOnly(filename: string) {
        const filePath = getMidiFilePath(filename);
        const bytes = await fs.promises.readFile(filePath);
        const file: DroppedFile = {bytes: [...new Uint8Array(bytes)], name: filename, path: filePath};
        await loadMediaFile(file);
        media_state.forcePaused();
    }

    private async loadArchiveFileOnly(filename: string) {
        await this.loadOnly(filename);
        setPlaybackSourcePlaylistIndex(undefined);
    }

    private async loadPlaylistEntryOnly(index: number) {
        const entry = listPlaylist()[index];
        if (!entry) {
            return;
        }
        await this.loadOnly(entry.filename);
        setInPoint(entry.inPointSeconds);
        setOutPoint(entry.outPointSeconds);
        setPlaybackSourcePlaylistIndex(index);
        seekMidi(entry.inPointSeconds);
    }

    private async simplifyFile(filename: string, algorithm: MidiSimplifyAlgorithm) {
        const bytes = await fs.promises.readFile(getMidiFilePath(filename));
        const simplified = simplifyMidiFile(new Uint8Array(bytes), algorithm);
        saveSimplifiedVariant(filename, algorithm, simplified);
        this.sendLibrary();
    }

    // Live in/out edits only have somewhere to persist to when the currently loaded file was
    // launched from a specific playlist entry (see getPlaybackSourcePlaylistIndex) - archive
    // playback plays the full file and doesn't expose in/out editing in the renderer at all, but
    // guard here too in case that ever changes.
    private persistCurrentInOut() {
        const index = getPlaybackSourcePlaylistIndex();
        if (index === undefined) {
            return;
        }
        const playlist = listPlaylist();
        const entry = playlist[index];
        if (!entry) {
            return;
        }
        const state = getMidiPlayerState();
        playlist[index] = {...entry, inPointSeconds: state.inPointSeconds, outPointSeconds: state.outPointSeconds};
        setPlaylist(playlist);
        this.sendPlaylist();
    }
}
