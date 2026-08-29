import React from "react";
import ReactDOM from "react-dom/client";
import {CoilID} from "../common/constants";
import {IPC_CONSTANTS_TO_MAIN} from "../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER} from "../common/IPCConstantsToRenderer";
import {TTConfig} from "../common/TTConfig";
import {SyncedUIConfig} from "../common/UIConfig";
import {ConnectScreen, FRDisplayData} from "./connect/ConnectScreen";
import {MainScreen} from "./control/MainScreen";
import {DarkModeContext} from "./DarkModeContext";
import {FlightRecordingScreen} from "./flightrecord/FlightRecordingScreen";
import {FlightSessionsScreen} from "./flightrecord/FlightSessionsScreen";
import {FlightVideoRecorder} from "./flightrecord/VideoRecorder";
import {processIPC} from "./ipc/IPCProvider";
import {setScopeColors} from "./control/scope/ScopeColors";
import {TTComponent} from "./TTComponent";

enum TopScreen {
    connect,
    control,
    flight_recording,
    flight_sessions,
}

interface TopLevelState {
    screen: TopScreen;
    screenBeforeRecording: TopScreen;
    flightEvents?: FRDisplayData;
    ttConfig: TTConfig;
    config: SyncedUIConfig;
    coils: CoilID[];
    multicoil: boolean;
}

export class App extends TTComponent<{}, TopLevelState> {
    // Lives at the top level rather than inside a screen component: recording has to keep running
    // while the user navigates between screens, and screens get unmounted when they do.
    private readonly videoRecorder = new FlightVideoRecorder();

    constructor(props: any) {
        super(props);
        this.state = {
            coils: [],
            config: undefined,
            multicoil: false,
            screen: TopScreen.connect,
            screenBeforeRecording: TopScreen.connect,
            ttConfig: undefined,
        };
    }

    public componentDidMount() {
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionStarted,
            (target) => {
                // Checked here rather than in main so that toggling the setting takes effect for
                // the very next session without main having to track renderer state.
                if (this.state.config?.recordVideo) {
                    this.videoRecorder.start(target).catch((e) => console.error('Starting video', e));
                }
            },
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.flightRecorder.sessionStopped,
            () => this.videoRecorder.stop().catch((e) => console.error('Stopping video', e)),
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.ttConfig, (cfg) => this.setState({ttConfig: cfg}),
        );
        this.addIPCListener(
            IPC_CONSTANTS_TO_RENDERER.uiConfig, (cfg) => {
                this.setState({config: cfg});
                document.documentElement.setAttribute('data-bs-theme', cfg.darkMode ? 'dark' : 'light');
                document.documentElement.style.setProperty('--tt-slider-thumb-size', cfg.sliderSize + 'px');
                setScopeColors({
                    background: cfg.scopeBackgroundColor,
                    gridLine: cfg.scopeGridColor,
                    lineWidth: cfg.scopeLineWidth,
                    traceColors: cfg.scopeTraceColors,
                });
            },
        );
        this.addIPCListener(IPC_CONSTANTS_TO_RENDERER.registerCoil, ([coil, multicoil]) => {
            this.setState((oldState) => {
                const result = {
                    coils: [...oldState.coils],
                    multicoil,
                    screen: oldState.screen,
                };
                if (!oldState.coils.includes(coil)) {
                    result.coils.push(coil);
                    result.screen = TopScreen.control;
                }
                return result;
            });
        });
        processIPC.send(IPC_CONSTANTS_TO_MAIN.requestFullSync, undefined);
    }

    public render(): React.ReactNode {
        return <div className={'tt-root'}>
            <DarkModeContext.Provider value={this.state.config && this.state.config.darkMode}>
                {this.getMainElement()}
            </DarkModeContext.Provider>
        </div>;
    }

    private getMainElement(): React.JSX.Element {
        if (!this.state.ttConfig || !this.state.config) {
            return <>Initializing...</>;
        } else if (this.state.screen === TopScreen.flight_recording) {
            return <FlightRecordingScreen
                events={this.state.flightEvents}
                voltagePhases={this.state.config.voltagePhases}
                close={() => this.setState({screen: this.state.screenBeforeRecording})}
            />;
        } else if (this.state.screen === TopScreen.flight_sessions) {
            return <FlightSessionsScreen
                close={() => this.setState({screen: TopScreen.connect})}
                openRecording={(data) => this.setState({
                    flightEvents: data,
                    screen: TopScreen.flight_recording,
                    screenBeforeRecording: TopScreen.flight_sessions,
                })}
            />;
        } else if (this.state.screen === TopScreen.control) {
            return <MainScreen
                ttConfig={this.state.ttConfig}
                returnToConnect={() => {
                    processIPC.send(IPC_CONSTANTS_TO_MAIN.clearCoils, undefined);
                    this.setState({screen: TopScreen.connect, coils: []});
                }}
                config={this.state.config}
                coils={this.state.coils}
                multicoil={this.state.multicoil}
                setDarkMode={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setDarkMode, newVal)}
            />;
        } else if (this.state.screen === TopScreen.connect) {
            return <ConnectScreen
                config={this.state.config}
                connecting={false/*TODO*/}
                setDarkMode={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setDarkMode, newVal)}
                setRecordVideo={newVal => processIPC.send(
                    IPC_CONSTANTS_TO_MAIN.setRecordVideo, newVal,
                )}
                setAutoFlightRecording={newVal => processIPC.send(
                    IPC_CONSTANTS_TO_MAIN.setAutoFlightRecording, newVal,
                )}
                setWindowSizeToCurrent={() => processIPC.send(
                    IPC_CONSTANTS_TO_MAIN.setWindowSizeToCurrent, undefined,
                )}
                setSliderSize={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setSliderSize, newVal)}
                setVoltagePhases={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setVoltagePhases, newVal)}
                setScopeBackgroundColor={newVal => processIPC.send(
                    IPC_CONSTANTS_TO_MAIN.setScopeBackgroundColor, newVal,
                )}
                setScopeGridColor={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setScopeGridColor, newVal)}
                setScopeLineWidth={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setScopeLineWidth, newVal)}
                setScopeTraceColors={newVal => processIPC.send(IPC_CONSTANTS_TO_MAIN.setScopeTraceColors, newVal)}
                openFlightRecording={(data) => this.setState({
                    flightEvents: data,
                    screen: TopScreen.flight_recording,
                    screenBeforeRecording: TopScreen.connect,
                })}
                openFlightSessions={() => this.setState({screen: TopScreen.flight_sessions})}
            />;
        } else {
            return <>Unsupported status {this.state.screen} :(</>;
        }
    }
}

export function init() {
    document.addEventListener('DOMContentLoaded', () => {
        const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
        root.render(<React.StrictMode><App/></React.StrictMode>);
    });
}
