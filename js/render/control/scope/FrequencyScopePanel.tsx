import React from "react";
import {CoilID} from "../../../common/constants";
import {IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil, ScopeTraceConfig, ScopeValues} from "../../../common/IPCConstantsToRenderer";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";
import {CanvasComponent} from "./CanvasComponent";
import {scopeColors} from "./ScopeColors";
import {OscilloscopeTrace, TraceConfig} from "./Trace";

export interface FrequencyScopePanelProps {
    coil: CoilID;
}

interface FrequencyScopePanelState {
    trace?: OscilloscopeTrace;
}

function isFrequencyChannel(cfg: ScopeTraceConfig): boolean {
    return cfg.unit === "Hz" || cfg.unit === "kHz" || /freq|fres/i.test(cfg.name);
}

// Fixed timebase: chosen so that a 40 kHz signal shows ~5 full cycles across the width. Any
// other frequency stretches/compresses relative to that same fixed time window, like a real
// scope with a fixed time/div setting.
const REFERENCE_FREQUENCY_KHZ = 40;
const REFERENCE_CYCLES = 5;
const DEFAULT_CYCLES = 5;

interface FrequencyWaveProps {
    color: string;
    valueText: string;
    frequencyKHz?: number;
}

class FrequencyWaveCanvas extends CanvasComponent<FrequencyWaveProps, {}> {
    protected draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
        const midY = height / 2;
        const amplitude = height * 0.35;
        const cycles = this.props.frequencyKHz !== undefined && this.props.frequencyKHz > 0
            ? (this.props.frequencyKHz / REFERENCE_FREQUENCY_KHZ) * REFERENCE_CYCLES
            : DEFAULT_CYCLES;

        ctx.strokeStyle = scopeColors.gridLine;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, midY);
        ctx.lineTo(width, midY);
        ctx.stroke();

        ctx.strokeStyle = this.props.color;
        ctx.lineWidth = scopeColors.lineWidth;
        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
            const angle = (x / width) * cycles * 2 * Math.PI;
            const y = midY - Math.sin(angle) * amplitude;
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        ctx.fillStyle = this.props.color;
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(this.props.valueText, 8, 18);
    }
}

export class FrequencyScopePanel extends TTComponent<FrequencyScopePanelProps, FrequencyScopePanelState> {
    private freqChannelId?: number;

    constructor(props: FrequencyScopePanelProps) {
        super(props);
        this.state = {};
    }

    public componentDidMount() {
        const channels = getToRenderIPCPerCoil(this.props.coil);
        this.addIPCListener(channels.scope.configure, (cfg: ScopeTraceConfig) => {
            if (isFrequencyChannel(cfg)) {
                this.freqChannelId = cfg.id;
                this.setState({trace: new OscilloscopeTrace(new TraceConfig(cfg))});
            }
        });
        this.addIPCListener(channels.scope.addValues, (values: ScopeValues) => {
            if (this.freqChannelId === undefined) {
                return;
            }
            const channelId = this.freqChannelId;
            this.setState((s) => {
                if (!s.trace) {
                    return null;
                }
                let trace = s.trace;
                for (const tickData of values.values) {
                    const v = tickData[channelId];
                    trace = v !== undefined ? trace.withSample(v) : trace.duplicateLast();
                }
                return {trace};
            });
        });
        // The frequency channel's config may already have been broadcast before this panel
        // existed - request a fresh sync so it gets re-sent now that we're listening.
        processIPC.send(IPC_CONSTANTS_TO_MAIN.requestFullSync, undefined);
    }

    public render(): React.ReactNode {
        if (!this.state.trace) {
            return <div className={"tt-freq-panel-empty"}>
                No frequency channel reported by the connected coil's firmware.
            </div>;
        }
        const trace = this.state.trace;
        const lastValue = trace.data.length > 0 ? trace.data[trace.data.length - 1] : undefined;
        const valueText = lastValue !== undefined
            ? `${trace.config.name}: ${lastValue.toFixed(2)} ${trace.config.unit}`
            : trace.config.name;
        const frequencyKHz = lastValue === undefined ? undefined
            : trace.config.unit === 'kHz' ? lastValue
            : trace.config.unit === 'Hz' ? lastValue / 1000
            : undefined;
        return <div className={"tt-freq-panel"}>
            <FrequencyWaveCanvas color={trace.config.wavecolor} valueText={valueText} frequencyKHz={frequencyKHz}/>
        </div>;
    }
}
