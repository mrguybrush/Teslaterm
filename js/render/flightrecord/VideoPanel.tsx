import React from "react";
import {Button, Form} from "react-bootstrap";
import {pathToFileURL} from "url";
import {FlightSessionInfo} from "../../common/FlightRecorderTypes";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil, IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {SyncedUIConfig} from "../../common/UIConfig";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {flightVideoRecorder} from "./VideoRecorder";
import {webcamManager} from "./WebcamManager";

export interface VideoPanelProps {
    config: SyncedUIConfig;
    coil: CoilID;
}

interface VideoPanelState {
    cameras: MediaDeviceInfo[];
    previewOn: boolean;
    // Video capture state, which can lag the session slightly while the camera opens.
    recording: boolean;
    // Whether a flight recording session is running at all.
    sessionActive: boolean;
    sessions: FlightSessionInfo[];
    playingVideoPath?: string;
    error?: string;
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
}

export class VideoPanel extends TTComponent<VideoPanelProps, VideoPanelState> {
    private readonly previewRef = React.createRef<HTMLVideoElement>();
    private unsubscribeStream?: () => void;
    private unsubscribeRecorder?: () => void;

    public constructor(props: VideoPanelProps) {
        super(props);
        this.state = {
            cameras: [],
            // The camera keeps running across tab switches, so a preview that was on before is
            // still on now - reflect the real state rather than assuming it starts off.
            previewOn: webcamManager.isActive(),
            recording: flightVideoRecorder.recording,
            sessionActive: false,
            sessions: [],
        };
    }

    public componentDidMount() {
        this.unsubscribeStream = webcamManager.subscribe(() => {
            this.setState({previewOn: webcamManager.isActive()});
            this.attachPreview();
        });
        this.unsubscribeRecorder = flightVideoRecorder.subscribe(
            () => this.setState({recording: flightVideoRecorder.recording}),
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionList,
            (sessions) => this.setState({sessions}),
        );
        this.addIPCListener(
            getToRenderIPCPerCoil(this.props.coil).flightRecorderActive,
            (sessionActive) => {
                this.setState({sessionActive});
                // A session that just ended has a new video to list.
                if (!sessionActive) {
                    processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.requestSessionList, undefined);
                }
            },
        );
        processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.requestSessionList, undefined);
        // The panel is remounted on every tab switch, so it has to ask rather than assume a
        // recording started before it was open is not running.
        processIPC.send(getToMainIPCPerCoil(this.props.coil).flightRecorder.requestState, undefined);
        this.refreshCameras();
        this.attachPreview();
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.unsubscribeStream?.();
        this.unsubscribeRecorder?.();
        // Deliberately not releasing the camera here: leaving the tab must not interrupt a preview
        // the user switched on, and never a running recording. Only the explicit toggle releases.
    }

    public componentDidUpdate() {
        this.attachPreview();
    }

    public render(): React.ReactNode {
        return <div className={'tt-video-panel'}>
            <div className={'tt-video-panel-controls'}>
                {this.makeRecordingIndicator()}
                <Button
                    size={'sm'}
                    variant={'danger'}
                    disabled={this.state.sessionActive}
                    onClick={() => processIPC.send(
                        getToMainIPCPerCoil(this.props.coil).flightRecorder.startRecording, undefined,
                    )}
                >
                    Record
                </Button>
                <Button
                    size={'sm'}
                    variant={'secondary'}
                    disabled={!this.state.sessionActive}
                    onClick={() => processIPC.send(
                        getToMainIPCPerCoil(this.props.coil).flightRecorder.stopRecording, undefined,
                    )}
                >
                    Stop
                </Button>
                <Form.Check
                    type={'checkbox'}
                    id={'video-record-video'}
                    label={'Include webcam video'}
                    checked={this.props.config.recordVideo}
                    onChange={(ev) => processIPC.send(IPC_CONSTANTS_TO_MAIN.setRecordVideo, ev.target.checked)}
                />
                {this.makeCameraSelect()}
                <Button
                    size={'sm'}
                    variant={this.state.previewOn ? 'primary' : 'secondary'}
                    onClick={() => this.togglePreview()}
                >
                    {this.state.previewOn ? 'Stop preview' : 'Start preview'}
                </Button>
                {this.state.error && <span className={'tt-video-panel-error'}>{this.state.error}</span>}
            </div>
            <div className={'tt-video-panel-body'}>
                {this.makePreview()}
                {this.makeRecordingList()}
            </div>
        </div>;
    }

    private makeRecordingIndicator() {
        if (!this.state.sessionActive) {
            return <span className={'tt-video-idle'}>Not recording</span>;
        }
        return <span className={'tt-video-recording'}>
            <span className={'tt-video-recording-dot'}/>
            {this.state.recording ? 'Recording + video' : 'Recording'}
        </span>;
    }

    private makeCameraSelect() {
        return <Form.Select
            size={'sm'}
            className={'tt-video-camera-select'}
            value={this.props.config.videoDeviceId}
            onChange={(ev) => this.selectCamera(ev.target.value)}
        >
            <option value={''}>Default camera</option>
            {this.state.cameras.map((camera, index) => (
                <option key={camera.deviceId} value={camera.deviceId}>
                    {camera.label || `Camera ${index + 1}`}
                </option>
            ))}
        </Form.Select>;
    }

    private makePreview() {
        return <div className={'tt-video-preview'}>
            <video
                ref={this.previewRef}
                className={'tt-video-preview-element'}
                autoPlay={true}
                playsInline={true}
                // Without this the preview would feed the microphone straight back to the speakers.
                muted={true}
            />
            {!this.state.previewOn &&
                <p className={'tt-video-preview-hint'}>Preview is off. Recording works either way.</p>}
        </div>;
    }

    private makeRecordingList() {
        const withVideo = this.state.sessions.filter((session) => session.videoPath);
        return <div className={'tt-video-list'}>
            <div className={'tt-video-list-header'}>Recorded videos ({withVideo.length})</div>
            <div className={'tt-video-list-body'}>
                {withVideo.length === 0 && <p className={'tt-video-list-empty'}>No session videos yet.</p>}
                {withVideo.map((session) => (
                    <div className={'tt-video-list-row'} key={session.filename}>
                        <span className={'tt-video-list-name'}>{formatDate(session.startIso)}</span>
                        <Button
                            size={'sm'}
                            variant={this.state.playingVideoPath === session.videoPath ? 'primary' : 'secondary'}
                            onClick={() => this.setState({playingVideoPath: session.videoPath})}
                        >
                            Play
                        </Button>
                    </div>
                ))}
            </div>
            {this.state.playingVideoPath && <video
                className={'tt-video-playback'}
                src={pathToFileURL(this.state.playingVideoPath).toString()}
                controls={true}
                autoPlay={true}
            />}
        </div>;
    }

    private async refreshCameras() {
        try {
            this.setState({cameras: await webcamManager.listCameras()});
        } catch (e) {
            console.error('Listing cameras', e);
        }
    }

    private async selectCamera(deviceId: string) {
        processIPC.send(IPC_CONSTANTS_TO_MAIN.setVideoDeviceId, deviceId);
        try {
            await webcamManager.setDeviceId(deviceId);
        } catch (e) {
            this.setState({error: `Could not switch camera: ${e?.message || e}`});
        }
    }

    private async togglePreview() {
        if (this.state.previewOn) {
            webcamManager.release('preview');
            this.setState({error: undefined});
            return;
        }
        try {
            await webcamManager.acquire('preview');
            this.setState({error: undefined});
            // Labels are only exposed once camera permission has been granted, so the list is
            // worth rebuilding now that it has been.
            await this.refreshCameras();
        } catch (e) {
            this.setState({error: `Could not open the camera: ${e?.message || e}`});
        }
    }

    private attachPreview() {
        const video = this.previewRef.current;
        if (!video) {
            return;
        }
        const stream = webcamManager.getStream();
        if (video.srcObject !== (stream || null)) {
            video.srcObject = stream || null;
        }
    }
}
