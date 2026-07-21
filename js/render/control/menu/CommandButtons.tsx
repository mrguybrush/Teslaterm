import React from "react";
import {Button, ButtonGroup, Modal} from "react-bootstrap";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {IUD3State} from "../../../common/IPCConstantsToRenderer";
import {processIPC} from "../../ipc/IPCProvider";
import {TTComponent} from "../../TTComponent";
import {TabControlLevel} from "../SingleCoilTab";

interface CommandButtonsState {
    warningText?: string;
    onOk?: () => any;
    discharging: boolean;
}

export interface CommandButtonsProps {
    level: TabControlLevel;
    udState?: IUD3State;
    disabled: boolean;
    size?: 'sm' | 'lg';
    showKill?: boolean;
    onDischarge?: () => void;
}

export class CommandButtons extends TTComponent<CommandButtonsProps, CommandButtonsState> {
    constructor(props: CommandButtonsProps) {
        super(props);
        this.state = {discharging: false};
    }

    public render(): React.ReactNode {
        const coilIPC = this.props.level.level !== 'central-control' ?
            getToMainIPCPerCoil(this.props.level.coil) :
            undefined;
        const combined = coilIPC ? coilIPC : IPC_CONSTANTS_TO_MAIN;
        const size = this.props.size || 'sm';

        const buttons: React.JSX.Element[] = [];

        // Bus Control Buttons
        if (!this.props.udState || this.props.udState.busControllable) {
            if (!this.props.udState || this.props.udState.busActive) {
                buttons.push(
                    <Button
                        key="bus-off"
                        variant="success"
                        size={size}
                        onClick={() => {
                            this.setState({discharging: false});
                            processIPC.send(combined.commands.setBusState, false);
                        }}
                        disabled={this.props.disabled}
                    >
                        Bus off
                    </Button>
                );
            }
            if (!this.props.udState || !this.props.udState.busActive) {
                buttons.push(
                    <Button
                        key="bus-on"
                        variant="secondary"
                        size={size}
                        onClick={() => {
                            this.setState({
                                discharging: false,
                                onOk: () => processIPC.send(combined.commands.setBusState, true),
                                warningText: 'The coil will be energized',
                            });
                        }}
                        disabled={this.props.disabled}
                    >
                        Bus on
                    </Button>
                );
            }
        }

        // TR Control Buttons
        if (!this.props.udState || this.props.udState.transientActive) {
            buttons.push(
                <Button
                    key="tr-stop"
                    variant="success"
                    size={size}
                    onClick={() => {
                        this.setState({discharging: false});
                        processIPC.send(combined.commands.setTRState, false);
                    }}
                    disabled={this.props.disabled}
                >
                    TR stop
                </Button>
            );
        }
        if (!this.props.udState || !this.props.udState.transientActive) {
            buttons.push(
                <Button
                    key="tr-start"
                    variant="secondary"
                    size={size}
                    onClick={() => {
                        this.setState({discharging: false});
                        processIPC.send(combined.commands.setTRState, true);
                    }}
                    disabled={this.props.disabled}
                >
                    TR start
                </Button>
            );
        }

        // Kill Button
        if (this.props.showKill) {
            const killChannel = coilIPC ? coilIPC.commands.setKillState : IPC_CONSTANTS_TO_MAIN.commands.setAllKillState;
            buttons.push(
                <Button
                    key="kill"
                    variant="danger"
                    size={size}
                    onClick={() => {
                        this.setState({discharging: false});
                        processIPC.send(killChannel, true);
                    }}
                    disabled={this.props.disabled}
                >
                    KILL
                </Button>
            );
        }

        // Discharge Button
        if (this.props.onDischarge) {
            buttons.push(
                <Button
                    key="discharge"
                    variant={this.state.discharging ? 'warning' : 'secondary'}
                    size={size}
                    onClick={() => {
                        this.setState({
                            onOk: () => {
                                this.setState({discharging: true});
                                this.props.onDischarge();
                            },
                            warningText: 'Bus will be turned off and TR turned on at low power (Ontime 50µs, ' +
                                '40 BPS) to discharge the coil. Continue?',
                        });
                    }}
                    disabled={this.props.disabled}
                >
                    Discharge
                </Button>
            );
        }

        return <>
            <ButtonGroup className={size === 'lg' ? 'tt-command-buttons-large' : undefined}>{buttons}</ButtonGroup>
            {this.makeWarningModal()}
        </>;
    }

    private makeWarningModal() {
        const closeModal = () => this.setState({warningText: undefined, onOk: undefined});
        const confirm = () => {
            this.state.onOk?.();
            closeModal();
        };
        return <Modal
            show={this.state.warningText !== undefined}
            onHide={closeModal}
        >
            <Modal.Header>
                <Modal.Title>WARNING</Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {this.state.warningText}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={closeModal}>Abort</Button>
                <Button variant="primary" onClick={confirm} disabled={this.props.disabled}>Confirm</Button>
            </Modal.Footer>
        </Modal>;
    }
}
