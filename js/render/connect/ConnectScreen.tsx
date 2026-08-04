import {shell} from "electron";
import React from "react";
import {Button, Form, Modal, Toast, ToastContainer} from "react-bootstrap";
import {UD3ConnectionType} from "../../common/constants";
import {InitialFRState, ParsedEvent} from "../../common/FlightRecorderTypes";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../../common/IPCConstantsToRenderer";
import {AdvancedOptions} from "../../common/Options";
import {
    SerialConnectionOptions,
    UD3ConnectionOptions,
    UDPConnectionOptions,
} from "../../common/SingleConnectionOptions";
import {SyncedUIConfig} from "../../common/UIConfig";
import {processIPC} from "../ipc/IPCProvider";
import {DEFAULT_SCOPE_BACKGROUND, DEFAULT_SCOPE_GRID_LINE, DEFAULT_TRACE_COLORS} from "../control/scope/ScopeColors";
import {ScreenWithDrop} from "../ScreenWithDrop";
import {ConnectForm} from "./ConnectForm";
import {ConnectionPresets} from "./ConnectionPresets";

export interface MergedConnectionOptions extends SerialConnectionOptions, UDPConnectionOptions {
    currentType: UD3ConnectionType;
}

export function areOptionsValid(options: MergedConnectionOptions): boolean {
    const isNonEmpty = (toCheck: string) => toCheck.trim().length > 0;
    switch (options.currentType) {
        case UD3ConnectionType.udp_min:
            return isNonEmpty(options.remoteIP) && options.udpMinPort > 0;
        case UD3ConnectionType.serial_min:
        case UD3ConnectionType.serial_plain:
            if (options.autoconnect) {
                return isNonEmpty(options.autoVendorID) && isNonEmpty(options.autoProductID);
            } else {
                return isNonEmpty(options.serialPort);
            }
    }
}

export function toSingleOptions(merged: MergedConnectionOptions): UD3ConnectionOptions {
    switch (merged.currentType) {
        case UD3ConnectionType.udp_min:
            return {
                connectionType: merged.currentType,
                options: {
                    remoteDesc: merged.remoteDesc,
                    remoteIP: merged.remoteIP,
                    udpMinPort: merged.udpMinPort,
                    useDesc: merged.useDesc,
                },
            };
        case UD3ConnectionType.serial_min:
        case UD3ConnectionType.serial_plain:
            return {
                connectionType: merged.currentType,
                options: {
                    autoProductID: merged.autoProductID,
                    autoVendorID: merged.autoVendorID,
                    autoconnect: merged.autoconnect,
                    baudrate: merged.baudrate,
                    serialPort: merged.serialPort,
                },
            };
    }
}

interface ConnectScreenState {
    error: string;
    showingError: boolean;

    currentOptions: MergedConnectionOptions;
    currentAdvancedOptions: AdvancedOptions;

    windowSizeJustSaved: boolean;
    showingSettings: boolean;

    updateCheckMessage?: string;
    updateCheckIsError: boolean;
    updateAvailable: boolean;
    updateReleaseNotes?: string;
}

export interface FRDisplayData {
    events: ParsedEvent[];
    initial: InitialFRState;
}

export interface ConnectScreenProps {
    config: SyncedUIConfig;
    connecting: boolean;
    setDarkMode: (newVal: boolean) => void;
    setAutoFlightRecording: (newVal: boolean) => void;
    setWindowSizeToCurrent: () => void;
    setSliderSize: (newVal: number) => void;
    setVoltagePhases: (newVal: number) => void;
    setScopeBackgroundColor: (newVal: string) => void;
    setScopeGridColor: (newVal: string) => void;
    setScopeTraceColors: (newVal: string[]) => void;
    openFlightRecording: (data: FRDisplayData) => any;
    openFlightSessions: () => any;
}

export class ConnectScreen extends ScreenWithDrop<ConnectScreenProps, ConnectScreenState> {
    private windowSizeSavedTimeout: ReturnType<typeof setTimeout>;

    constructor(props: ConnectScreenProps) {
        super(props);
        const connectOptions = this.props.config.lastConnectOptions;
        console.log(connectOptions);
        this.state = {
            currentAdvancedOptions: this.props.config.advancedOptions,
            currentOptions: {
                currentType: connectOptions.type,
                ...connectOptions.udpOptions,
                ...connectOptions.serialOptions,
            },
            error: '',
            showingError: false,
            showingSettings: false,
            updateAvailable: false,
            updateCheckIsError: false,
            windowSizeJustSaved: false,
        };
    }

    public componentDidMount() {
        super.componentDidMount();
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.updateCheckStatus, (status) => {
            this.setState({
                updateAvailable: status.updateAvailable,
                updateCheckIsError: status.isError,
                updateCheckMessage: status.message,
                updateReleaseNotes: status.releaseNotes,
            });
        });
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        clearTimeout(this.windowSizeSavedTimeout);
    }

    public render(): React.ReactNode {
        const setOptions = (opts: Partial<MergedConnectionOptions>) => this.setState(
            (oldState) => ({currentOptions: {...oldState.currentOptions, ...opts}}),
        );
        const setAdvancedOptions = (opts: Partial<AdvancedOptions>) => this.setState(
            (oldState) => ({currentAdvancedOptions: {...oldState.currentAdvancedOptions, ...opts}}),
        );
        return <div className={'tt-connect-screen'} ref={this.mainDivRef}>
            <ConnectForm
                currentOptions={this.state.currentOptions}
                currentAdvancedOptions={this.state.currentAdvancedOptions}
                setOptions={setOptions}
                setAdvancedOptions={setAdvancedOptions}
                connecting={this.props.connecting}
            />
            <div className={'tt-connect-sidebar'}>
                <ConnectionPresets
                    mainAdvanced={this.state.currentAdvancedOptions}
                    setMainAdvanced={setAdvancedOptions}
                    mainOptions={this.state.currentOptions}
                    setMainOptions={setOptions}
                    connecting={this.props.connecting}
                    presets={this.props.config.connectionPresets}
                />
                <Form.Check
                    type={'checkbox'}
                    id={'auto-flight-recording'}
                    label={'Automatic flight recording on TR start/stop'}
                    checked={this.props.config.autoFlightRecording}
                    onChange={(ev) => this.props.setAutoFlightRecording(ev.target.checked)}
                />
                <Button variant={'secondary'} onClick={this.props.openFlightSessions}>
                    Flight Sessions...
                </Button>
                <Button variant={'primary'} onClick={() => this.setState({showingSettings: true})}>
                    Settings
                </Button>
            </div>
            {this.makeToast()}
            {this.makeSettingsModal()}
        </div>;
    }

    protected async onDrop(e: DragEvent) {
        const files = e.dataTransfer.files;
        if (files.length !== 1 || !files[0].name.endsWith('.zip')) {
            return;
        }
        const data = await files[0].arrayBuffer();
        processIPC.once(IPC_CONSTANTS_TO_RENDERER.flightRecorder.fullList, (frData) => {
            this.props.openFlightRecording(frData);
        });
        processIPC.send(IPC_CONSTANTS_TO_MAIN.loadFlightRecording, [...new Uint8Array(data)]);
    }

    private makeToast() {
        return <ToastContainer position={'bottom-end'}>
            <Toast
                show={this.state.showingError}
                onClose={() => this.setState({showingError: false})}
                bg={'danger'}
            >
                <Toast.Header>Failed to connect</Toast.Header>
                <Toast.Body>{this.state.error}</Toast.Body>
            </Toast>
        </ToastContainer>;
    }

    private saveCurrentWindowSize() {
        this.props.setWindowSizeToCurrent();
        clearTimeout(this.windowSizeSavedTimeout);
        this.setState({windowSizeJustSaved: true});
        this.windowSizeSavedTimeout = setTimeout(() => this.setState({windowSizeJustSaved: false}), 1200);
    }

    private makeSettingsModal() {
        return <Modal
            show={this.state.showingSettings}
            onHide={() => this.setState({showingSettings: false})}
            size={'lg'}
        >
            <Modal.Header closeButton>
                <Modal.Title>Settings</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {this.makeAppSettings()}
            </Modal.Body>
        </Modal>;
    }

    // The changelog is otherwise plain text - this just makes any URL that happens to appear in it
    // (e.g. a stray "Full Changelog" compare link) clickable instead of dead text in a <pre>.
    private renderWithLinks(text: string): React.ReactNode[] {
        const urlPattern = /https?:\/\/\S+/g;
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;
        let match: RegExpExecArray;
        let key = 0;
        while ((match = urlPattern.exec(text)) !== null) {
            if (match.index > lastIndex) {
                parts.push(text.substring(lastIndex, match.index));
            }
            const url = match[0];
            parts.push(<a
                key={key++}
                href={url}
                onClick={(ev) => {
                    ev.preventDefault();
                    shell.openExternal(url);
                }}
            >
                {url}
            </a>);
            lastIndex = match.index + url.length;
        }
        if (lastIndex < text.length) {
            parts.push(text.substring(lastIndex));
        }
        return parts;
    }

    private makeAppSettings() {
        const otherMode = this.props.config.darkMode ? 'light' : 'dark';
        return <div className={'tt-app-settings'}>
            <Button
                variant={this.state.windowSizeJustSaved ? 'success' : 'secondary'}
                onClick={() => this.saveCurrentWindowSize()}
            >
                Set current window size as default
            </Button>
            <div>
                <Form.Label>Slider handle size (px)</Form.Label>
                <Form.Control
                    type={'number'}
                    min={16}
                    max={60}
                    style={{width: '8em'}}
                    value={this.props.config.sliderSize}
                    onChange={(ev) => this.props.setSliderSize(Number(ev.target.value))}
                />
            </div>
            <div>
                <Form.Label>Voltage scope range</Form.Label>
                <Form.Select
                    style={{width: '14em'}}
                    value={this.props.config.voltagePhases}
                    onChange={(ev) => this.props.setVoltagePhases(Number(ev.target.value))}
                >
                    <option value={1}>1-phase (0-350V, 35V/div)</option>
                    <option value={3}>3-phase (0-600V, 60V/div)</option>
                </Form.Select>
            </div>
            {this.makeScopeColorSettings()}
            <Button
                onClick={() => this.props.setDarkMode(!this.props.config.darkMode)}
                variant={otherMode}
            >
                Switch to {otherMode} mode
            </Button>
            <div>
                <a
                    href={'https://github.com/mrguybrush/Teslaterm'}
                    onClick={(ev) => {
                        ev.preventDefault();
                        shell.openExternal('https://github.com/mrguybrush/Teslaterm');
                    }}
                >
                    Teslaterm on GitHub
                </a>
            </div>
            <div>
                <Button
                    variant={'secondary'}
                    onClick={() => {
                        this.setState({
                            updateAvailable: false,
                            updateCheckIsError: false,
                            updateCheckMessage: undefined,
                            updateReleaseNotes: undefined,
                        });
                        processIPC.send(IPC_CONSTANTS_TO_MAIN.checkForUpdates, undefined);
                    }}
                >
                    Check for updates
                </Button>
                {this.state.updateCheckMessage && <span
                    className={'tt-update-check-status'}
                    style={{color: this.state.updateCheckIsError ? 'var(--bs-danger)' : undefined}}
                >
                    {this.state.updateCheckMessage}
                </span>}
            </div>
            {this.state.updateAvailable && this.state.updateReleaseNotes && <pre className={'tt-update-release-notes'}>
                {this.renderWithLinks(this.state.updateReleaseNotes)}
            </pre>}
            {this.state.updateAvailable && <Button
                variant={'success'}
                onClick={() => {
                    this.setState({updateAvailable: false});
                    processIPC.send(IPC_CONSTANTS_TO_MAIN.downloadUpdate, undefined);
                }}
            >
                Download &amp; install
            </Button>}
        </div>;
    }

    private makeScopeColorSettings() {
        const traceColors = this.props.config.scopeTraceColors;
        const setTraceColor = (index: number, color: string) => {
            const newColors = [...traceColors];
            newColors[index] = color;
            this.props.setScopeTraceColors(newColors);
        };
        const resetToDefaults = () => {
            this.props.setScopeBackgroundColor(DEFAULT_SCOPE_BACKGROUND);
            this.props.setScopeGridColor(DEFAULT_SCOPE_GRID_LINE);
            this.props.setScopeTraceColors(DEFAULT_TRACE_COLORS);
        };
        return <div>
            <Form.Label>Scope colors</Form.Label>
            <div style={{alignItems: 'center', display: 'flex', flexWrap: 'wrap', gap: '0.75rem'}}>
                <div style={{textAlign: 'center'}}>
                    <div>Background</div>
                    <Form.Control
                        type={'color'}
                        value={this.props.config.scopeBackgroundColor}
                        onChange={(ev) => this.props.setScopeBackgroundColor(ev.target.value)}
                    />
                </div>
                <div style={{textAlign: 'center'}}>
                    <div>Grid</div>
                    <Form.Control
                        type={'color'}
                        value={this.props.config.scopeGridColor}
                        onChange={(ev) => this.props.setScopeGridColor(ev.target.value)}
                    />
                </div>
                {traceColors.map((color, index) => (
                    <div style={{textAlign: 'center'}} key={index}>
                        <div>Trace {index + 1}</div>
                        <Form.Control
                            type={'color'}
                            value={color}
                            onChange={(ev) => setTraceColor(index, ev.target.value)}
                        />
                    </div>
                ))}
            </div>
            <Button variant={'secondary'} size={'sm'} onClick={resetToDefaults}>
                Reset scope colors to defaults
            </Button>
        </div>;
    }
}
