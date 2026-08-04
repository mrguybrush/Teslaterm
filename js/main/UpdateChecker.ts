import {app} from "electron";
import {spawn} from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import {IPC_CONSTANTS_TO_RENDERER} from "../common/IPCConstantsToRenderer";
import {processIPC} from "./ipc/IPCProvider";

// Matches the release CI (.github/workflows/release.yml), which zips the Windows --dir build
// under exactly this name and attaches it to the GitHub release created for each pushed vX.Y.Z tag.
const REPO = "mrguybrush/Teslaterm";
const WINDOWS_ASSET_NAME = "teslaterm-windows.zip";

interface GithubReleaseAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GithubRelease {
    tag_name: string;
    body: string;
    assets: GithubReleaseAsset[];
}

// Set by checkForUpdates() once it finds something newer, consumed by downloadAndInstallUpdate() -
// the user has to explicitly click a second "Download & install" button before anything is
// actually downloaded, so the two calls can happen an arbitrary amount of time apart.
let pendingRelease: GithubRelease | undefined;

// The "Check for updates" button lives in the connect screen's Settings dialog, which is shown
// before a coil is even connected and has no toast display mounted - so status goes out over its
// own dedicated channel instead of the usual (coil-oriented) toast system.
function reportStatus(
    message: string, isError: boolean = false, updateAvailable: boolean = false, releaseNotes: string = undefined,
) {
    processIPC.send(IPC_CONSTANTS_TO_RENDERER.updateCheckStatus, {isError, message, releaseNotes, updateAvailable});
}

// Both the GitHub API response and the asset download itself can come back as a redirect, so both
// helpers below need to follow one.
function httpGetJson<T>(url: string): Promise<T> {
    return new Promise((resolve, reject) => {
        https.get(url, {headers: {"User-Agent": "Teslaterm-Updater"}}, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpGetJson<T>(res.headers.location).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`GitHub API request failed with status ${res.statusCode}`));
                return;
            }
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
                } catch (e) {
                    reject(e);
                }
            });
            res.on("error", reject);
        }).on("error", reject);
    });
}

// Downloads to a temporary file first and only renames it into place once the byte count matches
// what the server announced - a connection that drops early can otherwise still fire a "finish"
// event with a silently truncated file.
function httpDownload(url: string, destPath: string, expectedSize?: number): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, {headers: {"User-Agent": "Teslaterm-Updater"}}, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpDownload(res.headers.location, destPath, expectedSize).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Download failed with status ${res.statusCode}`));
                return;
            }
            const partPath = destPath + ".part";
            const file = fs.createWriteStream(partPath);
            let received = 0;
            res.on("data", (chunk) => received += chunk.length);
            res.pipe(file);
            file.on("finish", () => file.close(() => {
                if (expectedSize !== undefined && received !== expectedSize) {
                    fs.unlink(partPath, () => undefined);
                    reject(new Error(`Download incomplete: got ${received} of ${expectedSize} bytes`));
                    return;
                }
                fs.renameSync(partPath, destPath);
                resolve();
            }));
            file.on("error", reject);
            res.on("error", reject);
        }).on("error", reject);
    });
}

// Simple numeric X.Y.Z compare - good enough for this repo's plain vX.Y.Z tags, no pre-release
// suffixes to worry about.
function isNewerVersion(remoteTag: string, currentVersion: string): boolean {
    const parse = (v: string) => v.replace(/^v/i, "").split(".").map((part) => parseInt(part, 10) || 0);
    const remote = parse(remoteTag);
    const current = parse(currentVersion);
    for (let i = 0; i < Math.max(remote.length, current.length); ++i) {
        const r = remote[i] || 0;
        const c = current[i] || 0;
        if (r !== c) {
            return r > c;
        }
    }
    return false;
}

// Writes a small batch script that:
//   1. waits for this process to actually exit (its files are locked while running),
//   2. extracts the downloaded zip using Windows' own bundled tar.exe (bsdtar, which auto-detects
//      zip format) rather than a JS unzip library - a 100+MB archive containing one large binary
//      blob (app.asar) is exactly the kind of thing a pure-JS decompressor can get subtly wrong,
//      and doing it from inside the still-running app added memory pressure for no benefit. Native
//      tar is what actually ships and gets tested on every Windows 10/11 install,
//   3. robocopies the extracted build over the current install directory (retrying a few times in
//      case a lingering helper process/file handle needs a moment to let go - see /R and /W) - it
//      only adds/overwrites files that exist in the new build, so user data alongside the exe
//      (tt-ui-config.json, midis/, flight recordings, ...) is never touched since it isn't part of
//      the release zip,
//   4. relaunches the exe - but only if robocopy actually reported success (exit code < 8);
//      otherwise the old install is left alone instead of launching something half-updated.
function writeUpdateScript(
    scriptPath: string, zipPath: string, stagingDir: string, installDir: string, exeName: string,
): void {
    const logPath = path.join(path.dirname(scriptPath), "update-error.log");
    const script = [
        "@echo off",
        "title Teslaterm Update",
        `set PID=${process.pid}`,
        `set EXENAME=${exeName}`,
        "set WAITCOUNT=0",
        ":waitloop",
        // Filtering on IMAGENAME as well as PID matters: Windows recycles a freed PID almost
        // immediately, and this very script spawns a fresh process (tasklist/find/timeout) on
        // every single loop iteration - it's entirely possible for one of those short-lived
        // helpers to get handed the old Teslaterm's just-freed PID, which would make a PID-only
        // check see "still running" forever and loop indefinitely.
        `tasklist /FI "PID eq %PID%" /FI "IMAGENAME eq %EXENAME%" 2>NUL | find "%PID%" >NUL`,
        "if not errorlevel 1 (",
        "  set /a WAITCOUNT+=1",
        "  if %WAITCOUNT% GEQ 30 goto waitdone",
        "  timeout /t 1 /nobreak >NUL",
        "  goto waitloop",
        ")",
        ":waitdone",
        // Extra grace period for the OS to finish releasing file handles/memory maps after the
        // process has already disappeared from the task list.
        "timeout /t 2 /nobreak >NUL",
        `mkdir "${stagingDir}" 2>NUL`,
        `tar -xf "${zipPath}" -C "${stagingDir}"`,
        "if errorlevel 1 (",
        `  echo Extraction failed with tar exit code %errorlevel%. > "${logPath}"`,
        "  goto end",
        ")",
        `robocopy "${stagingDir}" "${installDir}" /E /R:5 /W:2 /NFL /NDL /NJH /NJS >NUL`,
        "if errorlevel 8 (",
        `  echo Update copy failed, robocopy exit code %errorlevel%. > "${logPath}"`,
        ") else (",
        `  start "" "${path.join(installDir, exeName)}"`,
        ")",
        ":end",
        `del "%~f0"`,
    ].join("\r\n");
    fs.writeFileSync(scriptPath, script, "utf-8");
}

export async function checkForUpdates() {
    pendingRelease = undefined;
    if (process.platform !== "win32") {
        reportStatus("Automatic updates are only supported on Windows builds for now.", true);
        return;
    }
    try {
        reportStatus("Checking for updates...");
        const release = await httpGetJson<GithubRelease>(`https://api.github.com/repos/${REPO}/releases/latest`);
        const currentVersion = app.getVersion();
        if (!isNewerVersion(release.tag_name, currentVersion)) {
            reportStatus(`Already up to date (v${currentVersion}).`);
            return;
        }
        const asset = release.assets.find((a) => a.name === WINDOWS_ASSET_NAME);
        if (!asset) {
            reportStatus(`Release ${release.tag_name} has no Windows build attached.`, true);
            return;
        }
        pendingRelease = release;
        reportStatus(
            `Update available: ${release.tag_name} (currently v${currentVersion}).`,
            false,
            true,
            release.body || undefined,
        );
    } catch (e) {
        reportStatus(`Update check failed: ${e.message || e}`, true);
    }
}

export async function downloadAndInstallUpdate() {
    const release = pendingRelease;
    if (!release) {
        reportStatus("Check for updates first.", true);
        return;
    }
    const asset = release.assets.find((a) => a.name === WINDOWS_ASSET_NAME);
    try {
        reportStatus(`Downloading ${release.tag_name}...`);
        const tempDir = fs.mkdtempSync(path.join(app.getPath("temp"), "teslaterm-update-"));
        const zipPath = path.join(tempDir, WINDOWS_ASSET_NAME);
        await httpDownload(asset.browser_download_url, zipPath, asset.size);

        reportStatus("Installing update and restarting...");
        const stagingDir = path.join(tempDir, "extracted");
        const installDir = path.dirname(app.getPath("exe"));
        const exeName = path.basename(app.getPath("exe"));
        const scriptPath = path.join(tempDir, "apply-update.bat");
        writeUpdateScript(scriptPath, zipPath, stagingDir, installDir, exeName);

        pendingRelease = undefined;
        // windowsHide is what actually matters here - without it, spawning cmd.exe still pops up a
        // visible console window on Windows regardless of detached/stdio: "ignore".
        spawn(
            "cmd.exe", ["/c", scriptPath], {cwd: tempDir, detached: true, stdio: "ignore", windowsHide: true},
        ).unref();
        app.quit();
    } catch (e) {
        reportStatus(`Update failed: ${e.message || e}`, true);
    }
}
