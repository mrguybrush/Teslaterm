import React from "react";
import {Form} from "react-bootstrap";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../common/IPCConstantsToRenderer";
import {bandLabel, defaultEqState, MidiEqState} from "../../common/MidiEqualizer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {SimpleSlider} from "./sliders/SimpleSlider";

export interface EqualizerPanelProps {
    coil: CoilID;
}

export class EqualizerPanel extends TTComponent<EqualizerPanelProps, MidiEqState> {
    public constructor(props: EqualizerPanelProps) {
        super(props);
        // Replaced almost immediately by the real state requested below - the main process is the
        // source of truth, this is just something to render before that reply arrives.
        this.state = defaultEqState();
    }

    public componentDidMount() {
        this.addIPCListener(
            getToRenderIPCPerCoil(this.props.coil).equalizer.state,
            (state) => this.setState(state),
        );
        processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.requestState, undefined);
    }

    public render(): React.ReactNode {
        return <div className={'tt-equalizer-panel'}>
            <p className={'tt-equalizer-explanation'}>
                Scales how loud notes in each range play on the coil, by scaling their MIDI
                velocity - a Tesla coil has no audio signal to filter, so this is the closest
                equivalent of an EQ band. Only Note On velocity is touched: TR, the bus and every
                other coil control are unaffected.
            </p>
            <Form.Check
                type={'checkbox'}
                id={'equalizer-enabled'}
                label={'Enabled'}
                checked={this.state.enabled}
                onChange={(ev) => this.setEnabled(ev.target.checked)}
            />
            <div className={'tt-equalizer-bands'}>
                {this.state.gainPercent.map((gain, band) => (
                    <SimpleSlider
                        key={band}
                        title={bandLabel(band)}
                        unit={'%'}
                        min={0}
                        max={200}
                        value={gain}
                        setValue={(value) => this.setBandGain(band, value)}
                        visuallyEnabled={this.state.enabled}
                        disabled={false}
                    />
                ))}
            </div>
        </div>;
    }

    private setEnabled(enabled: boolean) {
        this.setState({enabled});
        processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setEnabled, enabled);
    }

    private setBandGain(band: number, gainPercent: number) {
        this.setState((state) => {
            const gains = [...state.gainPercent];
            gains[band] = gainPercent;
            return {gainPercent: gains};
        });
        processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setBandGain, {band, gainPercent});
    }
}
