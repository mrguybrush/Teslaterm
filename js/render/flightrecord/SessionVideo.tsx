import React from "react";
import {pathToFileURL} from "url";
import {SimpleSliderFixedTitle} from "../control/sliders/SimpleSlider";
import {TTComponent} from "../TTComponent";

export interface SessionVideoProps {
    videoPath: string;
    // Wall-clock time of the video's first frame.
    videoStartEpochMs: number;
    // Wall-clock time the telemetry view is currently showing.
    currentEpochMs: number;
    playing: boolean;
}

interface SessionVideoState {
    // In pixels rather than a percentage: the panel sits in a min-content grid column, where a
    // percentage width would be relative to a column that is itself sized by its contents.
    widthPx: number;
    failed: boolean;
}

// Seeking on every telemetry step would stutter badly during playback, since each seek restarts
// decoding. While playing, the element is left to run on its own and only nudged back when it has
// drifted further than this from where the telemetry says it should be.
const MAX_DRIFT_SECONDS = 0.35;

export class SessionVideo extends TTComponent<SessionVideoProps, SessionVideoState> {
    private readonly videoRef = React.createRef<HTMLVideoElement>();

    public constructor(props: SessionVideoProps) {
        super(props);
        this.state = {failed: false, widthPx: 360};
    }

    public componentDidMount() {
        this.syncToTelemetry();
    }

    public componentDidUpdate() {
        this.syncToTelemetry();
    }

    public render(): React.ReactNode {
        if (this.state.failed) {
            return <div className={'tt-fr-video'}>
                <p className={'tt-fr-video-error'}>The video for this session could not be loaded.</p>
            </div>;
        }
        return <div className={'tt-fr-video'} style={{width: `${this.state.widthPx}px`}}>
            <video
                ref={this.videoRef}
                className={'tt-fr-video-element'}
                src={pathToFileURL(this.props.videoPath).toString()}
                onError={() => this.setState({failed: true})}
                // Telemetry playback drives position and play/pause, so the element's own controls
                // would just let the two get out of step.
                controls={false}
                playsInline={true}
            />
            <SimpleSliderFixedTitle
                title={`Video size: ${this.state.widthPx} px`}
                min={160}
                max={960}
                value={this.state.widthPx}
                setValue={(widthPx) => this.setState({widthPx})}
                visuallyEnabled={true}
                disabled={false}
            />
        </div>;
    }

    private syncToTelemetry() {
        const video = this.videoRef.current;
        if (!video) {
            return;
        }
        // Negative while the telemetry is showing a moment from before the camera started (the
        // session runs from the first telemetry event, the video only once getUserMedia returned).
        const targetSeconds = (this.props.currentEpochMs - this.props.videoStartEpochMs) / 1000;
        const duration = Number.isFinite(video.duration) ? video.duration : undefined;
        const clamped = Math.max(0, duration !== undefined ? Math.min(targetSeconds, duration) : targetSeconds);
        if (!this.props.playing) {
            if (!video.paused) {
                video.pause();
            }
            // Paused means the user is scrubbing, so follow every step exactly.
            if (Math.abs(video.currentTime - clamped) > 0.01) {
                video.currentTime = clamped;
            }
            return;
        }
        if (Math.abs(video.currentTime - clamped) > MAX_DRIFT_SECONDS) {
            video.currentTime = clamped;
        }
        // Before the camera started there is nothing to show yet; let the telemetry run on alone
        // rather than pinning the video at frame 0 and calling that "in sync".
        if (targetSeconds < 0) {
            if (!video.paused) {
                video.pause();
            }
        } else if (video.paused) {
            video.play().catch((e) => console.error('Playing session video', e));
        }
    }
}
