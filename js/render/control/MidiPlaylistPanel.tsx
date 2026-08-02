import React from "react";
import {Button, ButtonGroup, Form} from "react-bootstrap";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {MidiLibraryEntry, MidiPlaybackState, MidiPlayerState, MidiPolyphonyClass} from "../../common/MidiPlaylistTypes";
import {MidiPreviewPlayer} from "../audio/MidiPreviewPlayer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {formatDuration, MidiTimeline} from "./MidiTimeline";

export interface MidiPlaylistPanelProps {
    disabled: boolean;
}

interface MidiPlaylistPanelState {
    library: MidiLibraryEntry[];
    playlist: string[];
    playerState: MidiPlayerState;
    autoPlay: boolean;
    savedPlaylists: string[];
    selectedSavedPlaylist: string;
    previewingFilename?: string;
}

type DragSource = 'library' | 'playlist';

// A single standard "text/plain" payload is used for drag data (rather than a custom MIME type)
// since custom dataTransfer types have been unreliable for getData() on drop in this app's
// Electron/Chromium build - drag would visually work, but the payload came back empty on drop.
function setDragPayload(ev: React.DragEvent, source: DragSource, value: string) {
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', JSON.stringify({source, value}));
}

function getDragPayload(ev: React.DragEvent): { source: DragSource, value: string } | undefined {
    try {
        const raw = ev.dataTransfer.getData('text/plain');
        return raw ? JSON.parse(raw) : undefined;
    } catch (e) {
        return undefined;
    }
}

function stripExtension(filename: string): string {
    return filename.replace(/\.midi?$/i, '');
}

function polyphonyLabel(polyphony: MidiPolyphonyClass): string {
    switch (polyphony) {
        case 'mono':
            return 'mostly monophonic';
        case 'low':
            return 'up to 2-3 notes at once';
        case 'high':
            return 'many notes at once';
    }
}

const EMPTY_PLAYER_STATE: MidiPlayerState = {
    durationSeconds: 0,
    inPointSeconds: 0,
    outPointSeconds: 0,
    positionSeconds: 0,
    state: MidiPlaybackState.stopped,
};

export class MidiPlaylistPanel extends TTComponent<MidiPlaylistPanelProps, MidiPlaylistPanelState> {
    private readonly previewPlayer = new MidiPreviewPlayer();

    constructor(props: MidiPlaylistPanelProps) {
        super(props);
        this.state = {
            autoPlay: false,
            library: [],
            playerState: EMPTY_PLAYER_STATE,
            playlist: [],
            savedPlaylists: [],
            selectedSavedPlaylist: '',
        };
    }

    public componentDidMount() {
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.library, (library) => this.setState({library}));
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playlist, (playlist) => this.setState({playlist}));
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playerState,
            (playerState) => this.setState({playerState}),
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.midiPlaylist.savedPlaylists,
            (savedPlaylists) => this.setState({savedPlaylists}),
        );
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.previewFile, ({filename, bytes}) => {
            if (this.state.previewingFilename !== filename) {
                // A late response for a file we've since stopped/switched away from previewing.
                return;
            }
            this.previewPlayer.play(new Uint8Array(bytes), () => {
                this.setState((s) => (s.previewingFilename === filename ? {previewingFilename: undefined} : null));
            });
        });
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.songEnded, () => this.onSongEnded());
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestLibrary, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylist, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestSavedPlaylists, undefined);
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.previewPlayer.stop();
    }

    public render(): React.ReactNode {
        return <div className={'tt-midi-playlist-panel'}>
            <div className={'tt-midi-toolbar'}>
                <Button
                    size={'sm'}
                    onClick={() => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestImport, undefined)}
                >
                    Import MIDI files...
                </Button>
                <Form.Check
                    type={'checkbox'}
                    id={'midi-auto-play'}
                    label={'Auto-play next in playlist'}
                    checked={this.state.autoPlay}
                    onChange={(ev) => this.setState({autoPlay: ev.target.checked})}
                />
            </div>
            {this.makeNowPlaying()}
            <div className={'tt-midi-lists'}>
                {this.makeLibraryColumn()}
                {this.makePlaylistColumn()}
            </div>
        </div>;
    }

    private onSongEnded() {
        if (!this.state.autoPlay) {
            return;
        }
        const finished = this.state.playerState.filename;
        const index = this.state.playlist.indexOf(finished);
        if (index >= 0 && index + 1 < this.state.playlist.length) {
            this.playFile(this.state.playlist[index + 1]);
        }
    }

    private playFile(filename: string) {
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playFile, filename);
    }

    private togglePreview(filename: string) {
        if (this.state.previewingFilename === filename) {
            this.previewPlayer.stop();
            this.setState({previewingFilename: undefined});
            return;
        }
        this.previewPlayer.stop();
        this.setState({previewingFilename: filename});
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, filename);
    }

    private makePreviewButton(filename: string) {
        const active = this.state.previewingFilename === filename;
        return <Button
            size={'sm'}
            variant={active ? 'warning' : 'secondary'}
            title={'Preview through this PC\'s speakers (not the coil)'}
            onClick={() => this.togglePreview(filename)}
        >
            {active ? '🔊⏹' : '🔊'}
        </Button>;
    }

    private makeNowPlaying() {
        const ps = this.state.playerState;
        if (ps.state === MidiPlaybackState.stopped) {
            return <div className={'tt-midi-nowplaying tt-midi-nowplaying-empty'}>No song playing</div>;
        }
        return <div className={'tt-midi-nowplaying'}>
            <div className={'tt-midi-nowplaying-row'}>
                <span className={'tt-midi-nowplaying-title'}>{stripExtension(ps.filename || '')}</span>
                <ButtonGroup size={'sm'}>
                    {ps.state === MidiPlaybackState.playing
                        ? <Button
                            variant={'secondary'}
                            disabled={this.props.disabled}
                            onClick={() => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.pause, undefined)}
                        >
                            ⏸ Pause
                        </Button>
                        : <Button
                            variant={'secondary'}
                            disabled={this.props.disabled}
                            onClick={() => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.resume, undefined)}
                        >
                            ▶ Resume
                        </Button>}
                    <Button
                        variant={'secondary'}
                        disabled={this.props.disabled}
                        onClick={() => processIPC.send(IPC_CONSTANTS_TO_MAIN.menu.stopMedia, undefined)}
                    >
                        ⏹ Stop
                    </Button>
                </ButtonGroup>
            </div>
            <MidiTimeline
                positionSeconds={ps.positionSeconds}
                durationSeconds={ps.durationSeconds}
                inPointSeconds={ps.inPointSeconds}
                outPointSeconds={ps.outPointSeconds}
                disabled={this.props.disabled}
                onSeek={(s) => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.seek, s)}
                onSetInPoint={(s) => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, s)}
                onSetOutPoint={(s) => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, s)}
            />
        </div>;
    }

    private makeDot(polyphony: MidiPolyphonyClass) {
        return <span
            className={`tt-midi-dot tt-midi-dot-${polyphony}`}
            title={polyphonyLabel(polyphony)}
        />;
    }

    private makeLibraryColumn() {
        return <div className={'tt-midi-list'}>
            <div className={'tt-midi-list-header'}>Archive ({this.state.library.length})</div>
            <div
                className={'tt-midi-list-body'}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={(ev) => this.onDropOnLibrary(ev)}
            >
                {this.state.library.length === 0 && <p className={'tt-midi-list-empty'}>No MIDI files imported yet.</p>}
                {this.state.library.map((entry) => (
                    <div
                        key={entry.filename}
                        className={'tt-midi-row'}
                        draggable={true}
                        onDragStart={(ev) => setDragPayload(ev, 'library', entry.filename)}
                    >
                        {this.makeDot(entry.polyphony)}
                        <span className={'tt-midi-row-name'} title={entry.filename}>
                            {stripExtension(entry.filename)}
                        </span>
                        <span className={'tt-midi-row-duration'}>{formatDuration(entry.durationSeconds)}</span>
                        {this.makePreviewButton(entry.filename)}
                        <Button
                            size={'sm'}
                            variant={'primary'}
                            disabled={this.props.disabled}
                            onClick={() => this.playFile(entry.filename)}
                        >
                            ▶
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'secondary'}
                            onClick={() => this.addToPlaylist(entry.filename)}
                        >
                            +
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'danger'}
                            onClick={() => this.deleteLibraryFile(entry.filename)}
                        >
                            🗑
                        </Button>
                    </div>
                ))}
            </div>
        </div>;
    }

    private makePlaylistColumn() {
        return <div className={'tt-midi-list'}>
            <div className={'tt-midi-list-header'}>
                Current playlist ({this.state.playlist.length})
                {this.makeSavedPlaylistBar()}
            </div>
            <div
                className={'tt-midi-list-body'}
                onDragOver={(ev) => ev.preventDefault()}
                onDrop={(ev) => this.onDropOnPlaylist(ev, this.state.playlist.length)}
            >
                {this.state.playlist.length === 0 &&
                    <p className={'tt-midi-list-empty'}>Drag songs here, or use the + button on the left.</p>}
                {this.state.playlist.map((filename, index) => {
                    const entry = this.state.library.find((e) => e.filename === filename);
                    const isCurrent = this.state.playerState.filename === filename &&
                        this.state.playerState.state !== MidiPlaybackState.stopped;
                    return <div
                        key={index}
                        className={'tt-midi-row' + (isCurrent ? ' tt-midi-row-current' : '')}
                        draggable={true}
                        onDragStart={(ev) => setDragPayload(ev, 'playlist', String(index))}
                        onDragOver={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                        }}
                        onDrop={(ev) => this.onDropOnPlaylist(ev, index)}
                    >
                        {entry ? this.makeDot(entry.polyphony) : <span className={'tt-midi-dot'}/>}
                        <span className={'tt-midi-row-name'} title={filename}>{stripExtension(filename)}</span>
                        <span className={'tt-midi-row-duration'}>
                            {formatDuration(entry?.durationSeconds || 0)}
                        </span>
                        {this.makePreviewButton(filename)}
                        <Button
                            size={'sm'}
                            variant={'primary'}
                            disabled={this.props.disabled}
                            onClick={() => this.playFile(filename)}
                        >
                            ▶
                        </Button>
                        <Button size={'sm'} variant={'secondary'} onClick={() => this.moveInPlaylist(index, -1)}>
                            ▲
                        </Button>
                        <Button size={'sm'} variant={'secondary'} onClick={() => this.moveInPlaylist(index, 1)}>
                            ▼
                        </Button>
                        <Button size={'sm'} variant={'danger'} onClick={() => this.removeFromPlaylist(index)}>
                            ✕
                        </Button>
                    </div>;
                })}
            </div>
        </div>;
    }

    private makeSavedPlaylistBar() {
        return <div className={'tt-midi-saved-bar'}>
            <Form.Select
                size={'sm'}
                value={this.state.selectedSavedPlaylist}
                onChange={(ev) => this.loadSavedPlaylist(ev.target.value)}
            >
                <option value={''}>-- unsaved / new --</option>
                {this.state.savedPlaylists.map((name) => <option key={name} value={name}>{name}</option>)}
            </Form.Select>
            <Button size={'sm'} variant={'secondary'} onClick={() => this.saveCurrentPlaylistAs()}>
                Save as...
            </Button>
            <Button
                size={'sm'}
                variant={'danger'}
                disabled={!this.state.selectedSavedPlaylist}
                onClick={() => this.deleteSavedPlaylist()}
            >
                Delete
            </Button>
        </div>;
    }

    private loadSavedPlaylist(name: string) {
        this.setState({selectedSavedPlaylist: name});
        if (name) {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadSavedPlaylist, name);
        }
    }

    private saveCurrentPlaylistAs() {
        const name = window.prompt('Save current playlist as:', this.state.selectedSavedPlaylist || '');
        if (!name) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.savePlaylistAs, name);
        this.setState({selectedSavedPlaylist: name});
    }

    private deleteSavedPlaylist() {
        const name = this.state.selectedSavedPlaylist;
        if (!name || !window.confirm(`Delete the saved playlist "${name}"? The current playlist stays as-is.`)) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteSavedPlaylist, name);
        this.setState({selectedSavedPlaylist: ''});
    }

    private onDropOnPlaylist(ev: React.DragEvent, targetIndex: number) {
        ev.preventDefault();
        ev.stopPropagation();
        const payload = getDragPayload(ev);
        if (!payload) {
            return;
        }
        const newPlaylist = [...this.state.playlist];
        if (payload.source === 'library') {
            newPlaylist.splice(targetIndex, 0, payload.value);
        } else {
            const fromIndex = Number(payload.value);
            const [item] = newPlaylist.splice(fromIndex, 1);
            const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
            newPlaylist.splice(adjustedTarget, 0, item);
        }
        this.setPlaylist(newPlaylist);
    }

    private onDropOnLibrary(ev: React.DragEvent) {
        ev.preventDefault();
        const payload = getDragPayload(ev);
        if (!payload || payload.source !== 'playlist') {
            return;
        }
        this.removeFromPlaylist(Number(payload.value));
    }

    private addToPlaylist(filename: string) {
        this.setPlaylist([...this.state.playlist, filename]);
    }

    private removeFromPlaylist(index: number) {
        this.setPlaylist(this.state.playlist.filter((_, i) => i !== index));
    }

    private moveInPlaylist(index: number, delta: number) {
        const newIndex = index + delta;
        if (newIndex < 0 || newIndex >= this.state.playlist.length) {
            return;
        }
        const newPlaylist = [...this.state.playlist];
        [newPlaylist[index], newPlaylist[newIndex]] = [newPlaylist[newIndex], newPlaylist[index]];
        this.setPlaylist(newPlaylist);
    }

    private setPlaylist(files: string[]) {
        this.setState({playlist: files});
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setPlaylist, files);
    }

    private deleteLibraryFile(filename: string) {
        if (!window.confirm(`Permanently delete "${filename}" from the MIDI archive?`)) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteLibraryFile, filename);
    }
}
