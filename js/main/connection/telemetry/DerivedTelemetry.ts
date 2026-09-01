import {TelemetryEvent} from "../../../common/constants";
import {TelemetryFrame} from "../../../common/TelemetryTypes";

/**
 * Whether a telemetry value shows up as a dial or as a scope trace is decided by the UD3 firmware
 * (the `.chart`/`.gauge` fields in tsk_overlay.c), and Ontime_eff arrives as a dial only. It is far
 * more useful as a curve over time, so its updates are mirrored into a scope trace here instead of
 * requiring a firmware rebuild and reflash - which would also leave every recording made before
 * that flash without the trace.
 *
 * Nothing is dropped here: channels that should not get a dial of their own are still needed by the
 * GDT panel, which looks meters up by name, so they are filtered where dials are drawn instead -
 * see isShownAsDial in common/TelemetryVisibility.
 *
 * This lives in TelemetryChannel, the one point the live connection and the flight-recording parser
 * both pass through, so the live scope and recorded sessions (old ones included) behave the same.
 */

const CHARTED_METER = 'Ontime_eff';
// The firmware assigns traces 0-4 itself; NUM_TRACES in Oscilloscope.tsx allows 7.
const DERIVED_TRACE_ID = 5;
// Only used until the UD3 reports its real limit in a state sync, which happens on connect.
const FALLBACK_MAX_ONTIME_US = 1000;

export class DerivedTelemetry {
    private chartedMeterId?: number;
    // The raw counts the UD3 sends are in tenths of a microsecond; the dial's scale is what turns
    // them into the displayed value, and the trace has to divide by exactly the same amount.
    private chartedScale: number = 1;
    private maxOntimeUs: number = FALLBACK_MAX_ONTIME_US;

    /** Returns what to emit in place of `frame`: it alone, it plus a derived frame, or nothing. */
    public transform(frame: TelemetryFrame): TelemetryFrame[] {
        switch (frame.type) {
            case TelemetryEvent.GAUGE_CONF:
            case TelemetryEvent.GAUGE32_CONF:
                if (frame.name === CHARTED_METER) {
                    this.chartedMeterId = frame.meterId;
                    this.chartedScale = frame.scale;
                    return [frame, this.makeTraceConfig()];
                }
                return [frame];
            case TelemetryEvent.GAUGE:
            case TelemetryEvent.GAUGE32:
                if (frame.index === this.chartedMeterId) {
                    return [frame, {type: TelemetryEvent.CHART, index: DERIVED_TRACE_ID, value: frame.value}];
                }
                return [frame];
            case TelemetryEvent.STATE_SYNC:
                // maxPw is the coil's configured maximum ontime, which is exactly the range an
                // ontime trace wants - the dial's own maximum is the interrupter period ceiling and
                // would leave a typical ontime as a flat line along the bottom of the scope.
                if (frame.maxPw !== undefined && frame.maxPw > 0 && frame.maxPw !== this.maxOntimeUs) {
                    this.maxOntimeUs = frame.maxPw;
                    if (this.chartedMeterId !== undefined) {
                        return [frame, this.makeTraceConfig()];
                    }
                }
                return [frame];
            default:
                return [frame];
        }
    }

    private makeTraceConfig(): TelemetryFrame {
        return {
            config: {
                div: this.chartedScale,
                id: DERIVED_TRACE_ID,
                max: this.maxOntimeUs,
                min: 0,
                name: CHARTED_METER,
                offset: 0,
                unit: 'us',
            },
            type: TelemetryEvent.CHART_CONF,
        };
    }
}
