import React from "react";
import {CanvasComponent} from "./CanvasComponent";
import {scopeColors} from "./ScopeColors";
import {OscilloscopeTrace, NUM_VERTICAL_DIVS, TraceConfig} from "./Trace";

const PIXELS_PER_HORIZONTAL_DIV = 100;
// How close to a line the pointer has to be for that line to be the one being asked about.
const HOVER_TOLERANCE_PIXELS = 6;

export interface TraceProps {
    traces: OscilloscopeTrace[];
}

interface HoverInfo {
    x: number;
    y: number;
    name: string;
    unit: string;
    color: string;
    value: number;
    flipHorizontally: boolean;
}

/**
 * Owns the hover label's state so that moving the pointer re-renders this alone. Putting it in the
 * Traces component instead would redraw the whole scope canvas on every mouse move.
 */
class TraceHoverLabel extends React.Component<{}, {info?: HoverInfo}> {
    public constructor(props: {}) {
        super(props);
        this.state = {};
    }

    public show(info: HoverInfo) {
        this.setState({info});
    }

    public hide() {
        if (this.state.info) {
            this.setState({info: undefined});
        }
    }

    public render(): React.ReactNode {
        const info = this.state.info;
        if (!info) {
            return undefined;
        }
        // Flipped to the other side of the pointer near the right edge so it cannot end up clipped.
        const flip = info.flipHorizontally;
        return <div
            className={'tt-scope-hover'}
            style={{
                borderColor: info.color,
                left: info.x + (flip ? -12 : 12),
                top: info.y + 12,
                transform: flip ? 'translateX(-100%)' : undefined,
            }}
        >
            <span style={{color: info.color}}>{info.name}</span>{': '}
            {info.value.toFixed(2)} {info.unit}
        </div>;
    }
}

export class Traces extends CanvasComponent<TraceProps, {}> {
    private readonly hoverLabel = React.createRef<TraceHoverLabel>();

    protected draw(ctx: CanvasRenderingContext2D, width: number, height: number) {
        Traces.drawGrid(ctx, width, height);
        for (const trace of this.props.traces) {
            Traces.drawTrace(trace.config, trace.data, ctx, width, height);
        }
    }

    protected renderOverlay(): React.ReactNode {
        return <TraceHoverLabel ref={this.hoverLabel}/>;
    }

    protected onCanvasMouseLeave() {
        this.hoverLabel.current?.hide();
    }

    protected onCanvasMouseMove(ev: React.MouseEvent) {
        const label = this.hoverLabel.current;
        const pos = this.canvasPosition(ev);
        const size = this.canvasSize();
        if (!label || !pos || !size) {
            return;
        }
        // The sample under the pointer is the same one drawTrace would have put there, so the label
        // reports exactly the value the line was drawn from rather than an interpolation of it.
        const sampleX = Math.round(pos.x);
        let best: {distance: number, info: HoverInfo} | undefined;
        for (const trace of this.props.traces) {
            const y = Traces.traceYAt(trace, sampleX, size.width, size.height);
            if (y === undefined) {
                continue;
            }
            const distance = Math.abs(y - pos.y);
            if (distance <= HOVER_TOLERANCE_PIXELS && (!best || distance < best.distance)) {
                const index = sampleX - (size.width - (trace.data.length - 1));
                best = {
                    distance,
                    info: {
                        color: trace.config.wavecolor,
                        flipHorizontally: pos.x > size.width - 140,
                        name: trace.config.name,
                        unit: trace.config.unit,
                        value: trace.data[index],
                        x: pos.x,
                        y: pos.y,
                    },
                };
            }
        }
        if (best) {
            label.show(best.info);
        } else {
            label.hide();
        }
    }

    /** Where the given trace's line sits at this x, or undefined if it has no sample there. */
    private static traceYAt(
        trace: OscilloscopeTrace, x: number, width: number, height: number,
    ): number | undefined {
        const data = trace.data;
        const dataOffset = width - (data.length - 1);
        const index = x - dataOffset;
        if (index < 0 || index >= data.length) {
            return undefined;
        }
        const valueDivs = (data[index] - trace.config.visualOffset) / trace.config.perDiv;
        return height - valueDivs * height / NUM_VERTICAL_DIVS;
    }

    public static drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = scopeColors.gridLine;
        ctx.beginPath();
        for (let x = width - PIXELS_PER_HORIZONTAL_DIV; x > 0; x -= PIXELS_PER_HORIZONTAL_DIV) {
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
        }
        ctx.stroke();
        for (let div = 0; div <= NUM_VERTICAL_DIVS; ++div) {
            ctx.lineWidth = div === NUM_VERTICAL_DIVS ? 3 : 1;
            ctx.strokeStyle = div === NUM_VERTICAL_DIVS ? 'yellow' : scopeColors.gridLine;
            ctx.beginPath();
            ctx.moveTo(0, height * div / NUM_VERTICAL_DIVS);
            ctx.lineTo(width, height * div / NUM_VERTICAL_DIVS);
            ctx.stroke();
        }

    }

    public static drawTrace(
        config: TraceConfig, data: number[], ctx: CanvasRenderingContext2D, width: number, height: number
    ) {
        ctx.strokeStyle = config.wavecolor;
        ctx.lineWidth = scopeColors.lineWidth;
        ctx.beginPath();
        const dataOffset = width - (data.length - 1);
        for (let x = width; x >= 0 && x >= dataOffset; --x) {
            const valueDivs = (data[x - dataOffset] - config.visualOffset) / config.perDiv;
            const valuePixels = valueDivs * height / NUM_VERTICAL_DIVS;
            // Canvas coords have 0 at the top, so we need to invert here
            const y = height - valuePixels;
            if (x == width) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();
    }
}
