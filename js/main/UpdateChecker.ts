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
// event with a silently truncated file. onProgress is called at most once per whole-percent change,
// not on every chunk, so it doesn't flood the renderer with IPC messages.
function httpDownload(
    url: string, destPath: string, expectedSize: number | undefined, onProgress: (percent: number) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, {headers: {"User-Agent": "Teslaterm-Updater"}}, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpDownload(res.headers.location, destPath, expectedSize, onProgress).then(resolve, reject);
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
            let lastPercent = -1;
            res.on("data", (chunk) => {
                received += chunk.length;
                if (expectedSize) {
                    const percent = Math.floor((received / expectedSize) * 100);
                    if (percent !== lastPercent) {
                        lastPercent = percent;
                        onProgress(percent);
                    }
                }
            });
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

// Builds (but doesn't write to disk) a PowerShell script that:
//   1. waits for this process to actually exit (its files are locked while running) via
//      Wait-Process, which operates on the OS process handle rather than repeatedly re-looking up
//      a PID number - unlike a poll loop that re-queries "is PID X still running" from scratch each
//      time, this can't be fooled by Windows recycling the freed PID onto some unrelated process in
//      between checks, and it has a built-in -Timeout so it can never wait forever,
//   2. extracts the downloaded zip using Windows' own bundled tar.exe (bsdtar, which auto-detects
//      zip format) rather than a JS unzip library - a 100+MB archive containing one large binary
//      blob (app.asar) is exactly the kind of thing a pure-JS decompressor can get subtly wrong,
//      and doing it from inside the still-running app added memory pressure for no benefit,
//   3. robocopies the extracted build over the current install directory (retrying a few times in
//      case a lingering handle needs a moment to let go - see /R and /W) - it only adds/overwrites
//      files that exist in the new build, so user data alongside the exe (tt-ui-config.json,
//      midis/, flight recordings, ...) is never touched since it isn't part of the release zip,
//   4. relaunches the exe and cleans up the temp download - but only if robocopy actually reported
//      success (exit code < 8); otherwise the old install is left alone instead of launching
//      something half-updated, and update-error.log records what went wrong.
//
// This is executed via `powershell -EncodedCommand`, deliberately *not* written to a .ps1 file and
// run with -File: PowerShell's execution policy (and, on managed machines, Group Policy on top of
// it) specifically gates running script *files* - -Command/-EncodedCommand input isn't subject to
// the same restriction, so this can't get silently blocked by a policy that would otherwise make
// the whole update quietly do nothing after the app closes. It also has no pipes anywhere (unlike
// the old "tasklist | find" batch loop), which is what caused the console-flashing before this -
// batch implements "cmd1 | cmd2" by spawning a *second* cmd.exe per pipe, and those don't reliably
// inherit a hidden console even when the top-level process has windowsHide set.
function buildUpdateScript(zipPath: string, stagingDir: string, installDir: string, exeName: string): string {
    const tempDir = path.dirname(zipPath);
    const logPath = path.join(tempDir, "update-error.log");
    const exePath = path.join(installDir, exeName);
    return [
        "$ErrorActionPreference = 'SilentlyContinue'",
        `Wait-Process -Id ${process.pid} -Timeout 30 -ErrorAction SilentlyContinue`,
        // Extra grace period for the OS to finish releasing file handles/memory maps after the
        // process has actually exited.
        "Start-Sleep -Seconds 2",
        `New-Item -ItemType Directory -Force -Path "${stagingDir}" | Out-Null`,
        `& tar -xf "${zipPath}" -C "${stagingDir}"`,
        "if ($LASTEXITCODE -ne 0) {",
        `    "Extraction failed with tar exit code $LASTEXITCODE." | Out-File -FilePath "${logPath}"`,
        "    exit 1",
        "}",
        `& robocopy "${stagingDir}" "${installDir}" /E /R:5 /W:2 /NFL /NDL /NJH /NJS | Out-Null`,
        "if ($LASTEXITCODE -ge 8) {",
        `    "Update copy failed, robocopy exit code $LASTEXITCODE." | Out-File -FilePath "${logPath}"`,
        "    exit 1",
        "}",
        `Start-Process -FilePath "${exePath}"`,
        `Remove-Item -Path "${tempDir}" -Recurse -Force -ErrorAction SilentlyContinue`,
    ].join("\r\n");
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
        reportStatus(`Downloading ${release.tag_name}... (0%)`);
        const tempDir = fs.mkdtempSync(path.join(app.getPath("temp"), "teslaterm-update-"));
        const zipPath = path.join(tempDir, WINDOWS_ASSET_NAME);
        await httpDownload(asset.browser_download_url, zipPath, asset.size, (percent) => {
            processIPC.send(IPC_CONSTANTS_TO_RENDERER.updateDownloadProgress, percent);
            reportStatus(`Downloading ${release.tag_name}... (${percent}%)`);
        });

        reportStatus("Installing update and restarting...");
        const stagingDir = path.join(tempDir, "extracted");
        const installDir = path.dirname(app.getPath("exe"));
        const exeName = path.basename(app.getPath("exe"));
        const script = buildUpdateScript(zipPath, stagingDir, installDir, exeName);
        // -EncodedCommand wants UTF-16LE, base64-encoded.
        const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

        pendingRelease = undefined;
        const child = spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedCommand],
            {cwd: tempDir, detached: true, stdio: "ignore", windowsHide: true},
        );
        // Only quit once the helper process has actually started - previously the app quit
        // unconditionally right after calling spawn(), so if PowerShell failed to launch at all
        // (blocked by security software, missing from PATH, ...) the app would just close with the
        // update silently never happening and nothing left to explain why.
        child.once("spawn", () => {
            child.unref();
            app.quit();
        });
        child.once("error", (err) => {
            reportStatus(`Update failed to start: ${err.message || err}`, true);
        });
    } catch (e) {
        reportStatus(`Update failed: ${e.message || e}`, true);
    }
}
