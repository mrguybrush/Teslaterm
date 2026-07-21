import React from "react";
import {Button, Modal, Table} from "react-bootstrap";
import {FlightSessionInfo} from "../../common/FlightRecorderTypes";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {FRDisplayData} from "../connect/ConnectScreen";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";

export interface FlightSessionsScreenProps {
    close: () => any;
    openRecording: (data: FRDisplayData) => any;
}

interface FlightSessionsScreenState {
    sessions: FlightSessionInfo[];
    pendingDelete?: FlightSessionInfo;
}

function formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes + ':' + seconds.toString().padStart(2, '0');
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
}

export class FlightSessionsScreen extends TTComponent<FlightSessionsScreenProps, FlightSessionsScreenState> {
    constructor(props: FlightSessionsScreenProps) {
        super(props);
        this.state = {sessions: []};
    }

    public componentDidMount() {
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionList,
            (sessions) => this.setState({sessions}),
        );
        this.requestSessions();
    }

    public render(): React.ReactNode {
        return <div className={'tt-flight-sessions-screen'}>
            <h3>Flight Sessions</h3>
            {this.makeTable()}
            <Button onClick={this.props.close}>Close</Button>
            {this.makeDeleteModal()}
        </div>;
    }

    private requestSessions() {
        processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.requestSessionList, undefined);
    }

    private makeTable() {
        if (this.state.sessions.length === 0) {
            return <p>No recorded sessions yet.</p>;
        }
        return <Table bordered className={'tt-flight-sessions-table'}>
            <thead>
            <tr>
                <th>Start</th>
                <th>Coil</th>
                <th>Duration</th>
                <th>Actions</th>
            </tr>
            </thead>
            <tbody>
            {this.state.sessions.map((session) => this.makeRow(session))}
            </tbody>
        </Table>;
    }

    private makeRow(session: FlightSessionInfo) {
        return <tr key={session.filename}>
            <td>{formatDate(session.startIso)}</td>
            <td>{session.coilName || ('Coil ' + session.coil)}</td>
            <td>{formatDuration(session.durationMs)}</td>
            <td>
                <Button size={'sm'} variant={'primary'} onClick={() => this.viewSession(session)}>
                    View
                </Button>{' '}
                <Button size={'sm'} variant={'secondary'} onClick={() => this.exportSession(session)}>
                    Export
                </Button>{' '}
                <Button size={'sm'} variant={'danger'} onClick={() => this.setState({pendingDelete: session})}>
                    Delete
                </Button>
            </td>
        </tr>;
    }

    private viewSession(session: FlightSessionInfo) {
        processIPC.once(IPC_CONSTANTS_TO_RENDERER.flightRecorder.fullList, (data) => {
            this.props.openRecording(data);
        });
        processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.openSession, session.filename);
    }

    private exportSession(session: FlightSessionInfo) {
        processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.exportSession, session.filename);
    }

    private makeDeleteModal() {
        const cancel = () => this.setState({pendingDelete: undefined});
        const confirmDelete = () => {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.deleteSession, this.state.pendingDelete.filename);
            this.setState({pendingDelete: undefined});
        };
        return <Modal show={this.state.pendingDelete !== undefined} onHide={cancel}>
            <Modal.Header>
                <Modal.Title>Delete session</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                This flight recording will be permanently deleted.
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={cancel}>Cancel</Button>
                <Button variant="danger" onClick={confirmDelete}>Delete</Button>
            </Modal.Footer>
        </Modal>;
    }
}
