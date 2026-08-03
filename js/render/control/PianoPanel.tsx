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
// The 3 notes of an arpeggio triad fit into a single BPM beat (i.e. they're played as a triplet),
// not one note per beat - the latter felt sluggish at any reasonable tempo.
const ARPEGGIO_NOTES_PER_BEAT = 3;
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
    // Tracked live (not just at press time) so an already-running arpeggio switches between
    // major/minor as soon as AltGr is pressed or released, instead of only at the initial press.
    private altGrHeld = false;
    // Timestamps of recent taps of the "Tap" tempo button.
    private readonly tapTimestamps: number[] = [];
    private readonly synth = new CoilSynth();

    constructor(props: PianoPanelProps) {
        super(props);
        this.state = {
            absoluteChordKeys: false,
            arpeggioEnabled: false,
            bpm: BPM_DEFAULT,
            layout: 'de',
            previewMode: true,
            pressedBaseNotes: new Set(),
            slideEnabled: false,
            transpose: 0,
        };
    }

    private beatMs(): number {
        return 60000 / this.state.bpm;
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

    public componentDidUpdate(prevProps: PianoPanelProps) {
        if (prevProps.active !== this.props.active) {
            if (this.props.active) {
                this.attachListeners();
            } else {
                this.detachListeners();
                this.releaseAll();
            }
        }
    }

    public componentWillUnmount() {
        super.componentWillUnmount();
        this.detachListeners();
        this.releaseAll();
        this.synth.stopAll();
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

    private playNote(key: string, note: number) {
        if (this.state.previewMode) {
            this.synth.noteOn(key, note);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, noteOnBytes(note));
        }
    }

    private stopNote(key: string, note: number) {
        if (this.state.previewMode) {
            this.synth.noteOff(key);
        } else {
            processIPC.send(IPC_CONSTANTS_TO_MAIN.midiMessage, noteOffBytes(note));
        }
    }

    private buildKeyMap(): Map<string, number> {
        if (this.state.arpeggioEnabled && this.state.absoluteChordKeys) {
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
        return map;
    }

    private readonly onKeyDown = (ev: KeyboardEvent) => {
        if (isTypingTarget(ev.target)) {
            // Don't hijack keystrokes meant for a text field (e.g. max_tr_pw, a playlist name)
            // just because the piano is active in the background on another tab.
            return;
        }
        this.altGrHeld = ev.getModifierState('AltGraph');
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
        this.altGrHeld = ev.getModifierState('AltGraph');
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
        const note = clampNote(baseNote + this.state.transpose);
        if (this.state.arpeggioEnabled) {
            this.startArpeggio(baseNote, note);
            return;
        }
        if (this.state.slideEnabled) {
            if (this.monoSoundingNote !== undefined && this.monoSoundingNote !== note) {
                this.slideTo(baseNote, note);
            } else if (this.monoSoundingNote === undefined) {
                this.playNote('mono', note);
                this.monoOwnerBaseNote = baseNote;
                this.monoSoundingNote = note;
            }
            return;
        }
        this.playNote(String(baseNote), note);
        this.soundingNoteFor.set(baseNote, note);
    }

    private release(baseNote: number) {
        if (!this.state.pressedBaseNotes.has(baseNote)) {
            return;
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
        if (this.arpeggioRuns.has(baseNote)) {
            this.stopArpeggio(baseNote);
            return;
        }
        if (this.state.slideEnabled) {
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
        const steps = Math.max(1, Math.round(this.beatMs() / SLIDE_STEP_MS));
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
        run.handle = setInterval(step, this.beatMs() / ARPEGGIO_NOTES_PER_BEAT);
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

    private setTranspose(newValue: number) {
        this.setState({transpose: Math.max(TRANSPOSE_MIN, Math.min(TRANSPOSE_MAX, newValue))});
    }

    private setBpm(newValue: number) {
        this.setState({bpm: Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(newValue)))});
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
                        min={BPM_MIN}
                        max={BPM_MAX}
                        style={{width: '5em'}}
                        value={this.state.bpm}
                        onChange={(ev) => this.setBpm(Number(ev.target.value))}
                    />
                    <span>BPM</span>
                    <button
                        type={'button'}
                        className={'btn btn-secondary btn-sm'}
                        onClick={() => this.tap()}
                    >
                        Tap
                    </button>
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
                <Form.Check
                    type={'checkbox'}
                    id={'piano-arpeggio'}
                    label={'Arpeggio'}
                    title={'Hold AltGr while pressing a key for a minor arpeggio instead of major.'}
                    checked={this.state.arpeggioEnabled}
                    onChange={(ev) => this.setState({arpeggioEnabled: ev.target.checked})}
                />
                <Form.Check
                    type={'checkbox'}
                    id={'piano-absolute-chord-keys'}
                    label={'Absolute chord keys'}
                    title={'With Arpeggio on: A-G play the same-named chord directly (key C plays a C arpeggio) instead of following the normal keyboard layout.'}
                    checked={this.state.absoluteChordKeys}
                    onChange={(ev) => this.setState({absoluteChordKeys: ev.target.checked})}
                />
            </div>
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
            <div className={'tt-piano-keyboard'}>
                {WHITE_KEYS.map((w, i) => {
                    const black = blackByIndex.get(i);
                    return <div className={'tt-piano-white-slot'} key={w.note}>
                        <div
                            className={
                                'tt-piano-white-key' + (this.state.pressedBaseNotes.has(w.note) ? ' active' : '')
                            }
                            onMouseDown={(ev) => {
                                this.altGrHeld = ev.getModifierState('AltGraph');
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
                                this.altGrHeld = ev.getModifierState('AltGraph');
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
