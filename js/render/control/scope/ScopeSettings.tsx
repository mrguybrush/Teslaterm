import React, {CSSProperties} from "react";
import {TTComponent} from "../../TTComponent";
import {OscilloscopeTrace, TraceConfig} from './Trace'

interface TraceSettingsProps {
    config: TraceConfig;
    currentValue?: number;
}

class TraceSettings extends TTComponent<TraceSettingsProps, {}> {
    render(): React.ReactNode {
        const style: CSSProperties = {
            color: this.props.config.wavecolor,
            fontWeight: 'bold',
        };
        return <div className={'tt-scope-legend-item'} style={style}>
            {this.props.config.name}<br/>
            {this.props.currentValue !== undefined ? this.props.currentValue.toFixed(2) : '-'} {this.props.config.unit}<br/>
            {this.props.config.perDiv.toFixed(2)} {this.props.config.unit} / div
        </div>;
    }
}

export interface ScopeSettingsProps {
    traces: OscilloscopeTrace[];
}

export class ScopeSettings extends TTComponent<ScopeSettingsProps, {}> {
    render(): React.ReactNode {
        return <div className={'tt-scope-settings'}>
            {this.props.traces.map((t, i) => (
                <TraceSettings config={t.config} currentValue={t.data[t.data.length - 1]} key={i}/>
            ))}
        </div>;
    }
}
