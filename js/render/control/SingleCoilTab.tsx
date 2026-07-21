import React from "react";
import {Button, ButtonGroup} from "react-bootstrap";
import {CoilID} from "../../common/constants";
import {ConnectionStatus, IUD3State} from "../../common/IPCConstantsToRenderer";
import {TTConfig} from "../../common/TTConfig";
import {SyncedUIConfig} from "../../common/UIConfig";
import {TTComponent} from "../TTComponent";
import {Gauges} from "./gauges/Gauges";
import {MenuBar} from "./menu/Menu";
import {MidiPlaylistPanel} from "./MidiPlaylistPanel";
import {PianoPanel} from "./PianoPanel";
import {FrequencyScopePanel} from "./scope/FrequencyScopePanel";
import {Oscilloscope} from "./scope/Oscilloscope";
import {Sliders} from "./sliders/Sliders";
import {Terminal} from "./Terminal";
import {TelemetryDebugPanel} from "./TelemetryDebugPanel";
import {Toasts, ToastsProps} from "./Toasts";

export type TabControlLevelBase<Single, Central> =
    ({ level: 'single-coil' | 'combined' } & Single) |
    ({ level: 'central-control' } & Central);

export type TabControlLevel = TabControlLevelBase<{ coil: CoilID }, {}>;

export interface SingleCoilTabProps {
    allowInteraction: boolean;
    ttConfig: TTConfig;
    connectionStatus: ConnectionStatus;
    coil: CoilID;
    ud3State: IUD3State;
    toasts: ToastsProps;
    level: 'single-coil' | 'combined';
    returnToConnect: () => any;
    config: SyncedUIConfig;
}

enum BottomPanelMode {
    terminal,
    midi_playlist,
    piano,
    frequency,
    debug,
    none,
}

interface SingleCoilTabState {
    bottomPanel: BottomPanelMode;
    pianoActive: boolean;
}

export class SingleCoilTab extends TTComponent<SingleCoilTabProps, SingleCoilTabState> {
    constructor(props) {
        super(props);
        this.state = {bottomPanel: BottomPanelMode.terminal, pianoActive: false};
    }

    public render() {
        const bottomPanel = this.state.bottomPanel;
        return (
            <div className={'tt-coil-tab'}>
                <div className={'tt-menu-bar'}>
                    <MenuBar
                        connectionStatus={this.props.connectionStatus}
                        ttConfig={this.props.ttConfig}
                        level={{level: this.props.level, coil: this.props.coil, state: this.props.ud3State}}
                        returnToConnect={this.props.returnToConnect}
                    />
                </div>
                <div className={'tt-terminal-and-gauges'}>
                    <div className={'tt-terminal-container'}>
                        <div
                            className={'tt-scope-container'}
                            style={bottomPanel === BottomPanelMode.none ? {height: 'calc(100% - 30px)'} : undefined}
                        >
                            <Oscilloscope coil={this.props.coil} voltagePhases={this.props.config.voltagePhases}/>
                            <Sliders
                                disabled={!this.props.allowInteraction}
                                enableMIDI={this.props.config.advancedOptions.enableMIDIInput}
                                level={{level: this.props.level, coil: this.props.coil, ud3State: this.props.ud3State}}
                            />
                        </div>
                        <ButtonGroup className={'tt-terminal-header'}>
                            <Button
                                variant={bottomPanel === BottomPanelMode.terminal ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.terminal})}
                            >
                                Terminal
                            </Button>
                            <Button
                                variant={bottomPanel === BottomPanelMode.midi_playlist ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.midi_playlist})}
                            >
                                MIDI Playlist
                            </Button>
                            <Button
                                variant={bottomPanel === BottomPanelMode.piano ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.piano})}
                            >
                                Piano
                            </Button>
                            <Button
                                variant={bottomPanel === BottomPanelMode.frequency ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.frequency})}
                            >
                                Frequency
                            </Button>
                            <Button
                                variant={bottomPanel === BottomPanelMode.debug ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.debug})}
                            >
                                Debug
                            </Button>
                            <Button
                                variant={bottomPanel === BottomPanelMode.none ? 'primary' : 'secondary'}
                                size={'sm'}
                                onClick={() => this.setState({bottomPanel: BottomPanelMode.none})}
                            >
                                Hide
                            </Button>
                        </ButtonGroup>
                        {bottomPanel === BottomPanelMode.terminal && <Terminal
                            disabled={!this.props.allowInteraction}
                            coil={this.props.coil}
                        />}
                        {bottomPanel === BottomPanelMode.midi_playlist &&
                            <MidiPlaylistPanel disabled={!this.props.allowInteraction}/>}
                        <PianoPanel
                            disabled={!this.props.allowInteraction}
                            active={this.state.pianoActive}
                            setActive={(pianoActive) => this.setState({pianoActive})}
                            visible={bottomPanel === BottomPanelMode.piano}
                        />
                        {bottomPanel === BottomPanelMode.frequency &&
                            <FrequencyScopePanel coil={this.props.coil}/>}
                        {bottomPanel === BottomPanelMode.debug &&
                            <TelemetryDebugPanel coil={this.props.coil}/>}
                    </div>
                    <Gauges coil={this.props.coil}/>
                </div>
                <Toasts {...this.props.toasts}/>
            </div>
        );
    }
}
