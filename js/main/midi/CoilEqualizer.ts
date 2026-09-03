import {CoilID} from "../../common/constants";
import {getToRenderIPCPerCoil} from "../../common/IPCConstantsToRenderer";
import {defaultEqState, EqPoint, MidiEqState} from "../../common/MidiEqualizer";
import {processIPC} from "../ipc/IPCProvider";

// Session-only, like the MIDI input port selection elsewhere in the app - it already resets on
// every restart, and giving the equalizer the same behaviour avoids a stored per-coil identity
// this app otherwise doesn't need to track.
const stateByCoil = new Map<CoilID, MidiEqState>();

export function getEqState(coil: CoilID): MidiEqState {
    let state = stateByCoil.get(coil);
    if (!state) {
        state = defaultEqState();
        stateByCoil.set(coil, state);
    }
    return state;
}

export function sendEqState(coil: CoilID) {
    processIPC.send(getToRenderIPCPerCoil(coil).equalizer.state, getEqState(coil));
}

export function setEqEnabled(coil: CoilID, enabled: boolean) {
    getEqState(coil).enabled = enabled;
    sendEqState(coil);
}

export function setEqPoints(coil: CoilID, points: EqPoint[]) {
    getEqState(coil).points = points;
    sendEqState(coil);
}
