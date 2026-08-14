import React, {ReactElement} from "react";
import {Button, Dropdown} from "react-bootstrap";
import {CoilID} from "../../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";
import {TTDropdown} from "../../TTDropdown";
import MIDIInput = WebMidi.MIDIInput;

export interface MidiSelectProps {
    coil?: CoilID;
}

interface MidiSelectState {
    access?: WebMidi.MIDIAccess;
    currentInput?: WebMidi.MIDIInput;
}

export class MidiSourceSelect extends TTComponent<MidiSelectProps, MidiSelectState> {
    constructor(props) {
        super(props);
        this.state = {};
    }

    public componentDidMount() {
        this.setupMidiAccess()
            .catch((e) => console.warn("Failed to get MIDI access:", e));
    }

    public render() {
        if (!this.state.access) {
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

    private selectInput(oldState: MidiSelectState, newInput?: MIDIInput): MIDIInput {
        if (oldState.currentInput) {
            oldState.currentInput.onmidimessage = undefined;
        }
        if (newInput) {
            const channel = this.props.coil !== undefined
                ? getToMainIPCPerCoil(this.props.coil).midiMessage
                : IPC_CONSTANTS_TO_MAIN.midiMessage;
            newInput.onmidimessage = (msg) => processIPC.send(channel, msg.data);
        }
        return newInput;
    }
}
