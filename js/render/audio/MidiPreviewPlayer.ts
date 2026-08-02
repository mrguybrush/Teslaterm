import * as MidiPlayer from "midi-player-js";
import {MidiPlaybackState, MidiPlayerState} from "../../common/MidiPlaylistTypes";

// Real "singing" Tesla coils make sound by gating the spark on/off at audio rate, which produces
// a harsh, buzzy tone close to a square/pulse wave rather than anything resembling a sampled
// instrument - so a plain oscillator synth gets us a more authentic preview than a MIDI sample
// library would, with none of the download size.
class CoilSynth {
    private audioContext: AudioContext | undefined;
    private noteBus: AudioNode | undefined;
    private readonly activeNotes: Map<string, { oscillators: OscillatorNode[], gain: GainNode }> = new Map();

    public noteOn(key: string, midiNote: number) {
        this.ensureContext();
        this.noteOff(key);
        const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        const now = this.audioContext.currentTime;

        const gain = this.audioContext.createGain();
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.25, now + 0.004);

        // A base square wave plus a faint octave-up layer with a little random detune on each,
        // to avoid an overly clean/electronic tone and get closer to a real coil's crackle.
        const osc1 = this.audioContext.createOscillator();
        osc1.type = 'square';
        osc1.frequency.value = freq;
        osc1.detune.value = (Math.random() - 0.5) * 10;

        const osc2 = this.audioContext.createOscillator();
        osc2.type = 'square';
        osc2.frequency.value = freq;
        osc2.detune.value = 1200 + (Math.random() - 0.5) * 10;
        const osc2Gain = this.audioContext.createGain();
        osc2Gain.gain.value = 0.3;

        osc1.connect(gain);
        osc2.connect(osc2Gain);
        osc2Gain.connect(gain);
        gain.connect(this.noteBus);
        osc1.start();
        osc2.start();

        this.activeNotes.set(key, {gain, oscillators: [osc1, osc2]});
    }

    public noteOff(key: string) {
        const active = this.activeNotes.get(key);
        if (!active) {
            return;
        }
        this.activeNotes.delete(key);
        const now = this.audioContext.currentTime;
        active.gain.gain.cancelScheduledValues(now);
        active.gain.gain.setValueAtTime(active.gain.gain.value, now);
        active.gain.gain.linearRampToValueAtTime(0, now + 0.02);
        active.oscillators.forEach((osc) => osc.stop(now + 0.03));
    }

    public stopAll() {
        for (const key of [...this.activeNotes.keys()]) {
            this.noteOff(key);
        }
    }

    private ensureContext() {
        if (this.audioContext) {
            return;
        }
        this.audioContext = new AudioContext();
        const shaper = this.audioContext.createWaveShaper();
        shaper.curve = CoilSynth.makeDistortionCurve();
        shaper.oversample = '4x';
        const master = this.audioContext.createGain();
        master.gain.value = 0.35;
        shaper.connect(master);
        master.connect(this.audioContext.destination);
        this.noteBus = shaper;
    }

    private static makeDistortionCurve(): Float32Array {
        const amount = 6;
        const samples = 256;
        const curve = new Float32Array(samples);
        for (let i = 0; i < samples; ++i) {
            const x = (i * 2) / samples - 1;
            curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
        }
        return curve;
    }
}

const EMPTY_STATE: MidiPlayerState = {
    durationSeconds: 0,
    inPointSeconds: 0,
    outPointSeconds: 0,
    positionSeconds: 0,
    state: MidiPlaybackState.stopped,
};

// Mirrors the shape and control surface of the main-process coil player (js/main/midi/midi.ts) -
// same play/pause/stop/seek/in-out-point semantics - so the renderer's "now playing" bar and
// timeline can drive either transport interchangeably depending on the preview/coil toggle.
export class MidiPreviewPlayer {
    private readonly synth = new CoilSynth();
    private player: MidiPlayer.Player | undefined;
    private filename: string | undefined;
    private durationSeconds = 0;
    private inPointSeconds = 0;
    private outPointSeconds = 0;
    private playbackState: MidiPlaybackState = MidiPlaybackState.stopped;
    private sourcePlaylistIndex: number | undefined;
    private pollHandle: ReturnType<typeof setInterval> | undefined;
    private onStateChange: (state: MidiPlayerState) => void = () => undefined;
    private onEnded: () => void = () => undefined;
    private onInOutChanged: (index: number, inPointSeconds: number, outPointSeconds: number) => void = () => undefined;

    public setListeners(
        onStateChange: (state: MidiPlayerState) => void,
        onEnded: () => void,
        onInOutChanged: (index: number, inPointSeconds: number, outPointSeconds: number) => void,
    ) {
        this.onStateChange = onStateChange;
        this.onEnded = onEnded;
        this.onInOutChanged = onInOutChanged;
    }

    // sourcePlaylistIndex/initialInPoint/initialOutPoint are set when playback was launched from a
    // specific playlist entry - archive playback omits them and always plays the full file.
    public play(
        bytes: Uint8Array,
        filename: string,
        sourcePlaylistIndex?: number,
        initialInPoint?: number,
        initialOutPoint?: number,
    ) {
        this.teardown();
        this.player = new MidiPlayer.Player((event) => this.handleEvent(event));
        (this.player as any).defaultTempo = 120;
        this.player.loadArrayBuffer(bytes);
        this.filename = filename;
        this.sourcePlaylistIndex = sourcePlaylistIndex;
        this.durationSeconds = this.player.getSongTime();
        this.inPointSeconds = Math.max(0, Math.min(initialInPoint ?? 0, this.durationSeconds));
        this.outPointSeconds = Math.min(this.durationSeconds, Math.max(initialOutPoint ?? this.durationSeconds, this.inPointSeconds));
        this.player.on('endOfFile', () => this.handleEndOfFile());
        this.player.skipToSeconds(this.inPointSeconds);
        this.player.play();
        this.playbackState = MidiPlaybackState.playing;
        this.startPolling();
        this.emitState();
    }

    public pause() {
        if (!this.player || this.playbackState !== MidiPlaybackState.playing) {
            return;
        }
        this.synth.stopAll();
        this.player.pause();
        this.playbackState = MidiPlaybackState.paused;
        this.emitState();
    }

    public resume() {
        if (!this.player || this.playbackState !== MidiPlaybackState.paused) {
            return;
        }
        this.player.play();
        this.playbackState = MidiPlaybackState.playing;
        this.emitState();
    }

    public stop() {
        if (this.playbackState === MidiPlaybackState.stopped) {
            return;
        }
        this.teardown();
        this.playbackState = MidiPlaybackState.stopped;
        this.emitState();
    }

    public seek(seconds: number) {
        if (!this.player) {
            return;
        }
        const clamped = Math.max(0, Math.min(seconds, this.durationSeconds));
        const wasPlaying = this.playbackState === MidiPlaybackState.playing;
        this.synth.stopAll();
        this.player.skipToSeconds(clamped);
        if (wasPlaying) {
            this.player.play();
        }
        this.emitState();
    }

    public setInPoint(seconds: number) {
        this.inPointSeconds = Math.max(0, Math.min(seconds, this.outPointSeconds));
        this.notifyInOutChanged();
        this.emitState();
    }

    public setOutPoint(seconds: number) {
        this.outPointSeconds = Math.min(this.durationSeconds, Math.max(seconds, this.inPointSeconds));
        this.notifyInOutChanged();
        this.emitState();
    }

    public getState(): MidiPlayerState {
        if (!this.player) {
            return EMPTY_STATE;
        }
        return {
            durationSeconds: this.durationSeconds,
            filename: this.filename,
            inPointSeconds: this.inPointSeconds,
            outPointSeconds: this.outPointSeconds,
            positionSeconds: this.getCurrentSeconds(),
            sourcePlaylistIndex: this.sourcePlaylistIndex,
            state: this.playbackState,
        };
    }

    private notifyInOutChanged() {
        if (this.sourcePlaylistIndex !== undefined) {
            this.onInOutChanged(this.sourcePlaylistIndex, this.inPointSeconds, this.outPointSeconds);
        }
    }

    private getCurrentSeconds(): number {
        if (!this.player || !this.player.tracks) {
            return 0;
        }
        return Math.max(0, this.player.getSongTime() - this.player.getSongTimeRemaining());
    }

    private handleEvent(event: MidiPlayer.Event) {
        const key = `${event.channel}-${event.noteNumber}`;
        if (event.name === 'Note on' && (event.velocity || 0) > 0) {
            this.synth.noteOn(key, event.noteNumber);
        } else if (event.name === 'Note off' || (event.name === 'Note on' && !(event.velocity || 0))) {
            this.synth.noteOff(key);
        }
    }

    private handleEndOfFile() {
        this.teardown();
        this.playbackState = MidiPlaybackState.stopped;
        this.emitState();
        this.onEnded();
    }

    private startPolling() {
        this.stopPolling();
        this.pollHandle = setInterval(() => {
            if (this.playbackState !== MidiPlaybackState.playing) {
                return;
            }
            if (this.outPointSeconds > 0 && this.getCurrentSeconds() >= this.outPointSeconds) {
                this.handleEndOfFile();
                return;
            }
            this.emitState();
        }, 100);
    }

    private stopPolling() {
        if (this.pollHandle) {
            clearInterval(this.pollHandle);
            this.pollHandle = undefined;
        }
    }

    private teardown() {
        this.stopPolling();
        if (this.player) {
            this.player.stop();
            this.player = undefined;
        }
        this.synth.stopAll();
    }

    private emitState() {
        this.onStateChange(this.getState());
    }
}
