import {MixerLayer, VolumeKey, VolumeUpdate} from "./MixerTypes";
import {MidiPlaylistInfo} from "./MidiPlaylistTypes";
import {MultiConnectionOptions, SingleConnectionOptions} from './SingleConnectionOptions';
import {CoilID, coilSuffix} from "./constants";
import {ConnectionPreset, FaderID} from "./IPCConstantsToRenderer";

// The type parameter is purely a compile-time safeguard to make sure both sides agree on what data should be sent over
// this channel
export interface IPCToMainKey<Type> {
    channel: string;
}

function makeKey<Type>(channel: string): IPCToMainKey<Type> {
    return {channel};
}

export const IPC_CONSTANTS_TO_MAIN = {
    centralTab: {
        requestCentralTelemetrySync: makeKey<undefined>('central-telemetry-sync'),
        requestTelemetryNames: makeKey<undefined>('request-telemetry-names'),
        setCentralTelemetry: makeKey<string[]>('set-central-telemetry'),
        setMIDIProgramOverride: makeKey<[FaderID, number]>('set-program-override'),
        setMixerLayer: makeKey<MixerLayer>('set-mixer-layer'),
        setPlaylistIndex: makeKey<number>('playlist-index'),
        setVolume: makeKey<[VolumeKey, VolumeUpdate]>('set-volume'),
    },
    clearCoils: makeKey<undefined>('clear-coils'),
    commands: {
        setAllKillState: makeKey<boolean>('set-kill-state'),
        setBusState: makeKey<boolean>('set-bus-state'),
        setTRState: makeKey<boolean>('set-tr-state'),
    },
    connect: {
        connect: makeKey<SingleConnectionOptions>('connect-to-ud3'),
        multiconnect: makeKey<MultiConnectionOptions>('connect-to-multiple-ud3'),
        requestSuggestions: makeKey<undefined>('request-connect-suggestions'),
        setPresets: makeKey<ConnectionPreset[]>('set-connect-presets'),
    },
    flightRecorder: {
        deleteSession: makeKey<string>('flight-session-delete'),
        exportSession: makeKey<string>('flight-session-export'),
        openSession: makeKey<string>('flight-session-open'),
        requestSessionList: makeKey<undefined>('flight-session-list-request'),
    },
    loadFile: makeKey<DroppedFile[]>('load-file'),
    loadFlightRecording: makeKey<number[]>('load-flight-recording'),
    midiPlaylist: {
        deleteFile: makeKey<string>('midi-playlist-delete-file'),
        deletePlaylist: makeKey<string>('midi-playlist-delete'),
        playFile: makeKey<string>('midi-playlist-play-file'),
        renamePlaylist: makeKey<{ oldName: string, newName: string }>('midi-playlist-rename'),
        requestFileList: makeKey<undefined>('midi-playlist-file-list-request'),
        requestImport: makeKey<undefined>('midi-playlist-import'),
        requestPlaylistList: makeKey<undefined>('midi-playlist-list-request'),
        savePlaylist: makeKey<MidiPlaylistInfo>('midi-playlist-save'),
    },
    menu: {
        startMedia: makeKey<undefined>('start-media'),
        stopMedia: makeKey<undefined>('stop-media'),
    },
    midiMessage: makeKey<Uint8Array>('midi-message'),
    requestFullSync: makeKey<undefined>('request-full-sync'),
    script: {
        confirmOrDeny: makeKey<ConfirmReply>('script-confirm'),
        startScript: makeKey<undefined>('start-script'),
        stopScript: makeKey<undefined>('stop-script'),
    },
    setAutoFlightRecording: makeKey<boolean>('setAutoFlightRecording'),
    setDarkMode: makeKey<boolean>('setDarkMode'),
    setScopeBackgroundColor: makeKey<string>('setScopeBackgroundColor'),
    setScopeGridColor: makeKey<string>('setScopeGridColor'),
    setScopeTraceColors: makeKey<string[]>('setScopeTraceColors'),
    setSliderSize: makeKey<number>('setSliderSize'),
    setVoltagePhases: makeKey<number>('setVoltagePhases'),
    setWindowSizeToCurrent: makeKey<undefined>('setWindowSizeToCurrent'),
    sliders: {
        setBPS: makeKey<number>('slider-set-bps'),
        setBurstOfftime: makeKey<number>('slider-set-burst-offtime'),
        setBurstOntime: makeKey<number>('slider-set-burst-ontime'),
        setOntimeRelative: makeKey<number>('slider-set-ontime-rel'),
    },
};

export function getToMainIPCPerCoil(coil: CoilID) {
    const suffix = coilSuffix(coil);
    const makeCoilKey = <Type>(channel: string) => makeKey<Type>(channel + suffix);
    return {
        commands: {
            saveEEPROM: makeCoilKey<undefined>('save-eeprom'),
            setBusState: makeCoilKey<boolean>('set-bus-state'),
            setKillState: makeCoilKey<boolean>('set-kill-state'),
            setParms: makeCoilKey<Map<string, string>>('set-parms'),
            setTRState: makeCoilKey<boolean>('set-tr-state'),
        },
        dumpFlightRecorder: makeCoilKey<CoilID>('dump-flight-recorder'),
        manualCommand: makeCoilKey<string>('manual-command'),
        menu: {
            disconnect: makeCoilKey<undefined>('disconnect-from-coil'),
            downloadUD3ConfigElectron: makeCoilKey<undefined>('download-ud-config-electron'),
            requestAlarmList: makeCoilKey<undefined>('request-alarms'),
            reconnect: makeCoilKey<undefined>('reconnect-if-idle'),
            requestConfigList: makeCoilKey<undefined>('request-config-list'),
            requestSingleConfig: makeCoilKey<string>('request-single-config'),
            requestUDConfig: makeCoilKey<undefined>('request-ud-config'),
        },
        sliders: {
            setBPS: makeCoilKey<number>('slider-set-bps'),
            setBurstOfftime: makeCoilKey<number>('slider-set-burst-offtime'),
            setBurstOntime: makeCoilKey<number>('slider-set-burst-ontime'),
            setOntimeAbsolute: makeCoilKey<number>('slider-set-ontime-abs'),
            setVolumeFraction: makeKey<number>('slider-volume-fraction'),
        },
    };
}

export type PerCoilMainIPCs = ReturnType<typeof getToMainIPCPerCoil>;

export class ConfirmReply {
    public readonly confirmed: boolean;
    public readonly requestID: number;

    constructor(confirmed: boolean, id: number) {
        this.confirmed = confirmed;
        this.requestID = id;
    }
}

export interface DroppedFile {
    name: string;
    bytes: number[];
    path?: string;
}
