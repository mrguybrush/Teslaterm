import React from "react";
import {Button} from "react-bootstrap";
import {TelemetryEvent} from "../../common/constants";
import {FRDisplayEventType} from "../../common/FlightRecorderTypes";
import {MeterConfig} from "../../common/IPCConstantsToRenderer";
import {FRDisplayData} from "../connect/ConnectScreen";
import {Gauge, GaugeProps} from "../control/gauges/Gauge";
import {applyRangeOverride} from "../control/scope/RangeOverride";
import {ScopeSettings} from "../control/scope/ScopeSettings";
import {ScopeStatistics} from "../control/scope/ScopeStatistics";
import {OscilloscopeTrace, TraceConfig, TraceStats} from "../control/scope/Trace";
import {Traces} from "../control/scope/Traces";
import {VoltagePhaseSelect} from "../control/scope/VoltagePhaseSelect";
import {SimpleSliderFixedTitle} from "../control/sliders/SimpleSlider";
import {TTComponent} from "../TTComponent";
import {downloadBlob, exportTelemetryVideo, VideoExportState} from "./VideoExport";

export interface TelemetryTabProps {
    events: FRDisplayData;
    voltagePhases: number;
}

interface TelemetryState {
    gauges: GaugeProps[];
    time: number;
    chartStateIndex: number;
}

interface ChartState {
    currentValue: number;
    firstIndexOfLine: number;
    config: TraceConfig;
}

export interface TelemetryTabState {
    lastIndexToShow: number;
    telemetryStates: TelemetryState[];
    chartStates: ChartState[][];
    exporting: boolean;
    exportProgress: number;
}

export class TelemetryTab extends TTComponent<TelemetryTabProps, TelemetryTabState> {
    public constructor(props) {
        super(props);
        const states: TelemetryState[] = [
            {
                chartStateIndex: -1,
                gauges: this.props.events.initial.meterConfigs.map(config => this.makeMeter(config)),
                time: -Infinity,
            },
        ];
        const chartStates: ChartState[][] = [
            this.props.events.initial.traceConfigs.map(cfg => ({
                config: new TraceConfig(applyRangeOverride(cfg, this.props.voltagePhases)),
                currentValue: 0,
                firstIndexOfLine: 0,
            })),
        ];
        let nextChartStates: ChartState[] = [...chartStates[0]];
        const minTimeDelt = 0.1;
        const eventList = this.props.events.events;
        const endTime = eventList[eventList.length - 1].time;
        for (const event of eventList) {
            if (event.type !== FRDisplayEventType.telemetry) {
                continue;
            }
            const frame = event.frame;
            const oldState = states[states.length - 1];
            const oldGaugeProps = oldState.gauges;
            let newGaugeProps: GaugeProps[];
            switch (frame.type) {
                case TelemetryEvent.GAUGE:
                case TelemetryEvent.GAUGE32:
                    newGaugeProps = [...oldGaugeProps];
                    const oldProps = oldGaugeProps[frame.index];
                    if (oldProps) {
                        newGaugeProps[frame.index] = {...oldProps, value: frame.value / oldProps.config.scale};
                    }
                    break;
                case TelemetryEvent.GAUGE32_CONF:
                case TelemetryEvent.GAUGE_CONF:
                    newGaugeProps = [...oldGaugeProps];
                    newGaugeProps[frame.meterId] = this.makeMeter(frame);
                    break;
                case TelemetryEvent.CHART_CONF:
                case TelemetryEvent.CHART32_CONF:
                    nextChartStates[frame.config.id] = {
                        config: new TraceConfig(applyRangeOverride(frame.config, this.props.voltagePhases)),
                        currentValue: 0,
                        firstIndexOfLine: chartStates.length,
                    };
                    break;
                case TelemetryEvent.CHART:
                case TelemetryEvent.CHART32:
                    if (nextChartStates[frame.index]) {
                        nextChartStates[frame.index] = {...nextChartStates[frame.index], currentValue: frame.value};
                    }
                    break;
                case TelemetryEvent.CHART_DRAW:
                    chartStates.push(nextChartStates);
                    nextChartStates = [...nextChartStates];
                    break;
            }
            if (newGaugeProps) {
                const now = (event.time - endTime) / 1e3;
                if (now - oldState.time > minTimeDelt) {
                    states.push({
                        chartStateIndex: chartStates.length - 1,
                        gauges: newGaugeProps,
                        time: now,
                    });
                } else {
                    states[states.length - 1].gauges = newGaugeProps;
                }
            }
        }
        states.shift();
        if (chartStates.length > 1) {
            chartStates[0] = chartStates[1];
        }
        this.state = {
            chartStates,
            exportProgress: 0,
            exporting: false,
            lastIndexToShow: 0,
            telemetryStates: states,
        };
    }

    public render() {
        const state = this.state.telemetryStates[this.state.lastIndexToShow];
        const traces = this.state.chartStates[state.chartStateIndex].map(
            (_, i) => this.makeTraceAt(state.chartStateIndex, i),
        );
        return (
            <div className='tt-fr-telemetry'>
                <div className='tt-fr-telemetry-control'>
                    <SimpleSliderFixedTitle
                        title={`Showing at ${state.time.toFixed(3)} seconds`}
                        min={0}
                        max={this.state.telemetryStates.length - 1}
                        value={this.state.lastIndexToShow}
                        setValue={(value) => this.setState({lastIndexToShow: value})}
                        visuallyEnabled={true}
                        disabled={false}
                    />
                    <Button
                        variant={'secondary'}
                        size={'sm'}
                        disabled={this.state.exporting}
                        onClick={() => this.exportVideo()}
                    >
                        {this.state.exporting
                            ? `Exporting… ${Math.round(this.state.exportProgress * 100)}%`
                            : 'Export as video'}
                    </Button>
                </div>
                <div className='tt-fr-telemetry-display'>
                    <div className={'tt-fr-scope'}>
                        <div className={'tt-scope-top-row'}>
                            {this.makeTimeProgress(state)}
                            <VoltagePhaseSelect voltagePhases={this.props.voltagePhases}/>
                        </div>
                        <div className={'tt-scope-middle-row'}>
                            <Traces traces={traces}/>
                            <ScopeSettings traces={traces}/>
                        </div>
                        <ScopeStatistics
                            traces={traces}
                            clearStats={() => {}}
                        />
                    </div>
                    <div className={'tt-gauges'}>
                        {state.gauges.map((p, i) => <Gauge {...p} key={i}/>)}
                    </div>
                </div>
            </div>
        );
    }

    private async exportVideo() {
        const states = this.state.telemetryStates;
        if (states.length === 0 || this.state.exporting) {
            return;
        }
        // `.time` on each state isn't a 0-based duration - it's relative to the recording's own
        // (possibly negative) time origin, so the actual length is last-minus-first, and mapping
        // "seconds since export started" onto a state requires re-adding that same start offset.
        const startTime = states[0].time;
        const totalDurationSeconds = states[states.length - 1].time - startTime;
        let cursor = 0;
        let cachedCursor = -1;
        let cachedTraces: OscilloscopeTrace[] = [];
        const stateAtTime = (seconds: number): VideoExportState => {
            const targetTime = startTime + seconds;
            while (cursor < states.length - 1 && states[cursor + 1].time <= targetTime) {
                cursor++;
            }
            const telemetryState = states[cursor];
            // Rebuilding every trace's sample array is expensive - only do it when the
            // underlying telemetry state actually advanced, not on every video frame.
            if (cursor !== cachedCursor) {
                cachedTraces = this.state.chartStates[telemetryState.chartStateIndex].map(
                    (_, i) => this.makeTraceAt(telemetryState.chartStateIndex, i),
                );
                cachedCursor = cursor;
            }
            return {gauges: telemetryState.gauges, time: telemetryState.time, traces: cachedTraces};
        };
        this.setState({exportProgress: 0, exporting: true});
        try {
            const blob = await exportTelemetryVideo(
                {stateAtTime, totalDurationSeconds},
                (fraction) => this.setState({exportProgress: fraction}),
            );
            downloadBlob(blob, `flight-recording-${Date.now()}.mp4`);
        } finally {
            this.setState({exporting: false});
        }
    }

    private makeTimeProgress(state: TelemetryState): React.ReactNode {
        const states = this.state.telemetryStates;
        const startTime = states[0].time;
        const totalDuration = states[states.length - 1].time - startTime;
        const elapsed = state.time - startTime;
        const fraction = totalDuration > 0 ? Math.max(0, Math.min(1, elapsed / totalDuration)) : 0;
        return <div className={'tt-fr-time-progress'}>
            <div className={'tt-fr-time-progress-bar'} style={{width: `${(fraction * 100).toFixed(2)}%`}}/>
            <span className={'tt-fr-time-progress-label'}>
                t = {elapsed.toFixed(3)} s / {totalDuration.toFixed(3)} s
            </span>
        </div>;
    }

    private makeMeter(config: MeterConfig): GaugeProps {
        return {
            config,
            value: config.min,
        };
    }

    private makeTraceAt(traceStateId: number, traceId: number) {
        const lastData = this.state.chartStates[traceStateId][traceId];
        let stats = new TraceStats();
        const samples: number[] = [];
        // TODO there's another magic constant for this somewhere
        const startIndex = Math.max(lastData.firstIndexOfLine, traceStateId - 1e4);
        for (let i = startIndex; i <= traceStateId; ++i) {
            // TODO apply divider elsewhere
            const value = this.state.chartStates[i][traceId].currentValue / lastData.config.divider;
            samples.push(value);
            stats = stats.withValue(value);
        }
        if (lastData.config === undefined) {
            console.error(lastData, traceStateId, traceId);
            throw new Error('undef divider');
        }
        return new OscilloscopeTrace(lastData.config, samples, stats);
    }
}
