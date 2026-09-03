import React from "react";
import {Button, Form, OverlayTrigger, Popover} from "react-bootstrap";
import {ArrowCounterclockwise, InfoCircle} from "react-bootstrap-icons";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../common/IPCConstantsToRenderer";
import {
    defaultEqState,
    EqPoint,
    MAX_Q,
    MidiEqState,
    MIN_Q,
    normalizedToQ,
    qToNormalized,
} from "../../common/MidiEqualizer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {EqualizerCurve} from "./EqualizerCurve";

export interface EqualizerPanelProps {
    coil: CoilID;
}

// The curve's own selection is UI-only (never sent to the main process), but the sidebar Q slider
// needs to know which point it's controlling, so it lives here rather than being local to the curve.
interface EqualizerPanelState extends MidiEqState {
    selectedId?: number;
}

// While dragging a point or turning its Q knob, onChange(..., false) can fire on every animation
// frame - sent to the main process at full rate that would be a lot of IPC traffic for no audible
// benefit. commit=true (mouse-up, a discrete add/remove/wheel-notch) always sends immediately.
const DRAG_SEND_INTERVAL_MS = 50;

export class EqualizerPanel extends TTComponent<EqualizerPanelProps, EqualizerPanelState> {
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
        const selectedPoint = this.state.points.find((p) => p.id === this.state.selectedId);
        const infoPopover = <Popover id={'equalizer-info-popover'}>
            <Popover.Body>
                Scales how loud notes in each range play on the coil, by scaling their MIDI
                velocity - a Tesla coil has no audio signal to filter, so this is the closest
                equivalent of an EQ. Only Note On velocity is touched: TR, the bus and every
                other coil control are unaffected.
                <hr/>
                Double-click to add a point, drag to move it, scroll (or the Q slider) to
                change its Q, right-click or Delete to remove it.
            </Popover.Body>
        </Popover>;
        return <div className={'tt-equalizer-panel'}>
            <div className={'tt-equalizer-header'}>
                <Form.Check
                    type={'switch'}
                    id={'equalizer-enabled'}
                    label={'Enabled'}
                    checked={this.state.enabled}
                    onChange={(ev) => this.setEnabled(ev.target.checked)}
                />
                <OverlayTrigger trigger={'click'} placement={'right'} overlay={infoPopover} rootClose={true}>
                    <Button variant={'link'} size={'sm'} className={'tt-equalizer-info-button'}>
                        <InfoCircle/>
                    </Button>
                </OverlayTrigger>
                <Button
                    variant={'outline-secondary'}
                    size={'sm'}
                    className={'tt-equalizer-reset-button'}
                    disabled={this.state.points.length === 0}
                    onClick={() => this.resetCurve()}
                    title={'Remove every point and start over'}
                >
                    <ArrowCounterclockwise/> Reset
                </Button>
            </div>
            <div className={'tt-equalizer-body'}>
                <EqualizerCurve
                    points={this.state.points}
                    enabled={this.state.enabled}
                    selectedId={this.state.selectedId}
                    onSelectPoint={(selectedId) => this.setState({selectedId})}
                    onChange={(points, commit) => this.onCurveChange(points, commit)}
                />
                <div className={'tt-eq-q-sidebar'}>
                    <span className={'tt-eq-q-label'}>Q</span>
                    <input
                        type={'range'}
                        className={'tt-eq-q-slider'}
                        min={0}
                        max={1}
                        step={0.001}
                        disabled={!selectedPoint}
                        value={selectedPoint ? qToNormalized(selectedPoint.q) : qToNormalized(1)}
                        onChange={(ev) => this.setSelectedQ(Number(ev.target.value))}
                        // input fires continuously while dragging the thumb (throttled below, like
                        // a canvas drag); mouseUp/keyUp catch the release the same way the curve's
                        // own window mouseup does, so the final position always actually reaches
                        // the main process even if the last input tick was swallowed by the throttle.
                        onMouseUp={() => this.flushSelectedQ()}
                        onKeyUp={() => this.flushSelectedQ()}
                        title={selectedPoint ? `Q ${selectedPoint.q.toFixed(2)}` : 'Select a point first'}
                    />
                    <span className={'tt-eq-q-value'}>
                        {selectedPoint ? selectedPoint.q.toFixed(2) : '-'}
                    </span>
                </div>
            </div>
        </div>;
    }

    private setEnabled(enabled: boolean) {
        this.setState({enabled});
        processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setEnabled, enabled);
    }

    // Clears every point (back to a flat, unity curve) without touching the Enabled switch - a
    // reset is about the shape of the curve, not whether it's currently applied.
    private resetCurve() {
        this.setState({points: [], selectedId: undefined});
        this.sendPoints([], true);
    }

    private onCurveChange(points: EqPoint[], commit: boolean) {
        this.setState({points});
        this.sendPoints(points, commit);
    }

    private setSelectedQ(normalized: number) {
        const id = this.state.selectedId;
        if (id === undefined) {
            return;
        }
        const q = Math.max(MIN_Q, Math.min(MAX_Q, normalizedToQ(normalized)));
        const points = this.state.points.map((p) => (p.id === id ? {...p, q} : p));
        this.setState({points});
        // A slider drag fires just as rapidly as a canvas drag does, so it gets the same throttle.
        this.sendPoints(points, false);
    }

    private flushSelectedQ() {
        this.sendPoints(this.state.points, true);
    }

    private sendPoints(points: EqPoint[], commit: boolean) {
        const now = Date.now();
        if (commit || now - this.lastSentAt > DRAG_SEND_INTERVAL_MS) {
            this.lastSentAt = now;
            processIPC.send(getToMainIPCPerCoil(this.props.coil).equalizer.setPoints, points);
        }
    }
}
