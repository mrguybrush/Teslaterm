/**
 * Some channels the UD3 sends as ordinary meters are not worth a dial of their own - they exist to
 * feed a panel rather than to be read off a dial. They cannot simply be dropped from the telemetry
 * stream: the GDT panel looks meters up by name, so the meter has to keep arriving and can only be
 * left out where dials are actually drawn (the live gauges, the recording view, and the exported
 * video, all of which go through this).
 */

// Both spellings: the firmware sources call it Pulse_eff, older flashed builds send Period_eff.
const NOT_SHOWN_AS_DIAL = ['Period_eff', 'Pulse_eff'];

export function isShownAsDial(name: string | undefined): boolean {
    return name !== undefined && !NOT_SHOWN_AS_DIAL.includes(name);
}
