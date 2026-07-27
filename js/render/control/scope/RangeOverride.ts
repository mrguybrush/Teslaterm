import {ScopeTraceConfig} from "../../../common/IPCConstantsToRenderer";
import {NUM_VERTICAL_DIVS} from "./Trace";

// Shared between the live Oscilloscope and the flight-recording playback Telemetry tab, so both
// show scope traces at the same (more useful than the firmware's raw defaults) scale.
export function applyRangeOverride(cfg: ScopeTraceConfig, voltagePhases: number | undefined): ScopeTraceConfig {
    if (cfg.unit === 'V' && voltagePhases) {
        const max = voltagePhases === 3 ? 600 : 350;
        return {...cfg, max, min: 0};
    }
    if (cfg.unit === 'kW') {
        // 1 kW/div instead of the firmware's theoretical-max-derived scale, which is far too
        // coarse for the power levels this coil actually draws.
        return {...cfg, max: 10, min: 0};
    }
    if (cfg.unit === 'kHz') {
        // 10 kHz/div instead of the firmware's default 50 kHz/div.
        return {...cfg, max: 100, min: 0};
    }
    return cfg;
}

// Voltage is the only override that depends on a value (voltagePhases) that can change live after
// a trace was already configured, so already-built TraceConfigs need to be able to pick up a new
// per-div scale without a fresh ScopeTraceConfig from the firmware.
export function voltagePerDivFor(voltagePhases: number | undefined): number {
    const max = voltagePhases === 3 ? 600 : 350;
    return max / NUM_VERTICAL_DIVS;
}
