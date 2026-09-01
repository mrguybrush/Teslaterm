/**
 * Channels the UD3 sends that should not be drawn, even though the telemetry itself has to keep
 * flowing: the GDT panel looks meters up by name, so nothing can simply be dropped from the stream
 * (see DerivedTelemetry) - it can only be left out where dials and traces are actually built. Both
 * the live view and the recording view go through these, so they stay consistent, and the exported
 * video inherits it from the recording view's own trace list.
 */

// Period_eff/Pulse_eff (two spellings of the same channel - the firmware sources use the latter,
// older flashed builds send the former) exist to feed the GDT panel, not to be read off a dial.
// Power is computed in the firmware as batt_i * bus_v / 10 and does not currently read correctly,
// so it stays out of the display until that is sorted out.
const NOT_SHOWN_AS_DIAL = ['Period_eff', 'Pulse_eff', 'Power'];
const NOT_SHOWN_AS_TRACE = ['Power'];

export function isShownAsDial(name: string | undefined): boolean {
    return name !== undefined && !NOT_SHOWN_AS_DIAL.includes(name);
}

export function isShownAsTrace(name: string | undefined): boolean {
    return name !== undefined && !NOT_SHOWN_AS_TRACE.includes(name);
}
