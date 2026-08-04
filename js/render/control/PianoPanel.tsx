import React from "react";
import {Form} from "react-bootstrap";
import {IPC_CONSTANTS_TO_MAIN} from "../../common/IPCConstantsToMain";
import {CoilSynth} from "../audio/CoilSynth";
import {processIPC} from "../ipc/IPCProvider";
import {TTComponent} from "../TTComponent";

export interface PianoPanelProps {
    disabled: boolean;
    // Whether the keyboard listeners should be active at all - once turned on here, it keeps
    // working even after switching to a different bottom tab.
    active: boolean;
    setActive: (active: boolean) => void;
    // Whether to actually render the on-screen keyboard/controls (only when this tab is selected).
    visible: boolean;
}

// Input types that don't consume regular letter/digit keystrokes, so focus sitting on one of
// these (e.g. right after clicking a checkbox) must not block piano keys.
const NON_TEXT_INPUT_TYPES = new Set([
    'checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image',
]);

function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target instanceof HTMLInputElement) {
        return !NON_TEXT_INPUT_TYPES.has(target.type);
    }
    return target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable;
}

type KeyboardLayout = 'en' | 'de';

interface WhiteKeyDef {
    note: number;
    key: string;
}

interface BlackKeyDef {
    afterWhiteIndex: number;
    note: number;
    key: string;
}

const WHITE_KEYS: WhiteKeyDef[] = [
    {key: 'Z', note: 60},
    {key: 'X', note: 62},
    {key: 'C', note: 64},
    {key: 'V', note: 65},
    {key: 'B', note: 67},
    {key: 'N', note: 69},
    {key: 'M', note: 71},
    {key: 'Q', note: 72},
    {key: 'W', note: 74},
    {key: 'E', note: 76},
    {key: 'R', note: 77},
    {key: 'T', note: 79},
    {key: 'Y', note: 81},
    {key: 'U', note: 83},
    {key: 'I', note: 84},
];

const BLACK_KEYS: BlackKeyDef[] = [
    {afterWhiteIndex: 0, key: 'S', note: 61},
    {afterWhiteIndex: 1, key: 'D', note: 63},
    {afterWhiteIndex: 3, key: 'G', note: 66},
    {afterWhiteIndex: 4, key: 'H', note: 68},
    {afterWhiteIndex: 5, key: 'J', note: 70},
    {afterWhiteIndex: 7, key: '2', note: 73},
    {afterWhiteIndex: 8, key: '3', note: 75},
    {afterWhiteIndex: 10, key: '5', note: 78},
    {afterWhiteIndex: 11, key: '6', note: 80},
    {afterWhiteIndex: 12, key: '7', note: 82},
];

// German (QWERTZ) keyboards swap the Z and Y keys relative to English (QWERTY) - every other
// letter/digit used here sits at the same position on both layouts.
function displayKey(baseKey: string, layout: KeyboardLayout): string {
    if (layout === 'de') {
        if (baseKey === 'Z') {
            return 'Y';
        }
        if (baseKey === 'Y') {
            return 'Z';
        }
    }
    return baseKey;
}

const TRANSPOSE_MIN = -24;
const TRANSPOSE_MAX = 24;
const OCTAVE_SEMITONES = 12;
const BPM_MIN = 20;
const BPM_MAX = 300;
const BPM_DEFAULT = 120;
const TAP_RESET_GAP_MS = 2000;
const TAP_HISTORY_LENGTH = 8;
const ARPEGGIO_INTERVALS_MAJOR = [0, 4, 7]; // major triad: root, major third, perfect fifth
const ARPEGGIO_INTERVALS_MINOR = [0, 3, 7]; // minor triad: root, minor third, perfect fifth
// The 3 notes of an arpeggio triad fit into a single BPM beat by default (played as a triplet),
// not one note per beat - the latter felt sluggish at any reasonable tempo. Adjustable in the UI.
const ARPEGGIO_NOTES_PER_BEAT_DEFAULT = 3;
// Below 1 means slower than one note per beat (e.g. 0.5 = one note every 2 beats); the top end
// goes well past what's musically a "triplet feel" for genuinely fast, buzzy arpeggios.
const ARPEGGIO_NOTES_PER_BEAT_MIN = 0.1;
const ARPEGGIO_NOTES_PER_BEAT_MAX = 64;
const ARPEGGIO_NOTES_PER_BEAT_STEP = 0.1;
const SLIDE_FACTOR_DEFAULT = 1;
const SLIDE_FACTOR_MIN = 0.1;
const SLIDE_FACTOR_MAX = 8;
const SLIDE_STEP_MS = 20;
// Widen the MIDI pitch bend range (default firmware range is +-2 semitones) so a slide can
// smoothly cover the full width of this 2-octave keyboard.
const BEND_RANGE_SEMITONES = 24;
const MIDI_CHANNEL = 0;

function clampNote(note: number): number {
    return Math.max(0, Math.min(127, note));
}

function noteOnBytes(note: number): Uint8Array {
    return new Uint8Array([0x90 | MIDI_CHANNEL, note, 127]);
}

function noteOffBytes(note: number): Uint8Array {
    return new Uint8Array([0x80 | MIDI_CHANNEL, note, 0]);
}

function pitchBendBytes(semitoneOffset: number): Uint8Array {
    const clamped = Math.max(-BEND_RANGE_SEMITONES, Math.min(BEND_RANGE_SEMITONES, semitoneOffset));
    const raw = Math.max(0, Math.min(16383, Math.round((clamped / BEND_RANGE_SEMITONES) * 8192) + 8192));
    return new Uint8Array([0xE0 | MIDI_CHANNEL, raw & 0x7F, (raw >> 7) & 0x7F]);
}

function controlChangeBytes(controller: number, value: number): Uint8Array {
    return new Uint8Array([0xB0 | MIDI_CHANNEL, controller, value]);
}

interface PianoPanelState {
    pressedBaseNotes: Set<number>;
    layout: KeyboardLayout;
    transpose: number;
    slideEnabled: boolean;
    arpeggioEnabled: boolean;
    // Single tempo driving both slide duration and arpeggio note speed (one beat each).
    bpm: number;
    // When on, keys play through this PC's speakers via a local synth instead of being sent to
    // the coil - same idea and toggle as the MIDI playlist panel's preview mode.
    previewMode: boolean;
    // Alternative keyboard mapping for arpeggios: the A-G letter keys directly play the
    // same-named chord (key "C" -> C major/minor arpeggio) instead of following the normal piano
    // key layout - a "chord organ" style mapping for quickly jamming named chords.
    absoluteChordKeys: boolean;
    // Multiplier on the beat length used for slide duration (1 = exactly one beat).
    slideFactor: number;
    // How many arpeggio notes fit into a single beat.
    arpeggioNotesPerBeat: number;
    metronomeEnabled: boolean;
    // Flips every beat while the metronome runs, driving the visual pulse.
    metronomeFlash: boolean;
    loopStationEnabled: boolean;
    loopRecording: boolean;
    // Set once the first layer is closed; undefined means no loop length has been established yet.
    loopLengthMs?: number;
    loopLayersView: LoopLayerView[];
    // A custom "arpeggio": instead of cycling through chord tones, a held key repeats a recorded
    // rhythm of retriggers, cycling every beatPatternBeats beats. beatPattern holds each pulse as a
    // 0..1 fraction of that whole cycle (not of a single beat - a tapped-in rhythm rarely fits in
    // exactly one beat, and squeezing it into one would bunch fast taps into an inaudible blur).
    beatRecordEnabled: boolean;
    recordingBeat: boolean;
    beatPattern: BeatPatternEvent[];
    beatPatternBeats: number;
}

// Natural note letters mapped to their pitch class in the same octave the normal keyboard layout
// starts from (Z = C4 = 60) - only used when absoluteChordKeys is on.
const NOTE_LETTER_TO_MIDI: Record<string, number> = {
    a: 69, b: 71, c: 60, d: 62, e: 64, f: 65, g: 67,
};

interface ArpeggioRun {
    handle?: ReturnType<typeof setInterval>;
    notes: number[];
    index: number;
    soundingNote?: number;
}

// Which mechanism actually made a given held key sound - recorded at press time and used at
// release time instead of re-checking the live checkboxes, so toggling a mode mid-hold (e.g.
// turning Slide time off while a slid note is still down) can't leave that note stuck on: release
// always tears down whatever actually started it, not whatever the checkboxes currently say.
type SoundMode = 'normal' | 'slide' | 'arpeggio' | 'beat' | 'chord';

interface BeatRun {
    note: number;
    pendingTimeouts: Array<ReturnType<typeof setTimeout>>;
}

// A single recorded press or release, timestamped as a 0..1 fraction of the whole pattern cycle -
// captures actual note durations (not just onsets), so a held tap sounds as long as it was held.
interface BeatPatternEvent {
    offset: number;
    on: boolean;
}

const DEFAULT_BEAT_PATTERN: BeatPatternEvent[] = [{offset: 0, on: true}, {offset: 0.5, on: false}];

// A single recorded note on/off, timestamped relative to the start of the loop cycle.
interface LoopEvent {
    offsetMs: number;
    note: number;
    on: boolean;
}

interface LoopLayer {
    id: number;
    events: LoopEvent[];
    muted: boolean;
}

interface LoopLayerView {
    id: number;
    muted: boolean;
    noteCount: number;
}

export class PianoPanel extends TTComponent<PianoPanelProps, PianoPanelState> {
    // Slide time makes the keyboard behave as a single monophonic glide voice (MIDI pitch bend
    // is channel-wide, so a "slide" can only meaningfully apply to one sounding note at a time).
    // These two track which physical key currently owns that one voice.
    private monoOwnerBaseNote?: number;
    private monoSoundingNote?: number;
    private slideAnimationHandle?: ReturnType<typeof setInterval>;
    // Base notes currently held down, oldest first - used so that releasing the top (currently
    // sounding) note while slide time is on can glide back down to whichever key is still held.
    private readonly heldStack: number[] = [];
    // Used only while slide time is off, where every key independently owns its own note-on/off.
    private readonly soundingNoteFor = new Map<number, number>();
    private readonly arpeggioRuns = new Map<number, ArpeggioRun>();
    private readonly beatRuns = new Map<number, BeatRun>();
    // Absolute chord keys with Arpeggio off: all three tones held together instead of cycled.
    private readonly chordNotesFor = new Map<number, number[]>();
    // What actually made each currently-held key sound, recorded at press time - see SoundMode.
    private readonly soundModeFor = new Map<number, SoundMode>();
    private beatRecordStartTime?: number;
    private beatRecordTaps: Array<{ t: number, on: boolean }> = [];
    // First-layer recording only: lazily set on the first note actually played (not on the Record
    // click), and kept updated on every subsequent event so the last one - normally a release -
    // marks where the loop should end.
    private firstLayerLastEventTime?: number;
    // Tracked live (not just at press time) so an already-running arpeggio switches between
    // major/minor as soon as AltGr is pressed or released, instead of only at the initial press.
    private altGrHeld = false;
    // Timestamps of recent taps of the "Tap" tempo button.
    private readonly tapTimestamps: number[] = [];
    private readonly synth = new CoilSynth();
    private metronomeHandle?: ReturnType<typeof setInterval>;

    // The loop station's timing/audio state lives in plain instance fields rather than React
    // state - it's driven by setTimeout chains that need to read the current data synchronously
    // and can't wait for a render cycle. `loopLayersView` in React state is a read-only mirror of
    // `loopLayers`, kept in sync explicitly, purely so the layer list can render.
    private loopLengthMs?: number;
    private loopStartTime?: number;
    private loopLayers: LoopLayer[] = [];
    private nextLoopLayerId = 1;
    private loopRecording = false;
    // Mirrors state.loopStationEnabled - the scheduler and record-start guards below run
    // synchronously right after a setState() call in the same event handler, where React's state
    // update hasn't been applied yet, so they need a value that's already up to date at that point.
    private loopStationEnabled = false;
    private recordStartTime?: number;
    private currentRecordingEvents: LoopEvent[] = [];
    private loopScheduleTimeouts: Array<ReturnType<typeof setTimeout>> = [];
    private recordAutoStopHandle?: ReturnType<typeof setTimeout>;

    constructor(props: PianoPanelProps) {
        super(props);
        this.state = {
            absoluteChordKeys: false,
            arpeggioEnabled: false,
            arpeggioNotesPerBeat: ARPEGGIO_NOTES_PER_BEAT_DEFAULT,
            beatPattern: [],
            beatPatternBeats: 1,
            beatRecordEnabled: false,
            bpm: BPM_DEFAULT,
            layout: 'de',
            loopLayersView: [],
            loopRecording: false,
            loopStationEnabled: false,
            metronomeEnabled: false,
            metronomeFlash: false,
            previewMode: true,
            pressedBaseNotes: new Set(),
            recordingBeat: false,
            slideEnabled: false,
            slideFactor: SLIDE_FACTOR_DEFAULT,
            transpose: 0,
        };
    }

    private beatMs(): number {
        // Guards against the BPM field transiently holding 0/invalid while being typed into.
        return 60000 / Math.max(1, this.state.bpm);
    }

    public componentDidMount() {
        if (this.props.active) {
            this.attachListeners();
        }
        // Widen the pitch bend range once so slides can cover more than +-2 semitones.
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, controlChangeBytes(0x65, 0x00));
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, controlChangeBytes(0x64, 0x00));
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, controlChangeBytes(0x06, BEND_RANGE_SEMITONES));
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, controlChangeBytes(0x65, 0x7F));
        processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, controlChangeBytes(0x64, 0x7F));
    }

    public componentDidUpdate(prevProps: PianoPanelProps, prevState: PianoPanelState) {
        if (prevProps.active !== this.props.active) {
            if (this.props.active) {
                this.attachListeners();
            } else {
                this.detachListeners();
                this.releaseAll();
            }
        }
        // The metronome's interval is otherwise fixed at whatever BPM was current when it started.
        if (prevState.bpm !== this.state.bpm && this.state.metronomeEnabled) {
            this.startMetronome();
        }
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.detachListeners();
        this.releaseAll();
        this.synth.stopAll();
        this.stopMetronome();
        if (this.loopRecording) {
            this.finishRecordingLayer();
        }
        this.stopLoopPlayback();
        if (this.recordAutoStopHandle !== undefined) {
            clearTimeout(this.recordAutoStopHandle);
        }
    }

    private attachListeners() {
        window.addEventListener('keydown', this.onKeyDown);
        window.addEventListener('keyup', this.onKeyUp);
    }

    private detachListeners() {
        window.removeEventListener('keydown', this.onKeyDown);
        window.removeEventListener('keyup', this.onKeyUp);
    }

    private releaseAll() {
        for (const baseNote of this.state.pressedBaseNotes) {
            this.release(baseNote);
        }
    }

    // Routes note on/off/control messages either to the coil (default) or to the local synth,
    // depending on the preview toggle - same idea as the MIDI playlist panel's preview mode.
    private sendMidi(bytes: Uint8Array) {
        if (!this.state.previewMode) {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, bytes);
        }
    }

    // `live` is false only when the loop station's own scheduler is the one triggering the note -
    // otherwise a recording layer would end up capturing the previous layers' looped playback
    // instead of just what the performer is actively playing.
    private playNote(key: string, note: number, live: boolean = true) {
        if (live) {
            this.recordLoopEvent(note, true);
        }
        if (this.state.previewMode) {
            this.synth.noteOn(key, note);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, noteOnBytes(note));
        }
    }

    private stopNote(key: string, note: number, live: boolean = true) {
        if (live) {
            this.recordLoopEvent(note, false);
        }
        if (this.state.previewMode) {
            this.synth.noteOff(key);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, noteOffBytes(note));
        }
    }

    private buildKeyMap(): Map<string, number> {
        if (this.state.absoluteChordKeys) {
            // A-G aren't affected by the DE/EN Z<->Y swap, so no layout handling is needed here.
            return new Map(Object.entries(NOTE_LETTER_TO_MIDI));
        }
        const map = new Map<string, number>();
        for (const w of WHITE_KEYS) {
            map.set(displayKey(w.key, this.state.layout).toLowerCase(), w.note);
        }
        for (const b of BLACK_KEYS) {
            map.set(displayKey(b.key, this.state.layout).toLowerCase(), b.note);
        }
        // ,/./- sit right after M on the bottom row, so they continue that row naturally instead
        // of jumping up to Q/W/E - an extra way to reach the same three notes, not a replacement.
        map.set(',', map.get(displayKey('Q', this.state.layout).toLowerCase()));
        map.set('.', map.get(displayKey('W', this.state.layout).toLowerCase()));
        map.set('-', map.get(displayKey('E', this.state.layout).toLowerCase()));
        return map;
    }

    // Windows implements AltGr as a Left-Ctrl+Right-Alt chord, and Chromium/Electron doesn't
    // always synthesize the 'AltGraph' virtual modifier from that reliably (depends on how the
    // active keyboard layout gets detected) - so Control+Alt both held is treated as AltGr too,
    // not just a direct AltGraph report, since that's what physically happens on the keyboard.
    private isAltGr(ev: { getModifierState(key: string): boolean }): boolean {
        return ev.getModifierState('AltGraph')
            || (ev.getModifierState('Control') && ev.getModifierState('Alt'));
    }

    private readonly onKeyDown = (ev: KeyboardEvent) => {
        if (isTypingTarget(ev.target)) {
            // Don't hijack keystrokes meant for a text field (e.g. max_tr_pw, a playlist name)
            // just because the piano is active in the background on another tab.
            return;
        }
        this.altGrHeld = this.isAltGr(ev);
        if (this.interactionBlocked() || ev.repeat) {
            return;
        }
        const note = this.buildKeyMap().get(ev.key.toLowerCase());
        if (note !== undefined) {
            this.press(note);
        }
    };

    private readonly onKeyUp = (ev: KeyboardEvent) => {
        if (isTypingTarget(ev.target)) {
            return;
        }
        this.altGrHeld = this.isAltGr(ev);
        const note = this.buildKeyMap().get(ev.key.toLowerCase());
        if (note !== undefined) {
            this.release(note);
        }
    };

    // Preview mode never touches the coil, so it should keep working even while a coil connection
    // is required for everything else (no connection, TR lock, etc.) - only actually sending to
    // the coil needs to respect that lock.
    private interactionBlocked(): boolean {
        return !this.state.previewMode && this.props.disabled;
    }

    private press(baseNote: number) {
        if (this.interactionBlocked() || this.state.pressedBaseNotes.has(baseNote)) {
            return;
        }
        this.setState((s) => ({pressedBaseNotes: new Set(s.pressedBaseNotes).add(baseNote)}));
        this.heldStack.push(baseNote);
        // Any key can tap in the rhythm while recording a beat - only the timing (including how
        // long it's held) is kept, so the pitch played here is discarded and reapplied to whatever
        // note is held during playback.
        if (this.state.recordingBeat) {
            this.tapBeat(true);
        }
        const note = clampNote(baseNote + this.state.transpose);
        // Absolute chord keys always play a chord, whether or not the general Arpeggio checkbox is
        // also on - the letter keys have no meaning as single notes in this mode. Arpeggio then
        // only decides HOW the chord sounds: cycled one tone at a time, or all held at once.
        if (this.state.absoluteChordKeys) {
            if (this.state.arpeggioEnabled) {
                this.soundModeFor.set(baseNote, 'arpeggio');
                this.startArpeggio(baseNote, note);
            } else {
                this.soundModeFor.set(baseNote, 'chord');
                this.startChord(baseNote, note);
            }
            return;
        }
        if (this.state.arpeggioEnabled) {
            this.soundModeFor.set(baseNote, 'arpeggio');
            this.startArpeggio(baseNote, note);
            return;
        }
        if (this.state.beatRecordEnabled) {
            this.soundModeFor.set(baseNote, 'beat');
            this.startBeatRun(baseNote, note);
            return;
        }
        if (this.state.slideEnabled) {
            this.soundModeFor.set(baseNote, 'slide');
            if (this.monoSoundingNote !== undefined && this.monoSoundingNote !== note) {
                this.slideTo(baseNote, note);
            } else if (this.monoSoundingNote === undefined) {
                this.playNote('mono', note);
                this.monoOwnerBaseNote = baseNote;
                this.monoSoundingNote = note;
            }
            return;
        }
        this.soundModeFor.set(baseNote, 'normal');
        this.playNote(String(baseNote), note);
        this.soundingNoteFor.set(baseNote, note);
    }

    private release(baseNote: number) {
        if (!this.state.pressedBaseNotes.has(baseNote)) {
            return;
        }
        if (this.state.recordingBeat) {
            this.tapBeat(false);
        }
        this.setState((s) => {
            const pressedBaseNotes = new Set(s.pressedBaseNotes);
            pressedBaseNotes.delete(baseNote);
            return {pressedBaseNotes};
        });
        const stackIndex = this.heldStack.indexOf(baseNote);
        if (stackIndex >= 0) {
            this.heldStack.splice(stackIndex, 1);
        }
        // Torn down according to however this specific key actually started sounding, not
        // whatever the mode checkboxes currently say - otherwise flipping a checkbox while a note
        // from the old mode is still held leaves it stuck on forever (nothing else ever stops it).
        const mode = this.soundModeFor.get(baseNote);
        this.soundModeFor.delete(baseNote);
        if (mode === 'arpeggio') {
            this.stopArpeggio(baseNote);
            return;
        }
        if (mode === 'beat') {
            this.stopBeatRun(baseNote);
            return;
        }
        if (mode === 'chord') {
            this.stopChord(baseNote);
            return;
        }
        if (mode === 'slide') {
            if (this.monoOwnerBaseNote === baseNote) {
                // Falling back to whichever other key is still held, if any, slides back down
                // (or up) to that note instead of just cutting off.
                const fallbackBaseNote = this.heldStack[this.heldStack.length - 1];
                if (fallbackBaseNote !== undefined) {
                    this.slideTo(fallbackBaseNote, clampNote(fallbackBaseNote + this.state.transpose));
                } else {
                    this.finishAnySlide();
                    if (this.monoSoundingNote !== undefined) {
                        this.stopNote('mono', this.monoSoundingNote);
                        this.sendMidi(pitchBendBytes(0));
                    }
                    this.monoOwnerBaseNote = undefined;
                    this.monoSoundingNote = undefined;
                }
            }
            // Releasing a key that isn't the current glide voice's owner is a no-op: while
            // slide time is on, only the most recently pressed key ever actually sounds.
            return;
        }
        const note = this.soundingNoteFor.get(baseNote);
        if (note !== undefined) {
            this.soundingNoteFor.delete(baseNote);
            this.stopNote(String(baseNote), note);
        }
    }

    private finishAnySlide() {
        if (this.slideAnimationHandle !== undefined) {
            clearInterval(this.slideAnimationHandle);
            this.slideAnimationHandle = undefined;
        }
    }

    private slideTo(newOwnerBaseNote: number, targetNote: number) {
        this.finishAnySlide();
        const fromNote = this.monoSoundingNote;
        const diff = targetNote - fromNote;
        const steps = Math.max(1, Math.round((this.beatMs() * this.state.slideFactor) / SLIDE_STEP_MS));
        let step = 0;
        this.slideAnimationHandle = setInterval(() => {
            step++;
            const progress = Math.min(1, step / steps);
            this.sendMidi(pitchBendBytes(diff * progress));
            if (this.state.previewMode) {
                this.synth.setNoteFrequency('mono', fromNote + diff * progress);
            }
            if (progress >= 1) {
                this.finishAnySlide();
                this.stopNote('mono', fromNote);
                this.sendMidi(pitchBendBytes(0));
                this.playNote('mono', targetNote);
                this.monoOwnerBaseNote = newOwnerBaseNote;
                this.monoSoundingNote = targetNote;
            }
        }, SLIDE_STEP_MS);
    }

    private startArpeggio(baseNote: number, rootNote: number) {
        const run: ArpeggioRun = {handle: undefined, index: -1, notes: []};
        const key = `arp-${baseNote}`;
        const step = () => {
            if (run.soundingNote !== undefined) {
                this.stopNote(key, run.soundingNote);
            }
            // Re-checked on every step (not just once at the initial press) so an already-running
            // arpeggio switches between major/minor as soon as AltGr is pressed or released.
            const intervals = this.altGrHeld ? ARPEGGIO_INTERVALS_MINOR : ARPEGGIO_INTERVALS_MAJOR;
            run.notes = intervals.map((offset) => clampNote(rootNote + offset));
            run.index = (run.index + 1) % run.notes.length;
            run.soundingNote = run.notes[run.index];
            this.playNote(key, run.soundingNote);
        };
        step();
        run.handle = setInterval(step, this.beatMs() / this.state.arpeggioNotesPerBeat);
        this.arpeggioRuns.set(baseNote, run);
    }

    private stopArpeggio(baseNote: number) {
        const run = this.arpeggioRuns.get(baseNote);
        if (!run) {
            return;
        }
        clearInterval(run.handle);
        if (run.soundingNote !== undefined) {
            this.stopNote(`arp-${baseNote}`, run.soundingNote);
        }
        this.arpeggioRuns.delete(baseNote);
    }

    // Absolute chord keys with Arpeggio off: a plain block chord, all tones held together for as
    // long as the key is down, instead of cycled one at a time.
    private startChord(baseNote: number, rootNote: number) {
        const intervals = this.altGrHeld ? ARPEGGIO_INTERVALS_MINOR : ARPEGGIO_INTERVALS_MAJOR;
        const notes = intervals.map((offset) => clampNote(rootNote + offset));
        this.chordNotesFor.set(baseNote, notes);
        for (const chordNote of notes) {
            this.playNote(`chord-${baseNote}-${chordNote}`, chordNote);
        }
    }

    private stopChord(baseNote: number) {
        const notes = this.chordNotesFor.get(baseNote);
        if (!notes) {
            return;
        }
        this.chordNotesFor.delete(baseNote);
        for (const chordNote of notes) {
            this.stopNote(`chord-${baseNote}-${chordNote}`, chordNote);
        }
    }

    // --- Beat Record --------------------------------------------------------------------------
    // A "custom arpeggio": instead of cycling through chord tones, a held key replays the recorded
    // press/release rhythm - including how long each hit was actually held, not just its onset -
    // cycling every beatPatternBeats beats, forever, until released.

    private startBeatRun(baseNote: number, note: number) {
        const key = `beat-${baseNote}`;
        const run: BeatRun = {note, pendingTimeouts: []};
        this.beatRuns.set(baseNote, run);
        const pattern = this.state.beatPattern.length > 0 ? this.state.beatPattern : DEFAULT_BEAT_PATTERN;
        const cycleBeats = Math.max(1, this.state.beatPatternBeats);
        const scheduleCycle = () => {
            run.pendingTimeouts = [];
            const cycleMs = this.beatMs() * cycleBeats;
            for (const event of pattern) {
                const t = setTimeout(() => {
                    if (event.on) {
                        this.playNote(key, note);
                    } else {
                        this.stopNote(key, note);
                    }
                }, event.offset * cycleMs);
                run.pendingTimeouts.push(t);
            }
            run.pendingTimeouts.push(setTimeout(scheduleCycle, cycleMs));
        };
        scheduleCycle();
    }

    private stopBeatRun(baseNote: number) {
        const run = this.beatRuns.get(baseNote);
        if (!run) {
            return;
        }
        for (const t of run.pendingTimeouts) {
            clearTimeout(t);
        }
        this.stopNote(`beat-${baseNote}`, run.note);
        this.beatRuns.delete(baseNote);
    }

    private toggleBeatRecording() {
        if (this.state.recordingBeat) {
            this.finishBeatRecording();
        } else {
            this.startBeatRecording();
        }
    }

    private startBeatRecording() {
        this.beatRecordStartTime = performance.now();
        this.beatRecordTaps = [];
        this.setState({recordingBeat: true});
    }

    private tapBeat(on: boolean) {
        if (!this.state.recordingBeat || this.beatRecordStartTime === undefined) {
            return;
        }
        this.beatRecordTaps.push({t: performance.now() - this.beatRecordStartTime, on});
    }

    private finishBeatRecording() {
        if (this.beatRecordStartTime === undefined) {
            this.setState({recordingBeat: false});
            return;
        }
        this.beatRecordStartTime = undefined;
        if (!this.beatRecordTaps.some((e) => e.on)) {
            // Nothing meaningful was tapped - keep whatever pattern was already recorded, if any.
            this.beatRecordTaps = [];
            this.setState({recordingBeat: false});
            return;
        }
        // The pattern starts at the first actual press, not at whenever the Record button was
        // clicked, so playback begins immediately when the key is pressed rather than after a
        // silent lead-in. If the last note tapped was still held when recording stopped, it's left
        // unreleased here too (no synthetic note-off inserted) - it just keeps sounding right up
        // to and through the pattern wrapping back to its start, instead of being muted at
        // whatever arbitrary instant the Stop button happened to be clicked. The recorded window
        // is then rescaled onto a whole number of beats (at the tempo used while recording) rather
        // than squeezed into exactly one - a tapped-in rhythm almost never spans exactly one beat,
        // and forcing it to would bunch fast taps closely enough that their attack/release ramps
        // overlap into a continuous buzz. Storing the cycle length in beats (not ms) keeps the
        // pattern sensible if the tempo changes later.
        const firstOnMs = this.beatRecordTaps.find((e) => e.on).t;
        const shifted = this.beatRecordTaps
            .filter((e) => e.t >= firstOnMs)
            .map((e) => ({t: e.t - firstOnMs, on: e.on}));
        const spanMs = Math.max(1, shifted[shifted.length - 1].t);
        const beatMsAtRecord = this.beatMs();
        const cycleBeats = Math.max(1, Math.round(spanMs / beatMsAtRecord));
        const cycleMs = cycleBeats * beatMsAtRecord;
        const pattern: BeatPatternEvent[] = shifted.map((e) => ({
            offset: Math.max(0, Math.min(0.999, e.t / cycleMs)),
            on: e.on,
        }));
        this.beatRecordTaps = [];
        this.setState({beatPattern: pattern, beatPatternBeats: cycleBeats, recordingBeat: false});
    }

    private setTranspose(newValue: number) {
        this.setState({transpose: Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, newValue))});
    }

    private setBpm(newValue: number) {
        this.setState({bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(newValue)))});
    }

    // Typing "60" digit-by-digit briefly passes through "6", which clamping-on-every-keystroke
    // would immediately snap up to BPM_MIN (20 > 6) before the second digit could be typed - so
    // the field accepts whatever's being typed as-is and only clamps once the user is done (blur).
    private onBpmInput(raw: string) {
        if (raw === '') {
            this.setState({bpm: 0});
            return;
        }
        const parsed = Number(raw);
        if (!isNaN(parsed)) {
            this.setState({bpm: parsed});
        }
    }

    private tap() {
        const now = Date.now();
        if (
            this.tapTimestamps.length > 0 &&
            now - this.tapTimestamps[this.tapTimestamps.length - 1] > TAP_RESET_GAP_MS
        ) {
            this.tapTimestamps.length = 0;
        }
        this.tapTimestamps.push(now);
        if (this.tapTimestamps.length > TAP_HISTORY_LENGTH) {
            this.tapTimestamps.shift();
        }
        if (this.tapTimestamps.length < 2) {
            return;
        }
        let totalIntervalMs = 0;
        for (let i = 1; i < this.tapTimestamps.length; i++) {
            totalIntervalMs += this.tapTimestamps[i] - this.tapTimestamps[i - 1];
        }
        const avgIntervalMs = totalIntervalMs / (this.tapTimestamps.length - 1);
        this.setBpm(60000 / avgIntervalMs);
    }

    private setSlideFactor(value: number) {
        this.setState({slideFactor: Math.max(SLIDE_FACTOR_MIN, Math.min(SLIDE_FACTOR_MAX, value))});
    }

    private setArpeggioNotesPerBeat(value: number) {
        this.setState({
            arpeggioNotesPerBeat: Math.max(
                ARPEGGIO_NOTES_PER_BEAT_MIN,
                // Fractional values matter here (e.g. 0.5 notes/beat), so no rounding to an int.
                Math.min(ARPEGGIO_NOTES_PER_BEAT_MAX, value),
            ),
        });
    }

    // --- Metronome ---------------------------------------------------------------------------

    private setMetronomeEnabled(enabled: boolean) {
        this.setState({metronomeEnabled: enabled});
        if (enabled) {
            this.startMetronome();
        } else {
            this.stopMetronome();
        }
    }

    private startMetronome() {
        this.stopMetronome();
        this.setState({metronomeFlash: true});
        this.metronomeHandle = setInterval(() => {
            this.setState((s) => ({metronomeFlash: !s.metronomeFlash}));
        }, this.beatMs());
    }

    private stopMetronome() {
        if (this.metronomeHandle !== undefined) {
            clearInterval(this.metronomeHandle);
            this.metronomeHandle = undefined;
        }
        this.setState({metronomeFlash: false});
    }

    // --- Loop station --------------------------------------------------------------------------
    // Classic looper workflow: the first recorded layer's length becomes the fixed loop length;
    // every layer after that records for exactly one loop cycle, phase-aligned to the shared loop
    // clock regardless of exactly when the user clicked Record, then starts looping automatically
    // alongside whatever's already playing (overdub).

    private recordLoopEvent(note: number, on: boolean) {
        if (!this.loopRecording) {
            return;
        }
        const now = performance.now();
        if (this.loopLengthMs === undefined) {
            // First layer: the loop's own timing reference is the first note actually played,
            // not the moment the Record button was clicked - so any lead-in silence before the
            // performer starts playing doesn't get baked into the loop length.
            if (this.recordStartTime === undefined) {
                if (!on) {
                    return;
                }
                this.recordStartTime = now;
            }
            this.currentRecordingEvents.push({note, offsetMs: now - this.recordStartTime, on});
            this.firstLayerLastEventTime = now;
            return;
        }
        if (this.recordStartTime === undefined) {
            return;
        }
        const offsetMs = (now - this.loopStartTime) % this.loopLengthMs;
        this.currentRecordingEvents.push({note, offsetMs, on});
    }

    private setLoopStationEnabled(enabled: boolean) {
        this.loopStationEnabled = enabled;
        this.setState({loopStationEnabled: enabled});
        if (!enabled) {
            if (this.loopRecording) {
                this.finishRecordingLayer();
            }
            this.stopLoopPlayback();
        } else if (this.loopLengthMs !== undefined) {
            this.scheduleLoopCycle();
        }
    }

    private toggleLoopRecording() {
        if (this.loopRecording) {
            this.finishRecordingLayer();
        } else {
            this.startRecordingLayer();
        }
    }

    private startRecordingLayer() {
        if (!this.loopStationEnabled || this.loopRecording) {
            return;
        }
        this.currentRecordingEvents = [];
        this.loopRecording = true;
        this.setState({loopRecording: true});
        if (this.loopLengthMs !== undefined) {
            // Overdub: starts immediately, phase-aligned to the shared loop clock, and auto-closes
            // after exactly one cycle - no need to click Record twice.
            this.recordStartTime = performance.now();
            this.recordAutoStopHandle = setTimeout(() => this.finishRecordingLayer(), this.loopLengthMs);
        } else {
            // First layer: recordStartTime is set lazily, on the first note actually played (see
            // recordLoopEvent) - not here.
            this.recordStartTime = undefined;
            this.firstLayerLastEventTime = undefined;
        }
    }

    private finishRecordingLayer() {
        if (!this.loopRecording) {
            return;
        }
        if (this.recordAutoStopHandle !== undefined) {
            clearTimeout(this.recordAutoStopHandle);
            this.recordAutoStopHandle = undefined;
        }
        const isFirstLayer = this.loopLengthMs === undefined;
        if (isFirstLayer && this.recordStartTime === undefined) {
            // Stopped without ever playing a note - nothing to close into a loop.
            this.currentRecordingEvents = [];
            this.loopRecording = false;
            this.setState({loopRecording: false});
            return;
        }
        const events = this.currentRecordingEvents;
        this.currentRecordingEvents = [];
        if (isFirstLayer) {
            // The loop ends at the last recorded event - normally a release - rather than
            // whenever the performer got around to clicking Stop, trimming trailing silence too.
            const endTime = this.firstLayerLastEventTime ?? performance.now();
            this.loopLengthMs = Math.max(200, endTime - this.recordStartTime);
            this.loopStartTime = this.recordStartTime;
            this.firstLayerLastEventTime = undefined;
            this.setState({loopLengthMs: this.loopLengthMs});
        }
        this.recordStartTime = undefined;
        this.loopRecording = false;
        this.loopLayers.push({events, id: this.nextLoopLayerId++, muted: false});
        this.setState({loopRecording: false});
        this.syncLoopLayersState();
        this.scheduleLoopCycle();
    }

    // Muting/deleting a layer clears its pending scheduled timeouts (via scheduleLoopCycle's own
    // reset), including whatever note-off was going to silence its currently-sounding note - so
    // without this, that note is left stuck on for good. Silencing every note the layer could ever
    // play is a bit of a blunt hammer, but stopNote() on an inactive key is a harmless no-op.
    private silenceLayer(layer: LoopLayer) {
        for (const note of new Set(layer.events.map((e) => e.note))) {
            this.stopNote(`loop-${layer.id}-${note}`, note, false);
        }
    }

    private toggleLayerMute(id: number) {
        const layer = this.loopLayers.find((l) => l.id === id);
        if (!layer) {
            return;
        }
        layer.muted = !layer.muted;
        if (layer.muted) {
            this.silenceLayer(layer);
        }
        this.syncLoopLayersState();
        this.scheduleLoopCycle();
    }

    private deleteLayer(id: number) {
        const layer = this.loopLayers.find((l) => l.id === id);
        if (layer) {
            this.silenceLayer(layer);
        }
        this.loopLayers = this.loopLayers.filter((l) => l.id !== id);
        this.syncLoopLayersState();
        if (this.loopLayers.length === 0) {
            this.resetLoopStation();
        } else {
            this.scheduleLoopCycle();
        }
    }

    private resetLoopStation() {
        if (this.loopRecording) {
            this.finishRecordingLayer();
        }
        this.stopLoopPlayback();
        this.loopLayers = [];
        this.loopLengthMs = undefined;
        this.loopStartTime = undefined;
        this.setState({loopLayersView: [], loopLengthMs: undefined});
    }

    private syncLoopLayersState() {
        this.setState({
            loopLayersView: this.loopLayers.map((l) => (
                {id: l.id, muted: l.muted, noteCount: l.events.filter((e) => e.on).length}
            )),
        });
    }

    private clearLoopSchedule() {
        for (const t of this.loopScheduleTimeouts) {
            clearTimeout(t);
        }
        this.loopScheduleTimeouts = [];
    }

    private stopLoopPlayback() {
        this.clearLoopSchedule();
        // Silence anything currently sounding from loop playback specifically.
        for (const layer of this.loopLayers) {
            for (const ev of layer.events) {
                if (ev.on) {
                    this.stopNote(`loop-${layer.id}-${ev.note}`, ev.note, false);
                }
            }
        }
    }

    private scheduleLoopCycle() {
        this.clearLoopSchedule();
        if (this.loopLengthMs === undefined || !this.loopStationEnabled) {
            return;
        }
        for (const layer of this.loopLayers) {
            if (layer.muted) {
                continue;
            }
            for (const ev of layer.events) {
                const key = `loop-${layer.id}-${ev.note}`;
                const timeout = setTimeout(() => {
                    if (ev.on) {
                        this.playNote(key, ev.note, false);
                    } else {
                        this.stopNote(key, ev.note, false);
                    }
                }, ev.offsetMs);
                this.loopScheduleTimeouts.push(timeout);
            }
        }
        const nextCycle = setTimeout(() => this.scheduleLoopCycle(), this.loopLengthMs);
        this.loopScheduleTimeouts.push(nextCycle);
    }

    private makeControls(): React.ReactNode {
        return <div className={'tt-piano-controls'}>
            <div className={'tt-piano-control-group'}>
                <Form.Check
                    type={'checkbox'}
                    id={'piano-active-toggle'}
                    label={'Piano active'}
                    title={'Keeps working after switching to another tab.'}
                    checked={this.props.active}
                    onChange={(ev) => this.props.setActive(ev.target.checked)}
                />
                <Form.Check
                    type={'switch'}
                    id={'piano-preview-mode'}
                    label={this.state.previewMode ? 'Preview locally' : 'Sending to the coil'}
                    title={'When on, keys play through this PC\'s speakers instead of the coil.'}
                    checked={this.state.previewMode}
                    onChange={(ev) => this.setState({previewMode: ev.target.checked})}
                />
            </div>
            <div className={'tt-piano-control-group'}>
                <Form.Select
                    size={'sm'}
                    style={{width: '9em'}}
                    title={'Keyboard layout'}
                    value={this.state.layout}
                    onChange={(ev) => this.setState({layout: ev.target.value as KeyboardLayout})}
                >
                    <option value={'en'}>English (QWERTY)</option>
                    <option value={'de'}>German (QWERTZ)</option>
                </Form.Select>
                <div className={'tt-piano-transpose'} title={'Transpose'}>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.setTranspose(this.state.transpose - OCTAVE_SEMITONES)}
                    >
                        Oct-
                    </button>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.setTranspose(this.state.transpose - 1)}
                    >
                        -
                    </button>
                    <span className={'tt-piano-transpose-value'}>{this.state.transpose}</span>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.setTranspose(this.state.transpose + 1)}
                    >
                        +
                    </button>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.setTranspose(this.state.transpose + OCTAVE_SEMITONES)}
                    >
                        Oct+
                    </button>
                </div>
            </div>
            <div className={'tt-piano-control-group'}>
                <div
                    className={'tt-piano-transpose'}
                    title={'Tempo - drives both the slide duration and the arpeggio speed (one beat each).'}
                >
                    <Form.Control
                        type={'number'}
                        size={'sm'}
                        style={{width: '5em'}}
                        value={this.state.bpm || ''}
                        onChange={(ev) => this.onBpmInput(ev.target.value)}
                        onBlur={() => this.setBpm(this.state.bpm)}
                    />
                    <span>BPM</span>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.tap()}
                    >
                        Tap
                    </button>
                    <span
                        className={'tt-piano-metronome-dot' + (this.state.metronomeFlash ? ' active' : '')}
                        title={'Metronome'}
                    />
                    <Form.Check
                        type={'switch'}
                        id={'piano-metronome'}
                        label={'Metronome'}
                        checked={this.state.metronomeEnabled}
                        onChange={(ev) => this.setMetronomeEnabled(ev.target.checked)}
                    />
                </div>
            </div>
            <div className={'tt-piano-control-group'}>
                <Form.Check
                    type={'checkbox'}
                    id={'piano-slide-time'}
                    label={'Slide time'}
                    checked={this.state.slideEnabled}
                    onChange={(ev) => this.setState({slideEnabled: ev.target.checked})}
                />
                <div className={'tt-piano-transpose'} title={'Slide duration = beat length x this factor'}>
                    <span>x</span>
                    <Form.Control
                        type={'number'}
                        size={'sm'}
                        step={0.1}
                        min={SLIDE_FACTOR_MIN}
                        max={SLIDE_FACTOR_MAX}
                        style={{width: '4.5em'}}
                        value={this.state.slideFactor}
                        onChange={(ev) => this.setSlideFactor(Number(ev.target.value))}
                    />
                </div>
            </div>
            <div className={'tt-piano-control-group'}>
                <Form.Check
                    type={'checkbox'}
                    id={'piano-arpeggio'}
                    label={'Arpeggio'}
                    title={'Hold AltGr while pressing a key for a minor arpeggio instead of major.'}
                    checked={this.state.arpeggioEnabled}
                    onChange={(ev) => this.setState({arpeggioEnabled: ev.target.checked})}
                />
                <div className={'tt-piano-transpose'} title={'Arpeggio notes per beat'}>
                    <Form.Control
                        type={'number'}
                        size={'sm'}
                        min={ARPEGGIO_NOTES_PER_BEAT_MIN}
                        max={ARPEGGIO_NOTES_PER_BEAT_MAX}
                        step={ARPEGGIO_NOTES_PER_BEAT_STEP}
                        style={{width: '4.5em'}}
                        value={this.state.arpeggioNotesPerBeat}
                        onChange={(ev) => this.setArpeggioNotesPerBeat(Number(ev.target.value))}
                    />
                    <span>notes/beat</span>
                </div>
            </div>
            <div className={'tt-piano-control-group'}>
                <Form.Check
                    type={'checkbox'}
                    id={'piano-beat-record'}
                    label={'Beat Record'}
                    title={'Records a press/release rhythm (with durations) that then repeats while a key is held - a custom arpeggio.'}
                    checked={this.state.beatRecordEnabled}
                    onChange={(ev) => this.setState({beatRecordEnabled: ev.target.checked})}
                />
                {this.state.beatRecordEnabled && <div className={'tt-piano-transpose'}>
                    <button
                        type={'button'}
                        className={'btn btn-sm ' + (this.state.recordingBeat ? 'btn-danger' : 'btn-secondary')}
                        onClick={() => this.toggleBeatRecording()}
                    >
                        {this.state.recordingBeat ? 'Stop' : '⏺ Record Beat'}
                    </button>
                    {this.state.recordingBeat && <button
                        type={'button'}
                        className={'btn btn-primary btn-sm'}
                        onClick={() => this.tapBeat(true)}
                    >
                        Tap
                    </button>}
                </div>}
            </div>
            <div className={'tt-piano-control-group'}>
                <Form.Check
                    type={'checkbox'}
                    id={'piano-absolute-chord-keys'}
                    label={'Absolute chord keys'}
                    title={'A-G play the same-named chord directly (key C plays a C chord) instead of following the normal keyboard layout. Hold AltGr for minor instead of major. Played as a block chord, or cycled one tone at a time if Arpeggio is also on.'}
                    checked={this.state.absoluteChordKeys}
                    onChange={(ev) => this.setState({absoluteChordKeys: ev.target.checked})}
                />
            </div>
        </div>;
    }

    private makeLoopStation(): React.ReactNode {
        const recordLabel = this.state.loopRecording
            ? '⏺ Recording...'
            : (this.state.loopLengthMs === undefined ? '⏺ Record' : '⏺ Overdub');
        return <div className={'tt-piano-loop-station'}>
            <div className={'tt-piano-loop-station-bar'}>
                <Form.Check
                    type={'switch'}
                    id={'piano-loop-station'}
                    label={'Loop Station'}
                    checked={this.state.loopStationEnabled}
                    onChange={(ev) => this.setLoopStationEnabled(ev.target.checked)}
                />
                {this.state.loopStationEnabled && <>
                    <button
                        type={'button'}
                        className={'btn btn-sm ' + (this.state.loopRecording ? 'btn-danger' : 'btn-secondary')}
                        onClick={() => this.toggleLoopRecording()}
                    >
                        {recordLabel}
                    </button>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        disabled={this.state.loopLayersView.length === 0}
                        onClick={() => this.resetLoopStation()}
                    >
                        Clear all
                    </button>
                    {this.state.loopLengthMs !== undefined &&
                        <span className={'tt-piano-hint'}>Loop: {(this.state.loopLengthMs / 1000).toFixed(1)}s</span>}
                </>}
            </div>
            {this.state.loopStationEnabled && this.state.loopLayersView.length > 0 && <div className={'tt-piano-loop-layers'}>
                {this.state.loopLayersView.map((layer, index) => (
                    <div key={layer.id} className={'tt-piano-loop-layer' + (layer.muted ? ' muted' : '')}>
                        <span
                            className={'tt-piano-loop-layer-name'}
                            onClick={() => this.toggleLayerMute(layer.id)}
                            title={layer.muted ? 'Click to unmute' : 'Click to mute'}
                        >
                            Layer {index + 1} ({layer.noteCount} notes)
                        </span>
                        <button
                            type={'button'}
                            className={'btn btn-outline-danger btn-sm'}
                            onClick={() => this.deleteLayer(layer.id)}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>}
        </div>;
    }

    public render(): React.ReactNode {
        if (!this.props.visible) {
            // Stays mounted (so listeners/state survive switching tabs) but renders nothing.
            return null;
        }
        const blackByIndex = new Map(BLACK_KEYS.map((b) => [b.afterWhiteIndex, b]));
        return <div className={'tt-piano-panel'}>
            {this.makeControls()}
            {this.makeLoopStation()}
            <div className={'tt-piano-keyboard'}>
                {WHITE_KEYS.map((w, i) => {
                    const black = blackByIndex.get(i);
                    return <div className={'tt-piano-white-slot'} key={w.note}>
                        <div
                            className={
                                'tt-piano-white-key' + (this.state.pressedBaseNotes.has(w.note) ? ' active' : '')
                            }
                            onMouseDown={(ev) => {
                                this.altGrHeld = this.isAltGr(ev);
                                this.press(w.note);
                            }}
                            onMouseUp={() => this.release(w.note)}
                            onMouseLeave={() => this.release(w.note)}
                        >
                            <span className={'tt-piano-key-label'}>{displayKey(w.key, this.state.layout)}</span>
                        </div>
                        {black && <div
                            className={
                                'tt-piano-black-key' +
                                (this.state.pressedBaseNotes.has(black.note) ? ' active' : '')
                            }
                            onMouseDown={(ev) => {
                                ev.stopPropagation();
                                this.altGrHeld = this.isAltGr(ev);
                                this.press(black.note);
                            }}
                            onMouseUp={(ev) => {
                                ev.stopPropagation();
                                this.release(black.note);
                            }}
                            onMouseLeave={() => this.release(black.note)}
                        >
                            <span className={'tt-piano-key-label'}>{displayKey(black.key, this.state.layout)}</span>
                        </div>}
                    </div>;
                })}
            </div>
        </div>;
    }
}
