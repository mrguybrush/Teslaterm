import React, {CSSProperties} from "react";
import {TTComponent} from "../../TTComponent";
import {OscilloscopeTrace, TraceConfig, TraceStats} from "./Trace";

interface SingleStatProps {
    stat: TraceStats;
    config: TraceConfig;
}

class SingleTraceStats extends TTComponent<SingleStatProps, {}> {
    public render(): React.ReactNode {
        const style: CSSProperties = {
            color: this.props.config.wavecolor,
            fontWeight: 'bold',
        };
        return <span style={style} className={'tt-trace-stats'}>
            <span className={'tt-trace-stat'}>Min: {this.props.stat.min.toFixed(2)} {this.props.config.unit}</span>
            <span className={'tt-trace-stat'}>Max: {this.props.stat.max.toFixed(2)} {this.props.config.unit}</span>
        </span>;
    }
}

export interface StatisticsProps {
    traces: OscilloscopeTrace[];
    clearStats: () => any;
}

export class ScopeStatistics extends TTComponent<StatisticsProps, {}> {
    public render(): React.ReactNode {
        return <div
            className={'tt-scope-stats'}
            onClick={(ev) => {
                ev.stopPropagation();
                this.props.clearStats();
            }}
        >
            {this.props.traces.map((t, i) => <SingleTraceStats stat={t.stats} config={t.config} key={i}/>)}
        </div>;
    }
}
