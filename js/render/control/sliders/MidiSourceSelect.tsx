import React, {ReactElement} from "react";
import {Button, Dropdown} from "react-bootstrap";
import {CoilID} from "../../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../../common/IPCConstantsToRenderer";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";
import {TTDropdown} from "../../TTDropdown";
import MIDIInput = WebMidi.MIDIInput;

export interface MidiSelectProps {
    coil?: CoilID;
}

// A fake "device" offered only while testing via the coil simulation feature (Settings ->
// "Simulate coils") - there is no real hardware/Web MIDI port behind it. Once selected it fires a
// slow, fixed note pulse on its own, so picking a different simulated device per coil tab is
// actually verifiable (via each coil's "MIDI notes received" meter) without owning any hardware.
class SimulatedMidiInput {
    public readonly name: string;
    public onmidimessage: ((msg: { data: Uint8Array }) => void) | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;

    constructor(name: string) {
        this.name = name;
    }

    public start() {
        this.timer = setInterval(() => {
            this.onmidimessage?.({data: new Uint8Array([0x90, 60, 100])});
            setTimeout(() => this.onmidimessage?.({data: new Uint8Array([0x80, 60, 0])}), 200);
        }, 1000);
    }

    public stop() {
        clearInterval(this.timer);
        this.timer = undefined;
    }
}

type SelectableInput = MIDIInput | SimulatedMidiInput;

interface MidiSelectState {
    access?: WebMidi.MIDIAccess;
    currentInput?: SelectableInput;
    simulatedDeviceName?: string;
}

export class MidiSourceSelect extends TTComponent<MidiSelectProps, MidiSelectState> {
    constructor(props) {
        super(props);
        this.state = {};
    }

    public componentDidMount() {
        this.setupMidiAccess()
            .catch((e) => console.warn("Failed to get MIDI access:", e));
        if (this.props.coil !== undefined) {
            this.addIPCListener(
                getToRenderIPCPerCoil(this.props.coil).simulatedMidiDeviceName,
                (simulatedDeviceName) => this.setState({simulatedDeviceName}),
            );
        }
    }

    public render() {
        if (!this.state.access && !this.state.simulatedDeviceName) {
            return <></>;
        }
        const items: ReactElement[] = [
            <Dropdown.Item
                as={Button}
                onClick={() => this.setState((state) => {
                    return {currentInput: this.selectInput(state, undefined)};
                })}
                key={'none'}
            >
                None
            </Dropdown.Item>,
        ];
        if (this.state.simulatedDeviceName) {
            const name = this.state.simulatedDeviceName;
            items.push(<Dropdown.Item
                as={Button}
                onClick={() => this.setState((state) => {
                    return {currentInput: this.selectInput(state, new SimulatedMidiInput(name))};
                })}
                key={'simulated'}
            >
                {name}
            </Dropdown.Item>);
        }
        if (this.state.access) {
            for (const input of this.state.access.inputs.values()) {
                items.push(<Dropdown.Item
                    as={Button}
                    onClick={() => this.setState((state) => {
                        return {currentInput: this.selectInput(state, input)};
                    })}
                    key={input.name}
                >
                    {input.name}
                </Dropdown.Item>);
            }
        }
        const title = (this.state.currentInput && this.state.currentInput.name) || 'Choose MIDI input';
        return (
            <TTDropdown title={title}>
                {items}
            </TTDropdown>
        );
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.selectInput(this.state, undefined);
        if (this.state.access) {
            this.state.access.onstatechange = undefined;
        }
    }


    private async setupMidiAccess() {
        const access = await navigator.requestMIDIAccess();
        this.setState({access});
        access.onstatechange = () => this.forceUpdate();
    }

    private selectInput(oldState: MidiSelectState, newInput?: SelectableInput): SelectableInput {
        if (oldState.currentInput) {
            oldState.currentInput.onmidimessage = undefined;
            if (oldState.currentInput instanceof SimulatedMidiInput) {
                oldState.currentInput.stop();
            }
        }
        if (newInput) {
            const channel = this.props.coil !== undefined
                ? getToMainIPCPerCoil(this.props.coil).midiMessage
                : IPC_CONSTANTS_TO_MAIN.midiMessage;
            newInput.onmidimessage = (msg) => processIPC.send(channel, msg.data);
            if (newInput instanceof SimulatedMidiInput) {
                newInput.start();
            }
        }
        return newInput;
    }
}
