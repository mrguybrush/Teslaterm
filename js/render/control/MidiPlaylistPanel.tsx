import React from "react";
import {Button, Form, Modal, Table} from "react-bootstrap";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {MidiPlaylistInfo} from "../../common/MidiPlaylistTypes";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";

export interface MidiPlaylistPanelProps {
    disabled: boolean;
}

interface MidiPlaylistPanelState {
    libraryFiles: string[];
    playlists: MidiPlaylistInfo[];
    selectedPlaylistName?: string;
    editingName: string;
    editingFiles: string[];
    fileToAdd: string;
    pendingDelete: boolean;
    autoPlay: boolean;
    currentlyPlayingFile?: string;
}

const NEW_PLAYLIST_KEY = "__new__";

export class MidiPlaylistPanel extends TTComponent<MidiPlaylistPanelProps, MidiPlaylistPanelState> {
    constructor(props: MidiPlaylistPanelProps) {
        super(props);
        this.state = {
            autoPlay: false,
            editingFiles: [],
            editingName: "",
            fileToAdd: "",
            libraryFiles: [],
            pendingDelete: false,
            playlists: [],
            selectedPlaylistName: undefined,
        };
    }

    public componentDidMount() {
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.fileList, (files) => {
            this.setState((s) => ({
                fileToAdd: files.includes(s.fileToAdd) ? s.fileToAdd : (files[0] || ""),
                libraryFiles: files,
            }));
        });
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.playlistList, (playlists) => {
            this.setState({playlists});
        });
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.midiPlaylist.songEnded, () => this.onSongEnded());
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestFileList, undefined);
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestPlaylistList, undefined);
    }

    private onSongEnded() {
        if (!this.state.autoPlay || !this.state.currentlyPlayingFile) {
            return;
        }
        const index = this.state.editingFiles.indexOf(this.state.currentlyPlayingFile);
        if (index >= 0 && index + 1 < this.state.editingFiles.length) {
            this.playTrack(this.state.editingFiles[index + 1]);
        } else {
            this.setState({currentlyPlayingFile: undefined});
        }
    }

    public render(): React.ReactNode {
        return <div className={"tt-midi-playlist-panel"}>
            {this.makeImportSection()}
            {this.makePlaylistSection()}
            {this.makeDeleteModal()}
        </div>;
    }

    private makeImportSection() {
        return <div className={"tt-midi-import-row"}>
            <Button
                size={"sm"}
                onClick={() => processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.requestImport, undefined)}
            >
                Import MIDI files...
            </Button>
            <Button
                size={"sm"}
                variant={"secondary"}
                disabled={this.props.disabled}
                onClick={() => this.stopPlayback()}
            >
                Stop
            </Button>
            <span className={"tt-midi-library-count"}>{this.state.libraryFiles.length} file(s) in library</span>
            <Form.Check
                type={"checkbox"}
                id={"midi-auto-play"}
                label={"Auto-play next"}
                checked={this.state.autoPlay}
                onChange={(ev) => this.setState({autoPlay: ev.target.checked})}
            />
        </div>;
    }

    private selectPlaylist(name: string) {
        if (name === NEW_PLAYLIST_KEY || !name) {
            this.setState({editingFiles: [], editingName: "", selectedPlaylistName: undefined});
            return;
        }
        const playlist = this.state.playlists.find((p) => p.name === name);
        if (playlist) {
            this.setState({
                editingFiles: [...playlist.files],
                editingName: playlist.name,
                selectedPlaylistName: playlist.name,
            });
        }
    }

    private makePlaylistSection() {
        const canSave = this.state.editingName.trim().length > 0;
        const canRename = this.state.selectedPlaylistName !== undefined &&
            this.state.editingName.trim().length > 0 &&
            this.state.editingName.trim() !== this.state.selectedPlaylistName;
        return <div className={"tt-midi-playlist-section"}>
            <Form.Label>Playlist</Form.Label>
            <Form.Select
                size={"sm"}
                value={this.state.selectedPlaylistName || NEW_PLAYLIST_KEY}
                onChange={(ev) => this.selectPlaylist(ev.target.value)}
            >
                <option value={NEW_PLAYLIST_KEY}>-- New playlist --</option>
                {this.state.playlists.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </Form.Select>
            <div className={"tt-midi-name-row"}>
                <Form.Control
                    size={"sm"}
                    placeholder={"Playlist name"}
                    value={this.state.editingName}
                    onChange={(ev) => this.setState({editingName: ev.target.value})}
                />
                <Button size={"sm"} disabled={!canSave} onClick={() => this.savePlaylist()}>Save</Button>
                <Button size={"sm"} disabled={!canRename} onClick={() => this.renamePlaylist()}>Rename</Button>
                <Button
                    size={"sm"}
                    variant={"danger"}
                    disabled={this.state.selectedPlaylistName === undefined}
                    onClick={() => this.setState({pendingDelete: true})}
                >
                    Delete
                </Button>
            </div>
            <div className={"tt-midi-add-row"}>
                <Form.Select
                    size={"sm"}
                    value={this.state.fileToAdd}
                    onChange={(ev) => this.setState({fileToAdd: ev.target.value})}
                >
                    {this.state.libraryFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                </Form.Select>
                <Button
                    size={"sm"}
                    disabled={!this.state.fileToAdd}
                    onClick={() => this.addTrack(this.state.fileToAdd)}
                >
                    Add
                </Button>
                <Button
                    size={"sm"}
                    variant={"danger"}
                    disabled={!this.state.fileToAdd}
                    onClick={() => this.deleteLibraryFile()}
                >
                    Remove
                </Button>
            </div>
            {this.makeTrackTable()}
        </div>;
    }

    private addTrack(filename: string) {
        if (!filename) {
            return;
        }
        this.setState((s) => ({editingFiles: [...s.editingFiles, filename], fileToAdd: filename}));
    }

    private deleteLibraryFile() {
        if (!this.state.fileToAdd) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deleteFile, this.state.fileToAdd);
    }

    private stopPlayback() {
        this.setState({currentlyPlayingFile: undefined});
        processIPC.send(IPC_CONSTANTS_TO_MAIN.menu.stopMedia, undefined);
    }

    private removeTrack(index: number) {
        this.setState((s) => ({editingFiles: s.editingFiles.filter((_, i) => i !== index)}));
    }

    private moveTrack(index: number, delta: number) {
        const newIndex = index + delta;
        if (newIndex < 0 || newIndex >= this.state.editingFiles.length) {
            return;
        }
        const newFiles = [...this.state.editingFiles];
        [newFiles[index], newFiles[newIndex]] = [newFiles[newIndex], newFiles[index]];
        this.setState({editingFiles: newFiles});
    }

    private playTrack(filename: string) {
        this.setState({currentlyPlayingFile: filename});
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.playFile, filename);
    }

    private makeTrackTable() {
        if (this.state.editingFiles.length === 0) {
            return <p>No tracks in this playlist yet.</p>;
        }
        return <Table bordered size={"sm"} className={"tt-midi-track-table"}>
            <tbody>
            {this.state.editingFiles.map((file, index) => (
                <tr key={index}>
                    <td>{file}</td>
                    <td className={"tt-midi-track-actions"}>
                        <Button
                            size={"sm"}
                            variant={"primary"}
                            disabled={this.props.disabled}
                            onClick={() => this.playTrack(file)}
                        >
                            Play
                        </Button>
                        <Button
                            size={"sm"}
                            variant={"secondary"}
                            disabled={this.props.disabled}
                            onClick={() => this.stopPlayback()}
                        >
                            Stop
                        </Button>
                        <Button size={"sm"} variant={"secondary"} onClick={() => this.moveTrack(index, -1)}>
                            ▲
                        </Button>
                        <Button size={"sm"} variant={"secondary"} onClick={() => this.moveTrack(index, 1)}>
                            ▼
                        </Button>
                        <Button size={"sm"} variant={"danger"} onClick={() => this.removeTrack(index)}>
                            Remove
                        </Button>
                    </td>
                </tr>
            ))}
            </tbody>
        </Table>;
    }

    private savePlaylist() {
        const name = this.state.editingName.trim();
        if (!name) {
            return;
        }
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.savePlaylist, {files: this.state.editingFiles, name});
        this.setState({selectedPlaylistName: name});
    }

    private renamePlaylist() {
        const newName = this.state.editingName.trim();
        if (!this.state.selectedPlaylistName || !newName) {
            return;
        }
        processIPC.send(
            IPC_CONSTANTS_TO_MAIN.midiPlaylist.renamePlaylist,
            {newName, oldName: this.state.selectedPlaylistName},
        );
        this.setState({selectedPlaylistName: newName});
    }

    private makeDeleteModal() {
        const cancel = () => this.setState({pendingDelete: false});
        const confirmDelete = () => {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiPlaylist.deletePlaylist, this.state.selectedPlaylistName);
            this.setState({
                editingFiles: [],
                editingName: "",
                pendingDelete: false,
                selectedPlaylistName: undefined,
            });
        };
        return <Modal show={this.state.pendingDelete} onHide={cancel}>
            <Modal.Header>
                <Modal.Title>Delete playlist</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                The playlist "{this.state.selectedPlaylistName}" will be permanently deleted. The MIDI files
                themselves are not affected.
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={cancel}>Cancel</Button>
                <Button variant="danger" onClick={confirmDelete}>Delete</Button>
            </Modal.Footer>
        </Modal>;
    }
}
