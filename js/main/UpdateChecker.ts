import {app} from "electron";
import {spawn} from "child_process";
import * as fs from "fs";
import * as https from "https";
import JSZip from "jszip";
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
}

interface GithubRelease {
    tag_name: string;
    assets: GithubReleaseAsset[];
}

// The "Check for updates" button lives in the connect screen's Settings dialog, which is shown
// before a coil is even connected and has no toast display mounted - so status goes out over its
// own dedicated channel instead of the usual (coil-oriented) toast system.
function reportStatus(message: string, isError: boolean = false) {
    processIPC.send(IPC_CONSTANTS_TO_RENDERER.updateCheckStatus, {isError, message});
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

function httpDownload(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        https.get(url, {headers: {"User-Agent": "Teslaterm-Updater"}}, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                res.resume();
                httpDownload(res.headers.location, destPath).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error(`Download failed with status ${res.statusCode}`));
                return;
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on("finish", () => file.close(() => resolve()));
            file.on("error", reject);
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

async function extractZipTo(zipPath: string, targetDir: string) {
    const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
    for (const relativePath of Object.keys(zip.files)) {
        const entry = zip.files[relativePath];
        const destPath = path.join(targetDir, relativePath);
        if (entry.dir) {
            fs.mkdirSync(destPath, {recursive: true});
        } else {
            fs.mkdirSync(path.dirname(destPath), {recursive: true});
            const content = await entry.async("nodebuffer");
            fs.writeFileSync(destPath, content);
        }
    }
}

// Writes a small batch script that waits for this process to actually exit (its files are locked
// while running, so they can't be overwritten in place), then copies the newly extracted build
// over the current install directory and relaunches it. xcopy only adds/overwrites files that
// exist in the new build - user data living alongside the exe (tt-ui-config.json, the midis/
// folder, flight recordings, ...) isn't part of the release zip, so it's never touched.
function writeUpdateScript(scriptPath: string, stagingDir: string, installDir: string, exeName: string): void {
    const script = [
        "@echo off",
        `set PID=${process.pid}`,
        ":waitloop",
        `tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL`,
        "if not errorlevel 1 (",
        "  timeout /t 1 /nobreak >NUL",
        "  goto waitloop",
        ")",
        `xcopy /Y /E /I "${stagingDir}" "${installDir}" >NUL`,
        `start "" "${path.join(installDir, exeName)}"`,
        `del "%~f0"`,
    ].join("\r\n");
    fs.writeFileSync(scriptPath, script, "utf-8");
}

export async function checkForUpdates() {
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

        reportStatus(`Downloading ${release.tag_name}...`);
        const tempDir = fs.mkdtempSync(path.join(app.getPath("temp"), "teslaterm-update-"));
        const zipPath = path.join(tempDir, WINDOWS_ASSET_NAME);
        await httpDownload(asset.browser_download_url, zipPath);

        reportStatus("Installing update and restarting...");
        const stagingDir = path.join(tempDir, "extracted");
        fs.mkdirSync(stagingDir, {recursive: true});
        await extractZipTo(zipPath, stagingDir);

        const installDir = path.dirname(app.getPath("exe"));
        const exeName = path.basename(app.getPath("exe"));
        const scriptPath = path.join(tempDir, "apply-update.bat");
        writeUpdateScript(scriptPath, stagingDir, installDir, exeName);

        spawn("cmd.exe", ["/c", scriptPath], {cwd: tempDir, detached: true, stdio: "ignore"}).unref();
        app.quit();
    } catch (e) {
        reportStatus(`Update failed: ${e.message || e}`, true);
    }
}
