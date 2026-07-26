import {ArrayBufferTarget, Muxer} from "mp4-muxer";
import {GaugeProps} from "../control/gauges/Gauge";
import {scopeColors} from "../control/scope/ScopeColors";
import {OscilloscopeTrace} from "../control/scope/Trace";
import {Traces} from "../control/scope/Traces";

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
// The recording itself only has a handful of samples per second anyway, so a higher video frame
// rate wouldn't show anything new - keep it low to keep encoding (and thus export) fast.
const FPS = 10;
const VIDEO_BITRATE = 2_000_000;
const SCOPE_HEIGHT = 380;
const LEGEND_WIDTH = 220;
const TOP_MARGIN = 36;

export interface VideoExportState {
    time: number;
    traces: OscilloscopeTrace[];
    gauges: GaugeProps[];
}

export interface VideoExportSource {
    totalDurationSeconds: number;
    // Returns the display state (traces + gauges) that should be visible at the given time.
    stateAtTime: (seconds: number) => VideoExportState;
}

function drawFrame(ctx: CanvasRenderingContext2D, source: VideoExportSource, elapsed: number) {
    const state = source.stateAtTime(elapsed);
    const scopeWidth = CANVAS_WIDTH - LEGEND_WIDTH;

    ctx.fillStyle = scopeColors.background;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    ctx.fillStyle = '#888';
    ctx.font = '16px sans-serif';
    ctx.fillText(`t = ${state.time.toFixed(3)} s`, 8, 24);

    ctx.save();
    ctx.translate(0, TOP_MARGIN);
    Traces.drawGrid(ctx, scopeWidth, SCOPE_HEIGHT);
    for (const trace of state.traces) {
        Traces.drawTrace(trace.config, trace.data, ctx, scopeWidth, SCOPE_HEIGHT);
    }
    ctx.restore();

    let legendY = TOP_MARGIN + 4;
    ctx.font = 'bold 13px sans-serif';
    for (const trace of state.traces) {
        const currentValue = trace.data.length > 0 ? trace.data[trace.data.length - 1] : undefined;
        ctx.fillStyle = trace.config.wavecolor;
        ctx.fillText(trace.config.name, scopeWidth + 10, legendY);
        legendY += 16;
        ctx.fillText(
            `${currentValue !== undefined ? currentValue.toFixed(2) : '-'} ${trace.config.unit}`,
            scopeWidth + 10, legendY,
        );
        legendY += 16;
        ctx.fillText(`${trace.config.perDiv.toFixed(2)} ${trace.config.unit} / div`, scopeWidth + 10, legendY);
        legendY += 22;
    }

    let gaugeY = TOP_MARGIN + SCOPE_HEIGHT + 22;
    ctx.font = '13px sans-serif';
    ctx.fillStyle = '#888';
    const gaugeLine = state.gauges.map((g) => `${g.config.name}: ${g.value.toFixed(2)}`).join('   ');
    ctx.fillText(gaugeLine, 8, gaugeY);
}

// Encodes frames with WebCodecs as fast as the CPU allows (no waiting on wall-clock time like
// MediaRecorder/captureStream would) while still tagging each frame with the correct timestamp,
// so the resulting video plays back at the right speed even though producing it was much faster.
export async function exportTelemetryVideo(
    source: VideoExportSource,
    onProgress: (fraction: number) => void,
): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d');

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
        target,
        video: {
            codec: 'avc',
            frameRate: FPS,
            height: CANVAS_HEIGHT,
            width: CANVAS_WIDTH,
        },
    });

    const videoEncoder = new VideoEncoder({
        error: (e) => console.error('Video export encoding error:', e),
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    });
    videoEncoder.configure({
        // H.264 Baseline profile, level 3.1 - widely supported, cheap to encode in software.
        bitrate: VIDEO_BITRATE,
        codec: 'avc1.42001f',
        framerate: FPS,
        height: CANVAS_HEIGHT,
        width: CANVAS_WIDTH,
    });

    const totalDuration = Math.max(source.totalDurationSeconds, 0.1);
    const frameIntervalSeconds = 1 / FPS;
    const totalFrames = Math.max(1, Math.ceil(totalDuration / frameIntervalSeconds));

    for (let i = 0; i < totalFrames; i++) {
        const t = Math.min(i * frameIntervalSeconds, totalDuration);
        drawFrame(ctx, source, t);
        const timestampMicros = Math.round(i * frameIntervalSeconds * 1e6);
        const frame = new VideoFrame(canvas, {
            duration: Math.round(frameIntervalSeconds * 1e6),
            timestamp: timestampMicros,
        });
        // Every frame is a keyframe: at this frame rate/resolution the size cost is negligible,
        // and it avoids any inter-frame reference bugs entirely.
        videoEncoder.encode(frame, {keyFrame: true});
        frame.close();
        onProgress((i + 1) / totalFrames);

        // Yield periodically so the progress display stays responsive; the encoder queue is
        // otherwise free to run flat out.
        if (i % 4 === 0) {
            await new Promise((resolve) => setTimeout(resolve, 0));
        }
    }

    await videoEncoder.flush();
    videoEncoder.close();
    muxer.finalize();

    return new Blob([target.buffer], {type: 'video/mp4'});
}

export function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}
