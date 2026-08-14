import React from 'react';
import {CoilID} from "../../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil, ISliderState, IUD3State} from "../../../common/IPCConstantsToRenderer";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";
import {CommandButtons} from "../menu/CommandButtons";
import {TabControlLevelBase} from "../SingleCoilTab";
import {MidiSourceSelect} from "./MidiSourceSelect";
import {OntimeSlider} from './OntimeSlider';
import {SimpleSlider} from './SimpleSlider';

export interface SlidersProps {
    disabled: boolean;
    enableMIDI: boolean;
    level: TabControlLevelBase<{ coil: CoilID, ud3State: IUD3State }, {}>;
}

interface SliderUIState extends ISliderState {
    controllingRelativeOntime: boolean;
}

export class Sliders extends TTComponent<SlidersProps, SliderUIState> {
    private appliedInitialBurstOntimeOverride: boolean = false;

    constructor(props: any) {
        super(props);
        this.state = {
            bps: 20,
            burstOfftime: 0,
            burstOntime: 0,
            controllingRelativeOntime: false,
            maxBPS: 1000,
            maxOntime: 400,
            onlyMaxOntimeSettable: false,
            ontimeAbs: 0,
            ontimeRel: this.props.level.level === 'central-control' ? 0 : 100,
            volumeFraction: 1,
        };
    }

    public componentDidMount() {
        if (this.props.level.level !== 'central-control') {
            const coil = this.props.level.coil;
            this.addIPCListener(
                getToRenderIPCPerCoil(coil).sliders.syncSettings,
                (sync) => {
                    let burstOntime = sync.burstOntime;
                    if (!this.appliedInitialBurstOntimeOverride) {
                        this.appliedInitialBurstOntimeOverride = true;
                        if (sync.burstOntime !== 0) {
                            burstOntime = 0;
                            processIPC.send(getToMainIPCPerCoil(coil).sliders.setBurstOntime, 0);
                        }
                    }
                    const newState: SliderUIState = {
                        ...sync,
                        burstOntime,
                        controllingRelativeOntime: this.state.controllingRelativeOntime,
                    };
                    if (sync.onlyMaxOntimeSettable) {
                        newState.controllingRelativeOntime = false;
                    }
                    this.setState(newState);
                },
            );
        }
    }

    public render(): React.ReactNode {
        // TODO make this work properly in the central tab
        const coil = this.props.level.level !== 'central-control' ? this.props.level.coil : undefined;
        const coilIPC = coil !== undefined ? getToMainIPCPerCoil(coil) : undefined;
        const combinedIPC = coilIPC ? coilIPC : IPC_CONSTANTS_TO_MAIN;
        const setOntime = (val: number, relative: boolean) => {
            const channel = relative ?
                IPC_CONSTANTS_TO_MAIN.sliders.setOntimeRelative :
                coilIPC.sliders.setOntimeAbsolute;
            processIPC.send(channel, val);
            if (relative) {
                this.setState({ontimeRel: val});
            } else {
                this.setState({ontimeAbs: val});
            }
        };
        const udState = this.props.level.level !== 'central-control' ? this.props.level.ud3State : undefined;
        const [busOn, trOn] = (() => {
            if (!udState) {
                return [true, true];
            } else {
                 const busOn = udState.busActive || udState.busControllable;
                 return [busOn, busOn && udState.transientActive];
            }
        })();
        const startDischarge = () => {
            if (!coilIPC) {
                return;
            }
            processIPC.send(combinedIPC.commands.setBusState, false);
            if (!(udState && udState.transientActive)) {
                processIPC.send(combinedIPC.commands.setTRState, true);
            }
            processIPC.send(coilIPC.sliders.setOntimeAbsolute, 50);
            processIPC.send(combinedIPC.sliders.setBPS, 40);
            this.setState({bps: 40, controllingRelativeOntime: false, ontimeAbs: 50});
        };
        let volumeSlider: React.JSX.Element;
        if (this.props.level.level === 'combined') {
            volumeSlider = <SimpleSlider
                title={'Volume'}
                unit={'%'}
                value={Math.floor(this.state.volumeFraction * 100)}
                min={0}
                max={100}
                setValue={(volumePercent) => {
                    const volume = volumePercent / 100;
                    this.setState({volumeFraction: volume});
                    processIPC.send(coilIPC.sliders.setVolumeFraction, volume);
                }}
                visuallyEnabled={true}
                disabled={this.props.disabled}
            />;
        }
        return <div className={'tt-sliders-container'}>
            <CommandButtons
                level={this.props.level}
                udState={udState}
                disabled={this.props.disabled}
                size={'lg'}
                showKill={true}
                onDischarge={coilIPC ? startDischarge : undefined}
            />
            <OntimeSlider
                max={this.state.maxOntime}
                valueAbsolute={this.state.ontimeAbs}
                valueRelative={this.state.ontimeRel}
                setValue={setOntime}
                relativeAllowed={!this.state.onlyMaxOntimeSettable}
                visuallyEnabled={busOn}
                disabled={this.props.disabled}
                controllingRelative={this.state.controllingRelativeOntime}
                setControllingRelative={b => this.setState({controllingRelativeOntime: b})}
                level={this.props.level}
            />
            <SimpleSlider
                title={'BPS'}
                unit={'/ second'}
                value={this.state.bps}
                min={20}
                max={this.state.maxBPS}
                setValue={(v) => {
                    this.setState({bps: v});
                    processIPC.send(combinedIPC.sliders.setBPS, v);
                }}
                visuallyEnabled={trOn}
                disabled={this.props.disabled || this.state.onlyMaxOntimeSettable}
            />
            {volumeSlider}
            <SimpleSlider
                title={'Burst Ontime'}
                unit={'ms'}
                value={this.state.burstOntime}
                min={0}
                max={1000}
                setValue={(v) => {
                    this.setState({burstOntime: v});
                    processIPC.send(combinedIPC.sliders.setBurstOntime, v);
                }}
                visuallyEnabled={trOn}
                disabled={this.props.disabled || this.state.onlyMaxOntimeSettable}
            />
            <SimpleSlider
                title={'Burst Offtime'}
                unit={'ms'}
                value={this.state.burstOfftime}
                min={0}
                max={1000}
                setValue={(v) => {
                    this.setState({burstOfftime: v});
                    processIPC.send(combinedIPC.sliders.setBurstOfftime, v);
                }}
                visuallyEnabled={trOn}
                disabled={this.props.disabled || this.state.onlyMaxOntimeSettable}
            />
            {this.props.enableMIDI && <MidiSourceSelect coil={coil}/>}
        </div>;
    }
}
