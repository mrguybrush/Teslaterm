import {app} from "electron";
import {spawn} from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as path from "path";
import {AvailableVersion, IPC_CONSTANTS_TO_RENDERER} from "../common/IPCConstantsToRenderer";
import {processIPC} from "./ipc/IPCProvider";

// Matches the release CI (.github/workflows/release.yml), which zips the Windows --dir build
// under exactly this name and attaches it to the GitHub release created for each pushed vX.Y.Z tag.
const REPO = "mrguybrush/Teslaterm";
const WINDOWS_ASSET_NAME = "teslaterm-windows.zip";
// If cmd.exe somehow never reports back after launching the helper, quit anyway rather than
// leaving the app sitting there forever.
const HELPER_LAUNCH_TIMEOUT_MS = 10000;

interface GithubReleaseAsset {
    name: string;
    browser_download_url: string;
    size: number;
}

interface GithubRelease {
    tag_name: string;
    name?: string;
    body: string;
    published_at?: string;
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
// suffixes to worry about. Returns >0 if a is newer than b, <0 if older, 0 if equal.
function compareVersions(a: string, b: string): number {
    const parse = (v: string) => v.replace(/^v/i, "").split(".").map((part) => parseInt(part, 10) || 0);
    const pa = parse(a);
    const pb = parse(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); ++i) {
        const diff = (pa[i] || 0) - (pb[i] || 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

function isNewerVersion(remoteTag: string, currentVersion: string): boolean {
    return compareVersions(remoteTag, currentVersion) > 0;
}

// Versions before this shipped an auto-updater that didn't actually work (the update helper
// process got torn down along with the app on Windows instead of surviving to finish the install,
// fixed in v1.8.15/v1.8.16) - offering them in the version picker would let someone install a
// build that then has no working way to update itself again afterwards.
const MIN_SELECTABLE_VERSION = "1.8.16";

// The PowerShell script that does the actual work once this app has exited:
//   1. waits for this process to exit (its files are locked while running) via Wait-Process, which
//      works off the OS process handle instead of repeatedly re-querying a PID number - so it can't
//      be fooled by Windows recycling that PID onto something else, and its -Timeout means it can
//      never wait forever,
//   2. extracts the zip with Windows' own bundled tar.exe (bsdtar, which auto-detects zip format)
//      rather than a JS unzip library - a 100+MB archive with one huge binary blob (app.asar) is
//      exactly what a pure-JS decompressor tends to get subtly wrong,
//   3. robocopies the extracted build over the install directory (/R and /W retry a file that's
//      briefly still locked). It only adds/overwrites what's in the new build, so user data living
//      next to the exe (tt-ui-config.json, midis/, flight recordings) is untouched - none of it is
//      in the release zip,
//   4. relaunches the app. Note -WorkingDirectory: Teslaterm resolves tt-ui-config.json and midis/
//      relative to the *current directory*, so launching it with anything else as the cwd would
//      make it silently look for (and create) config in the wrong place.
//
// Every step is logged unconditionally. On success the whole temp dir (log included) is removed; on
// failure it's deliberately left behind so there's something to diagnose from, and the app is
// relaunched anyway so a failed update never leaves the user staring at a closed app.
function buildUpdateScript(zipPath: string, stagingDir: string, installDir: string, exeName: string): string {
    const tempDir = path.dirname(zipPath);
    const logPath = path.join(tempDir, "update.log");
    const exePath = path.join(installDir, exeName);
    const relaunch = `Start-Process -FilePath "${exePath}" -WorkingDirectory "${installDir}"`;
    return [
        `$log = "${logPath}"`,
        `function Note($m) { "$(Get-Date -Format o)  $m" | Out-File -FilePath $log -Append }`,
        `Note "helper started (pid $PID), waiting for Teslaterm pid ${process.pid}"`,
        `Wait-Process -Id ${process.pid} -Timeout 30 -ErrorAction SilentlyContinue`,
        // Extra grace period for the OS to release file handles/memory maps after the process is
        // gone from the task list.
        "Start-Sleep -Seconds 2",
        `Note "extracting"`,
        `New-Item -ItemType Directory -Force -Path "${stagingDir}" | Out-Null`,
        `& tar -xf "${zipPath}" -C "${stagingDir}"`,
        "if ($LASTEXITCODE -ne 0) {",
        `    Note "tar FAILED with exit code $LASTEXITCODE - relaunching old version"`,
        `    ${relaunch}`,
        "    exit 1",
        "}",
        `Note "copying into ${installDir}"`,
        `& robocopy "${stagingDir}" "${installDir}" /E /R:5 /W:2 /NFL /NDL /NJH /NJS | Out-Null`,
        "$rc = $LASTEXITCODE",
        "if ($rc -ge 8) {",
        `    Note "robocopy FAILED with exit code $rc - relaunching anyway"`,
        `    ${relaunch}`,
        "    exit 1",
        "}",
        `Note "copy ok (robocopy code $rc), relaunching"`,
        relaunch,
        `Note "done"`,
        // Only reached when everything worked, so the temp dir (and its log) can go.
        `Set-Location "${installDir}"`,
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

// Lets the user install any past release, not just the newest one - e.g. to roll back a version
// that misbehaves. GitHub returns releases newest-first, which is also the order the dropdown
// should show them in.
export async function listAvailableVersions() {
    if (process.platform !== "win32") {
        reportStatus("Automatic updates are only supported on Windows builds for now.", true);
        return;
    }
    try {
        const releases = await httpGetJson<GithubRelease[]>(
            `https://api.github.com/repos/${REPO}/releases?per_page=100`,
        );
        const versions: AvailableVersion[] = releases
            .filter((r) => r.assets.some((a) => a.name === WINDOWS_ASSET_NAME))
            .filter((r) => compareVersions(r.tag_name, MIN_SELECTABLE_VERSION) >= 0)
            .map((r) => ({name: r.name || r.tag_name, publishedAt: r.published_at || "", tag: r.tag_name}));
        processIPC.send(IPC_CONSTANTS_TO_RENDERER.availableVersions, versions);
    } catch (e) {
        reportStatus(`Failed to list versions: ${e.message || e}`, true);
    }
}

// Same "check, then explicit download step" flow as checkForUpdates(), just for a release the user
// picked by hand instead of always "latest" - this can be older, newer or equal to the version
// currently running. downloadAndInstallUpdate() below doesn't care which of those it is.
export async function selectVersion(tag: string) {
    if (process.platform !== "win32") {
        reportStatus("Automatic updates are only supported on Windows builds for now.", true);
        return;
    }
    try {
        reportStatus(`Loading ${tag}...`);
        const release = await httpGetJson<GithubRelease>(
            `https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
        );
        const asset = release.assets.find((a) => a.name === WINDOWS_ASSET_NAME);
        if (!asset) {
            reportStatus(`Release ${release.tag_name} has no Windows build attached.`, true);
            return;
        }
        if (compareVersions(release.tag_name, MIN_SELECTABLE_VERSION) < 0) {
            reportStatus(
                `${release.tag_name} predates v${MIN_SELECTABLE_VERSION}, when the auto-updater `
                + "was fixed - it can't be installed through this picker.",
                true,
            );
            return;
        }
        pendingRelease = release;
        const currentVersion = app.getVersion();
        const currentTag = currentVersion.replace(/^v/i, "");
        const releaseVersion = release.tag_name.replace(/^v/i, "");
        const action = releaseVersion === currentTag
            ? "Reinstall"
            : isNewerVersion(release.tag_name, currentVersion) ? "Update" : "Downgrade";
        reportStatus(
            `${action} to ${release.tag_name} selected (currently v${currentVersion}).`,
            false,
            true,
            release.body || undefined,
        );
    } catch (e) {
        reportStatus(`Failed to load ${tag}: ${e.message || e}`, true);
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
        const scriptPath = path.join(tempDir, "apply-update.ps1");
        fs.writeFileSync(scriptPath, buildUpdateScript(zipPath, stagingDir, installDir, exeName), "utf-8");

        // The script lives in a file (keeps the command line short regardless of how long the
        // install/temp paths are), but is invoked by *reading* it rather than by -File: PowerShell's
        // execution policy, and Group Policy on managed machines, gate running script files, and
        // getting silently blocked there would make the whole update do nothing.
        const bootstrap = `Invoke-Expression (Get-Content -Raw -LiteralPath '${scriptPath}')`;
        const encodedCommand = Buffer.from(bootstrap, "utf16le").toString("base64");

        pendingRelease = undefined;
        // Launched through `cmd /c start` rather than spawning PowerShell directly. Verified by
        // experiment on Windows: a directly-spawned child does NOT survive this app exiting, even
        // with detached: true and unref() - it gets torn down along with the parent, which is
        // exactly why the update previously appeared to do nothing at all after the app closed.
        // Going through `start` hands the helper off as an independent process that keeps running.
        const child = spawn(
            "cmd.exe",
            ["/c", "start", "", "/b", "powershell.exe",
                "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encodedCommand],
            {cwd: installDir, detached: true, stdio: "ignore", windowsHide: true},
        );
        // cmd.exe exits as soon as `start` has handed off the helper, so waiting for its exit -
        // rather than quitting the instant spawn() returns - guarantees the helper is actually
        // running before this process (cmd's parent) goes away.
        let quit = false;
        const quitOnce = () => {
            if (!quit) {
                quit = true;
                child.unref();
                app.quit();
            }
        };
        child.once("close", quitOnce);
        setTimeout(quitOnce, HELPER_LAUNCH_TIMEOUT_MS);
        child.once("error", (err) => {
            quit = true;
            reportStatus(`Update failed to start: ${err.message || err}`, true);
        });
    } catch (e) {
        reportStatus(`Update failed: ${e.message || e}`, true);
    }
}
