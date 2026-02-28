const { app, BrowserWindow, ipcMain, shell, Tray, Menu, screen } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

let venmic = null;
try {
	const { PatchBay } = require("@vencord/venmic");
	if (PatchBay.hasPipeWire()) {
		venmic = new PatchBay();
		console.log("[Venmic] Initialized successfully");
	} else {
		console.log("[Venmic] Pipewire not detected");
	}
} catch (e) {
	console.error("[Venmic] Failed to initialize:", e);
}

function getAudioServicePid() {
	try {
		const metrics = app.getAppMetrics();
		const audioService = metrics.find((p) => p.name === "Audio Service" || (p.type === "Utility" && p.name.includes("Audio")));
		return audioService ? audioService.pid.toString() : null;
	} catch {
		return null;
	}
}

// register this app as the handler for discord:// links
// uses xdg-mime instead of xdg-settings to avoid a long-standing ubuntu bug where xdg-settings would also register the app as the default browser
function registerDiscordProtocol() {
	if (process.platform !== "linux") return;

	const desktopFile = process.env.CHROME_DESKTOP || "recar.desktop";

	execFile("xdg-mime", ["default", desktopFile, "x-scheme-handler/discord"], (err) => {
		if (err) {
			console.error("[discord://] Failed to register protocol handler:", err.message);
		} else {
			console.log(`[discord://] Registered as handler via ${desktopFile}`);
		}
	});
}

// parse a discord:// uri and navigate mainWindow to the equivalent https://discord.com/... url, respecting the configured branch.
function handleDiscordUrl(uri) {
	if (!uri || !uri.startsWith("discord://")) return;
	if (!mainWindow || mainWindow.isDestroyed()) return;

	try {
		const parsed = new URL(uri);
		// parsed.pathname is e.g. "/channels/123/456" - slice off the leading slash.
		const discordPath = parsed.pathname.slice(1) || "app";

		const subdomain = settings.branch === "canary" || settings.branch === "ptb"
			? `${settings.branch}.`
			: "";

		const target = `https://${subdomain}discord.com/${discordPath}`;
		console.log(`[discord://] Navigating to ${target}`);

		mainWindow.loadURL(target);
		mainWindow.show();
		mainWindow.focus();
	} catch (e) {
		console.error("[discord://] Failed to parse URI:", uri, e);
	}
}

// Single instance allowed
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	app.on("second-instance", (event, commandLine, workingDirectory) => {
		// on linux/windows, the os re-launches the app and passes
		// the discord:// url as a command-line argument when already running.
		const discordUrl = commandLine.find((arg) => arg.startsWith("discord://"));
		if (discordUrl) {
			handleDiscordUrl(discordUrl);
			return;
		}

		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
}

app.commandLine.appendSwitch("enable-features", "WebRTCPipeWireCapturer");
app.commandLine.appendSwitch("disable-features", "ParserBlockingScriptsIntervention,BlinkParserBlockingScriptsIntervention,AudioServiceOutOfProcess");

app.userAgentFallback = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

let mainWindow;
let settingsWindow;
let splashWindow;
let callWindow;
let streamWindow;
let pendingStreamCallback = null;
let currentStreamSettings = { resolution: { width: 1920, height: 1080 }, fps: 60, contentHint: "motion" };
let callBaseHeight = 276;
let tray;
let pendingCallData = null;
let settings = {
	branch: "stable",
	minimizeToTray: true,
	startMaximized: true,
	autoEnableWebRPC: true,
	enableCallPopup: true,
};
let isFirstLaunch = false;
let discordCSS = null;

const extractCSS = async () => {
	if (!mainWindow || mainWindow.isDestroyed()) return;
	try {
		discordCSS = await mainWindow.webContents.executeJavaScript(`
      (() => {
        const computed = getComputedStyle(document.documentElement);
        const varNames = new Set();
        for (const sheet of document.styleSheets) {
          try {
            for (const rule of sheet.cssRules) {
              const matches = rule.cssText.matchAll(/var\\(\\s*(--([\\w-]+))/g);
              for (const m of matches) varNames.add(m[1]);
              if (rule.style) {
                for (const prop of rule.style) {
                  if (prop.startsWith('--')) varNames.add(prop);
                }
              }
            }
          } catch {}
        }
        const pairs = [...varNames]
          .map(name => {
            const v = computed.getPropertyValue(name).trim();
            return v ? name + ':' + v : '';
          })
          .filter(Boolean);
        return ':root{' + pairs.join(';') + '}';
      })()
    `);
		if (callWindow && !callWindow.isDestroyed()) {
			callWindow.webContents.insertCSS(discordCSS);
		}
	} catch (e) {
		console.error("[Main] Failed to extract Discord CSS:", e);
	}
};

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

	callWindow.once("ready-to-show", async () => {
		if (discordCSS) callWindow.webContents.insertCSS(discordCSS);
		await extractCSS();
		if (pendingCallData) {
			callWindow.webContents.send("call-data", pendingCallData);
		}
		callWindow.show();
	});

	callWindow.on("closed", () => {
		callWindow = null;
	});
};

const createStreamWindow = () => {
	if (streamWindow) {
		streamWindow.focus();
		return;
	}
	streamWindow = new BrowserWindow({
		width: 900,
		height: 640,
		title: "Share Your Screen",
		icon: iconPath,
		autoHideMenuBar: true,
		backgroundColor: "#0f1012",
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			preload: path.join(__dirname, "stream.js"),
		},
	});

	streamWindow.loadFile(path.join(__dirname, "stream.html"));
	streamWindow.once("ready-to-show", () => streamWindow.show());
	streamWindow.on("closed", () => {
		streamWindow = null;
		if (pendingStreamCallback) {
			pendingStreamCallback(null);
			pendingStreamCallback = null;
		}
	});
};

ipcMain.handle("get-session-type", () => {
	return {
		isWayland: process.env.WAYLAND_DISPLAY !== undefined || process.env.XDG_SESSION_TYPE === "wayland",
		platform: process.platform,
	};
});

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

ipcMain.on("discord-theme-changed", () => {
	extractCSS();
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
		const isPopup = features && (features.includes("width=") || features.includes("height="));
		if (isPopup) {
			return { action: "allow" };
		}
		shell.openExternal(url);
		return { action: "deny" };
	});

	const session = mainWindow.webContents.session;

	session.setDisplayMediaRequestHandler((request, callback) => {
		pendingStreamCallback = callback;
		createStreamWindow();
	});

	// if the app was cold-launched via a discord:// link (Linux/Windows pass it as a cli arg), load that url instead of the default /app page
	const startUrl = process.argv.find((arg) => arg.startsWith("discord://"));
	if (startUrl) {
		try {
			const parsed = new URL(startUrl);
			const discordPath = parsed.pathname.slice(1) || "app";
			const subdomain = settings.branch === "canary" || settings.branch === "ptb"
				? `${settings.branch}.`
				: "";
			mainWindow.loadURL(`https://${subdomain}discord.com/${discordPath}`);
			console.log(`[discord://] Cold-launched with ${startUrl}`);
		} catch {
			mainWindow.loadURL(getDiscordUrl());
		}
	} else {
		mainWindow.loadURL(getDiscordUrl());
	}

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

	mainWindow.webContents.on("did-finish-load", () => {
		extractCSS();
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
		width: 800,
		height: 600,
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

ipcMain.handle("get-versions", () => ({
	app: app.getVersion(),
	electron: process.versions.electron,
}));

ipcMain.handle("get-settings", () => ({ ...settings, isFirstLaunch }));
ipcMain.handle("save-settings", (event, newSettings) => {
	settings = { ...settings, ...newSettings };
	saveSettings();
	isFirstLaunch = false; // Once saved, it's no longer first launch
	return true;
});

/*

	SO! Turns out exclusion is broken. It's broken on Vesktop too so this is purely an assumption, but it's possible to be venmic, since I referenced Equibop's implementation to do this, which likely has a very close implementation of it to Vesktop's who has it broken. Atleast on Wayland KDE Plasma (don't see how its related though... :/).

	Ignore all of my attempts trying to get exclusion working, keeping for future's sake

	-- hamhim

*/

let lastSources = [];
ipcMain.handle("get-stream-sources", async () => {
	const { desktopCapturer } = require("electron");
	const sources = await desktopCapturer.getSources({
		types: ["screen", "window"],
		fetchWindowIcons: true,
		thumbnailSize: { width: 400, height: 400 },
	});
	lastSources = sources;
	return sources.map((s) => ({
		id: s.id,
		name: s.name,
		thumbnail: s.thumbnail.toDataURL(),
		appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
	}));
});

ipcMain.handle("get-audio-sources", () => {
	if (!venmic) return [];
	try {
		const audioPid = getAudioServicePid();
		const sources = venmic.list(["node.name", "application.name", "application.process.id", "application.process.binary", "object.serial"]);
		return sources.filter((s) => s["application.process.id"] !== audioPid);
	} catch (e) {
		console.error("[Venmic] Failed to list audio sources:", e);
		return [];
	}
});

ipcMain.on("stream-selected", async (event, { sourceId, fps, resolution, includeAudio = [], excludeAudio = [], contentHint }) => {
	console.log(`[Stream] Selected source ${sourceId} at ${fps} FPS, ${resolution.width}x${resolution.height}`);

	if (venmic) {
		try {
			const audioPid = getAudioServicePid();
			const excludeList = [{ "media.class": "Stream/Input/Audio" }];

			const myName = app.getName().toLowerCase();
			excludeList.push({ "application.name": myName });
			excludeList.push({ "node.name": myName });
			excludeList.push({ "application.name": "recar" });
			excludeList.push({ "node.name": "recar" });

			if (audioPid && audioPid !== "owo") {
				excludeList.push({ "application.process.id": audioPid });
			}

			excludeAudio.forEach((node) => {
				const filters = [];
				if (node["application.process.id"]) {
					filters.push({ "application.process.id": node["application.process.id"].toString() });
				}
				if (node["node.name"] && node["node.name"] !== "entire-system") {
					filters.push({ "node.name": node["node.name"] });
				}
				if (node["application.name"]) {
					filters.push({ "application.name": node["application.name"] });
				}
				if (node["application.process.binary"]) {
					filters.push({ "application.process.binary": node["application.process.binary"] });
				}
				filters.forEach((f) => excludeList.push(f));
			});

			let includeList = [];

			if (includeAudio.some((a) => a["node.name"] === "entire-system")) {
				includeList = [];
				console.log(`[Venmic] Linking entire system audio (excludes: ${excludeAudio.length} user-apps + Discord-base)`);
			} else if (includeAudio.length > 0) {
				includeAudio.forEach((node) => {
					const filter = {};
					if (node["application.process.id"]) filter["application.process.id"] = node["application.process.id"].toString();
					if (node["node.name"]) filter["node.name"] = node["node.name"];
					includeList.push(filter);
				});
				console.log(`[Venmic] Linking specifically ${includeAudio.length} items`);
			} else {
				console.log("[Venmic] Unlinked (no audio selected)");
			}

			if (includeAudio.length > 0) {
				const data = {
					include: includeList,
					exclude: excludeList,
					ignore_devices: true,
					only_speakers: true,
					only_default_speakers: true,
				};

				if (audioPid && audioPid !== "owo") {
					data.workaround = [{ "application.process.id": audioPid, "media.name": "RecordStream" }];
				}

				console.log("[Venmic] Final Link Data:", JSON.stringify(data, null, 2));
				venmic.link(data);
			} else {
				venmic.unlink();
			}
		} catch (e) {
			console.error("[Venmic] Failed to link audio node:", e);
		}
	}

	currentStreamSettings = { fps, resolution, contentHint: contentHint ?? "motion" };
	if (mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.send("stream-settings-update", currentStreamSettings);
	}

	if (pendingStreamCallback) {
		const selected = lastSources.find((s) => s.id === sourceId) ?? lastSources[0];
		if (selected) {
			pendingStreamCallback({ video: selected });
		} else {
			pendingStreamCallback({});
		}
		pendingStreamCallback = null;
	}

	if (streamWindow && !streamWindow.isDestroyed()) {
		streamWindow.close();
		streamWindow = null;
	}
});

ipcMain.on("stream-cancel", () => {
	if (pendingStreamCallback) pendingStreamCallback(null);
	pendingStreamCallback = null;
	if (streamWindow && !streamWindow.isDestroyed()) {
		streamWindow.close();
		streamWindow = null;
	}
});

ipcMain.on("stream-resize", (event, width, height) => {
	if (streamWindow && !streamWindow.isDestroyed()) {
		streamWindow.setSize(width, height);
	}
});

ipcMain.handle("get-current-stream-settings", () => currentStreamSettings);

ipcMain.on("call-ring-started", (event, data) => {
	if (!settings.enableCallPopup) return;
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
		mainWindow.webContents.executeJavaScript(`Vencord.Webpack.findByProps("stopRinging")?.stopRinging(${JSON.stringify(channelId)})`);
	}
	pendingCallData = null;
	if (callWindow && !callWindow.isDestroyed()) {
		callWindow.close();
	}
});

ipcMain.on("call-answer", () => {
	const channelId = pendingCallData?.channelId;
	if (channelId && mainWindow && !mainWindow.isDestroyed()) {
		mainWindow.webContents.executeJavaScript(`Vencord.Webpack.findByProps("stopRinging")?.call(${JSON.stringify(channelId)})`);
		mainWindow.show();
		mainWindow.focus();
	}
	pendingCallData = null;
	if (callWindow && !callWindow.isDestroyed()) {
		callWindow.close();
	}
});

ipcMain.on("open-settings", () => {
	createSettingsWindow();
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
	app.setAppUserModelId("app.loxodrome.recar");
	loadSettings();

	registerDiscordProtocol();

	const { session } = require("electron");
	session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
		const responseHeaders = Object.assign({}, details.responseHeaders);
		const toDelete = ["content-security-policy", "content-security-policy-report-only", "x-frame-options", "x-content-type-options"];

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
					console.log("[arRPC] Activity broadcasted to", clients.size, "clients");
				});
				console.log("[arRPC] Rich Presence server started");
			} else {
				console.log("[arRPC Bridge] Port 1337 is already in use, skipping websocket");
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
