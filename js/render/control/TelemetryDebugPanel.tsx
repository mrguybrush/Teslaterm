import React from "react";
import {Button, Table} from "react-bootstrap";
import {CoilID} from "../../common/constants";
import {getToMainIPCPerCoil, IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {
    getToRenderIPCPerCoil,
    MeterConfig,
    ScopeTraceConfig,
    ScopeValues,
    SetMeters,
    UD3ConfigOption,
} from "../../common/IPCConstantsToRenderer";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";

export interface TelemetryDebugPanelProps {
    coil: CoilID;
}

interface GaugeRow {
    config: MeterConfig;
    value: number;
}

interface ScopeRow {
    config: ScopeTraceConfig;
    lastValue?: number;
}

interface TelemetryDebugPanelState {
    gauges: { [id: number]: GaugeRow };
    scopeChannels: { [id: number]: ScopeRow };
    configParams?: UD3ConfigOption[];
    loadingConfig: boolean;
}

export class TelemetryDebugPanel extends TTComponent<TelemetryDebugPanelProps, TelemetryDebugPanelState> {
    constructor(props: TelemetryDebugPanelProps) {
        super(props);
        this.state = {gauges: {}, loadingConfig: false, scopeChannels: {}};
    }

    public componentDidMount() {
        const channels = getToRenderIPCPerCoil(this.props.coil);
        this.addIPCListener(channels.meters.configure, (config: MeterConfig) => {
            this.setState((s) => ({
                gauges: {
                    ...s.gauges,
                    [config.meterId]: {config, value: s.gauges[config.meterId]?.value ?? 0},
                },
            }));
        });
        this.addIPCListener(channels.meters.setValue, (update: SetMeters) => {
            this.setState((s) => {
                const gauges = {...s.gauges};
                for (const [id, value] of Object.entries(update.values)) {
                    if (gauges[id]) {
                        gauges[id] = {config: gauges[id].config, value};
                    }
                }
                return {gauges};
            });
        });
        this.addIPCListener(channels.scope.configure, (config: ScopeTraceConfig) => {
            this.setState((s) => ({
                scopeChannels: {
                    ...s.scopeChannels,
                    [config.id]: {config, lastValue: s.scopeChannels[config.id]?.lastValue},
                },
            }));
        });
        this.addIPCListener(channels.scope.addValues, (values: ScopeValues) => {
            this.setState((s) => {
                const scopeChannels = {...s.scopeChannels};
                const lastTick = values.values[values.values.length - 1];
                if (!lastTick) {
                    return null;
                }
                for (const [id, value] of Object.entries(lastTick)) {
                    if (scopeChannels[id]) {
                        scopeChannels[id] = {config: scopeChannels[id].config, lastValue: value};
                    }
                }
                return {scopeChannels};
            });
        });
        this.addIPCListener(channels.configList, (configParams) => {
            this.setState({configParams, loadingConfig: false});
        });
        // Gauge/scope channels the firmware already reported before this panel existed were missed -
        // request a fresh sync so they get re-broadcast now that we're listening.
        processIPC.send(IPC_CONSTANTS_TO_MAIN.requestFullSync, undefined);
    }

    public render(): React.ReactNode {
        return <div className={"tt-telemetry-debug-panel"}>
            <div className={"tt-telemetry-debug-columns"}>
                <div className={"tt-telemetry-debug-column"}>
                    <h6>Gauge/Meter channels</h6>
                    {this.makeGaugeTable()}
                </div>
                <div className={"tt-telemetry-debug-column"}>
                    <h6>Scope/chart channels</h6>
                    {this.makeScopeTable()}
                </div>
                <div className={"tt-telemetry-debug-column"}>
                    <h6>
                        Config parameters (config_get){" "}
                        <Button
                            size={"sm"}
                            variant={"secondary"}
                            disabled={this.state.loadingConfig}
                            onClick={() => this.loadConfig()}
                        >
                            {this.state.loadingConfig ? "Loading..." : "Load"}
                        </Button>
                    </h6>
                    {this.makeConfigTable()}
                </div>
            </div>
        </div>;
    }

    private loadConfig() {
        this.setState({loadingConfig: true});
        processIPC.send(getToMainIPCPerCoil(this.props.coil).menu.requestConfigList, undefined);
    }

    private makeConfigTable() {
        if (!this.state.configParams) {
            return <p>Not loaded yet. Click "Load" (may take a few seconds).</p>;
        }
        if (this.state.configParams.length === 0) {
            return <p>No response received from the coil (timed out).</p>;
        }
        return <Table bordered size={"sm"}>
            <thead>
            <tr>
                <th>Name</th>
                <th>Current</th>
                <th>Min</th>
                <th>Max</th>
            </tr>
            </thead>
            <tbody>
            {this.state.configParams.map((opt) => (
                <tr key={opt.name}>
                    <td>{opt.name}</td>
                    <td>{opt.current}</td>
                    <td>{opt.min}</td>
                    <td>{opt.max}</td>
                </tr>
            ))}
            </tbody>
        </Table>;
    }

    private makeGaugeTable() {
        const rows = Object.values(this.state.gauges).sort((a, b) => a.config.meterId - b.config.meterId);
        if (rows.length === 0) {
            return <p>No gauge channels received yet.</p>;
        }
        return <Table bordered size={"sm"}>
            <thead>
            <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Min</th>
                <th>Max</th>
                <th>Scale</th>
                <th>Value</th>
            </tr>
            </thead>
            <tbody>
            {rows.map((row) => (
                <tr key={row.config.meterId}>
                    <td>{row.config.meterId}</td>
                    <td>{row.config.name}</td>
                    <td>{row.config.min}</td>
                    <td>{row.config.max}</td>
                    <td>{row.config.scale}</td>
                    <td>{row.value.toFixed(3)}</td>
                </tr>
            ))}
            </tbody>
        </Table>;
    }

    private makeScopeTable() {
        const rows = Object.values(this.state.scopeChannels).sort((a, b) => a.config.id - b.config.id);
        if (rows.length === 0) {
            return <p>No scope channels received yet.</p>;
        }
        return <Table bordered size={"sm"}>
            <thead>
            <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Unit</th>
                <th>Min</th>
                <th>Max</th>
                <th>Div</th>
                <th>Offset</th>
                <th>Last value</th>
            </tr>
            </thead>
            <tbody>
            {rows.map((row) => (
                <tr key={row.config.id}>
                    <td>{row.config.id}</td>
                    <td>{row.config.name}</td>
                    <td>{row.config.unit}</td>
                    <td>{row.config.min}</td>
                    <td>{row.config.max}</td>
                    <td>{row.config.div}</td>
                    <td>{row.config.offset}</td>
                    <td>{row.lastValue !== undefined ? (row.lastValue / row.config.div).toFixed(3) : "-"}</td>
                </tr>
            ))}
            </tbody>
        </Table>;
    }
}
