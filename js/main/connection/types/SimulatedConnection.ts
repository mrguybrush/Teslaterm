import {CoilID, FEATURE_PROTOCOL_VERSION, LAST_SUPPORTED_PROTOCOL} from "../../../common/constants";
import {SimulatedConnectionOptions} from "../../../common/SingleConnectionOptions";
import {ipcs} from "../../ipc/IPCProvider";
import {ISidConnection} from "../../sid/ISidConnection";
import {resetResponseTimeout} from "../state/Connected";
import {updateStateFromTelemetry} from "../telemetry/UD3State";
import {UD3Connection} from "./UD3Connection";

// Matches the app's own "3-phase" nominal bus voltage (see RangeOverride.ts) - simulated coils
// always pretend to be 3-phase, so this is the number the Bus voltage gauge shows once a
// simulated coil's bus is switched on.
const SIMULATED_BUS_VOLTAGE = 600;

// Every simulated coil's fake MIDI device name, keyed by coil - broadcast as one flat list to
// every coil's MIDI input dropdown (not just the owning coil's), so any device can be freely
// assigned to any coil, exactly like real MIDI devices already work.
const activeSimulatedDevices: Map<CoilID, string> = new Map();

function broadcastSimulatedDevices() {
    ipcs.misc.sendSimulatedMidiDevices([...activeSimulatedDevices.values()]);
}

export function clearSimulatedMidiDevices() {
    activeSimulatedDevices.clear();
    broadcastSimulatedDevices();
}

// A MidiSourceSelect that mounts after some simulated devices already registered would otherwise
// never see them - broadcasts are only delivered to listeners that were already subscribed at the
// time they went out. Newly-mounted dropdowns call this once to get caught up.
export function resendSimulatedMidiDevices() {
    broadcastSimulatedDevices();
}

export class SimulatedConnection extends UD3Connection {
    private readonly name: string;
    private readonly midiDeviceName: string;
    private busActive = false;
    private transientActive = false;
    private killBitSet = false;
    private midiNoteCount = 0;

    constructor(coil: CoilID, options: SimulatedConnectionOptions) {
        super(coil);
        this.name = options.name;
        this.midiDeviceName = options.midiDeviceName;
    }

    public async connect(): Promise<void> {
        ipcs.coilMisc(this.getCoil()).sendUDName(this.name);
        activeSimulatedDevices.set(this.getCoil(), this.midiDeviceName);
        broadcastSimulatedDevices();
        ipcs.meters(this.getCoil()).configure(0, 0, SIMULATED_BUS_VOLTAGE, 1, "Bus voltage");
        ipcs.meters(this.getCoil()).configure(1, 0, 999, 1, "MIDI notes received");
        // Gauge (justgage) crashes if it's ever asked to render before a first value has been
        // set for a configured meter - real coils always follow a GAUGE_CONF with a GAUGE value,
        // so this only ever showed up here where the "MIDI notes received" meter otherwise sits
        // at undefined until the first note arrives.
        ipcs.meters(this.getCoil()).setValue(1, 0);
        this.pushState();
    }

    public getFeatureValue(feature: string): string {
        // Real coils negotiate their protocol version over the wire; a simulated one just claims
        // to support the newest one this app knows about, so it passes the same multicoil-support
        // check a real coil would (see Connected.tickFast()).
        if (feature === FEATURE_PROTOCOL_VERSION) {
            return LAST_SUPPORTED_PROTOCOL.toFixed(1);
        }
        return super.getFeatureValue(feature);
    }

    // All the state-changing commands this app sends (bus on/off, tr start/stop, kill set/reset,
    // set pw/bon/boff/pwd/vol/synth, tterm start/stop, ...) go out as plain ASCII lines over
    // sendTelnet - so intercepting them here is enough to react like a real coil would, without
    // needing to simulate the actual binary UD3 protocol.
    public async sendTelnet(data: Buffer): Promise<void> {
        switch (data.toString().trim()) {
            case 'bus on':
                this.busActive = true;
                break;
            case 'bus off':
                this.busActive = false;
                this.transientActive = false;
                break;
            case 'tr start':
                this.transientActive = this.busActive;
                break;
            case 'tr stop':
                this.transientActive = false;
                break;
            case 'kill set':
                this.killBitSet = true;
                this.busActive = false;
                this.transientActive = false;
                break;
            case 'kill reset':
                this.killBitSet = false;
                break;
            default:
                // Everything else has no simulated hardware behind it to react to - silently
                // accepted, same as a real coil just applying a setting without talking back.
                break;
        }
        this.pushState();
    }

    public async sendMidi(data: Buffer): Promise<void> {
        // No synthesizer behind a simulated coil - but a Note On is still counted, so selecting
        // different simulated MIDI devices per coil tab is actually verifiable without hardware.
        const isNoteOn = (data[0] & 0xf0) === 0x90 && data[2] > 0;
        if (isNoteOn) {
            this.midiNoteCount++;
            ipcs.meters(this.getCoil()).setValue(1, this.midiNoteCount);
        }
    }

    public async sendVMSFrame(): Promise<void> {
        throw new Error('VMS is not supported for simulated connections');
    }

    public getSidConnection(): ISidConnection {
        return undefined;
    }

    public async sendDisconnectData(): Promise<void> {
    }

    public releaseResources(): void {
        activeSimulatedDevices.delete(this.getCoil());
        broadcastSimulatedDevices();
    }

    public resetWatchdog(): void {
    }

    public tick(): void {
        // Simulated coils never actually go quiet, so keep marking them as "just heard from" -
        // otherwise Connected.tickFast() would decide the connection was lost after 1 second.
        resetResponseTimeout(this.getCoil());
    }

    public getUDName(): string | undefined {
        return this.name;
    }

    protected async setSynthImpl(): Promise<void> {
    }

    private pushState() {
        const packedState =
            (this.busActive ? 1 : 0) |
            (this.transientActive ? 2 : 0) |
            4 | // busControllable - a simulated bus can always be switched on/off
            (this.killBitSet ? 8 : 0);
        updateStateFromTelemetry(this.getCoil(), packedState);
        ipcs.meters(this.getCoil()).setValue(0, this.busActive ? SIMULATED_BUS_VOLTAGE : 0);
    }
}

export function createSimulatedConnection(coil: CoilID, options: SimulatedConnectionOptions): UD3Connection {
    return new SimulatedConnection(coil, options);
}
