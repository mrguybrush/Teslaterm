import React from "react";
import {Form} from "react-bootstrap";
import {IPC_CONSTANTS_TO_MAIN} from "../../../common/IPCConstantsToMain";
import {processIPC} from "../../ipc/IPCProvider";

export interface VoltagePhaseSelectProps {
    voltagePhases?: number;
}

// Same dropdown as the "Voltage scope range" setting on the connect screen, duplicated here so it
// can sit directly next to the scope diagram (live and flight recording playback) instead of only
// being reachable through Settings.
export function VoltagePhaseSelect(props: VoltagePhaseSelectProps) {
    return <Form.Select
        size={'sm'}
        style={{width: '14em'}}
        value={props.voltagePhases || 1}
        onChange={(ev) => processIPC.send(IPC_CONSTANTS_TO_MAIN.setVoltagePhases, Number(ev.target.value))}
    >
        <option value={1}>1-phase (0-350V, 35V/div)</option>
        <option value={3}>3-phase (0-600V, 60V/div)</option>
    </Form.Select>;
}
