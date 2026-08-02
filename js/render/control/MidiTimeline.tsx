import React from "react";

export interface MidiTimelineProps {
    positionSeconds: number;
    durationSeconds: number;
    inPointSeconds: number;
    outPointSeconds: number;
    disabled: boolean;
    // Only playback launched from a specific playlist entry has somewhere to persist a trim to -
    // archive playback always plays the full file, so the in/out handles are hidden for it.
    editableRange: boolean;
    onSeek: (seconds: number) => void;
    onSetInPoint: (seconds: number) => void;
    onSetOutPoint: (seconds: number) => void;
}

type DragTarget = 'in' | 'out' | undefined;

export function formatDuration(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) {
        seconds = 0;
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return mins + ':' + secs.toString().padStart(2, '0');
}

// Plain instance fields (not React state) drive the drag bookkeeping here since the mousemove/up
// handlers are attached to `window`, outside React's synthetic event batching - using setState for
// them would risk a stale read in the click handler that fires right after mouseup.
export class MidiTimeline extends React.Component<MidiTimelineProps> {
    private readonly trackRef = React.createRef<HTMLDivElement>();
    private dragging: DragTarget = undefined;
    private suppressClick = false;

    public componentWillUnmount() {
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
    }

    public render(): React.ReactNode {
        const duration = Math.max(this.props.durationSeconds, 0.001);
        const pct = (seconds: number) => Math.max(0, Math.min(100, (seconds / duration) * 100));
        const inPct = pct(this.props.inPointSeconds);
        const outPct = pct(this.props.outPointSeconds);
        return <div className={'tt-midi-timeline'}>
            <div
                className={'tt-midi-timeline-track'}
                ref={this.trackRef}
                onClick={this.onTrackClick}
            >
                {this.props.editableRange && <div
                    className={'tt-midi-timeline-range'}
                    style={{left: `${inPct}%`, width: `${Math.max(0, outPct - inPct)}%`}}
                />}
                <div className={'tt-midi-timeline-playhead'} style={{left: `${pct(this.props.positionSeconds)}%`}}/>
                {this.props.editableRange && <div
                    className={'tt-midi-timeline-handle tt-midi-timeline-handle-in'}
                    style={{left: `${inPct}%`}}
                    onMouseDown={this.startDrag('in')}
                    onClick={(ev) => ev.stopPropagation()}
                    title={'Drag to set in point'}
                />}
                {this.props.editableRange && <div
                    className={'tt-midi-timeline-handle tt-midi-timeline-handle-out'}
                    style={{left: `${outPct}%`}}
                    onMouseDown={this.startDrag('out')}
                    onClick={(ev) => ev.stopPropagation()}
                    title={'Drag to set out point'}
                />}
            </div>
            <div className={'tt-midi-timeline-labels'}>
                <span>{formatDuration(this.props.positionSeconds)}</span>
                <span>{formatDuration(this.props.durationSeconds)}</span>
            </div>
        </div>;
    }

    private secondsAtClientX(clientX: number): number {
        const rect = this.trackRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) {
            return 0;
        }
        const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        return fraction * this.props.durationSeconds;
    }

    private onTrackClick = (ev: React.MouseEvent) => {
        if (this.suppressClick) {
            this.suppressClick = false;
            return;
        }
        if (this.props.disabled) {
            return;
        }
        this.props.onSeek(this.secondsAtClientX(ev.clientX));
    };

    private startDrag = (target: DragTarget) => (ev: React.MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        if (this.props.disabled) {
            return;
        }
        this.dragging = target;
        window.addEventListener('mousemove', this.onMouseMove);
        window.addEventListener('mouseup', this.onMouseUp);
    };

    private onMouseMove = (ev: MouseEvent) => {
        if (!this.dragging) {
            return;
        }
        this.suppressClick = true;
        const seconds = this.secondsAtClientX(ev.clientX);
        if (this.dragging === 'in') {
            this.props.onSetInPoint(seconds);
        } else {
            this.props.onSetOutPoint(seconds);
        }
    };

    private onMouseUp = () => {
        this.dragging = undefined;
        window.removeEventListener('mousemove', this.onMouseMove);
        window.removeEventListener('mouseup', this.onMouseUp);
    };
}
