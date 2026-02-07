const { app, BrowserWindow, ipcMain, shell, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');

app.userAgentFallback = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';

let mainWindow;
let settingsWindow;
let splashWindow;
let tray;
let settings = {
    branch: 'stable',
    minimizeToTray: true,
    mod: 'equicord'
};
let isFirstLaunch = false;

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const iconPath = path.join(__dirname, 'img', 'recar.png');

const loadSettings = () => {
    if (process.argv.includes('--reset-config')) {
        console.log('[Main] --reset-config flag detected. Removing config file.');
        if (fs.existsSync(settingsPath)) {
            fs.unlinkSync(settingsPath);
        }
    }

    try {
        if (fs.existsSync(settingsPath)) {
            settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
            isFirstLaunch = false;
        } else {
            console.log('[Main] No settings found. Preparing first launch.');
            isFirstLaunch = true;
        }
    } catch (e) {
        console.error('Failed to load settings:', e);
        isFirstLaunch = true;
    }
};

const saveSettings = () => {
    try {
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (e) {
        console.error('Failed to save settings:', e);
    }
};

const getDiscordUrl = () => {
    switch (settings.branch) {
        case 'ptb': return 'https://ptb.discord.com/app';
        case 'canary': return 'https://canary.discord.com/app';
        default: return 'https://discord.com/app';
    }
};

const createSplashWindow = () => {
    splashWindow = new BrowserWindow({
        width: 300,
        height: 350,
        transparent: true,
        title: 'Recar',
        frame: false,
        alwaysOnTop: true,
        resizable: false,
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true
        }
    });

    splashWindow.loadFile(path.join(__dirname, 'splash.html'));
};

const createMainWindow = () => {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: 'Discord',
        backgroundColor: '#2b2d31',
        show: false,
        autoHideMenuBar: true,
        icon: iconPath,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            preload: path.join(__dirname, 'preload.js')
        }
    })

    app.isQuiting = false;
    mainWindow.on('close', (event) => {
        if (settings.minimizeToTray && !app.isQuiting) {
            event.preventDefault();
            mainWindow.hide();
        }
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith('http')) {
            shell.openExternal(url);
        }
        return { action: 'deny' };
    });

    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = Object.assign({}, details.responseHeaders);
        delete responseHeaders['content-security-policy'];
        delete responseHeaders['content-security-policy-report-only'];
        delete responseHeaders['Content-Security-Policy'];
        delete responseHeaders['Content-Security-Policy-Report-Only'];
        callback({ responseHeaders });
    });

    const session = mainWindow.webContents.session;

    const { desktopCapturer, Menu } = require('electron');
    session.setDisplayMediaRequestHandler((request, callback) => {
        desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {

            if (sources.length === 0) {
                callback(null);
                return;
            }

            if (sources.length === 1) {
                callback({ video: sources[0] });
                return;
            }

            const menu = Menu.buildFromTemplate(
                sources.map((source) => ({
                    label: source.name,
                    click: () => {
                        callback({ video: source });
                    }
                }))
            );
            menu.popup();
        }).catch((e) => {
            callback(null);
        });
    });

    mainWindow.loadURL(getDiscordUrl());

    mainWindow.on('page-title-updated', (e, title) => {
        const matches = title.match(/^\((\d+)\)/);
        if (matches) {
            const count = parseInt(matches[1], 10);
            app.setBadgeCount(count);
        } else {
            app.setBadgeCount(0);
        }
    });

    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            if (splashWindow) {
                splashWindow.close();
                splashWindow = null;
            }
            mainWindow.show();
        }, 1500);
    });
};

const createTray = () => {
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Recar', click: () => mainWindow.show() },
        { label: 'Settings', click: () => createSettingsWindow() },
        {
            label: 'Restart Recar', click: () => {
                app.isQuiting = true;
                app.relaunch();
                app.exit(0);
            }
        },
        { type: 'separator' },
        {
            label: 'Quit', click: () => {
                app.isQuiting = true;
                app.quit();
            }
        }
    ]);
    tray.setToolTip('Recar');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => mainWindow.show() || mainWindow.focus());
};

const createSettingsWindow = () => {
    if (settingsWindow) {
        settingsWindow.focus();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 400,
        height: 500,
        title: 'Recar Settings',
        icon: iconPath,
        autoHideMenuBar: true,
        backgroundColor: '#232323',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'settings.js')
        }
    });

    settingsWindow.loadFile(path.join(__dirname, 'settings.html'));

    // Auto-save and quit app on close if it's first launch and they haven't saved
    settingsWindow.on('closed', () => {
        settingsWindow = null;
        if (isFirstLaunch) {
            app.quit();
        }
    });
};

ipcMain.handle('get-settings', () => ({ ...settings, isFirstLaunch }));
ipcMain.handle('save-settings', (event, newSettings) => {
    settings = { ...settings, ...newSettings };
    saveSettings();
    isFirstLaunch = false; // Once saved, it's no longer first launch
    return true;
});

ipcMain.handle('restart-app', () => {
    app.isQuiting = true;

    // Filter out --reset-config so it doesn't loop
    const args = process.argv.slice(1).filter(arg => arg !== '--reset-config');
    app.relaunch({ args });

    app.exit(0);
});

app.whenReady().then(async () => {
    loadSettings();

    if (isFirstLaunch) {
        createSettingsWindow();
        return;
    }

    createSplashWindow();
    createTray();

    setTimeout(async () => {
        createMainWindow();

        try {
            const { default: Server } = await import('arrpc');
            const { WebSocketServer } = await import('ws');

            const wss = new WebSocketServer({ port: 1337 });
            const clients = new Set();

            wss.on('connection', (ws) => {
                console.log('[arRPC Bridge] Client connected');
                clients.add(ws);
                ws.on('close', () => {
                    console.log('[arRPC Bridge] Client disconnected');
                    clients.delete(ws);
                });
            });

            console.log('[arRPC Bridge] WebSocket server started on port 1337');

            const arrpc = await new Server();
            arrpc.on('activity', data => {
                console.log('[arRPC] Activity received:', data);
                const message = JSON.stringify(data);
                for (const client of clients) {
                    client.send(message);
                }
                console.log('[arRPC] Activity broadcasted to', clients.size, 'clients');
            });
            console.log('[arRPC] Rich Presence server started');
        } catch (e) {
            console.error('[arRPC] Failed to start:', e);
        }
    }, 2000);
});

app.on('window-all-closed', () => {
    app.quit();
});
