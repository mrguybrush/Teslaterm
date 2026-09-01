/**
 * The scope's trace colours, indexed by trace id.
 *
 * Kept here rather than next to the renderer's scope code because the stored UI config needs the
 * same list: it used to carry its own hard-coded copy in UIConfigHandler, which silently left the
 * palette one colour short of the traces that actually existed, so the newest trace fell back to
 * trace 0's red.
 */
export const DEFAULT_TRACE_COLORS: string[] = [
    "#ff3b3b",
    "#ffb703",
    "#00d68f",
    "#0d7fc4",
    "#a64dd6",
    // Trace 5 is the Ontime_eff curve derived from its dial (see DerivedTelemetry).
    "#00a8a8",
    // NUM_TRACES in Oscilloscope.tsx allows one more than the firmware currently assigns, so this
    // last slot has a colour of its own ready rather than repeating red if it is ever used.
    "#e06c00",
];
