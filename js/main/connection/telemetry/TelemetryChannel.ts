import {TelemetryEvent} from "../../../common/constants";
import {MeterConfig} from "../../../common/IPCConstantsToRenderer";
import {TelemetryFrame} from "../../../common/TelemetryTypes";
import {DerivedTelemetry} from "./DerivedTelemetry";
import {TelemetryFrameParser} from "./TelemetryFrame";

enum TelemetryFrameState {
    idle,
    frame,
    collect,
}

export class TelemetryChannel {
    private frameParser: TelemetryFrameParser | undefined;
    private state: TelemetryFrameState = TelemetryFrameState.idle;
    // Per channel, so a replayed recording never inherits meter ids from the live connection.
    private readonly derived = new DerivedTelemetry();

    /**
     * Replaying a flight recording starts a brand new DerivedTelemetry with no memory of anything -
     * including a channel like Ontime_eff that was already configured (and is included in the
     * recording's own initial-meter-config snapshot) before the recording began. Without this, its
     * GAUGE_CONF byte would need to reoccur somewhere inside the recorded window for the derived
     * trace to ever exist, which most recordings that start well after connecting never see (a
     * meter is typically only configured once, right at connect) - and worse, every ordinary value
     * update for it in the meantime would be silently dropped too, since the chart update path
     * only mirrors a GAUGE_CONF-established meter id.
     *
     * Returns only the frames that actually matter for display - a derived CHART_CONF, when the
     * seeded config turns out to be Ontime_eff - not a copy of every ordinary meter's own config,
     * which is already covered independently by the recording's initial gauge state.
     */
    public primeFromKnownMeters(meterConfigs: MeterConfig[]): TelemetryFrame[] {
        const synthetic: TelemetryFrame[] = [];
        for (const config of meterConfigs) {
            if (!config) {
                continue;
            }
            const result = this.derived.transform({
                max: config.max,
                meterId: config.meterId,
                min: config.min,
                name: config.name,
                scale: config.scale,
                type: TelemetryEvent.GAUGE_CONF,
            });
            if (result.length > 1) {
                synthetic.push(result[1]);
            }
        }
        return synthetic;
    }

    public processBytes(bytes: Iterable<number>, print: (s: string) => void, handleFrame: (f: TelemetryFrame) => any) {
        for (const byte of bytes) {
            switch (this.state) {
                case TelemetryFrameState.idle:
                    if (byte === 0xff) {
                        this.state = TelemetryFrameState.frame;
                    } else {
                        const asString = String.fromCharCode(byte);
                        print(asString);
                    }
                    break;
                case TelemetryFrameState.frame:
                    this.frameParser = new TelemetryFrameParser(byte);
                    this.state = TelemetryFrameState.collect;
                    break;
                case TelemetryFrameState.collect:
                    const frame = this.frameParser.addByte(byte);
                    if (frame) {
                        for (const derivedFrame of this.derived.transform(frame)) {
                            handleFrame(derivedFrame);
                        }
                        this.frameParser = undefined;
                        this.state = TelemetryFrameState.idle;
                    }
                    break;
            }
        }
    }
}
