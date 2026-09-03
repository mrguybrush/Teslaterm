import React from "react";
import {
    DEFAULT_Q,
    EqPoint,
    gainPercentAt,
    MAX_FREQ_HZ,
    MAX_GAIN_PERCENT,
    MAX_Q,
    MIN_FREQ_HZ,
    MIN_GAIN_PERCENT,
    MIN_Q,
    UNITY_GAIN_PERCENT,
} from "../../common/MidiEqualizer";
import {TTComponent} from "../TTComponent";

export interface EqualizerCurveProps {
    points: EqPoint[];
    enabled: boolean;
    // `commit`: false while a drag/scroll is still in progress (the caller may throttle sending
    // this on to the main process); true for the final position of a drag, a discrete action
    // (add/remove, one wheel notch), or a keyboard delete - always send those on immediately.
    onChange: (points: EqPoint[], commit: boolean) => void;
}

interface EqualizerCurveState {
    width: number;
    height: number;
    selectedId?: number;
    hoveredId?: number;
}

const POINT_RADIUS = 7;
const HIT_RADIUS = 8;
// Round frequencies to label the grid with, filtered to the visible range at draw time.
const GRID_FREQUENCIES = [25, 50, 100, 200, 500, 1000, 2000, 4000];
const GRID_GAIN_STEPS = [0, 50, 100, 150, 200];

function freqToX(freq: number, width: number): number {
    const t = Math.log(freq / MIN_FREQ_HZ) / Math.log(MAX_FREQ_HZ / MIN_FREQ_HZ);
    return t * width;
}

function xToFreq(x: number, width: number): number {
    const t = Math.max(0, Math.min(1, x / width));
    return MIN_FREQ_HZ * Math.pow(MAX_FREQ_HZ / MIN_FREQ_HZ, t);
}

function gainToY(gainPercent: number, height: number): number {
    const t = (gainPercent - MIN_GAIN_PERCENT) / (MAX_GAIN_PERCENT - MIN_GAIN_PERCENT);
    return height * (1 - t);
}

function yToGain(y: number, height: number): number {
    const t = Math.max(0, Math.min(1, 1 - y / height));
    return MIN_GAIN_PERCENT + t * (MAX_GAIN_PERCENT - MIN_GAIN_PERCENT);
}

function formatFreq(freq: number): string {
    return freq >= 1000 ? `${(freq / 1000).toFixed(freq >= 10000 ? 0 : 1)}k` : freq.toFixed(0);
}

/**
 * A FabFilter-style curve: a draggable point per band (both axes free), scroll to change a point's
 * Q, double-click empty space to add one, right-click or Delete to remove the selected one. Not
 * built on CanvasComponent - that base class assumes a read-only canvas redrawn on prop/resize
 * changes only, where this one is driven by continuous local drag state and needs a wider set of
 * pointer events than its hooks cover.
 */
export class EqualizerCurve extends TTComponent<EqualizerCurveProps, EqualizerCurveState> {
    private readonly canvasRef = React.createRef<HTMLCanvasElement>();
    private readonly divRef = React.createRef<HTMLDivElement>();
    private readonly resizeObserver: ResizeObserver;
    private nextPointId = 1;
    // Set while a point is being dragged; not in React state since it needs to be read
    // synchronously from window-level listeners attached only for the drag's duration.
    private draggingId: number | undefined;

    public constructor(props: EqualizerCurveProps) {
        super(props);
        this.state = {height: 260, width: 800};
        this.resizeObserver = new ResizeObserver(() => this.syncSize());
    }

    public componentDidMount() {
        if (this.divRef.current) {
            this.resizeObserver.observe(this.divRef.current);
        }
        window.addEventListener('keydown', this.onWindowKeyDown);
        this.syncSize();
        this.draw();
    }

    public componentDidUpdate() {
        this.draw();
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.resizeObserver.disconnect();
        window.removeEventListener('mousemove', this.onWindowMouseMove);
        window.removeEventListener('mouseup', this.onWindowMouseUp);
        window.removeEventListener('keydown', this.onWindowKeyDown);
    }

    private syncSize() {
        const div = this.divRef.current;
        if (div && (div.offsetWidth !== this.state.width || div.offsetHeight !== this.state.height)) {
            this.setState({height: div.offsetHeight, width: div.offsetWidth});
        }
    }

    public render(): React.ReactNode {
        return <div className={'tt-eq-curve-container'} ref={this.divRef}>
            <canvas
                ref={this.canvasRef}
                className={'tt-eq-curve-canvas'}
                onMouseDown={(ev) => this.onMouseDown(ev)}
                onMouseMove={(ev) => this.onHoverMove(ev)}
                onMouseLeave={() => this.setState({hoveredId: undefined})}
                onDoubleClick={(ev) => this.onDoubleClick(ev)}
                onContextMenu={(ev) => this.onContextMenu(ev)}
                onWheel={(ev) => this.onWheel(ev)}
            />
        </div>;
    }

    private pointAt(clientX: number, clientY: number): {x: number, y: number} | undefined {
        const canvas = this.canvasRef.current;
        if (!canvas) {
            return undefined;
        }
        const rect = canvas.getBoundingClientRect();
        return {x: clientX - rect.left, y: clientY - rect.top};
    }

    private hitTest(x: number, y: number): EqPoint | undefined {
        const {width, height} = this.state;
        let best: {point: EqPoint, distance: number} | undefined;
        for (const point of this.props.points) {
            const px = freqToX(point.freqHz, width);
            const py = gainToY(point.gainPercent, height);
            const distance = Math.hypot(px - x, py - y);
            if (distance <= HIT_RADIUS + POINT_RADIUS && (!best || distance < best.distance)) {
                best = {distance, point};
            }
        }
        return best?.point;
    }

    private onMouseDown(ev: React.MouseEvent) {
        const pos = this.pointAt(ev.clientX, ev.clientY);
        if (!pos) {
            return;
        }
        const hit = this.hitTest(pos.x, pos.y);
        this.setState({selectedId: hit?.id});
        if (hit) {
            this.draggingId = hit.id;
            window.addEventListener('mousemove', this.onWindowMouseMove);
            window.addEventListener('mouseup', this.onWindowMouseUp);
        }
    }

    private readonly onWindowMouseMove = (ev: MouseEvent) => {
        if (this.draggingId === undefined) {
            return;
        }
        const pos = this.pointAt(ev.clientX, ev.clientY);
        if (!pos) {
            return;
        }
        const clampedX = Math.max(0, Math.min(this.state.width, pos.x));
        const clampedY = Math.max(0, Math.min(this.state.height, pos.y));
        const freqHz = xToFreq(clampedX, this.state.width);
        const gainPercent = yToGain(clampedY, this.state.height);
        const id = this.draggingId;
        this.props.onChange(
            this.props.points.map((p) => (p.id === id ? {...p, freqHz, gainPercent} : p)),
            false,
        );
    };

    private readonly onWindowMouseUp = () => {
        if (this.draggingId !== undefined) {
            // Guarantees the final position reaches the main process even if onChange's caller was
            // throttling the in-progress (commit=false) updates.
            this.props.onChange(this.props.points, true);
        }
        this.draggingId = undefined;
        window.removeEventListener('mousemove', this.onWindowMouseMove);
        window.removeEventListener('mouseup', this.onWindowMouseUp);
    };

    private readonly onWindowKeyDown = (ev: KeyboardEvent) => {
        if ((ev.key === 'Delete' || ev.key === 'Backspace') && this.state.selectedId !== undefined) {
            // Only when the focus isn't in some other input (e.g. the frequency/gain readout
            // fields a future revision might add) - harmless today, but keeps this from eating a
            // Backspace meant for actual text editing elsewhere on the page.
            const target = document.activeElement;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
                return;
            }
            this.removePoint(this.state.selectedId);
        }
    };

    private onHoverMove(ev: React.MouseEvent) {
        const pos = this.pointAt(ev.clientX, ev.clientY);
        if (!pos) {
            return;
        }
        const hit = this.hitTest(pos.x, pos.y);
        if (hit?.id !== this.state.hoveredId) {
            this.setState({hoveredId: hit?.id});
        }
    }

    private onDoubleClick(ev: React.MouseEvent) {
        const pos = this.pointAt(ev.clientX, ev.clientY);
        if (!pos || this.hitTest(pos.x, pos.y)) {
            return;
        }
        const point: EqPoint = {
            freqHz: xToFreq(pos.x, this.state.width),
            gainPercent: yToGain(pos.y, this.state.height),
            id: this.nextPointId++,
            q: DEFAULT_Q,
        };
        this.setState({selectedId: point.id});
        this.props.onChange([...this.props.points, point], true);
    }

    private onContextMenu(ev: React.MouseEvent) {
        ev.preventDefault();
        const pos = this.pointAt(ev.clientX, ev.clientY);
        const hit = pos && this.hitTest(pos.x, pos.y);
        if (hit) {
            this.removePoint(hit.id);
        }
    }

    private onWheel(ev: React.WheelEvent) {
        const pos = this.pointAt(ev.clientX, ev.clientY);
        const hit = pos && this.hitTest(pos.x, pos.y);
        if (!hit) {
            return;
        }
        ev.preventDefault();
        // Multiplicative, not additive, so the step feels equally sized whether Q is currently
        // small or large.
        const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
        const newQ = Math.max(MIN_Q, Math.min(MAX_Q, hit.q * factor));
        this.props.onChange(
            this.props.points.map((p) => (p.id === hit.id ? {...p, q: newQ} : p)),
            true,
        );
    }

    private removePoint(id: number) {
        this.props.onChange(this.props.points.filter((p) => p.id !== id), true);
        if (this.state.selectedId === id) {
            this.setState({selectedId: undefined});
        }
    }

    private draw() {
        const canvas = this.canvasRef.current;
        if (!canvas) {
            return;
        }
        const {width, height} = this.state;
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        ctx.fillStyle = '#1c1c1c';
        ctx.fillRect(0, 0, width, height);

        this.drawGrid(ctx, width, height);
        this.drawCurve(ctx, width, height);
        this.drawPoints(ctx, width, height);
    }

    private drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number) {
        ctx.font = '10px sans-serif';
        ctx.lineWidth = 1;
        for (const freq of GRID_FREQUENCIES) {
            if (freq < MIN_FREQ_HZ || freq > MAX_FREQ_HZ) {
                continue;
            }
            const x = freqToX(freq, width);
            ctx.strokeStyle = '#3a3a3a';
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            ctx.fillStyle = '#888';
            ctx.fillText(`${formatFreq(freq)} Hz`, x + 3, height - 4);
        }
        for (const gain of GRID_GAIN_STEPS) {
            const y = gainToY(gain, height);
            ctx.strokeStyle = gain === UNITY_GAIN_PERCENT ? '#666' : '#3a3a3a';
            ctx.lineWidth = gain === UNITY_GAIN_PERCENT ? 2 : 1;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
            ctx.fillStyle = '#888';
            ctx.fillText(`${gain}%`, 3, y - 3);
        }
    }

    private drawCurve(ctx: CanvasRenderingContext2D, width: number, height: number) {
        const {points, enabled} = this.props;
        ctx.beginPath();
        for (let x = 0; x <= width; x++) {
            const gain = gainPercentAt(points, xToFreq(x, width));
            const y = gainToY(gain, height);
            if (x === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.strokeStyle = enabled ? '#e0b400' : '#5a5a5a';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineTo(width, height);
        ctx.lineTo(0, height);
        ctx.closePath();
        ctx.fillStyle = enabled ? 'rgba(224, 180, 0, 0.12)' : 'rgba(255, 255, 255, 0.04)';
        ctx.fill();
    }

    private drawPoints(ctx: CanvasRenderingContext2D, width: number, height: number) {
        for (const point of this.props.points) {
            const x = freqToX(point.freqHz, width);
            const y = gainToY(point.gainPercent, height);
            const active = point.id === this.state.selectedId || point.id === this.state.hoveredId
                || point.id === this.draggingId;

            ctx.beginPath();
            ctx.arc(x, y, active ? POINT_RADIUS + 2 : POINT_RADIUS, 0, Math.PI * 2);
            ctx.fillStyle = this.props.enabled ? '#4dc3ff' : '#8a8a8a';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = active ? '#ffffff' : '#0c0c0c';
            ctx.stroke();

            if (active) {
                const label =
                    `${formatFreq(point.freqHz)} Hz   ${point.gainPercent.toFixed(0)}%   Q ${point.q.toFixed(2)}`;
                ctx.font = 'bold 11px sans-serif';
                const textWidth = ctx.measureText(label).width;
                const labelX = Math.min(Math.max(x - textWidth / 2, 2), width - textWidth - 2);
                const labelY = y > 20 ? y - 14 : y + 24;
                ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
                ctx.fillRect(labelX - 4, labelY - 11, textWidth + 8, 16);
                ctx.fillStyle = '#fff';
                ctx.fillText(label, labelX, labelY);
            }
        }
    }
}
