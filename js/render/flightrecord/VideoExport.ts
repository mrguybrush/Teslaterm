import * as fs from "fs";
import {ArrayBufferTarget, Muxer} from "mp4-muxer";
import {pathToFileURL} from "url";
import {GaugeProps} from "../control/gauges/Gauge";
import {scopeColors} from "../control/scope/ScopeColors";
import {OscilloscopeTrace} from "../control/scope/Trace";
import {Traces} from "../control/scope/Traces";

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 540;
// The recording itself only has a handful of samples per second anyway, so a higher video frame
// rate wouldn't show anything new - keep it low to keep encoding (and thus export) fast.
const FPS = 10;
// Quality doesn't matter much here (it's a line chart, not video footage), so bias hard towards
// small file size: a low bitrate plus infrequent keyframes let H.264's inter-frame compression do
// most of the work, since consecutive frames of a slowly-moving chart are mostly identical.
const VIDEO_BITRATE = 250_000;
// Real camera footage does not compress nearly as well as a mostly-static line chart, so the panel
// gets a much larger bitrate share whenever it is included.
const VIDEO_BITRATE_WITH_CAMERA = 2_000_000;
const KEYFRAME_INTERVAL_FRAMES = FPS * 3;
const SCOPE_HEIGHT = 380;
const LEGEND_WIDTH = 220;
const TOP_MARGIN = 36;
// Width of the extra panel added to the right of the scope when a session video is included.
const CAMERA_PANEL_WIDTH = 360;

export interface VideoExportState {
    time: number;
    traces: OscilloscopeTrace[];
    gauges: GaugeProps[];
    // Absolute wall-clock time (Date.now()-style ms) this state represents. Only needed to line up
    // the session video, which is timestamped separately from the telemetry - see SessionVideo.tsx.
    epochMs: number;
}

export interface VideoExportSource {
    totalDurationSeconds: number;
    // Returns the display state (traces + gauges) that should be visible at the given time.
    stateAtTime: (seconds: number) => VideoExportState;
    // Present only when the "include session video" checkbox was on and this session has one.
    video?: {
        path: string;
        startEpochMs: number;
    };
}

// AAC-LC. WebCodecs' registered codec string, not the container-level 'aac' mp4-muxer expects.
const AAC_LC_CODEC = 'mp4a.40.2';
const AUDIO_BITRATE = 192_000;
// Matches the AAC-LC frame size, so every encoded AAC frame corresponds to exactly one AudioData.
const AUDIO_SAMPLES_PER_FRAME = 1024;

// Decodes the session video's full audio track to PCM. decodeAudioData demuxes and decodes in one
// step regardless of the source container (the recording is WebM/Opus today), so this needs no
// separate demuxer - only a real AudioContext, since OfflineAudioContext refuses files longer than
// the render length it was constructed for.
async function loadSessionAudio(path: string): Promise<AudioBuffer | undefined> {
    try {
        const bytes = await fs.promises.readFile(path);
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const audioCtx = new AudioContext();
        try {
            return await audioCtx.decodeAudioData(arrayBuffer);
        } finally {
            await audioCtx.close();
        }
    } catch (e) {
        console.error('Decoding session audio for export', e);
        return undefined;
    }
}

// Encodes the portion of `audioBuffer` that overlaps the export's [0, totalDurationSeconds] range
// to AAC and feeds it to the muxer. `offsetSeconds` is where the export's t=0 falls inside the
// audio recording - negative when the camera (and its audio) had not started yet at that point,
// in which case that leading gap is encoded as silence so the audio track still lines up with the
// video rather than starting early or being cut short.
async function encodeSessionAudio(
    muxer: Muxer<ArrayBufferTarget>, audioBuffer: AudioBuffer, offsetSeconds: number, totalDurationSeconds: number,
): Promise<void> {
    const sampleRate = audioBuffer.sampleRate;
    const numberOfChannels = audioBuffer.numberOfChannels;
    const totalOutputSamples = Math.round(totalDurationSeconds * sampleRate);
    const silenceSamples = offsetSeconds < 0 ? Math.round(-offsetSeconds * sampleRate) : 0;
    const sourceStartSample = offsetSeconds >= 0 ? Math.round(offsetSeconds * sampleRate) : 0;

    const channelData: Float32Array[] = [];
    for (let ch = 0; ch < numberOfChannels; ch++) {
        // Float32Array is zero-initialized, which is exactly the silence needed for both the
        // leading gap and any trailing samples past the end of the source recording.
        const out = new Float32Array(totalOutputSamples);
        const src = audioBuffer.getChannelData(ch);
        for (let i = silenceSamples; i < totalOutputSamples; i++) {
            const srcIndex = sourceStartSample + (i - silenceSamples);
            if (srcIndex < src.length) {
                out[i] = src[srcIndex];
            }
        }
        channelData.push(out);
    }

    const audioEncoder = new AudioEncoder({
        error: (e) => console.error('Audio export encoding error:', e),
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
    });
    audioEncoder.configure({
        bitrate: AUDIO_BITRATE,
        codec: AAC_LC_CODEC,
        numberOfChannels,
        sampleRate,
    });

    for (let offset = 0; offset < totalOutputSamples; offset += AUDIO_SAMPLES_PER_FRAME) {
        const frameSamples = Math.min(AUDIO_SAMPLES_PER_FRAME, totalOutputSamples - offset);
        // AudioData wants planar samples concatenated channel-by-channel, not interleaved.
        const planar = new Float32Array(frameSamples * numberOfChannels);
        for (let ch = 0; ch < numberOfChannels; ch++) {
            planar.set(channelData[ch].subarray(offset, offset + frameSamples), ch * frameSamples);
        }
        const audioData = new AudioData({
            data: planar,
            format: 'f32-planar',
            numberOfChannels,
            numberOfFrames: frameSamples,
            sampleRate,
            timestamp: Math.round((offset / sampleRate) * 1e6),
        });
        audioEncoder.encode(audioData);
        audioData.close();
    }

    await audioEncoder.flush();
    audioEncoder.close();
}

// Loads a video file into an off-DOM element and waits until seeking it is possible. Never
// attached to the document and never played - only ever used as a drawImage() source.
function loadCameraVideo(path: string): Promise<HTMLVideoElement> {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.onloadedmetadata = () => resolve(video);
        video.onerror = () => reject(new Error(`Could not load session video: ${path}`));
        video.src = pathToFileURL(path).toString();
    });
}

// HTMLMediaElement.seeked does not fire if currentTime is set to a value the element considers
// unchanged (already-current time, or a time outside [0, duration] getting clamped to where it
// already was) - both are common here since many consecutive export frames can map to the same
// or an out-of-range video time. A short timeout treats "nothing happened" the same as "arrived".
function seekCameraVideo(video: HTMLVideoElement, seconds: number): Promise<void> {
    const clamped = Math.max(0, Math.min(seconds, Math.max(video.duration - 0.05, 0)));
    if (Math.abs(video.currentTime - clamped) < 0.02) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (!done) {
                done = true;
                video.removeEventListener('seeked', finish);
                resolve();
            }
        };
        video.addEventListener('seeked', finish);
        video.currentTime = clamped;
        // Fallback in case 'seeked' never fires for this browser/codec combination.
        setTimeout(finish, 500);
    });
}

function drawCameraPanel(
    ctx: CanvasRenderingContext2D, video: HTMLVideoElement | undefined, startX: number, showFrame: boolean,
) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(startX, 0, CAMERA_PANEL_WIDTH, CANVAS_HEIGHT);
    if (video && showFrame && video.videoWidth > 0) {
        // Letterboxed rather than stretched or cropped - the point of including the camera is to
        // see what actually happened, distorting or cutting off the picture would work against that.
        const scale = Math.min(CAMERA_PANEL_WIDTH / video.videoWidth, CANVAS_HEIGHT / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, startX + (CAMERA_PANEL_WIDTH - w) / 2, (CANVAS_HEIGHT - h) / 2, w, h);
    } else {
        ctx.fillStyle = '#666';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No camera footage yet', startX + CAMERA_PANEL_WIDTH / 2, CANVAS_HEIGHT / 2);
        ctx.textAlign = 'left';
    }
    ctx.restore();
}

async function drawFrame(
    ctx: CanvasRenderingContext2D, source: VideoExportSource, elapsed: number, cameraVideo?: HTMLVideoElement,
) {
    const state = source.stateAtTime(elapsed);
    const scopeWidth = CANVAS_WIDTH - LEGEND_WIDTH;

    ctx.fillStyle = scopeColors.background;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    if (source.video) {
        // Negative until the camera actually started (getUserMedia is slower than the session
        // start it belongs to - see FlightVideoRecorder) - nothing to seek to yet in that case.
        const videoSeconds = (state.epochMs - source.video.startEpochMs) / 1000;
        if (cameraVideo && videoSeconds >= 0) {
            await seekCameraVideo(cameraVideo, videoSeconds);
        }
        drawCameraPanel(ctx, cameraVideo, CANVAS_WIDTH, videoSeconds >= 0);
    }

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
    const includeCamera = source.video !== undefined;
    const canvasWidth = CANVAS_WIDTH + (includeCamera ? CAMERA_PANEL_WIDTH : 0);
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = CANVAS_HEIGHT;
    const ctx = canvas.getContext('2d');

    // Loaded once up front rather than per frame - repeatedly creating/loading a <video> element
    // would dwarf the cost of the seeks themselves.
    const cameraVideo = source.video ? await loadCameraVideo(source.video.path) : undefined;
    // Decoded separately from the <video> element above: reading frames back out of an
    // HTMLVideoElement's audio track isn't something the DOM exposes, so the same file is decoded
    // a second time, this time as audio, via the Web Audio API.
    const sessionAudio = source.video ? await loadSessionAudio(source.video.path) : undefined;

    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
        audio: sessionAudio ? {
            codec: 'aac',
            numberOfChannels: sessionAudio.numberOfChannels,
            sampleRate: sessionAudio.sampleRate,
        } : undefined,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'offset',
        target,
        video: {
            codec: 'avc',
            frameRate: FPS,
            height: CANVAS_HEIGHT,
            width: canvasWidth,
        },
    });

    const videoEncoder = new VideoEncoder({
        error: (e) => console.error('Video export encoding error:', e),
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    });
    videoEncoder.configure({
        // H.264 Baseline profile, level 3.1 - widely supported, cheap to encode in software.
        bitrate: includeCamera ? VIDEO_BITRATE_WITH_CAMERA : VIDEO_BITRATE,
        codec: 'avc1.42001f',
        framerate: FPS,
        height: CANVAS_HEIGHT,
        width: canvasWidth,
    });

    const totalDuration = Math.max(source.totalDurationSeconds, 0.1);
    const frameIntervalSeconds = 1 / FPS;
    const totalFrames = Math.max(1, Math.ceil(totalDuration / frameIntervalSeconds));

    for (let i = 0; i < totalFrames; i++) {
        const t = Math.min(i * frameIntervalSeconds, totalDuration);
        // Seeking the camera video is genuinely asynchronous (unlike the pure-canvas chart draw),
        // so this loop can no longer run flat out - the periodic yield below is still needed for
        // the progress display, but is no longer what's keeping the UI responsive.
        await drawFrame(ctx, source, t, cameraVideo);
        const timestampMicros = Math.round(i * frameIntervalSeconds * 1e6);
        const frame = new VideoFrame(canvas, {
            duration: Math.round(frameIntervalSeconds * 1e6),
            timestamp: timestampMicros,
        });
        videoEncoder.encode(frame, {keyFrame: i % KEYFRAME_INTERVAL_FRAMES === 0});
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

    if (sessionAudio && source.video) {
        // Where the export's own t=0 falls inside the camera recording - the same reference point
        // drawFrame() uses per-frame for the picture, needed here once for the whole audio track.
        const offsetSeconds = (source.stateAtTime(0).epochMs - source.video.startEpochMs) / 1000;
        await encodeSessionAudio(muxer, sessionAudio, offsetSeconds, totalDuration);
    }

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
