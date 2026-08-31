import {ConnectionPreset} from "./IPCConstantsToRenderer";
import {VolumeSetting} from "./MixerTypes";
import {AdvancedOptions} from "./Options";
import {FullConnectionOptions} from "./SingleConnectionOptions";

// A user-saved snapshot of the Piano panel's Autonomous mode parameters - the built-in presets
// shown alongside these live only in the renderer (they're fixed), so only custom, user-created
// ones need to be persisted here.
export interface AutonomousPreset {
    name: string;
    root: number;
    scale: string;
    density: number;
    rangeOctaves: number;
    randomness: number;
    bpm: number;
    droidMode: boolean;
}

export interface SyncedUIConfig {
    connectionPresets: ConnectionPreset[];
    autonomousPresets: AutonomousPreset[];
    darkMode: boolean;
    centralTelemetry: string[];
    midiPrograms: string[];
    // Record a webcam video (with audio) alongside each flight recording session.
    recordVideo: boolean;
    // deviceId of the chosen camera, empty for the system default. Device ids are stable per
    // browser profile, so this survives restarts as long as the camera stays plugged in.
    videoDeviceId: string;
    windowWidth: number;
    windowHeight: number;
    sliderSize: number;
    voltagePhases: number;
    scopeBackgroundColor: string;
    scopeGridColor: string;
    scopeTraceColors: string[];
    scopeLineWidth: number;

    lastConnectOptions: FullConnectionOptions;
    advancedOptions: AdvancedOptions;
}

export interface CoilMixerState {
    channelSettings: Array<Partial<VolumeSetting>>;
    masterSetting: Partial<VolumeSetting>;
    sidSpecialSettings: Partial<VolumeSetting>;
}

export interface SavedMixerState {
    coilSettings: { [coilName: string]: CoilMixerState; };
    masterSettings: CoilMixerState;
    channelPrograms: string[];
}

export interface FullUIConfig {
    syncedConfig: SyncedUIConfig;
    mixerStateBySong: { [filename: string]: SavedMixerState};
}
