import React from "react";
import {CoilID} from "../../common/constants";
import {getToRenderIPCPerCoil, MeterConfig, SetMeters} from "../../common/IPCConstantsToRenderer";
import {TTComponent} from "../TTComponent";

// The UD3 sends these as ordinary meters. They are looked up by name rather than by meter id so a
// reshuffle of the gauge slots in the firmware does not silently point this panel at the wrong
// channel. Ontime_eff and Pulse_eff are read straight out of int1_prd/int1_cmp, i.e. after the
// duty limiter, the compressor and every clamp - they are what the coil actually switches.
const METER_ONTIME = 'Ontime_eff';
// Named Pulse_eff, not Period_eff: the register holds offtime + ontime, not the note spacing.
const METER_PULSE = 'Pulse_eff';
const METER_DUTY = 'Dutycycle';
const METER_FRES = 'Fres';

interface GDTPanelProps {
    coil: CoilID;
    visible: boolean;
}

interface GDTPanelState {
    // microseconds
    ontime: number;
    // offtime + ontime, i.e. the pulse itself
    pulse: number;
    // percent, used to derive the note spacing
    duty: number;
    // kHz
    fres: number;
    // how much of the pulse period the window shows, 1 = everything
    zoom: number;
    // left edge of the window, in microseconds from the start of the pulse
    offset: number;
    cursorUs?: number;
    everReceived: boolean;
}

// Named ids resolved from the config messages, so values can be routed without hardcoding slots
interface MeterIds {
    [id: number]: string;
}

const PLOT_W = 900;
const ROW_H = 54;
const GAP = 18;
const LEFT = 62;
const RIGHT = 16;
const TOP = 18;

export class GDTPanel extends TTComponent<GDTPanelProps, GDTPanelState> {
    private meterNames: MeterIds = {};
    private svgRef = React.createRef<SVGSVGElement>();

    constructor(props: GDTPanelProps) {
        super(props);
        this.state = {
            everReceived: false,
            fres: 0,
            duty: 0,
            offset: 0,
            ontime: 0,
            pulse: 0,
            zoom: 1,
        };
    }

    public componentDidMount() {
        const channels = getToRenderIPCPerCoil(this.props.coil);
        this.addIPCListener(channels.meters.configure, (config: MeterConfig) => {
            this.meterNames[config.meterId] = config.name;
        });
        this.addIPCListener(channels.meters.setValue, (update: SetMeters) => {
            const next: Partial<GDTPanelState> = {};
            for (const [idText, raw] of Object.entries(update.values)) {
                const name = this.meterNames[Number(idText)];
                // Both time channels are sent in 10ths of a microsecond, Fres in 10ths of a kHz
                if (name === METER_ONTIME) {
                    next.ontime = raw / 10;
                    next.everReceived = true;
                } else if (name === METER_PULSE) {
                    next.pulse = raw / 10;
                } else if (name === METER_DUTY) {
                    next.duty = raw / 10;
                } else if (name === METER_FRES) {
                    next.fres = raw / 10;
                }
            }
            if (Object.keys(next).length > 0) {
                this.setState(next as GDTPanelState);
            }
        });
    }

    public render(): React.ReactNode {
        if (!this.props.visible) {
            return <></>;
        }
        const {zoom, everReceived} = this.state;

        if (!everReceived) {
            return <div className={'tt-gdt-panel'}>
                <div className={'tt-gdt-hint'}>
                    Waiting for the UD3 to report its switching times. This panel needs firmware
                    that sends the <code>Ontime_eff</code> and <code>Pulse_eff</code> channels.
                </div>
            </div>;
        }

        const span = this.spanUs();
        const windowUs = Math.max(span * zoom, 0.2);
        const offset = Math.min(this.state.offset, Math.max(span - windowUs, 0));
        const toX = (us: number) => LEFT + ((us - offset) / windowUs) * (PLOT_W - LEFT - RIGHT);

        const height = TOP + 2 * ROW_H + GAP + 46;

        return <div className={'tt-gdt-panel'}>
            {this.renderReadout()}
            <div className={'tt-gdt-plot'}>
                <svg
                    ref={this.svgRef}
                    viewBox={`0 0 ${PLOT_W} ${height}`}
                    preserveAspectRatio={'none'}
                    onMouseMove={(e) => this.onMove(e, windowUs, offset)}
                    onMouseLeave={() => this.setState({cursorUs: undefined})}
                    onWheel={(e) => this.onWheel(e, windowUs, offset)}
                >
                    {this.renderGrid(toX, windowUs, offset, height)}
                    {this.renderGate(toX, 'GDT1', TOP, false)}
                    {this.renderGate(toX, 'GDT2', TOP + ROW_H + GAP, true)}
                    {this.renderCursor(toX, height)}
                </svg>
            </div>
            {this.renderControls(windowUs)}
        </div>;
    }

    // How much time the plot covers when fully zoomed out. The UD3 reports the pulse itself
    // (offtime + ontime), not the gap to the next note, so the repetition period is derived from
    // the duty cycle where that is available - otherwise there is nothing but the pulse to show.
    private spanUs(): number {
        const {ontime, duty} = this.state;
        if (duty > 0 && ontime > 0) {
            return Math.max(ontime / (duty / 100), this.state.pulse);
        }
        return Math.max(this.state.pulse, 1);
    }

    private renderReadout() {
        const {ontime, pulse, duty, fres} = this.state;
        const span = this.spanUs();
        const cycleUs = fres > 0 ? 1000 / fres : 0;
        const cycles = cycleUs > 0 ? ontime / cycleUs : 0;
        const cell = (k: string, v: string) => <div>
            <div className={'k'}>{k}</div>
            <div className={'v'}>{v}</div>
        </div>;
        return <div className={'tt-gdt-readout'}>
            {cell('Ontime', ontime.toFixed(1) + ' µs')}
            {cell('Offtime', Math.max(pulse - ontime, 0).toFixed(1) + ' µs')}
            {/* derived from the duty, since the UD3 reports the pulse and not the note spacing */}
            {cell('Note period', duty > 0 ? span.toFixed(0) + ' µs' : '—')}
            {cell('Note rate', duty > 0 && span > 0 ? (1e6 / span).toFixed(0) + ' Hz' : '—')}
            {cell('Duty', duty > 0 ? duty.toFixed(1) + ' %' : '—')}
            {cell('Fres', fres > 0 ? fres.toFixed(1) + ' kHz' : '—')}
            {cell('Cycles', cycles > 0 ? cycles.toFixed(1) : '—')}
        </div>;
    }

    private renderGrid(toX: (us: number) => number, windowUs: number, offset: number, height: number) {
        const step = niceStep(windowUs / 6);
        const lines: React.JSX.Element[] = [];
        const first = Math.ceil(offset / step) * step;
        for (let t = first; t <= offset + windowUs + 1e-9; t += step) {
            const x = toX(t);
            lines.push(<line key={'g' + t} x1={x} x2={x} y1={TOP - 6} y2={height - 30} className={'tt-gdt-grid'}/>);
            lines.push(<text key={'t' + t} x={x} y={height - 14} textAnchor={'middle'} className={'tt-gdt-axis'}>
                {formatUs(t)}
            </text>);
        }
        return <g>{lines}</g>;
    }

    // One gate transformer: a burst of square waves lasting the ontime, then nothing until the
    // next pulse. GDT2 is the opposite half of the bridge, so it is inverted against GDT1.
    private renderGate(toX: (us: number) => number, label: string, y: number, invert: boolean) {
        const {ontime, fres} = this.state;
        const cycleUs = fres > 0 ? 1000 / fres : 0;
        const top = y + 6;
        const bottom = y + ROW_H - 10;

        let d: string;
        if (cycleUs <= 0 || ontime <= 0) {
            d = `M${toX(0)} ${bottom} L${toX(this.spanUs())} ${bottom}`;
        } else {
            const pts: string[] = [];
            let level = invert ? bottom : top;
            pts.push(`M${toX(0)} ${level}`);
            // half a resonant cycle per switch state
            const half = cycleUs / 2;
            let t = 0;
            let guard = 0;
            while (t < ontime && guard++ < 4000) {
                const next = Math.min(t + half, ontime);
                pts.push(`L${toX(next)} ${level}`);
                if (next < ontime) {
                    level = level === top ? bottom : top;
                    pts.push(`L${toX(next)} ${level}`);
                }
                t = next;
            }
            // after the burst both halves rest low until the next pulse
            pts.push(`L${toX(ontime)} ${bottom}`);
            pts.push(`L${toX(this.spanUs())} ${bottom}`);
            d = pts.join(' ');
        }

        return <g>
            <text x={LEFT - 10} y={y + ROW_H / 2} textAnchor={'end'} className={'tt-gdt-label'}>{label}</text>
            <rect
                x={toX(0)} y={top - 4}
                width={Math.max(toX(ontime) - toX(0), 0)} height={ROW_H - 12}
                className={'tt-gdt-burst'}
            />
            <path d={d} className={'tt-gdt-trace'}/>
        </g>;
    }

    private renderCursor(toX: (us: number) => number, height: number) {
        const {cursorUs} = this.state;
        if (cursorUs === undefined) {
            return <></>;
        }
        const x = toX(cursorUs);
        return <g>
            <line x1={x} x2={x} y1={TOP - 6} y2={height - 30} className={'tt-gdt-cursor'}/>
            <text x={x + 5} y={TOP + 4} className={'tt-gdt-cursor-text'}>{formatUs(cursorUs)}</text>
        </g>;
    }

    private renderControls(windowUs: number) {
        const {zoom} = this.state;
        const maxOffset = Math.max(this.spanUs() - windowUs, 0);
        return <div style={{display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap', marginTop: '4px'}}>
            <label style={{display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px'}}>
                Zoom
                <input
                    type={'range'} min={-4} max={0} step={0.02}
                    value={Math.log10(zoom)}
                    onChange={(e) => this.setState({zoom: Math.pow(10, e.target.valueAsNumber)})}
                    style={{width: '190px'}}
                />
                <span style={{fontFamily: 'monospace'}}>{formatUs(windowUs)} window</span>
            </label>
            <label style={{display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', flex: '1 1 220px'}}>
                Pan
                <input
                    type={'range'} min={0} max={Math.max(maxOffset, 0.0001)} step={Math.max(maxOffset / 500, 1e-6)}
                    value={Math.min(this.state.offset, maxOffset)}
                    onChange={(e) => this.setState({offset: e.target.valueAsNumber})}
                    disabled={maxOffset <= 0}
                    style={{flex: 1}}
                />
            </label>
            <button
                type={'button'} className={'btn btn-secondary btn-sm'}
                onClick={() => this.setState({zoom: 1, offset: 0})}
            >Fit</button>
        </div>;
    }

    private onMove(e: React.MouseEvent, windowUs: number, offset: number) {
        const svg = this.svgRef.current;
        if (!svg) {
            return;
        }
        const rect = svg.getBoundingClientRect();
        const vx = ((e.clientX - rect.left) / rect.width) * PLOT_W;
        if (vx < LEFT || vx > PLOT_W - RIGHT) {
            this.setState({cursorUs: undefined});
            return;
        }
        this.setState({cursorUs: offset + ((vx - LEFT) / (PLOT_W - LEFT - RIGHT)) * windowUs});
    }

    // Wheel zooms around the pointer, which is what makes finding a single edge bearable
    private onWheel(e: React.WheelEvent, windowUs: number, offset: number) {
        const svg = this.svgRef.current;
        if (!svg) {
            return;
        }
        const rect = svg.getBoundingClientRect();
        const vx = ((e.clientX - rect.left) / rect.width) * PLOT_W;
        const frac = Math.min(Math.max((vx - LEFT) / (PLOT_W - LEFT - RIGHT), 0), 1);
        const anchor = offset + frac * windowUs;
        const factor = e.deltaY > 0 ? 1.25 : 0.8;
        const newZoom = Math.min(Math.max(this.state.zoom * factor, 1e-4), 1);
        const newWindow = Math.max(this.spanUs() * newZoom, 0.2);
        const newOffset = Math.min(Math.max(anchor - frac * newWindow, 0), Math.max(this.spanUs() - newWindow, 0));
        this.setState({offset: newOffset, zoom: newZoom});
    }
}

function niceStep(raw: number): number {
    const p = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const r = (raw || 1) / p;
    return (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10) * p;
}

function formatUs(us: number): string {
    if (Math.abs(us) >= 1000) {
        return (us / 1000).toFixed(2) + ' ms';
    }
    if (Math.abs(us) >= 1) {
        return us.toFixed(2) + ' µs';
    }
    return (us * 1000).toFixed(0) + ' ns';
}
