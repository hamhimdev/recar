const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Tray,
  Menu,
  screen,
} = require("electron");
const path = require("path");
const fs = require("fs");

// Single instance allowed
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (event, commandLine, workingDirectory) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch(
  "disable-features",
  "ParserBlockingScriptsIntervention,BlinkParserBlockingScriptsIntervention,AudioServiceOutOfProcess",
);

app.userAgentFallback =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

let mainWindow;
let settingsWindow;
let splashWindow;
let callWindow;
let callBaseHeight = 276;
let tray;
let pendingCallData = null;
let settings = {
  branch: "stable",
  minimizeToTray: true,
  startMaximized: true,
  mod: "equicord",
};
let isFirstLaunch = false;

const settingsPath = path.join(app.getPath("userData"), "settings.json");
const iconPath = path.join(__dirname, "assets", "img", "recar.png");

const loadSettings = () => {
  if (process.argv.includes("--reset-config")) {
    console.log("[Main] --reset-config flag detected. Removing config file.");
    if (fs.existsSync(settingsPath)) {
      fs.unlinkSync(settingsPath);
    }
  }

  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      isFirstLaunch = false;
    } else {
      console.log("[Main] No settings found. Preparing first launch.");
      isFirstLaunch = true;
    }
  } catch (e) {
    console.error("Failed to load settings:", e);
    isFirstLaunch = true;
  }
};

const saveSettings = () => {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error("Failed to save settings:", e);
  }
};

const getDiscordUrl = () => {
  switch (settings.branch) {
    case "ptb":
      return "https://ptb.discord.com/app";
    case "canary":
      return "https://canary.discord.com/app";
    default:
      return "https://discord.com/app";
  }
};

const createSplashWindow = () => {
  splashWindow = new BrowserWindow({
    width: 300,
    height: 350,
    transparent: true,
    title: "Recar",
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  splashWindow.loadFile(path.join(__dirname, "splash.html"));
};

const createCallWindow = () => {
  callWindow = new BrowserWindow({
    width: 232,
    height: 276,
    transparent: true,
    backgroundColor: "#111214",
    title: "Recar",
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    show: false,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "call.js"),
    },
  });

  callWindow.loadFile(path.join(__dirname, "call.html"));

  callWindow.once("ready-to-show", () => {
    if (pendingCallData) {
      callWindow.webContents.send("call-data", pendingCallData);
    }
    callWindow.show();
  });

  callWindow.on("closed", () => {
    callWindow = null;
  });
};

// Adjust call window height by delta from renderer (idempotent against base height)
ipcMain.on("call-adjust-height", (event, delta) => {
  if (!callWindow || callWindow.isDestroyed()) return;
  const width = 232;
  const d = Number(delta) || 0;
  const newH = (callBaseHeight || 276) + d;
  try {
    callWindow.setSize(width, newH);
  } catch (e) {
    console.error("[Main] Failed to set call window size:", e);
  }
});

const createMainWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Discord",
    backgroundColor: "#2b2d31",
    show: false,
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  app.isQuiting = false;
  mainWindow.on("close", (event) => {
    clearTimeout(splashTimeout);
    if (settings.minimizeToTray && !app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url, features }) => {
    const isPopup =
      features && (features.includes("width=") || features.includes("height="));
    if (isPopup) {
      return { action: "allow" };
    }
    shell.openExternal(url);
    return { action: "deny" };
  });

  const session = mainWindow.webContents.session;

  const { desktopCapturer, Menu } = require("electron");
  session.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer
      .getSources({ types: ["screen", "window"] })
      .then((sources) => {
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
            },
          })),
        );
        menu.popup({
          callback: () => {
            callback(null);
          },
        });
      })
      .catch((e) => {
        callback(null);
      });
  });

  mainWindow.loadURL(getDiscordUrl());

  mainWindow.on("page-title-updated", (e, title) => {
    console.log(`[Main] Title updated: ${title}`);
    const matches = title.match(/^\s*\((\d+)\)/);
    if (matches) {
      const count = parseInt(matches[1], 10);
      console.log(`[Main] Badge count detected: ${count}`);
      const success = app.setBadgeCount(count);
      console.log(`[Main] setBadgeCount(${count}) result: ${success}`);
    } else {
      app.setBadgeCount(0);
    }
  });

  mainWindow.once("ready-to-show", () => {
    splashTimeout = setTimeout(() => {
      if (splashWindow) {
        splashWindow.close();
        splashWindow = null;
      }
      if (settings.startMaximized) {
        mainWindow.maximize();
      }
      mainWindow.show();
    }, 1500);
  });
};

const createTray = () => {
  tray = new Tray(iconPath);
  const contextMenu = Menu.buildFromTemplate([
    { label: "Show Recar", click: () => mainWindow.show() },
    { label: "Settings", click: () => createSettingsWindow() },
    {
      label: "Restart Recar",
      click: () => {
        app.isQuiting = true;
        app.relaunch();
        app.exit(0);
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
    // { type: 'separator' },
    // { label: 'Open Call Window', click: () => createCallWindow() }
  ]);
  tray.setToolTip("Recar");
  tray.setContextMenu(contextMenu);
  tray.on("click", () => mainWindow.show() || mainWindow.focus());
};

const createSettingsWindow = () => {
  if (settingsWindow) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 400,
    height: 560,
    title: "Recar Settings",
    icon: iconPath,
    autoHideMenuBar: true,
    backgroundColor: "#232323",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "settings.js"),
    },
  });

  settingsWindow.loadFile(path.join(__dirname, "settings.html"));

  settingsWindow.once("ready-to-show", () => {
    settingsWindow.show();
  });

  // Auto-save and quit app on close if it's first launch and they haven't saved
  settingsWindow.on("closed", () => {
    settingsWindow = null;
    if (isFirstLaunch) {
      app.quit();
    }
  });
};

ipcMain.handle("get-settings", () => ({ ...settings, isFirstLaunch }));
ipcMain.handle("save-settings", (event, newSettings) => {
  settings = { ...settings, ...newSettings };
  saveSettings();
  isFirstLaunch = false; // Once saved, it's no longer first launch
  return true;
});

ipcMain.on("call-ring-started", (event, data) => {
  pendingCallData = data;
  if (!callWindow || callWindow.isDestroyed()) {
    createCallWindow();
  } else {
    callWindow.webContents.send("call-data", data);
    callWindow.show();
  }
});

ipcMain.on("call-ring-stopped", () => {
  pendingCallData = null;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.close();
  }
});

ipcMain.on("call-dismiss", () => {
  const channelId = pendingCallData?.channelId;
  if (channelId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `Vencord.Webpack.findByProps("stopRinging")?.stopRinging(${JSON.stringify(channelId)})`,
    );
  }
  pendingCallData = null;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.close();
  }
});

ipcMain.on("call-answer", () => {
  const channelId = pendingCallData?.channelId;
  if (channelId && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      `Vencord.Webpack.findByProps("stopRinging")?.call(${JSON.stringify(channelId)})`,
    );
    mainWindow.show();
    mainWindow.focus();
  }
  pendingCallData = null;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.close();
  }
});

ipcMain.handle("restart-app", () => {
  app.isQuiting = true;

  // Filter out --reset-config so it doesn't loop
  const args = process.argv.slice(1).filter((arg) => arg !== "--reset-config");
  app.relaunch({ args });

  app.exit(0);
});

app.whenReady().then(async () => {
  app.setName("recar");
  app.desktopName = "recar";
  app.setAppUserModelId("net.strangled.cutely.recar");
  loadSettings();

  const { session } = require("electron");
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = Object.assign({}, details.responseHeaders);
    const toDelete = [
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "x-content-type-options",
    ];

    for (const header of Object.keys(responseHeaders)) {
      if (toDelete.includes(header.toLowerCase())) {
        delete responseHeaders[header];
      }
    }

    callback({ responseHeaders });
  });

  if (isFirstLaunch) {
    createSettingsWindow();
    return;
  }
  createSplashWindow();
  createTray();
  setTimeout(async () => {
    createMainWindow();
    try {
      const { default: Server } = await import("arrpc");
      const { WebSocketServer } = await import("ws");

      const portAvailable = await isPortUsed(1337);

      if (portAvailable) {
        const wss = new WebSocketServer({ port: 1337 });
        const clients = new Set();
        wss.on("connection", (ws) => {
          console.log("[arRPC Bridge] Client connected");
          clients.add(ws);
          ws.on("close", () => {
            console.log("[arRPC Bridge] Client disconnected");
            clients.delete(ws);
          });
        });
        console.log("[arRPC Bridge] WebSocket server started on port 1337");

        const arrpc = await new Server();
        arrpc.on("activity", (data) => {
          console.log("[arRPC] Activity received:", data);
          const message = JSON.stringify(data);
          for (const client of clients) {
            client.send(message);
          }
          console.log(
            "[arRPC] Activity broadcasted to",
            clients.size,
            "clients",
          );
        });
        console.log("[arRPC] Rich Presence server started");
      } else {
        console.log(
          "[arRPC Bridge] Port 1337 is already in use, skipping websocket",
        );
        const arrpc = await new Server();
        arrpc.on("activity", (data) => {
          console.log("[arRPC] Activity received:", data);
        });
        console.log("[arRPC] Rich Presence server started (without websocket)");
      }
    } catch (e) {
      console.error("[arRPC] Failed to start:", e);
    }
  }, 2000);
});

app.on("window-all-closed", () => {
  app.quit();
});

function isPortUsed(port) {
  return new Promise((resolve) => {
    const server = require("net").createServer();
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}
