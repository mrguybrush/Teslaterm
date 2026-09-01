import * as fs from "fs";
import {ArrayBufferTarget, Muxer} from "mp4-muxer";
import {pathToFileURL} from "url";
import {GaugeProps} from "../control/gauges/Gauge";
import {scopeColors} from "../control/scope/ScopeColors";
import {OscilloscopeTrace} from "../control/scope/Trace";
import {Traces} from "../control/scope/Traces";

export type ExportResolution = 'hd_ready' | 'full_hd';

export interface ExportOptions {
    fps: number;
    resolution: ExportResolution;
}

const RESOLUTIONS: Record<ExportResolution, {width: number; height: number}> = {
    full_hd: {height: 1080, width: 1920},
    hd_ready: {height: 720, width: 1280},
};

// The whole layout below (panel widths, margins, font sizes) was designed against this canvas
// height. Every selectable resolution scales those same proportions up or down from here instead
// of hard-coding a second set of constants per resolution - all three options share one 16:9 aspect
// ratio, so a single height-derived scale factor keeps width and height proportions consistent too.
const BASE_CANVAS_HEIGHT = 540;
const BASE_SCOPE_HEIGHT = 380;
const BASE_LEGEND_WIDTH = 220;
const BASE_TOP_MARGIN = 36;
const BASE_CAMERA_PANEL_WIDTH = 360;
// Quality doesn't matter much for the chart itself (it's a line chart, not video footage), so bias
// hard towards small file size: a low bitrate plus infrequent keyframes let H.264's inter-frame
// compression do most of the work, since consecutive frames of a slowly-moving chart are mostly
// identical. Real camera footage does not compress nearly as well, so the panel gets a much larger
// bitrate share whenever it is included. Both scale with the chosen resolution's pixel area.
const BASE_VIDEO_BITRATE = 250_000;
const BASE_VIDEO_BITRATE_WITH_CAMERA = 2_000_000;
const KEYFRAME_INTERVAL_SECONDS = 3;

interface Layout {
    canvasHeight: number;
    scopeWidth: number;
    scopeHeight: number;
    legendWidth: number;
    topMargin: number;
    cameraPanelWidth: number;
    // Applied to every font size and small spacing constant so text stays proportional instead of
    // shrinking into a corner of a 1080p canvas or overflowing a 720p one.
    fontScale: number;
}

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

// H.264 level limits (Annex A), macroblocks are 16x16 - the original 960x540 canvas fit inside
// level 3.1 (its own hard-coded codec string until now) with room to spare, but level 3.1 caps out
// at 3600 macroblocks/frame - 1280x720 alone is already right at that ceiling, and every resolution
// or frame rate above the old defaults (both now user-selectable) needs a higher level or
// VideoEncoder.configure() rejects it outright and the export aborts before it can produce anything.
const H264_LEVELS: Array<{levelIdc: number; maxFrameMacroblocks: number; maxMacroblocksPerSecond: number}> = [
    {levelIdc: 0x0a, maxFrameMacroblocks: 99, maxMacroblocksPerSecond: 1_485},
    {levelIdc: 0x0b, maxFrameMacroblocks: 396, maxMacroblocksPerSecond: 3_000},
    {levelIdc: 0x0c, maxFrameMacroblocks: 396, maxMacroblocksPerSecond: 6_000},
    {levelIdc: 0x0d, maxFrameMacroblocks: 396, maxMacroblocksPerSecond: 11_880},
    {levelIdc: 0x14, maxFrameMacroblocks: 396, maxMacroblocksPerSecond: 11_880},
    {levelIdc: 0x15, maxFrameMacroblocks: 792, maxMacroblocksPerSecond: 19_800},
    {levelIdc: 0x16, maxFrameMacroblocks: 1_620, maxMacroblocksPerSecond: 20_250},
    {levelIdc: 0x1e, maxFrameMacroblocks: 1_620, maxMacroblocksPerSecond: 40_500},
    {levelIdc: 0x1f, maxFrameMacroblocks: 3_600, maxMacroblocksPerSecond: 108_000},
    {levelIdc: 0x20, maxFrameMacroblocks: 5_120, maxMacroblocksPerSecond: 216_000},
    {levelIdc: 0x28, maxFrameMacroblocks: 8_192, maxMacroblocksPerSecond: 245_760},
    {levelIdc: 0x29, maxFrameMacroblocks: 8_192, maxMacroblocksPerSecond: 245_760},
    {levelIdc: 0x2a, maxFrameMacroblocks: 8_704, maxMacroblocksPerSecond: 522_240},
    {levelIdc: 0x32, maxFrameMacroblocks: 22_080, maxMacroblocksPerSecond: 589_824},
    {levelIdc: 0x33, maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 983_040},
    {levelIdc: 0x34, maxFrameMacroblocks: 36_864, maxMacroblocksPerSecond: 2_073_600},
];

// Baseline profile (0x42), no constraint flags - only the level (the last byte) varies.
function pickH264Codec(width: number, height: number, fps: number): string {
    const frameMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
    const macroblocksPerSecond = frameMacroblocks * fps;
    const level = H264_LEVELS.find(
        (l) => frameMacroblocks <= l.maxFrameMacroblocks && macroblocksPerSecond <= l.maxMacroblocksPerSecond,
    ) ?? H264_LEVELS[H264_LEVELS.length - 1];
    return `avc1.4200${level.levelIdc.toString(16).padStart(2, '0')}`;
}

// Loads a video file into an off-DOM element and waits until seeking it is possible. Never
// attached to the document and never played - only ever used as a drawImage() source, which is why
// muting it here is safe (the audio track is decoded straight from the file, see loadSessionAudio).
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

// Decodes the session video's full audio track to PCM. decodeAudioData demuxes and decodes in one
// step regardless of the source container (the recording is WebM/Opus today), so this needs no
// separate demuxer - only a real AudioContext, since OfflineAudioContext refuses files longer than
// the render length it was constructed for.
//
// An earlier attempt captured this by playing the camera video through a MediaElementAudioSourceNode
// instead. That is what produced an entirely silent audio track: loadCameraVideo mutes the element
// (it is only ever a drawImage source), and a muted element feeds silence into the graph. Decoding
// the file directly sidesteps that entirely, and does not cost the length of the recording in
// real-time playback either.
async function loadSessionAudio(path: string): Promise<AudioBuffer | undefined> {
    const audioCtx = new AudioContext();
    try {
        const bytes = await fs.promises.readFile(path);
        const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        return await audioCtx.decodeAudioData(arrayBuffer);
    } catch (e) {
        console.error('Decoding session audio for export', e);
        return undefined;
    } finally {
        await audioCtx.close();
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

function drawCameraPanel(
    ctx: CanvasRenderingContext2D, video: HTMLVideoElement | undefined, startX: number, showFrame: boolean,
    layout: Layout,
) {
    ctx.save();
    ctx.fillStyle = '#fff';
    ctx.fillRect(startX, 0, layout.cameraPanelWidth, layout.canvasHeight);
    if (video && showFrame && video.videoWidth > 0) {
        // Letterboxed rather than stretched or cropped - the point of including the camera is to
        // see what actually happened, distorting or cutting off the picture would work against that.
        const scale = Math.min(layout.cameraPanelWidth / video.videoWidth, layout.canvasHeight / video.videoHeight);
        const w = video.videoWidth * scale;
        const h = video.videoHeight * scale;
        ctx.drawImage(video, startX + (layout.cameraPanelWidth - w) / 2, (layout.canvasHeight - h) / 2, w, h);
    } else {
        ctx.fillStyle = '#666';
        ctx.font = `${Math.round(14 * layout.fontScale)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('No camera footage yet', startX + layout.cameraPanelWidth / 2, layout.canvasHeight / 2);
        ctx.textAlign = 'left';
    }
    ctx.restore();
}

async function drawFrame(
    ctx: CanvasRenderingContext2D, source: VideoExportSource, elapsed: number, layout: Layout,
    cameraVideo?: HTMLVideoElement,
) {
    const state = source.stateAtTime(elapsed);
    const canvasWidth = layout.scopeWidth + layout.legendWidth + (source.video ? layout.cameraPanelWidth : 0);

    ctx.fillStyle = scopeColors.background;
    ctx.fillRect(0, 0, canvasWidth, layout.canvasHeight);

    if (source.video) {
        // Negative until the camera actually started (getUserMedia is slower than the session
        // start it belongs to - see FlightVideoRecorder) - nothing to seek to yet in that case.
        const videoSeconds = (state.epochMs - source.video.startEpochMs) / 1000;
        if (cameraVideo && videoSeconds >= 0) {
            await seekCameraVideo(cameraVideo, videoSeconds);
        }
        drawCameraPanel(ctx, cameraVideo, layout.scopeWidth + layout.legendWidth, videoSeconds >= 0, layout);
    }

    ctx.fillStyle = '#888';
    ctx.font = `${Math.round(16 * layout.fontScale)}px sans-serif`;
    ctx.fillText(`t = ${state.time.toFixed(3)} s`, 8, Math.round(24 * layout.fontScale));

    ctx.save();
    ctx.translate(0, layout.topMargin);
    Traces.drawGrid(ctx, layout.scopeWidth, layout.scopeHeight);
    for (const trace of state.traces) {
        Traces.drawTrace(trace.config, trace.data, ctx, layout.scopeWidth, layout.scopeHeight);
    }
    ctx.restore();

    let legendY = layout.topMargin + Math.round(4 * layout.fontScale);
    const legendLineHeight = Math.round(16 * layout.fontScale);
    ctx.font = `bold ${Math.round(13 * layout.fontScale)}px sans-serif`;
    for (const trace of state.traces) {
        const currentValue = trace.data.length > 0 ? trace.data[trace.data.length - 1] : undefined;
        ctx.fillStyle = trace.config.wavecolor;
        ctx.fillText(trace.config.name, layout.scopeWidth + 10, legendY);
        legendY += legendLineHeight;
        ctx.fillText(
            `${currentValue !== undefined ? currentValue.toFixed(2) : '-'} ${trace.config.unit}`,
            layout.scopeWidth + 10, legendY,
        );
        legendY += legendLineHeight;
        ctx.fillText(`${trace.config.perDiv.toFixed(2)} ${trace.config.unit} / div`, layout.scopeWidth + 10, legendY);
        legendY += Math.round(22 * layout.fontScale);
    }

    let gaugeY = layout.topMargin + layout.scopeHeight + Math.round(22 * layout.fontScale);
    ctx.font = `${Math.round(13 * layout.fontScale)}px sans-serif`;
    ctx.fillStyle = '#888';
    const gaugeLine = state.gauges.map((g) => `${g.config.name}: ${g.value.toFixed(2)}`).join('   ');
    ctx.fillText(gaugeLine, 8, gaugeY);
}

// Encodes frames with WebCodecs as fast as the CPU allows (no waiting on wall-clock time like
// MediaRecorder/captureStream would) while still tagging each frame with the correct timestamp,
// so the resulting video plays back at the right speed even though producing it was much faster.
// Returns the finished MP4 as the muxer's own buffer rather than wrapping it in a Blob: a finished
// export can run to hundreds of megabytes, and every additional full copy of it in the renderer's
// heap is a real risk of the whole export dying right at the finish line.
export async function exportTelemetryVideo(
    source: VideoExportSource,
    options: ExportOptions,
    onProgress: (fraction: number) => void,
): Promise<ArrayBuffer> {
    const fps = options.fps;
    const {width: baseWidth, height: canvasHeight} = RESOLUTIONS[options.resolution];
    const scale = canvasHeight / BASE_CANVAS_HEIGHT;
    const includeCamera = source.video !== undefined;
    const layout: Layout = {
        cameraPanelWidth: Math.round(BASE_CAMERA_PANEL_WIDTH * scale),
        canvasHeight,
        fontScale: scale,
        legendWidth: Math.round(BASE_LEGEND_WIDTH * scale),
        scopeHeight: Math.round(BASE_SCOPE_HEIGHT * scale),
        scopeWidth: baseWidth - Math.round(BASE_LEGEND_WIDTH * scale),
        topMargin: Math.round(BASE_TOP_MARGIN * scale),
    };
    const canvasWidth = layout.scopeWidth + layout.legendWidth + (includeCamera ? layout.cameraPanelWidth : 0);
    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext('2d');

    // Loaded once up front rather than per frame - repeatedly creating/loading a <video> element
    // would dwarf the cost of the seeks themselves.
    const cameraVideo = source.video ? await loadCameraVideo(source.video.path) : undefined;
    // Decoded separately from the <video> element above: reading frames back out of an
    // HTMLVideoElement's audio track isn't something the DOM exposes, so the same file is decoded
    // a second time, this time as audio.
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
            frameRate: fps,
            height: canvasHeight,
            width: canvasWidth,
        },
    });

    const areaScale = scale * scale;
    const videoBitrate = Math.round(
        (includeCamera ? BASE_VIDEO_BITRATE_WITH_CAMERA : BASE_VIDEO_BITRATE) * areaScale,
    );
    const videoEncoder = new VideoEncoder({
        error: (e) => console.error('Video export encoding error:', e),
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    });
    videoEncoder.configure({
        // H.264 Baseline profile - widely supported, cheap to encode in software. The level has to
        // match the actual frame size/rate (see pickH264Codec) or configure() rejects it outright.
        bitrate: videoBitrate,
        codec: pickH264Codec(canvasWidth, canvasHeight, fps),
        framerate: fps,
        height: canvasHeight,
        width: canvasWidth,
    });

    // Where the export's t=0 falls inside the camera recording. Read here, before the frame loop,
    // and NOT afterwards next to the audio encoding where it is actually used: stateAtTime walks a
    // cursor that only ever moves forward, so once the loop has run, asking it for t=0 again returns
    // the *last* state instead of the first. That put the audio's start a whole recording length
    // past the end of the recording, which is why the exported file had no audio in it at all.
    const exportStartEpochMs = source.stateAtTime(0).epochMs;

    const totalDuration = Math.max(source.totalDurationSeconds, 0.1);
    const frameIntervalSeconds = 1 / fps;
    const totalFrames = Math.max(1, Math.ceil(totalDuration / frameIntervalSeconds));
    const keyframeIntervalFrames = Math.max(1, Math.round(fps * KEYFRAME_INTERVAL_SECONDS));

    for (let i = 0; i < totalFrames; i++) {
        const t = Math.min(i * frameIntervalSeconds, totalDuration);
        // Seeking the camera video is genuinely asynchronous (unlike the pure-canvas chart draw),
        // so this loop can no longer run flat out - the periodic yield below is still needed for
        // the progress display, but is no longer what's keeping the UI responsive.
        await drawFrame(ctx, source, t, layout, cameraVideo);
        const timestampMicros = Math.round(i * frameIntervalSeconds * 1e6);
        const frame = new VideoFrame(canvas, {
            duration: Math.round(frameIntervalSeconds * 1e6),
            timestamp: timestampMicros,
        });
        videoEncoder.encode(frame, {keyFrame: i % keyframeIntervalFrames === 0});
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
        const offsetSeconds = (exportStartEpochMs - source.video.startEpochMs) / 1000;
        await encodeSessionAudio(muxer, sessionAudio, offsetSeconds, totalDuration);
    }

    muxer.finalize();

    return target.buffer;
}
