import React from "react";
import {Button, Form} from "react-bootstrap";
import {CoilID} from "../../../common/constants";
import {getToMainIPCPerCoil} from "../../../common/IPCConstantsToMain";
import {getToRenderIPCPerCoil} from "../../../common/IPCConstantsToRenderer";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";

export interface TrPwEditorProps {
    coil: CoilID;
    disabled: boolean;
}

interface TrPwEditorState {
    value: string;
    saved: boolean;
}

const PARAM_NAME = "max_tr_pw";

export class TrPwEditor extends TTComponent<TrPwEditorProps, TrPwEditorState> {
    private savedTimeout: ReturnType<typeof setTimeout>;

    constructor(props: TrPwEditorProps) {
        super(props);
        this.state = {saved: false, value: ""};
    }

    public componentDidMount() {
        const channels = getToRenderIPCPerCoil(this.props.coil);
        this.addIPCListener(channels.singleConfigValue, (option) => {
            if (option.name === PARAM_NAME) {
                this.setState({value: option.current});
            }
        });
        // Also pick up the value passively if the user opens the full Settings dialog.
        this.addIPCListener(channels.udConfig, (options) => {
            const match = options.find((o) => o.name === PARAM_NAME);
            if (match) {
                this.setState({value: match.current});
            }
        });
        // requestConfig() now has a timeout safety net (see TelemetryFrame.ts), so an
        // auto-load on mount can no longer permanently stall the shared config queue.
        this.requestValue();
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        clearTimeout(this.savedTimeout);
    }

    public render(): React.ReactNode {
        return <div className={"tt-tr-pw-row"}>
            <Form.Label>max_tr_pw</Form.Label>
            <Form.Control
                type={"number"}
                size={"sm"}
                value={this.state.value}
                disabled={this.props.disabled}
                onChange={(ev) => this.setState({value: ev.target.value})}
            />
            <Button
                size={"sm"}
                variant={"secondary"}
                disabled={this.props.disabled}
                onClick={() => this.requestValue()}
            >
                Load
            </Button>
            <Button
                size={"sm"}
                variant={this.state.saved ? "success" : "secondary"}
                disabled={this.props.disabled}
                onClick={() => this.save()}
            >
                Save
            </Button>
        </div>;
    }

    private requestValue() {
        processIPC.send(getToMainIPCPerCoil(this.props.coil).menu.requestSingleConfig, PARAM_NAME);
    }

    private save() {
        const coilIPC = getToMainIPCPerCoil(this.props.coil);
        const changes = new Map<string, string>([[PARAM_NAME, this.state.value]]);
        processIPC.send(coilIPC.commands.setParms, changes);
        processIPC.send(coilIPC.commands.saveEEPROM, undefined);
        clearTimeout(this.savedTimeout);
        this.setState({saved: true});
        this.savedTimeout = setTimeout(() => this.setState({saved: false}), 1200);
    }
}
