import React from "react";
import {Button, ButtonGroup, Form, Modal} from "react-bootstrap";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {
    MidiLibraryEntry,
    MidiPlaybackState,
    MidiPlayerState,
    MidiPlaylistEntry,
    MidiPolyphonyClass,
} from "../../common/MidiPlaylistTypes";
import {MidiPreviewPlayer} from "../audio/MidiPreviewPlayer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {formatDuration, MidiTimeline} from "./MidiTimeline";

export interface MidiPlaylistPanelProps {
    disabled: boolean;
}

interface MidiPlaylistPanelState {
    library: MidiLibraryEntry[];
    playlist: MidiPlaylistEntry[];
    coilState: MidiPlayerState;
    previewState: MidiPlayerState;
    previewMode: boolean;
    autoPlay: boolean;
    savedPlaylists: string[];
    selectedSavedPlaylist: string;
    showSaveDialog: boolean;
    saveDialogName: string;
}

type DragSource = 'library' | 'playlist';

interface DragState {
    source: DragSource;
    value: string;
    label: string;
    startX: number;
    startY: number;
    active: boolean;
}

// What gets loaded when a song is clicked - either a bare archive file (always the full length),
// or a specific playlist entry (its own stored in/out range, editable and persisted back to it).
type PlayTarget = { kind: 'archive', filename: string } | { kind: 'playlist', index: number };

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
    private drag: DragState | undefined;
    private dragGhostEl: HTMLDivElement | undefined;
    private hoverEl: HTMLElement | undefined;
    private pendingPreview: PlayTarget | undefined;

    constructor(props: MidiPlaylistPanelProps) {
        super(props);
        this.state = {
            autoPlay: false,
            coilState: EMPTY_PLAYER_STATE,
            library: [],
            playlist: [],
            previewMode: true,
            previewState: EMPTY_PLAYER_STATE,
            saveDialogName: '',
            savedPlaylists: [],
            selectedSavedPlaylist: '',
            showSaveDialog: false,
        };
    }

    public componentDidMount() {
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.library, (library) => this.setState({library}));
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playlist, (playlist) => this.setState({playlist}));
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playerState,
            (coilState) => this.setState({coilState}),
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.midiPlaylist.savedPlaylists,
            (savedPlaylists) => this.setState({savedPlaylists}),
        );
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.previewFile, ({filename, bytes}) => {
            const target = this.pendingPreview;
            if (!target || (target.kind === 'archive' ? target.filename !== filename
                : this.state.playlist[target.index]?.filename !== filename)) {
                // A late response for a file we've since navigated away from.
                return;
            }
            this.pendingPreview = undefined;
            if (target.kind === 'archive') {
                this.previewPlayer.play(new Uint8Array(bytes), filename);
            } else {
                const entry = this.state.playlist[target.index];
                this.previewPlayer.play(
                    new Uint8Array(bytes), filename, target.index, entry.inPointSeconds, entry.outPointSeconds,
                );
            }
        });
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.songEnded, () => this.onSongEnded(false));
        this.previewPlayer.setListeners(
            (previewState) => this.setState({previewState}),
            () => this.onSongEnded(true),
            (index, inPointSeconds, outPointSeconds) => this.persistInOut(index, inPointSeconds, outPointSeconds),
        );
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestLibrary, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylist, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestSavedPlaylists, undefined);
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.previewPlayer.stop();
        this.endDrag();
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
                    type={'switch'}
                    id={'midi-preview-mode'}
                    label={this.state.previewMode
                        ? 'Preview locally (not sent to the coil)'
                        : 'Sending to the coil'}
                    checked={this.state.previewMode}
                    onChange={(ev) => this.setState({previewMode: ev.target.checked})}
                />
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
            {this.makeSaveDialog()}
        </div>;
    }

    private onSongEnded(fromPreview: boolean) {
        if (!this.state.autoPlay || fromPreview !== this.state.previewMode) {
            return;
        }
        const ps = this.state.previewMode ? this.state.previewState : this.state.coilState;
        const index = ps.sourcePlaylistIndex;
        if (index !== undefined && index + 1 < this.state.playlist.length) {
            this.playPlaylistEntry(index + 1);
        }
    }

    private playArchiveEntry(filename: string) {
        if (this.state.previewMode) {
            this.pendingPreview = {filename, kind: 'archive'};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playArchiveFile, filename);
        }
    }

    private playPlaylistEntry(index: number) {
        const entry = this.state.playlist[index];
        if (!entry) {
            return;
        }
        if (this.state.previewMode) {
            this.pendingPreview = {index, kind: 'playlist'};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, entry.filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playPlaylistEntry, index);
        }
    }

    private persistInOut(index: number, inPointSeconds: number, outPointSeconds: number) {
        const entry = this.state.playlist[index];
        if (!entry) {
            return;
        }
        const newPlaylist = [...this.state.playlist];
        newPlaylist[index] = {...entry, inPointSeconds, outPointSeconds};
        this.setPlaylist(newPlaylist);
    }

    private makeNowPlaying() {
        const preview = this.state.previewMode;
        const ps = preview ? this.state.previewState : this.state.coilState;
        if (ps.state === MidiPlaybackState.stopped) {
            return <div className={'tt-midi-nowplaying tt-midi-nowplaying-empty'}>No song playing</div>;
        }
        // Preview playback never touches the coil, so it should stay controllable even while
        // interaction is otherwise locked (no connection, TR lock, etc.) - only coil transport
        // controls should respect that lock.
        const controlsDisabled = !preview && this.props.disabled;
        const pause = () => preview ? this.previewPlayer.pause()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.pause, undefined);
        const resume = () => preview ? this.previewPlayer.resume()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.resume, undefined);
        const stop = () => preview ? this.previewPlayer.stop()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.menu.stopMedia, undefined);
        return <div className={'tt-midi-nowplaying'}>
            <div className={'tt-midi-nowplaying-row'}>
                <span className={'tt-midi-nowplaying-title'}>{stripExtension(ps.filename || '')}</span>
                <ButtonGroup size={'sm'}>
                    {ps.state === MidiPlaybackState.playing
                        ? <Button variant={'secondary'} disabled={controlsDisabled} onClick={pause}>
                            ⏸ Pause
                        </Button>
                        : <Button variant={'secondary'} disabled={controlsDisabled} onClick={resume}>
                            ▶ Resume
                        </Button>}
                    <Button variant={'secondary'} disabled={controlsDisabled} onClick={stop}>
                        ⏹ Stop
                    </Button>
                </ButtonGroup>
            </div>
            <MidiTimeline
                positionSeconds={ps.positionSeconds}
                durationSeconds={ps.durationSeconds}
                inPointSeconds={ps.inPointSeconds}
                outPointSeconds={ps.outPointSeconds}
                disabled={controlsDisabled}
                editableRange={ps.sourcePlaylistIndex !== undefined}
                onSeek={(s) => preview
                    ? this.previewPlayer.seek(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.seek, s)}
                onSetInPoint={(s) => preview
                    ? this.previewPlayer.setInPoint(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, s)}
                onSetOutPoint={(s) => preview
                    ? this.previewPlayer.setOutPoint(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, s)}
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
            <div className={'tt-midi-list-body'} data-mididrop={'library'}>
                {this.state.library.length === 0 && <p className={'tt-midi-list-empty'}>No MIDI files imported yet.</p>}
                {this.state.library.map((entry) => (
                    <div
                        key={entry.filename}
                        className={'tt-midi-row'}
                        onMouseDown={this.beginDrag('library', entry.filename, stripExtension(entry.filename))}
                    >
                        {this.makeDot(entry.polyphony)}
                        <span className={'tt-midi-row-name'} title={entry.filename}>
                            {stripExtension(entry.filename)}
                        </span>
                        <span className={'tt-midi-row-duration'}>{formatDuration(entry.durationSeconds)}</span>
                        <Button
                            size={'sm'}
                            variant={'primary'}
                            disabled={!this.state.previewMode && this.props.disabled}
                            onClick={() => this.playArchiveEntry(entry.filename)}
                        >
                            ▶
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'secondary'}
                            onClick={() => this.addToPlaylist(entry)}
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
            <div className={'tt-midi-list-body'} data-mididrop={'playlist'}>
                {this.state.playlist.length === 0 &&
                    <p className={'tt-midi-list-empty'}>Drag songs here, or use the + button on the left.</p>}
                {this.state.playlist.map((entry, index) => {
                    const libraryEntry = this.state.library.find((e) => e.filename === entry.filename);
                    const coilCurrent = !this.state.previewMode && this.state.coilState.sourcePlaylistIndex === index &&
                        this.state.coilState.state !== MidiPlaybackState.stopped;
                    const previewCurrent = this.state.previewMode &&
                        this.state.previewState.sourcePlaylistIndex === index &&
                        this.state.previewState.state !== MidiPlaybackState.stopped;
                    const isCurrent = coilCurrent || previewCurrent;
                    const clipSeconds = Math.max(0, entry.outPointSeconds - entry.inPointSeconds);
                    const isTrimmed = libraryEntry !== undefined &&
                        (entry.inPointSeconds > 0.01 || entry.outPointSeconds < libraryEntry.durationSeconds - 0.01);
                    return <div
                        key={index}
                        className={'tt-midi-row' + (isCurrent ? ' tt-midi-row-current' : '')}
                        data-mididrop={'playlist-row'}
                        data-index={index}
                        onMouseDown={this.beginDrag('playlist', String(index), stripExtension(entry.filename))}
                    >
                        {libraryEntry ? this.makeDot(libraryEntry.polyphony) : <span className={'tt-midi-dot'}/>}
                        <span className={'tt-midi-row-name'} title={entry.filename}>
                            {stripExtension(entry.filename)}
                        </span>
                        <span
                            className={'tt-midi-row-duration'}
                            title={isTrimmed ? `Trimmed clip (full song: ${formatDuration(libraryEntry.durationSeconds)})` : undefined}
                        >
                            {isTrimmed ? '✂ ' : ''}{formatDuration(clipSeconds)}
                        </span>
                        <Button
                            size={'sm'}
                            variant={'primary'}
                            disabled={!this.state.previewMode && this.props.disabled}
                            onClick={() => this.playPlaylistEntry(index)}
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
            <Button size={'sm'} variant={'secondary'} onClick={() => this.openSaveDialog()}>
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

    private makeSaveDialog() {
        const name = this.state.saveDialogName.trim();
        const confirm = () => {
            if (!name) {
                return;
            }
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.savePlaylistAs, name);
            this.setState({selectedSavedPlaylist: name, showSaveDialog: false});
        };
        return <Modal show={this.state.showSaveDialog} onHide={() => this.setState({showSaveDialog: false})}>
            <Modal.Header closeButton>
                <Modal.Title>Save playlist as</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <Form.Control
                    autoFocus={true}
                    placeholder={'Playlist name'}
                    value={this.state.saveDialogName}
                    onChange={(ev) => this.setState({saveDialogName: ev.target.value})}
                    onKeyDown={(ev) => {
                        if (ev.key === 'Enter') {
                            confirm();
                        }
                    }}
                />
            </Modal.Body>
            <Modal.Footer>
                <Button variant={'secondary'} onClick={() => this.setState({showSaveDialog: false})}>Cancel</Button>
                <Button variant={'primary'} disabled={!name} onClick={confirm}>Save</Button>
            </Modal.Footer>
        </Modal>;
    }

    private openSaveDialog() {
        this.setState({saveDialogName: this.state.selectedSavedPlaylist || '', showSaveDialog: true});
    }

    private loadSavedPlaylist(name: string) {
        this.setState({selectedSavedPlaylist: name});
        if (name) {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadSavedPlaylist, name);
        } else {
            // "-- unsaved / new --" starts a fresh, empty working playlist rather than just
            // deselecting while leaving the previous playlist's contents in place.
            this.setPlaylist([]);
        }
    }

    private deleteSavedPlaylist() {
        const name = this.state.selectedSavedPlaylist;
        if (!name || !window.confirm(`Delete the saved playlist "${name}"? The current playlist stays as-is.`)) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteSavedPlaylist, name);
        this.setState({selectedSavedPlaylist: ''});
    }

    // Plain mouse-tracked drag & drop instead of the native HTML5 DnD API - dataTransfer.getData()
    // was coming back empty on drop in this app's Electron build even with a standard MIME type,
    // so dragging visually worked but dropping silently did nothing. Hit-testing via
    // elementFromPoint against data-mididrop markers sidesteps the native DnD stack entirely.
    private beginDrag = (source: DragSource, value: string, label: string) => (ev: React.MouseEvent) => {
        if (ev.button !== 0 || (ev.target as HTMLElement).closest('button')) {
            return;
        }
        this.drag = {active: false, label, source, startX: ev.clientX, startY: ev.clientY, value};
        window.addEventListener('mousemove', this.onDragMove);
        window.addEventListener('mouseup', this.onDragUp);
    };

    private onDragMove = (ev: MouseEvent) => {
        const drag = this.drag;
        if (!drag) {
            return;
        }
        if (!drag.active) {
            if (Math.hypot(ev.clientX - drag.startX, ev.clientY - drag.startY) < 5) {
                return;
            }
            drag.active = true;
            this.createGhost(drag.label);
            document.body.style.cursor = 'grabbing';
        }
        this.moveGhost(ev.clientX, ev.clientY);
        this.updateHover(ev.clientX, ev.clientY);
    };

    private onDragUp = (ev: MouseEvent) => {
        const drag = this.drag;
        this.endDrag();
        if (!drag || !drag.active) {
            return;
        }
        const target = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)
            ?.closest('[data-mididrop]') as HTMLElement | null;
        if (!target) {
            return;
        }
        const zone = target.dataset.mididrop;
        if (zone === 'playlist-row') {
            this.applyDrop(drag.source, drag.value, Number(target.dataset.index));
        } else if (zone === 'playlist') {
            this.applyDrop(drag.source, drag.value, this.state.playlist.length);
        } else if (zone === 'library' && drag.source === 'playlist') {
            this.removeFromPlaylist(Number(drag.value));
        }
    };

    private endDrag() {
        this.drag = undefined;
        window.removeEventListener('mousemove', this.onDragMove);
        window.removeEventListener('mouseup', this.onDragUp);
        document.body.style.cursor = '';
        this.destroyGhost();
        this.clearHover();
    }

    private applyDrop(source: DragSource, value: string, targetIndex: number) {
        const newPlaylist = [...this.state.playlist];
        if (source === 'library') {
            const libraryEntry = this.state.library.find((e) => e.filename === value);
            newPlaylist.splice(targetIndex, 0, this.makeEntry(value, libraryEntry?.durationSeconds || 0));
        } else {
            const fromIndex = Number(value);
            const [item] = newPlaylist.splice(fromIndex, 1);
            const adjustedTarget = fromIndex < targetIndex ? targetIndex - 1 : targetIndex;
            newPlaylist.splice(adjustedTarget, 0, item);
        }
        this.setPlaylist(newPlaylist);
    }

    private createGhost(label: string) {
        const el = document.createElement('div');
        el.className = 'tt-midi-drag-ghost';
        el.textContent = label;
        document.body.appendChild(el);
        this.dragGhostEl = el;
    }

    private moveGhost(x: number, y: number) {
        if (this.dragGhostEl) {
            this.dragGhostEl.style.left = `${x + 12}px`;
            this.dragGhostEl.style.top = `${y + 12}px`;
        }
    }

    private destroyGhost() {
        this.dragGhostEl?.remove();
        this.dragGhostEl = undefined;
    }

    private updateHover(x: number, y: number) {
        const target = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('[data-mididrop]') as
            HTMLElement | null;
        if (target === this.hoverEl) {
            return;
        }
        this.clearHover();
        if (target) {
            target.classList.add('tt-midi-drop-hover');
            this.hoverEl = target;
        }
    }

    private clearHover() {
        this.hoverEl?.classList.remove('tt-midi-drop-hover');
        this.hoverEl = undefined;
    }

    private makeEntry(filename: string, durationSeconds: number): MidiPlaylistEntry {
        return {filename, inPointSeconds: 0, outPointSeconds: durationSeconds};
    }

    private addToPlaylist(entry: MidiLibraryEntry) {
        this.setPlaylist([...this.state.playlist, this.makeEntry(entry.filename, entry.durationSeconds)]);
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

    private setPlaylist(entries: MidiPlaylistEntry[]) {
        this.setState({playlist: entries});
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setPlaylist, entries);
    }

    private deleteLibraryFile(filename: string) {
        if (!window.confirm(`Permanently delete "${filename}" from the MIDI archive?`)) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteLibraryFile, filename);
    }
}
