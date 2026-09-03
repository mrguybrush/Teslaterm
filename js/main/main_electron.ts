import {app, BrowserWindow} from "electron";
import * as fs from "fs";
import * as path from "path";
import {init} from "./init";
import {getUIConfig, saveUIConfigNow} from "./UIConfigHandler";

export let mainWindow: BrowserWindow;

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf-8"));
const windowTitle = `Teslaterm v${packageJson.version}`;

function createWindow() {
    init();
    const {windowWidth, windowHeight} = getUIConfig().syncedConfig;
    // Create the browser window.
    mainWindow = new BrowserWindow({
        height: windowHeight,
        width: windowWidth,
        title: windowTitle,
        // The packaged .exe/.ico carries this too (see package.json's build.win.icon), but that
        // only takes effect for a built app - an unpackaged `npm start` run has no exe resource to
        // pull an icon from, and would otherwise show Electron's own default one. A copy at the
        // project root rather than under build/ specifically: that directory is electron-builder's
        // own buildResources folder, read directly off disk at build time and not bundled into the
        // packaged app - confirmed by listing app.asar's contents, which does not include it.
        icon: path.join(__dirname, "../../app-icon.png"),
        webPreferences: {
            // TODO the goal is for both of these to be removed at some point
            nodeIntegration: true,
            contextIsolation: false,
        },
    });

    // and load the index.html of the app.
    mainWindow.loadFile(path.join(__dirname, "../../index_electron.html"));

    // Open the DevTools.
    // mainWindow.webContents.openDevTools();

    mainWindow.setMenuBarVisibility(false);

    // Electron otherwise resets the window title back to the page's own <title> (plain
    // "Teslaterm", with no version) as soon as the page finishes loading.
    mainWindow.on("page-title-updated", (event) => {
        event.preventDefault();
    });

    mainWindow.on("closed", () => {
        mainWindow = null;
    });
}

app.on("ready", createWindow);

app.on("window-all-closed", () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    // On OS X it"s common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        createWindow();
    }
});

app.on('will-quit', saveUIConfigNow);
