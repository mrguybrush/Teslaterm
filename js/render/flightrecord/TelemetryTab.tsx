import * as fs from "fs";
import React from "react";
import {Button, Form} from "react-bootstrap";
import {TelemetryEvent} from "../../common/constants";
import {FRDisplayEventType} from "../../common/FlightRecorderTypes";
import {isShownAsDial} from "../../common/GaugeVisibility";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {IPC_CONSTANTS_TO_RENDERER, MeterConfig} from "../../common/IPCConstantsToRenderer";
import {FRDisplayData} from "../connect/ConnectScreen";
import {Gauge, GaugeProps} from "../control/gauges/Gauge";
import {applyRangeOverride, voltagePerDivFor} from "../control/scope/RangeOverride";
import {ScopeSettings} from "../control/scope/ScopeSettings";
import {ScopeStatistics} from "../control/scope/ScopeStatistics";
import {OscilloscopeTrace, TraceConfig, TraceStats} from "../control/scope/Trace";
import {Traces} from "../control/scope/Traces";
import {VoltagePhaseSelect} from "../control/scope/VoltagePhaseSelect";
import {SimpleSliderFixedTitle} from "../control/sliders/SimpleSlider";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";
import {SessionVideo} from "./SessionVideo";
import {ExportResolution, exportTelemetryVideo, VideoExportState} from "./VideoExport";

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
    exportError?: string;
    playing: boolean;
    includeVideoInExport: boolean;
    exportFps: number;
    exportResolution: ExportResolution;
}

export class TelemetryTab extends TTComponent<TelemetryTabProps, TelemetryTabState> {
    // Absolute wall-clock time of the recording's last event. Each state's `time` is relative to
    // it, so this is what turns a scrub position back into a real timestamp for the video.
    private readonly endTimeMs: number;
    private playTimer?: ReturnType<typeof setInterval>;
    // Wall-clock and telemetry-time origin of the current playback run.
    private playStartWallClock: number = 0;
    private playStartTime: number = 0;

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
        this.endTimeMs = endTime;
        this.state = {
            chartStates,
            exportFps: 24,
            exportProgress: 0,
            exportResolution: 'hd_ready',
            exporting: false,
            includeVideoInExport: false,
            lastIndexToShow: 0,
            playing: false,
            telemetryStates: states,
        };
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.stopPlayback();
    }

    /**
     * Advances the scrub position in real time so the recording actually plays back rather than
     * only being draggable. The video (if any) follows the same position, which is what keeps the
     * two in step without either driving the other.
     */
    private togglePlayback() {
        if (this.state.playing) {
            this.stopPlayback();
            return;
        }
        const states = this.state.telemetryStates;
        // Starting from the very end would immediately stop again; rewind instead.
        const startIndex = this.state.lastIndexToShow >= states.length - 1 ? 0 : this.state.lastIndexToShow;
        this.playStartWallClock = Date.now();
        this.playStartTime = states[startIndex].time;
        this.playTimer = setInterval(() => this.advancePlayback(), 50);
        this.setState({lastIndexToShow: startIndex, playing: true});
    }

    private stopPlayback() {
        if (this.playTimer) {
            clearInterval(this.playTimer);
            this.playTimer = undefined;
        }
        if (this.state.playing) {
            this.setState({playing: false});
        }
    }

    private advancePlayback() {
        const states = this.state.telemetryStates;
        const target = this.playStartTime + (Date.now() - this.playStartWallClock) / 1000;
        let index = this.state.lastIndexToShow;
        while (index < states.length - 1 && states[index + 1].time <= target) {
            ++index;
        }
        if (index >= states.length - 1) {
            this.setState({lastIndexToShow: states.length - 1});
            this.stopPlayback();
        } else if (index !== this.state.lastIndexToShow) {
            this.setState({lastIndexToShow: index});
        }
    }

    public componentDidUpdate(prevProps: TelemetryTabProps) {
        // All chartStates snapshots were built once from initial.traceConfigs/CHART_CONF events
        // using whatever voltagePhases was current at construction time - rescale every voltage
        // trace's cached config now, not just whichever snapshot happens to be visible, since the
        // slider can jump to any of them.
        if (prevProps.voltagePhases !== this.props.voltagePhases) {
            const newPerDiv = voltagePerDivFor(this.props.voltagePhases);
            this.setState((state) => ({
                chartStates: state.chartStates.map((snapshot) => snapshot.map((cs) => (
                    cs && cs.config.unit === 'V' ? {...cs, config: cs.config.withPerDiv(newPerDiv)} : cs
                ))),
            }));
        }
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
                        setValue={(value) => {
                            this.stopPlayback();
                            this.setState({lastIndexToShow: value});
                        }}
                        visuallyEnabled={true}
                        disabled={false}
                    />
                    <Button
                        variant={this.state.playing ? 'primary' : 'secondary'}
                        size={'sm'}
                        onClick={() => this.togglePlayback()}
                    >
                        {this.state.playing ? 'Pause' : 'Play'}
                    </Button>
                    <Button
                        variant={this.state.exportError ? 'danger' : 'secondary'}
                        size={'sm'}
                        disabled={this.state.exporting}
                        title={this.state.exportError ? `Export failed: ${this.state.exportError}` : undefined}
                        onClick={() => this.exportVideo()}
                    >
                        {this.state.exporting
                            ? `Exporting… ${Math.round(this.state.exportProgress * 100)}%`
                            : this.state.exportError ? 'Export failed - retry?' : 'Export as video'}
                    </Button>
                    <Form.Select
                        size={'sm'}
                        style={{width: 'auto'}}
                        title={'Export frame rate'}
                        value={this.state.exportFps}
                        disabled={this.state.exporting}
                        onChange={(ev) => this.setState({exportFps: Number(ev.target.value)})}
                    >
                        <option value={10}>10 fps</option>
                        <option value={15}>15 fps</option>
                        <option value={24}>24 fps</option>
                        <option value={30}>30 fps</option>
                        <option value={60}>60 fps</option>
                    </Form.Select>
                    <Form.Select
                        size={'sm'}
                        style={{width: 'auto'}}
                        title={'Export resolution'}
                        value={this.state.exportResolution}
                        disabled={this.state.exporting}
                        onChange={(ev) => this.setState({exportResolution: ev.target.value as ExportResolution})}
                    >
                        <option value={'hd_ready'}>HD Ready (1280×720)</option>
                        <option value={'full_hd'}>Full HD (1920×1080)</option>
                    </Form.Select>
                    {this.props.events.videoPath && <Form.Check
                        type={'checkbox'}
                        id={'export-include-video'}
                        label={'Include session video'}
                        checked={this.state.includeVideoInExport}
                        disabled={this.state.exporting}
                        onChange={(ev) => this.setState({includeVideoInExport: ev.target.checked})}
                    />}
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
                        {state.gauges
                            .filter((p) => p !== undefined && isShownAsDial(p.config.name))
                            .map((p, i) => <Gauge {...p} key={i}/>)}
                    </div>
                    {this.makeVideo(state)}
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
            return {
                epochMs: this.endTimeMs + telemetryState.time * 1000,
                gauges: telemetryState.gauges,
                time: telemetryState.time,
                traces: cachedTraces,
            };
        };
        const {videoPath, videoStartEpochMs} = this.props.events;
        const includeVideo = this.state.includeVideoInExport && videoPath !== undefined
            && videoStartEpochMs !== undefined;
        this.setState({exportError: undefined, exportProgress: 0, exporting: true});
        try {
            const video = await exportTelemetryVideo(
                {
                    stateAtTime,
                    totalDurationSeconds,
                    video: includeVideo ? {path: videoPath, startEpochMs: videoStartEpochMs} : undefined,
                },
                {fps: this.state.exportFps, resolution: this.state.exportResolution},
                (fraction) => this.setState({exportProgress: fraction}),
            );
            await this.saveExportedVideo(video);
        } catch (e) {
            // Without this, a failure here (e.g. the encoder rejecting an unsupported
            // resolution/frame rate combination) used to just silently reset the button - exporting
            // again would look identical and fail identically, with no way to tell what went wrong.
            console.error('Exporting flight recording video', e);
            this.setState({exportError: e?.message || String(e)});
        } finally {
            this.setState({exporting: false});
        }
    }

    // Native dialogs only exist in the main process, so the destination has to be asked for over
    // IPC - but the export itself stays here and is written straight to that path.
    //
    // It is deliberately never turned into a Blob or a single Buffer first: a Full HD export with
    // camera footage runs to hundreds of megabytes, and each such copy sits in the renderer's heap
    // next to the muxer's own. That is what killed the export right before this point - it aborted
    // with no file and no dialog. Buffer.from(arrayBuffer, offset, length) is a *view*, so writing
    // in slices through one handle copies nothing at all.
    private async saveExportedVideo(video: ArrayBuffer) {
        const filePath = await this.requestSavePath(`flight-recording-${Date.now()}.mp4`);
        if (!filePath) {
            return;
        }
        const handle = await fs.promises.open(filePath, 'w');
        try {
            const chunkSize = 8 * 1024 * 1024;
            for (let offset = 0; offset < video.byteLength; offset += chunkSize) {
                const length = Math.min(chunkSize, video.byteLength - offset);
                await handle.write(Buffer.from(video, offset, length));
            }
        } finally {
            await handle.close();
        }
    }

    private requestSavePath(suggestedName: string): Promise<string | undefined> {
        return new Promise((resolve) => {
            processIPC.once(IPC_CONSTANTS_TO_RENDERER.flightRecorder.videoSavePath, resolve);
            processIPC.send(IPC_CONSTANTS_TO_MAIN.flightRecorder.requestVideoSavePath, suggestedName);
        });
    }

    private makeVideo(state: TelemetryState): React.ReactNode {
        const {videoPath, videoStartEpochMs} = this.props.events;
        if (!videoPath || videoStartEpochMs === undefined) {
            return undefined;
        }
        return <SessionVideo
            videoPath={videoPath}
            videoStartEpochMs={videoStartEpochMs}
            currentEpochMs={this.endTimeMs + state.time * 1000}
            playing={this.state.playing}
        />;
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
