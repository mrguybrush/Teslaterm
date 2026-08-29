// Where a session's webcam video and its metadata live, derived from the session's own zip path.
//
// Deriving both from the zip path rather than storing them in the session index keeps the two
// sides independent: the video is written by the renderer (MediaRecorder only exists there) while
// the index entry is written by the main process once its export worker finishes, and those two
// finish in no particular order. Anything that needs the video just asks the filesystem.

export function videoPathForSession(sessionZipPath: string): string {
    return stripZip(sessionZipPath) + '.webm';
}

export function videoMetaPathForSession(sessionZipPath: string): string {
    return stripZip(sessionZipPath) + '.video.json';
}

/** Contents of the sidecar written next to the video file. */
export interface FlightVideoMeta {
    // Wall-clock time of the video's first frame. The recorder only starts once getUserMedia has
    // handed over a stream, which is noticeably later than the session start, so playback needs
    // this to line the video up against the session's own absolute event timestamps.
    startEpochMs: number;
}

function stripZip(sessionZipPath: string): string {
    return sessionZipPath.endsWith('.zip') ? sessionZipPath.slice(0, -'.zip'.length) : sessionZipPath;
}
