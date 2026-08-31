export type WebcamConsumer = 'preview' | 'recording';

type StreamListener = (stream?: MediaStream) => void;

/**
 * Owns the single webcam stream shared by the live preview and the session recorder.
 *
 * Module-level rather than component state on purpose: the preview panel is unmounted whenever
 * another bottom panel is selected, but a recording started from it has to keep running, and
 * re-opening the camera per consumer risks "device busy" on hardware that only allows one open
 * handle. Consumers acquire and release; the camera closes once the last one lets go.
 */
class WebcamManager {
    private stream?: MediaStream;
    private deviceId: string = '';
    private readonly consumers = new Set<WebcamConsumer>();
    private readonly listeners = new Set<StreamListener>();
    // getUserMedia is slow enough that two consumers can ask before the first call returns; they
    // must end up sharing one stream rather than opening the camera twice.
    private opening?: Promise<MediaStream>;

    public getStream(): MediaStream | undefined {
        return this.stream;
    }

    public isActive(): boolean {
        return this.stream !== undefined;
    }

    public subscribe(listener: StreamListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    public async acquire(consumer: WebcamConsumer): Promise<MediaStream> {
        this.consumers.add(consumer);
        if (this.stream) {
            return this.stream;
        }
        if (!this.opening) {
            this.opening = this.openStream();
        }
        try {
            return await this.opening;
        } finally {
            this.opening = undefined;
        }
    }

    public release(consumer: WebcamConsumer) {
        this.consumers.delete(consumer);
        if (this.consumers.size === 0) {
            this.closeStream();
        }
    }

    /** Switches cameras, restarting the stream in place if anything is currently using it. */
    public async setDeviceId(deviceId: string) {
        if (deviceId === this.deviceId) {
            return;
        }
        this.deviceId = deviceId;
        if (this.consumers.size === 0) {
            this.closeStream();
            return;
        }
        this.closeStream();
        try {
            await this.acquireExisting();
        } catch (e) {
            console.error('Switching camera', e);
        }
    }

    public getDeviceId(): string {
        return this.deviceId;
    }

    /** Sets the device without touching a running stream - used to apply the persisted setting. */
    public initDeviceId(deviceId: string) {
        if (!this.stream) {
            this.deviceId = deviceId;
        }
    }

    public async listCameras(): Promise<MediaDeviceInfo[]> {
        const devices = await navigator.mediaDevices.enumerateDevices();
        return devices.filter((device) => device.kind === 'videoinput');
    }

    private async acquireExisting(): Promise<MediaStream> {
        this.opening = this.openStream();
        try {
            return await this.opening;
        } finally {
            this.opening = undefined;
        }
    }

    private async openStream(): Promise<MediaStream> {
        const video: MediaTrackConstraints = {
            ...(this.deviceId ? {deviceId: {exact: this.deviceId}} : {}),
            // Chrome's default without an explicit resolution is 640x480 - plenty for a live
            // preview, not for a recording meant to actually be watched back. `ideal` rather than
            // `exact` so a camera that can't do 1080p still opens at whatever it can do instead of
            // failing outright.
            height: {ideal: 1080},
            width: {ideal: 1920},
        };
        const audio: MediaTrackConstraints = {
            channelCount: {ideal: 2},
            // Voice-call defaults, on by default when audio is just `true`. They actively work
            // against a coil recording: noise suppression treats the arcing itself as noise to
            // remove, AGC constantly rides the gain up and down between quiet and loud discharges,
            // and echo cancellation has nothing to cancel with no call partner - the combined
            // effect is the "muddy"/pumping sound quality. Plain booleans, not `{ideal: false}`:
            // these toggle a software DSP stage the browser itself owns, not a hardware capability
            // a given microphone might lack, so there's no risk of this failing like a channel
            // count or resolution request against fixed hardware could.
            autoGainControl: false,
            echoCancellation: false,
            noiseSuppression: false,
        };
        const stream = await navigator.mediaDevices.getUserMedia({audio, video});
        // Everyone may have released again while the camera was opening.
        if (this.consumers.size === 0) {
            stopTracks(stream);
            throw new Error('Webcam released before it finished opening');
        }
        this.stream = stream;
        this.notify();
        return stream;
    }

    private closeStream() {
        if (!this.stream) {
            return;
        }
        stopTracks(this.stream);
        this.stream = undefined;
        this.notify();
    }

    private notify() {
        this.listeners.forEach((listener) => listener(this.stream));
    }
}

function stopTracks(stream: MediaStream) {
    stream.getTracks().forEach((track) => track.stop());
}

export const webcamManager = new WebcamManager();
