import React from "react";
import {Button, ButtonGroup, Form, Modal} from "react-bootstrap";
import {PauseFill, PlayFill, StopFill} from "react-bootstrap-icons";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil, IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {
    MidiLibraryEntry,
    MidiPlaybackState,
    MidiPlayerState,
    MidiPlaylistEntry,
    MidiPolyphonyClass,
    MidiSimplifyAlgorithm,
} from "../../common/MidiPlaylistTypes";
import {MidiPreviewPlayer} from "../audio/MidiPreviewPlayer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {formatDuration, MidiTimeline} from "./MidiTimeline";

export interface MidiPlaylistPanelProps {
    disabled: boolean;
    coil: CoilID;
}

const MAX_UD3_VOICES = 6;

// This panel is unmounted and rebuilt every time another bottom panel is selected, so anything
// kept in component state resets on a tab switch. For these two that was actively harmful:
// previewMode springing back to "preview locally" left the UI showing and controlling the local
// preview player while the coil kept playing from the main process - the song vanished from the
// now-playing bar and Stop no longer stopped it. Module scope outlives the remount.
let persistedPreviewMode = true;
let persistedAutoPlay = true;

const SIMPLIFY_ALGORITHMS: Array<{ id: MidiSimplifyAlgorithm, label: string, description: string }> = [
    {
        description: 'Keeps only the highest-pitched note at any moment - works well when the melody is the top voice.',
        id: 'melody-top',
        label: 'Highest note (soprano)',
    },
    {
        description: 'Keeps only the lowest-pitched note at any moment - extracts the bass line instead.',
        id: 'melody-bottom',
        label: 'Lowest note (bass)',
    },
    {
        description: 'Keeps only the single track with the most notes, resolving any remaining chords to their top note.',
        id: 'dominant-track',
        label: 'Dominant track',
    },
];

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
    simplifyTarget?: string;
    midiPolyphony: number;
    notesRequested: number;
    notesForwarded: number;
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

// A pending request for the raw bytes of a preview file - autoplay distinguishes a double-click
// (start playing immediately once the bytes arrive) from a single click (just load it, paused).
interface PendingPreview {
    target: PlayTarget;
    autoplay: boolean;
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
    private drag: DragState | undefined;
    private dragGhostEl: HTMLDivElement | undefined;
    private hoverEl: HTMLElement | undefined;
    private pendingPreview: PendingPreview | undefined;
    private clickTimer: ReturnType<typeof setTimeout> | undefined;

    constructor(props: MidiPlaylistPanelProps) {
        super(props);
        this.state = {
            autoPlay: persistedAutoPlay,
            coilState: EMPTY_PLAYER_STATE,
            library: [],
            midiPolyphony: 0,
            notesForwarded: 0,
            notesRequested: 0,
            playlist: [],
            previewMode: persistedPreviewMode,
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
            const pending = this.pendingPreview;
            const target = pending?.target;
            if (!target || (target.kind === 'archive' ? target.filename !== filename
                : this.state.playlist[target.index]?.filename !== filename)) {
                // A late response for a file we've since navigated away from.
                return;
            }
            this.pendingPreview = undefined;
            const method = pending.autoplay ? 'play' : 'load';
            if (target.kind === 'archive') {
                this.previewPlayer[method](new Uint8Array(bytes), filename);
            } else {
                const entry = this.state.playlist[target.index];
                this.previewPlayer[method](
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
        this.addIPCListener(
            getToRenderIPCPerCoil(this.props.coil).sliders.syncSettings,
            (sync) => this.setState({midiPolyphony: sync.midiPolyphony}),
        );
        this.addIPCListener(
            getToRenderIPCPerCoil(this.props.coil).midiNoteCounts,
            ([notesRequested, notesForwarded]) => this.setState({notesForwarded, notesRequested}),
        );
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestLibrary, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylist, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestSavedPlaylists, undefined);
        // This panel is unmounted whenever another bottom panel is selected, so it misses the
        // syncs sent while it was gone - ask for the current value instead of showing a stale one.
        processIPC.send(getToMainIPCPerCoil(this.props.coil).sliders.requestSync, undefined);
        // This component only mounts while the MIDI Playlist tab is the active bottom panel (see
        // SingleCoilTab's conditional render), so a window-level listener here is naturally scoped
        // to "shortcuts active while this tab is visible" without needing extra focus tracking.
        window.addEventListener('keydown', this.onKeyDown);
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.previewPlayer.stop();
        this.endDrag();
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
        }
        window.removeEventListener('keydown', this.onKeyDown);
    }

    private onKeyDown = (ev: KeyboardEvent) => {
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active?.isContentEditable) {
            return;
        }
        if (ev.code === 'Space') {
            ev.preventDefault();
            this.togglePlayPause();
        } else if (ev.key.toLowerCase() === 'w') {
            ev.preventDefault();
            this.stopCurrent();
        } else if (ev.key.toLowerCase() === 'i') {
            ev.preventDefault();
            this.setInPointAtCurrent();
        } else if (ev.key.toLowerCase() === 'o') {
            ev.preventDefault();
            this.setOutPointAtCurrent();
        }
    };

    // I/O only do anything for playlist-launched playback - there's nowhere to persist a trim to
    // for a bare archive play, same reasoning as why the timeline hides its handles there.
    private setInPointAtCurrent() {
        if (this.controlsDisabled()) {
            return;
        }
        const ps = this.currentPlayerState();
        if (ps.sourcePlaylistIndex === undefined) {
            return;
        }
        this.state.previewMode ? this.previewPlayer.setInPoint(ps.positionSeconds)
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, ps.positionSeconds);
    }

    private setOutPointAtCurrent() {
        if (this.controlsDisabled()) {
            return;
        }
        const ps = this.currentPlayerState();
        if (ps.sourcePlaylistIndex === undefined) {
            return;
        }
        this.state.previewMode ? this.previewPlayer.setOutPoint(ps.positionSeconds)
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, ps.positionSeconds);
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
                    onChange={(ev) => {
                        persistedPreviewMode = ev.target.checked;
                        this.setState({previewMode: ev.target.checked});
                    }}
                />
                <Form.Check
                    type={'checkbox'}
                    id={'midi-auto-play'}
                    label={'Auto-play next in playlist'}
                    checked={this.state.autoPlay}
                    onChange={(ev) => {
                        persistedAutoPlay = ev.target.checked;
                        this.setState({autoPlay: ev.target.checked});
                    }}
                />
                {this.makePolyphonyLimitControl()}
            </div>
            {this.makeNowPlaying()}
            <div className={'tt-midi-lists'}>
                {this.makeLibraryColumn()}
                {this.makePlaylistColumn()}
            </div>
            {this.makeSaveDialog()}
            {this.makeSimplifyDialog()}
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

    // Loading (even without playing) still switches the coil's synth mode over MIDI, so it needs
    // the same interaction-lock gating the old per-row Play button had; preview mode never touches
    // the coil at all and stays available regardless.
    private coilLocked(): boolean {
        return !this.state.previewMode && this.props.disabled;
    }

    private playArchiveEntry(filename: string) {
        if (this.coilLocked()) {
            return;
        }
        if (this.state.previewMode) {
            this.pendingPreview = {autoplay: true, target: {filename, kind: 'archive'}};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playArchiveFile, filename);
        }
    }

    private playPlaylistEntry(index: number) {
        const entry = this.state.playlist[index];
        if (!entry || this.coilLocked()) {
            return;
        }
        if (this.state.previewMode) {
            this.pendingPreview = {autoplay: true, target: {index, kind: 'playlist'}};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, entry.filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playPlaylistEntry, index);
        }
    }

    // Single-click behavior: load the song so it shows in the now-playing bar, without starting
    // playback - double-click (playArchiveEntry/playPlaylistEntry above) starts it right away.
    private loadArchiveEntry(filename: string) {
        if (this.coilLocked()) {
            return;
        }
        if (this.state.previewMode) {
            this.pendingPreview = {autoplay: false, target: {filename, kind: 'archive'}};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadArchiveFile, filename);
        }
    }

    private loadPlaylistEntryOnly(index: number) {
        const entry = this.state.playlist[index];
        if (!entry || this.coilLocked()) {
            return;
        }
        if (this.state.previewMode) {
            this.pendingPreview = {autoplay: false, target: {index, kind: 'playlist'}};
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPreviewFile, entry.filename);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.loadPlaylistEntry, index);
        }
    }

    // Standard delayed-click pattern to tell single vs. double clicks apart: a single click is
    // only actually acted on if no second click follows within the window; a double click cancels
    // the pending single-click action and fires immediately instead.
    private onRowClick = (singleFn: () => void) => () => {
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
        }
        this.clickTimer = setTimeout(() => {
            this.clickTimer = undefined;
            singleFn();
        }, 220);
    };

    private onRowDoubleClick = (doubleFn: () => void) => () => {
        if (this.clickTimer) {
            clearTimeout(this.clickTimer);
            this.clickTimer = undefined;
        }
        doubleFn();
    };

    private persistInOut(index: number, inPointSeconds: number, outPointSeconds: number) {
        const entry = this.state.playlist[index];
        if (!entry) {
            return;
        }
        const newPlaylist = [...this.state.playlist];
        newPlaylist[index] = {...entry, inPointSeconds, outPointSeconds};
        this.setPlaylist(newPlaylist);
    }

    // Current playback state regardless of mode - shared by the buttons, the keyboard shortcuts,
    // and the row highlighting.
    private currentPlayerState(): MidiPlayerState {
        return this.state.previewMode ? this.state.previewState : this.state.coilState;
    }

    private controlsDisabled(): boolean {
        // Preview playback never touches the coil, so it should stay controllable even while
        // interaction is otherwise locked (no connection, TR lock, etc.) - only coil transport
        // controls should respect that lock.
        return !this.state.previewMode && this.props.disabled;
    }

    private pauseCurrent() {
        this.state.previewMode ? this.previewPlayer.pause()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.pause, undefined);
    }

    private resumeCurrent() {
        this.state.previewMode ? this.previewPlayer.resume()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.resume, undefined);
    }

    private stopCurrent() {
        this.state.previewMode ? this.previewPlayer.stopToStart()
            : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.stopToStart, undefined);
    }

    private togglePlayPause() {
        if (this.controlsDisabled()) {
            return;
        }
        const ps = this.currentPlayerState();
        if (ps.state === MidiPlaybackState.playing) {
            this.pauseCurrent();
        } else if (ps.state === MidiPlaybackState.paused) {
            this.resumeCurrent();
        }
    }

    private makeNowPlaying() {
        const ps = this.currentPlayerState();
        if (ps.state === MidiPlaybackState.stopped) {
            return <div className={'tt-midi-nowplaying tt-midi-nowplaying-empty'}>No song playing</div>;
        }
        const controlsDisabled = this.controlsDisabled();
        // Nothing has actually played yet from this position (either just loaded, or just
        // rewound via Stop), so "Play" reads better than "Resume", which implies continuing a
        // playback that was paused partway through.
        const atStart = Math.abs(ps.positionSeconds - ps.inPointSeconds) < 0.15;
        return <div className={'tt-midi-nowplaying'}>
            <div className={'tt-midi-nowplaying-row'}>
                <span className={'tt-midi-nowplaying-title'}>{stripExtension(ps.filename || '')}</span>
                <ButtonGroup size={'sm'} className={'tt-midi-nowplaying-controls'}>
                    {ps.state === MidiPlaybackState.playing
                        ? <Button variant={'secondary'} disabled={controlsDisabled} onClick={() => this.pauseCurrent()}>
                            <PauseFill/> Pause
                        </Button>
                        : <Button variant={'secondary'} disabled={controlsDisabled} onClick={() => this.resumeCurrent()}>
                            <PlayFill/> {atStart ? 'Play' : 'Resume'}
                        </Button>}
                    <Button variant={'secondary'} disabled={controlsDisabled} onClick={() => this.stopCurrent()}>
                        <StopFill/> Stop
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
                onSeek={(s) => this.state.previewMode
                    ? this.previewPlayer.seek(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.seek, s)}
                onSetInPoint={(s) => this.state.previewMode
                    ? this.previewPlayer.setInPoint(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setInPoint, s)}
                onSetOutPoint={(s) => this.state.previewMode
                    ? this.previewPlayer.setOutPoint(s)
                    : processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.setOutPoint, s)}
            />
        </div>;
    }

    // Caps how many notes are forwarded to the coil at once. The UD3 only has 6 voices, and once
    // they are all busy it silences its oldest note instantly, with no release envelope - staying
    // below that keeps notes from being chopped off, and thins out the pulse collisions that make
    // dense multi-track files sound rough. Applies to playlist playback and live MIDI input alike.
    private makePolyphonyLimitControl() {
        const options = [<option key={0} value={0}>Off</option>];
        for (let i = 1; i <= MAX_UD3_VOICES; i++) {
            options.push(<option key={i} value={i}>{i}</option>);
        }
        return <div className={'tt-midi-polyphony-limit'}>
            <span title={'The UD3 has 6 voices. Limiting notes here avoids its hard voice stealing.'}>
                Max. notes at once:
            </span>
            <Form.Select
                size={'sm'}
                value={this.state.midiPolyphony}
                onChange={(ev) => {
                    const value = Number(ev.target.value);
                    this.setState({midiPolyphony: value});
                    processIPC.send(getToMainIPCPerCoil(this.props.coil).sliders.setMidiPolyphony, value);
                }}
            >
                {options}
            </Form.Select>
            <span
                className={'tt-midi-note-counter'}
                title={'Notes the file wants to play right now → notes actually sent to the coil'}
            >
                {this.state.notesRequested} → {this.state.notesForwarded}
            </span>
        </div>;
    }

    private makeDot(polyphony: MidiPolyphonyClass) {
        return <span
            className={`tt-midi-dot tt-midi-dot-${polyphony}`}
            title={polyphonyLabel(polyphony)}
        />;
    }

    // The dot only conveys a rough mono/low/high bucket - this is the actual peak count of notes
    // sounding at once, for when that bucket isn't precise enough.
    private makePolyphonyCount(maxPolyphony: number) {
        return <span className={'tt-midi-polyphony-count'} title={'Max. simultaneous notes'}>
            ×{maxPolyphony}
        </span>;
    }

    private makeLibraryColumn() {
        return <div className={'tt-midi-list'}>
            <div className={'tt-midi-list-header'}>Archive ({this.state.library.length})</div>
            <div className={'tt-midi-list-body'} data-mididrop={'library'}>
                {this.state.library.length === 0 && <p className={'tt-midi-list-empty'}>No MIDI files imported yet.</p>}
                {this.state.library.map((entry) => {
                    // Exactly one row across both lists is ever "current" - an archive row only
                    // counts when playback was launched directly from the archive (no playlist
                    // entry involved), so it doesn't also light up while a playlist row is active.
                    const ps = this.currentPlayerState();
                    const isCurrent = ps.filename === entry.filename && ps.sourcePlaylistIndex === undefined &&
                        ps.state !== MidiPlaybackState.stopped;
                    return <div
                        key={entry.filename}
                        className={'tt-midi-row' + (isCurrent ? ' tt-midi-row-current' : '')}
                        onMouseDown={this.beginDrag('library', entry.filename, stripExtension(entry.filename))}
                        onClick={this.onRowClick(() => this.loadArchiveEntry(entry.filename))}
                        onDoubleClick={this.onRowDoubleClick(() => this.playArchiveEntry(entry.filename))}
                    >
                        {this.makeDot(entry.polyphony)}
                        {this.makePolyphonyCount(entry.maxPolyphony)}
                        <span className={'tt-midi-row-name'} title={entry.filename}>
                            {stripExtension(entry.filename)}
                        </span>
                        <span className={'tt-midi-row-duration'}>{formatDuration(entry.durationSeconds)}</span>
                        <Button
                            size={'sm'}
                            variant={'secondary'}
                            title={'Simplify to melody...'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.setState({simplifyTarget: entry.filename});
                            }}
                        >
                            ✨
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'secondary'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.addToPlaylist(entry);
                            }}
                        >
                            +
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'danger'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.deleteLibraryFile(entry.filename);
                            }}
                        >
                            🗑
                        </Button>
                    </div>;
                })}
            </div>
        </div>;
    }

    // Play only ever starts a fresh run from track 1 when nothing is loaded at all - if something
    // is just paused (regardless of which track), it resumes exactly there (same song, same
    // second) rather than restarting the playlist.
    private playOrResumePlaylist() {
        if (this.coilLocked()) {
            return;
        }
        const ps = this.currentPlayerState();
        if (ps.state === MidiPlaybackState.paused) {
            this.resumeCurrent();
            return;
        }
        if (this.state.playlist.length === 0) {
            return;
        }
        if (!this.state.autoPlay) {
            persistedAutoPlay = true;
            this.setState({autoPlay: true});
        }
        this.playPlaylistEntry(0);
    }

    // Unlike the now-playing bar's Stop (which just rewinds whatever's currently loaded to its own
    // start), the playlist's Stop resets all the way back to track 1.
    private stopPlaylist() {
        if (this.coilLocked()) {
            return;
        }
        if (this.state.playlist.length === 0) {
            this.stopCurrent();
            return;
        }
        this.loadPlaylistEntryOnly(0);
    }

    private makePlaylistTransport() {
        const disabled = this.controlsDisabled();
        const ps = this.currentPlayerState();
        const playing = ps.state === MidiPlaybackState.playing;
        return <ButtonGroup size={'sm'} className={'tt-midi-playlist-transport'}>
            {playing
                ? <Button variant={'secondary'} disabled={disabled} title={'Pause'} onClick={() => this.pauseCurrent()}>
                    <PauseFill/>
                </Button>
                : <Button
                    variant={'secondary'}
                    disabled={disabled || (ps.state === MidiPlaybackState.stopped && this.state.playlist.length === 0)}
                    title={ps.state === MidiPlaybackState.paused ? 'Resume' : 'Play playlist from the start'}
                    onClick={() => this.playOrResumePlaylist()}
                >
                    <PlayFill/>
                </Button>}
            <Button variant={'secondary'} disabled={disabled} title={'Stop (back to track 1)'} onClick={() => this.stopPlaylist()}>
                <StopFill/>
            </Button>
        </ButtonGroup>;
    }

    private makePlaylistColumn() {
        return <div className={'tt-midi-list'}>
            <div className={'tt-midi-list-header'}>
                {this.makePlaylistTransport()}
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
                        onClick={this.onRowClick(() => this.loadPlaylistEntryOnly(index))}
                        onDoubleClick={this.onRowDoubleClick(() => this.playPlaylistEntry(index))}
                    >
                        {libraryEntry ? this.makeDot(libraryEntry.polyphony) : <span className={'tt-midi-dot'}/>}
                        {libraryEntry && this.makePolyphonyCount(libraryEntry.maxPolyphony)}
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
                            variant={'secondary'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.moveInPlaylist(index, -1);
                            }}
                        >
                            ▲
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'secondary'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.moveInPlaylist(index, 1);
                            }}
                        >
                            ▼
                        </Button>
                        <Button
                            size={'sm'}
                            variant={'danger'}
                            onClick={(ev) => {
                                ev.stopPropagation();
                                this.removeFromPlaylist(index);
                            }}
                        >
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

    private makeSimplifyDialog() {
        const target = this.state.simplifyTarget;
        return <Modal show={!!target} onHide={() => this.setState({simplifyTarget: undefined})}>
            <Modal.Header closeButton>
                <Modal.Title>Simplify to melody</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                <p>
                    Reduce "{target ? stripExtension(target) : ''}" to its essential melody as a new
                    archive entry. Choose how the notes are picked:
                </p>
                <div className={'tt-midi-simplify-options'}>
                    {SIMPLIFY_ALGORITHMS.map((algo) => (
                        <Button
                            key={algo.id}
                            variant={'secondary'}
                            className={'tt-midi-simplify-option'}
                            onClick={() => this.runSimplify(algo.id)}
                        >
                            <div className={'tt-midi-simplify-option-label'}>{algo.label}</div>
                            <div className={'tt-midi-simplify-option-desc'}>{algo.description}</div>
                        </Button>
                    ))}
                </div>
            </Modal.Body>
            <Modal.Footer>
                <Button variant={'secondary'} onClick={() => this.setState({simplifyTarget: undefined})}>
                    Cancel
                </Button>
            </Modal.Footer>
        </Modal>;
    }

    private runSimplify(algorithm: MidiSimplifyAlgorithm) {
        const filename = this.state.simplifyTarget;
        if (!filename) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.simplifyFile, {algorithm, filename});
        this.setState({simplifyTarget: undefined});
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
        // Without this, moving the mouse after mousedown makes the browser start a native text
        // selection over the row instead of letting our own drag tracking take over.
        ev.preventDefault();
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
