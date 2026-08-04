// Real "singing" Tesla coils make sound by gating the spark on/off at audio rate, which produces
// a harsh, buzzy tone close to a square/pulse wave rather than anything resembling a sampled
// instrument - so a plain oscillator synth gets closer to the real thing than a MIDI sample
// library would, with none of the download size. Shared between the MIDI playlist's local preview
// player and the piano's local preview toggle.
export class CoilSynth {
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

    // Smoothly re-pitches an already-sounding note - used for the piano's slide/glide effect,
    // where the same voice needs to bend continuously rather than retrigger.
    public setNoteFrequency(key: string, midiNote: number) {
        const active = this.activeNotes.get(key);
        if (!active || !this.audioContext) {
            return;
        }
        const freq = 440 * Math.pow(2, (midiNote - 69) / 12);
        const now = this.audioContext.currentTime;
        for (const osc of active.oscillators) {
            osc.frequency.setTargetAtTime(freq, now, 0.01);
        }
    }

    public stopAll() {
        for (const key of [...this.activeNotes.keys()]) {
            this.noteOff(key);
        }
    }

    // A short, plain percussive tick for the metronome - deliberately bypasses the coil-buzz voice
    // path (noteBus/distortion) so it reads as a clean click distinct from the notes themselves,
    // and is never touched by anything that forwards to the coil since it's a one-shot local sound.
    public click(accent: boolean) {
        this.ensureContext();
        const now = this.audioContext.currentTime;
        const osc = this.audioContext.createOscillator();
        osc.type = 'square';
        osc.frequency.value = accent ? 1600 : 1000;
        const gain = this.audioContext.createGain();
        gain.gain.setValueAtTime(accent ? 0.5 : 0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
        osc.connect(gain);
        gain.connect(this.audioContext.destination);
        osc.start(now);
        osc.stop(now + 0.05);
    }

    // Creating an AudioContext and letting the audio hardware actually spin up both take a moment
    // - if that first happens on the very first key press, that press gets stuck with the extra
    // delay. Call this as soon as preview mode is available (before any note is actually needed)
    // so that startup cost is paid upfront instead of showing up as latency on the first note.
    public prewarm() {
        this.ensureContext();
        if (this.audioContext.state === 'suspended') {
            void this.audioContext.resume();
        }
    }

    private ensureContext() {
        if (this.audioContext) {
            return;
        }
        // 'interactive' is the lowest-latency preset (smallest internal buffer) - already the
        // default with no options, but named explicitly here since it's the reason this exists.
        this.audioContext = new AudioContext({latencyHint: 'interactive'});
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
