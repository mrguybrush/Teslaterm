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
const AUDIO_CHANNEL_COUNT = 2;

// Loads a video file into an off-DOM element and waits until seeking it is possible. Never
// attached to the document and never played by its caller - only ever used as a drawImage() source
// (loadSessionAudio() below plays it once, separately, before the caller starts seeking it).
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

// decodeAudioData() turned out to be unreliable for these recordings: MediaRecorder never goes
// back and rewrites the file with a proper duration/seek index once it stops, and Chromium's
// offline audio decoder is far stricter about that than <video> playback is - it can throw or
// silently return nothing for exactly the WebM files this app records, even though the very same
// file plays back fine as a <video> (proven by the camera panel, which reads this same file).
// This decodes it the same way playback does instead: play the muted, off-DOM camera video in real
// time and capture what a MediaElementAudioSourceNode actually produces, rather than parsing the
// container directly. That does mean this takes as long as the recording itself.
async function loadSessionAudio(
    video: HTMLVideoElement, onProgress: (fraction: number) => void,
): Promise<AudioBuffer | undefined> {
    const audioCtx = new AudioContext();
    try {
        // MediaRecorder never writes a final duration into the file, so Chromium reports it as
        // Infinity until something makes it scan for the real one - and playback of a
        // still-Infinity-duration file never reaches 'ended' below, which used to hang the export
        // forever. Seeking near the end once is the standard fix: it forces the real duration to
        // resolve immediately, and it has to happen before anything below starts relying on either.
        if (!isFinite(video.duration)) {
            await new Promise<void>((resolve) => {
                const onDurationChange = () => {
                    video.removeEventListener('durationchange', onDurationChange);
                    resolve();
                };
                video.addEventListener('durationchange', onDurationChange);
                video.currentTime = 1e101;
                setTimeout(resolve, 2000);
            });
            video.currentTime = 0;
        }

        const source = audioCtx.createMediaElementSource(video);
        const bufferSize = 4096;
        const processor = audioCtx.createScriptProcessor(bufferSize, AUDIO_CHANNEL_COUNT, AUDIO_CHANNEL_COUNT);
        const chunks: Float32Array[][] = Array.from({length: AUDIO_CHANNEL_COUNT}, () => []);
        processor.onaudioprocess = (ev) => {
            for (let ch = 0; ch < AUDIO_CHANNEL_COUNT; ch++) {
                chunks[ch].push(new Float32Array(ev.inputBuffer.getChannelData(ch)));
            }
        };
        // The processor only receives audioprocess callbacks while it is part of a live graph that
        // reaches the destination - routing it through a zero-gain node keeps the captured audio
        // from actually being audible during export.
        const silence = audioCtx.createGain();
        silence.gain.value = 0;
        source.connect(processor);
        processor.connect(silence);
        silence.connect(audioCtx.destination);

        const ended = new Promise<void>((resolve) => {
            video.addEventListener('ended', () => resolve(), {once: true});
        });
        const onTimeUpdate = () => {
            if (isFinite(video.duration) && video.duration > 0) {
                onProgress(Math.min(1, video.currentTime / video.duration));
            }
        };
        video.addEventListener('timeupdate', onTimeUpdate);
        try {
            await video.play();
        } catch (e) {
            console.error('Playing session video for audio export', e);
        }
        // 'ended' is the normal way this resolves; the timeout is a safety net so a recording that
        // still (for some other reason) never reaches 'ended' can no longer hang the whole export -
        // it just exports with whatever audio was captured up to that point instead.
        const timeoutMs = (isFinite(video.duration) ? video.duration * 1000 : 10 * 60 * 1000) + 15_000;
        await Promise.race([ended, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
        video.removeEventListener('timeupdate', onTimeUpdate);

        processor.disconnect();
        source.disconnect();
        video.pause();
        onProgress(1);

        const totalFrames = chunks[0].reduce((sum, c) => sum + c.length, 0);
        if (totalFrames === 0) {
            return undefined;
        }
        const buffer = audioCtx.createBuffer(AUDIO_CHANNEL_COUNT, totalFrames, audioCtx.sampleRate);
        for (let ch = 0; ch < AUDIO_CHANNEL_COUNT; ch++) {
            const out = buffer.getChannelData(ch);
            let offset = 0;
            for (const chunk of chunks[ch]) {
                out.set(chunk, offset);
                offset += chunk.length;
            }
        }
        return buffer;
    } catch (e) {
        console.error('Extracting session audio for export', e);
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
// The session audio (when included) is the one part that can't be sped up the same way - see
// loadSessionAudio() - so it gets its own share of the progress range further down.
export async function exportTelemetryVideo(
    source: VideoExportSource,
    options: ExportOptions,
    onProgress: (fraction: number) => void,
): Promise<Blob> {
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
    // Extracting the audio track plays the whole recording back in real time (see loadSessionAudio),
    // so it gets a share of the progress bar proportional to roughly how long that actually takes
    // relative to the (much faster) frame encoding loop below.
    const audioProgressShare = includeCamera ? 0.3 : 0;
    const sessionAudio = cameraVideo
        ? await loadSessionAudio(cameraVideo, (f) => onProgress(f * audioProgressShare))
        : undefined;

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
        // H.264 Baseline profile, level 3.1 - widely supported, cheap to encode in software.
        bitrate: videoBitrate,
        codec: 'avc1.42001f',
        framerate: fps,
        height: canvasHeight,
        width: canvasWidth,
    });

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
        onProgress(audioProgressShare + (1 - audioProgressShare) * (i + 1) / totalFrames);

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
