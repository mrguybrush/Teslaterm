import React from "react";
import {Form} from "react-bootstrap";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../common/IPCConstantsToRenderer";
import {defaultEqState, EqPoint, MidiEqState} from "../../common/MidiEqualizer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {EqualizerCurve} from "./EqualizerCurve";

export interface EqualizerPanelProps {
    coil: CoilID;
}

// While dragging a point or turning its Q knob, onChange(..., false) can fire on every animation
// frame - sent to the main process at full rate that would be a lot of IPC traffic for no audible
// benefit. commit=true (mouse-up, a discrete add/remove/wheel-notch) always sends immediately.
const DRAG_SEND_INTERVAL_MS = 50;

export class EqualizerPanel extends TTComponent<EqualizerPanelProps, MidiEqState> {
    private lastSentAt = 0;

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
            <div className={'tt-equalizer-header'}>
                <Form.Check
                    type={'checkbox'}
                    id={'equalizer-enabled'}
                    label={'Enabled'}
                    checked={this.state.enabled}
                    onChange={(ev) => this.setEnabled(ev.target.checked)}
                />
                <span className={'tt-equalizer-hint'}>
                    Double-click to add a point, drag to move it, scroll to change its Q,
                    right-click or Delete to remove it.
                </span>
            </div>
            <EqualizerCurve
                points={this.state.points}
                enabled={this.state.enabled}
                onChange={(points, commit) => this.onCurveChange(points, commit)}
            />
            <p className={'tt-equalizer-explanation'}>
                Scales how loud notes in each range play on the coil, by scaling their MIDI
                velocity - a Tesla coil has no audio signal to filter, so this is the closest
                equivalent of an EQ. Only Note On velocity is touched: TR, the bus and every
                other coil control are unaffected.
            </p>
        </div>;
    }

    private setEnabled(enabled: boolean) {
        this.setState({enabled});
        processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setEnabled, enabled);
    }

    private onCurveChange(points: EqPoint[], commit: boolean) {
        this.setState({points});
        const now = Date.now();
        if (commit || now - this.lastSentAt > DRAG_SEND_INTERVAL_MS) {
            this.lastSentAt = now;
            processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setPoints, points);
        }
    }
}
