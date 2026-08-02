import * as MidiPlayer from "midi-player-js";

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

export class MidiPreviewPlayer {
    private readonly synth = new CoilSynth();
    private player: MidiPlayer.Player | undefined;

    public play(bytes: Uint8Array, onEnded: () => void) {
        this.stop();
        this.player = new MidiPlayer.Player((event) => this.handleEvent(event));
        (this.player as any).defaultTempo = 120;
        this.player.on('endOfFile', () => {
            this.synth.stopAll();
            onEnded();
        });
        this.player.loadArrayBuffer(bytes);
        this.player.play();
    }

    public stop() {
        if (this.player) {
            this.player.stop();
            this.player = undefined;
        }
        this.synth.stopAll();
    }

    private handleEvent(event: MidiPlayer.Event) {
        const key = `${event.channel}-${event.noteNumber}`;
        if (event.name === 'Note on' && (event.velocity || 0) > 0) {
            this.synth.noteOn(key, event.noteNumber);
        } else if (event.name === 'Note off' || (event.name === 'Note on' && !(event.velocity || 0))) {
            this.synth.noteOff(key);
        }
    }
}
