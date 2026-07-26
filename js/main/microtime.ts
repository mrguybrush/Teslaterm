export function now(): number {
    const now_bigint = process.hrtime.bigint();
    return Number((now_bigint) / BigInt(1000));
}

// `process.hrtime` is relative to an arbitrary, implementation-defined reference point - on some
// platforms that's system boot, not process start, so raw microsecond values can already be huge
// by the time this app is even opened. That matters because the flight recorder stores timestamps
// in a 32-bit field (see FlightRecorder.ts), which silently wraps around every ~71.6 minutes of
// that value. Rebasing against a fixed point captured once at app start keeps values small (just
// this session's uptime) instead of wrapping unpredictably mid-recording.
const START_US = now();

export function nowRelative(): number {
    return now() - START_US;
}
