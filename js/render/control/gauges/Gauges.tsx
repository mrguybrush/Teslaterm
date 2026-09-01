import React from "react";
import {CoilID} from "../../../common/constants";
import {getToRenderIPCPerCoil, MeterConfig, SetMeters} from "../../../common/IPCConstantsToRenderer";
import {isShownAsDial} from "../../../common/TelemetryVisibility";
import {TTComponent} from "../../TTComponent";
import {Gauge, GaugeProps} from "./Gauge";

export const NUM_GAUGES = 7;

export interface GaugesProps {
    coil: CoilID;
}

interface GaugeState {
    gauges: GaugeProps[];
}

export class Gauges extends TTComponent<GaugesProps, GaugeState> {
    constructor(props: any) {
        super(props);
        const gauges: GaugeProps[] = [];
        for (let i = 0; i < NUM_GAUGES; ++i) {
            gauges.push({
                config: {
                    max: 10,
                    meterId: i,
                    min: 0,
                    name: "Meter " + i,
                    scale: 1,
                },
                value: 0,
            });
        }
        this.state = {gauges};
    }

    public componentDidMount() {
        const coilChannels = getToRenderIPCPerCoil(this.props.coil);
        this.addIPCListener(coilChannels.meters.configure, (config: MeterConfig) => {
            this.setState((oldState) => {
                const newGauges: GaugeProps[] = [...oldState.gauges];
                newGauges[config.meterId] = {
                    config,
                    value: newGauges[config.meterId]?.value || 0,
                };
                return {gauges: newGauges};
            });
        });
        this.addIPCListener(coilChannels.meters.setValue, (update: SetMeters) => {
            this.setState((oldState) => {
                const newGauges: GaugeProps[] = [...oldState.gauges];
                for (const [id, value] of Object.entries(update.values)) {
                    if (!newGauges[id]) {
                        console.warn(`Invalid gauge ${id}`);
                        continue;
                    }
                    const config = newGauges[id].config;
                    newGauges[id] = {value, config};
                }
                return {gauges: newGauges};
            });
        });
    }

    public render(): React.ReactNode {
        // Meter ids above this component's own slots leave gaps in the array (the UD3 numbers the
        // GDT panel's channels well past the dials), so entries can legitimately be missing.
        const shown = this.state.gauges.filter((p) => p !== undefined && isShownAsDial(p.config.name));
        return <div className={'tt-gauges'}>
            {shown.map((p, i) => <Gauge {...p} key={p.config.meterId ?? i}/>)}
        </div>;
    }
}
