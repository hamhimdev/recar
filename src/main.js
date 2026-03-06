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
const { execFile } = require("child_process");

const { OverlayRenderer } = require("./rcRvRndr.js");
const RvInst = require("./rcRvInst.js");
const OvRn = new OverlayRenderer();

let _venmic;
const getVenmic = () => {
	if (_venmic !== undefined) return _venmic;
	try {
		const { PatchBay } = require("@vencord/venmic");
		_venmic = PatchBay.hasPipeWire() ? new PatchBay() : null;
		console.log(
			_venmic
				? "[Venmic] Initialized successfully"
				: "[Venmic] Pipewire not detected"
		);
	} catch (e) {
		console.error("[Venmic] Failed to initialize:", e);
		_venmic = null;
	}
	return _venmic;
};

function getAudioServicePid() {
	try {
		const metrics = app.getAppMetrics();
		const audioService = metrics.find(
			(p) =>
				p.name === "Audio Service" ||
				(p.type === "Utility" && p.name.includes("Audio"))
		);
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

	execFile(
		"xdg-mime",
		["default", desktopFile, "x-scheme-handler/discord"],
		(err) => {
			if (err) {
				console.error(
					"[discord://] Failed to register protocol handler:",
					err.message
				);
			} else {
				console.log(
					`[discord://] Registered as handler via ${desktopFile}`
				);
			}
		}
	);
}

// parse a discord:// uri and navigate mainWindow to the equivalent https://discord.com/... url, respecting the configured branch.
function handleDiscordUrl(uri) {
	if (!uri || !uri.startsWith("discord://")) return;
	if (!mainWindow || mainWindow.isDestroyed()) return;

	try {
		const parsed = new URL(uri);
		// parsed.pathname is e.g. "/channels/123/456" - slice off the leading slash.
		const discordPath = parsed.pathname.slice(1) || "app";

		const subdomain =
			settings.branch === "canary" || settings.branch === "ptb"
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
		const discordUrl = commandLine.find((arg) =>
			arg.startsWith("discord://")
		);
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

app.commandLine.appendSwitch(
	"enable-features",
	"WebRTCPipeWireCapturer,VaapiVideoDecodeLinuxGL,VaapiVideoEncoder,CanvasOopRasterization"
);
app.commandLine.appendSwitch(
	"disable-features",
	"ParserBlockingScriptsIntervention,BlinkParserBlockingScriptsIntervention,AudioServiceOutOfProcess,UseChromeOSDirectVideoDecoder,MediaFoundationVideoCapture"
);
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("enable-zero-copy");
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch(
	"enable-hardware-overlays",
	"single-fullscreen,single-on-top,underlay"
);
app.commandLine.appendSwitch("renderer-process-limit", "3");

app.userAgentFallback =
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36";

let mainWindow;
let settingsWindow;
let splashWindow;
let callWindow;
let streamWindow;
let pendingStreamCallback = null;
let currentStreamSettings = {
	resolution: { width: 1920, height: 1080 },
	fps: 60,
	contentHint: "motion",
};
let callBaseHeight = 276;
let tray;
let pendingCallData = null;
let settings = {
	branch: "stable",
	minimizeToTray: true,
	startMaximized: true,
	autoEnableWebRPC: true,
	enableCallPopup: true,
	useDiscordTitleBar: false,
	autoStart: false,
	enableOverlay: true,
};
let isFirstLaunch = false;
let discordCSS = null;
let currentUserInfo = null; // populated once the Discord renderer reports the logged-in user
let vcMembers = new Map();

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
		console.log(
			"[Main] --reset-config flag detected. Removing config file."
		);
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
		if (process.platform === "linux") {
			updateAutostart(settings.autoStart);
		}
	} catch (e) {
		console.error("Failed to save settings:", e);
	}
};

const updateAutostart = (enabled) => {
	if (process.platform !== "linux") return;

	const autostartDir = path.join(app.getPath("home"), ".config", "autostart");
	const desktopFilePath = path.join(autostartDir, "recar.desktop");

	if (enabled) {
		if (!fs.existsSync(autostartDir)) {
			fs.mkdirSync(autostartDir, { recursive: true });
		}

		const executablePath = app.getPath("exe");
		const desktopFileContent = `[Desktop Entry]
Type=Application
Name=Recar
Comment=A Discord Client for Linux
Exec=${executablePath}
Icon=recar
Terminal=false
Categories=Network;InstantMessaging;Chat;
StartupWMClass=Recar
`;
		fs.writeFileSync(desktopFilePath, desktopFileContent);
		console.log("[Autostart] Created recar.desktop");
	} else {
		if (fs.existsSync(desktopFilePath)) {
			fs.unlinkSync(desktopFilePath);
			console.log("[Autostart] Removed recar.desktop");
		}
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

	const isWayland =
		process.env.WAYLAND_DISPLAY !== undefined ||
		process.env.XDG_SESSION_TYPE === "wayland";

	streamWindow = new BrowserWindow({
		width: isWayland ? 400 : 900,
		height: isWayland ? 720 : 640,
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
		isWayland:
			process.env.WAYLAND_DISPLAY !== undefined ||
			process.env.XDG_SESSION_TYPE === "wayland",
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

ipcMain.on("window-maximize", () => {
	if (!mainWindow) return;
	if (mainWindow.isMaximized()) {
		mainWindow.unmaximize();
	} else {
		mainWindow.maximize();
	}
});

ipcMain.on("window-minimize", () => {
	if (mainWindow) mainWindow.minimize();
});

const createMainWindow = () => {
	mainWindow = new BrowserWindow({
		width: 1200,
		height: 800,
		title: "Discord",
		backgroundColor: "#2b2d31",
		frame: !settings.useDiscordTitleBar,
		show: false,
		autoHideMenuBar: true,
		icon: iconPath,
		webPreferences: {
			nodeIntegration: false,
			backgroundThrottling: false,
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
			features &&
			(features.includes("width=") || features.includes("height="));
		if (isPopup) {
			return {
				action: "allow",
				overrideBrowserWindowOptions: {
					autoHideMenuBar: true,
				},
			};
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
			const subdomain =
				settings.branch === "canary" || settings.branch === "ptb"
					? `${settings.branch}.`
					: "";
			mainWindow.loadURL(
				`https://${subdomain}discord.com/${discordPath}`
			);
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
		mainWindow.webContents.send("request-user-info");
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
		resizable: false,
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

ipcMain.handle("roverpp-status", () => {
	return { installed: RvInst.isInstalled() };
});

ipcMain.handle("roverpp-install", () => {
	try {
		RvInst.install(path.join(__dirname, ".."));
		return { ok: true };
	} catch (e) {
		console.error("[roverpp] Install failed:", e);
		return { ok: false, error: e.message };
	}
});

ipcMain.handle("roverpp-uninstall", () => {
	try {
		RvInst.uninstall();
		return { ok: true };
	} catch (e) {
		console.error("[roverpp] Uninstall failed:", e);
		return { ok: false, error: e.message };
	}
});

ipcMain.on("user-info", (event, data) => {
	currentUserInfo = data;
	console.log(
		"[Main] User info received:",
		currentUserInfo?.username ?? "(null)"
	);
});

ipcMain.handle("get-user-info", () => currentUserInfo);

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
	if (!getVenmic()) return [];
	try {
		const audioPid = getAudioServicePid();
		const sources = getVenmic().list([
			"node.name",
			"application.name",
			"application.process.id",
			"application.process.binary",
			"object.serial",
		]);
		return sources.filter((s) => s["application.process.id"] !== audioPid);
	} catch (e) {
		console.error("[Venmic] Failed to list audio sources:", e);
		return [];
	}
});

ipcMain.on(
	"stream-selected",
	async (
		event,
		{
			sourceId,
			fps,
			resolution,
			includeAudio = [],
			excludeAudio = [],
			contentHint,
		}
	) => {
		console.log(
			`[Stream] Selected source ${sourceId} at ${fps} FPS, ${resolution.width}x${resolution.height}`
		);

		if (getVenmic()) {
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
						filters.push({
							"application.process.id":
								node["application.process.id"].toString(),
						});
					}
					if (
						node["node.name"] &&
						node["node.name"] !== "entire-system"
					) {
						filters.push({ "node.name": node["node.name"] });
					}
					if (node["application.name"]) {
						filters.push({
							"application.name": node["application.name"],
						});
					}
					if (node["application.process.binary"]) {
						filters.push({
							"application.process.binary":
								node["application.process.binary"],
						});
					}
					filters.forEach((f) => excludeList.push(f));
				});

				let includeList = [];

				if (
					includeAudio.some((a) => a["node.name"] === "entire-system")
				) {
					includeList = [];
					console.log(
						`[Venmic] Linking entire system audio (excludes: ${excludeAudio.length} user-apps + Discord-base)`
					);
				} else if (includeAudio.length > 0) {
					includeAudio.forEach((node) => {
						const filter = {};
						if (node["application.process.id"]) {
							filter["application.process.id"] =
								node["application.process.id"].toString();
						}
						if (node["node.name"]) {
							filter["node.name"] = node["node.name"];
						}
						includeList.push(filter);
					});
					console.log(
						`[Venmic] Linking specifically ${includeAudio.length} items`
					);
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
						data.workaround = [
							{
								"application.process.id": audioPid,
								"media.name": "RecordStream",
							},
						];
					}

					console.log(
						"[Venmic] Final Link Data:",
						JSON.stringify(data, null, 2)
					);
					getVenmic().link(data);
				} else {
					getVenmic().unlink();
				}
			} catch (e) {
				console.error("[Venmic] Failed to link audio node:", e);
			}
		}

		/**
		 * for later me: "Venmic" is from recar, "venmic" is from venmic
		 */

		currentStreamSettings = {
			fps,
			resolution,
			contentHint: contentHint ?? "motion",
		};
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send(
				"stream-settings-update",
				currentStreamSettings
			);
		}

		if (pendingStreamCallback) {
			const selected =
				lastSources.find((s) => s.id === sourceId) ?? lastSources[0];
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
	}
);

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
		mainWindow.webContents.executeJavaScript(
			`Vencord.Webpack.findByProps("stopRinging")?.stopRinging(${JSON.stringify(channelId)})`
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
			`Vencord.Webpack.findByProps("stopRinging")?.call(${JSON.stringify(channelId)})`
		);
		mainWindow.show();
		mainWindow.focus();
	}
	pendingCallData = null;
	if (callWindow && !callWindow.isDestroyed()) {
		callWindow.close();
	}
});

function gaai(author) {
	if (!author) return { userId: null, avatarHash: null };
	return {
		userId: author.id || null,
		avatarHash: author.avatar || null,
	};
}

function gmai(member) {
	if (!member) return { avatarHash: null };
	const user = member.user || member;
	return {
		avatarHash: user.avatar || member.avatar || null,
	};
}

async function fah(userId) {
	if (!mainWindow || mainWindow.isDestroyed() || !userId) return null;
	try {
		const hash = await mainWindow.webContents.executeJavaScript(`
		(() => {
			try {
				const UserStore = Vencord?.Webpack?.findByProps?.("getUser", "getCurrentUser")
				|| Object.values(Vencord?.Webpack?.cache || {}).map(m => m?.exports).filter(Boolean).flatMap(e => [e, e?.default, e?.Z]).find(e => e?.getUser && e?.getCurrentUser);
				if (!UserStore) return null;
				const user = UserStore.getUser("${userId}");
				return user?.avatar || null;
			} catch { return null; }
		})()
		`);
		return hash || null;
	} catch {
		return null;
	}
}

function pnfo(data) {
	const msg = data?.message;
	if (!msg) return null;

	const author = msg.author;
	const sender =
		author?.globalName ||
		author?.displayName ||
		author?.username ||
		"Unknown";
	const body = data.body || msg.content || "";
	if (!body) return null;

	const channelType = msg.channel_type;
	const isDM = channelType === 1;

	let channel = "";
	let server = "";

	if (!isDM && data.title) {
		const titleMatch = data.title.match(/\(([^)]+)\)\s*$/);
		if (titleMatch) {
			if (channelType === 3) channel = titleMatch[1];
			else server = titleMatch[1];
		}
	}

	const { userId, avatarHash } = gaai(author);

	return { sender, message: body, channel, server, isDM, userId, avatarHash };
}

ipcMain.on("notification", (event, data) => {
	if (!settings.enableOverlay) return;
	const parsed = pnfo(data);
	if (parsed) {
		OvRn.addNotification(parsed);
	}
});

ipcMain.on("vc-update", async (event, data) => {
	if (!settings.enableOverlay) return;

	if (data?.inVoice === false) {
		vcMembers.clear();
		OvRn.voiceClear();
		return;
	}

	const members = Array.isArray(data)
		? data
		: data?.users || data?.members || [];
	const newIds = new Set();

	for (const member of members) {
		const uid = member.userId || member.id || member.user?.id;
		if (!uid) continue;

		const username =
			member.displayName ||
			member.globalName ||
			member.username ||
			member.user?.globalName ||
			member.user?.username ||
			member.nick ||
			uid;
		newIds.add(uid);

		const prev = vcMembers.get(uid);
		const muted = !!(member.muted || member.mute || member.selfMute);
		const deafened = !!(member.deafened || member.deaf || member.selfDeaf);

		let avatarHash =
			member.avatar ||
			member.user?.avatar ||
			gmai(member).avatarHash ||
			prev?.avatarHash ||
			null;

		if (!avatarHash && !prev?.avatarFetched) {
			avatarHash = await fah(uid);
		}

		if (!prev) {
			OvRn.voiceJoin({
				uid,
				username,
				avatarHash,
				muted,
				deafened,
			});
		} else {
			if (avatarHash && !prev.avatarHash) {
				OvRn.voiceUpdateAvatar({ uid, avatarHash });
			}
			if (prev.muted !== muted)
				OvRn[muted ? "voiceMuted" : "voiceUnmuted"]({ uid });
			if (prev.deafened !== deafened)
				OvRn[deafened ? "voiceDeafened" : "voiceUndeafened"]({ uid });
		}

		vcMembers.set(uid, {
			username,
			muted,
			deafened,
			speaking: prev?.speaking || false,
			avatarHash,
			avatarFetched: true,
		});
	}

	for (const [uid, info] of vcMembers) {
		if (!newIds.has(uid)) {
			OvRn.voiceLeave({ uid });
			vcMembers.delete(uid);
		}
	}
});

ipcMain.on("vc-join", async (event, data) => {
	if (!settings.enableOverlay) return;

	const uid = data?.userId || data?.id || data?.user?.id;
	if (!uid) return;

	const username =
		data?.displayName ||
		data?.globalName ||
		data?.username ||
		data?.user?.globalName ||
		data?.user?.username ||
		data?.nick ||
		uid;
	const muted = !!(data?.muted || data?.mute || data?.selfMute);
	const deafened = !!(data?.deafened || data?.deaf || data?.selfDeaf);

	let avatarHash =
		data?.avatar || data?.user?.avatar || gmai(data).avatarHash;
	if (!avatarHash) avatarHash = await fah(uid);

	vcMembers.set(uid, {
		username,
		muted,
		deafened,
		speaking: false,
		avatarHash,
	});
	OvRn.voiceJoin({ uid, username, avatarHash, muted, deafened });
});

ipcMain.on("vc-leave", (event, data) => {
	if (!settings.enableOverlay) return;
	const uid = data?.id || data?.userId || data?.user?.id;
	if (!uid) return;

	vcMembers.delete(uid);
	OvRn.voiceLeave({ uid });
});

ipcMain.on("vc-state-change", (event, data) => {
	if (!settings.enableOverlay) return;

	const uid = data?.id || data?.userId || data?.user?.id;
	if (!uid) return;

	const username =
		data?.displayName ||
		data?.globalName ||
		data?.username ||
		data?.user?.globalName ||
		data?.user?.username ||
		vcMembers.get(uid)?.username ||
		uid;
	const prev = vcMembers.get(uid) || {};
	const muted = !!(data?.muted || data?.mute || data?.selfMute);
	const deafened = !!(data?.deafened || data?.deaf || data?.selfDeaf);

	if (prev.deafened !== deafened)
		OvRn[deafened ? "voiceDeafened" : "voiceUndeafened"]({
			uid,
		});
	if (prev.muted !== muted)
		OvRn[muted ? "voiceMuted" : "voiceUnmuted"]({ uid });

	vcMembers.set(uid, { ...prev, username, muted, deafened });
});

ipcMain.on("vc-speaking", (event, data) => {
	// fires when someone starts or stops speaking. use this to update that person's
	// status in the vc ui without rebuilding the entire thing
	// will be for the overlay in future
	console.log("[VC Speaking]", data);
});

ipcMain.on("open-settings", () => {
	createSettingsWindow();
});

ipcMain.handle("open-dev-window", (event, which) => {
	if (which === "splash") {
		const w = new BrowserWindow({
			width: 300,
			height: 350,
			transparent: true,
			title: "Recar Splash Preview",
			frame: false,
			alwaysOnTop: true,
			resizable: false,
			icon: iconPath,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
			},
		});
		w.loadFile(path.join(__dirname, "splash.html"));
	} else if (which === "call") {
		const w = new BrowserWindow({
			width: 232,
			height: 276,
			transparent: true,
			title: "Recar Call Preview",
			frame: false,
			alwaysOnTop: true,
			resizable: false,
			icon: iconPath,
			webPreferences: {
				nodeIntegration: false,
				contextIsolation: true,
				preload: path.join(__dirname, "call.js"),
			},
		});
		w.loadFile(path.join(__dirname, "call.html"));
		w.once("ready-to-show", async () => {
			if (discordCSS) w.webContents.insertCSS(discordCSS);
			w.show();
		});
	}
});

ipcMain.handle("open-external", (event, url) => {
	shell.openExternal(url);
});

ipcMain.handle("restart-app", () => {
	app.isQuiting = true;

	// Filter out --reset-config so it doesn't loop
	const args = process.argv
		.slice(1)
		.filter((arg) => arg !== "--reset-config");
	app.relaunch({ args });

	app.exit(0);
});

app.whenReady().then(async () => {
	app.setName("recar");
	app.desktopName = "recar";
	app.setAppUserModelId("app.loxodrome.recar");
	loadSettings();

	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{
				label: "Recar",
				submenu: [
					{ label: "Settings", click: () => createSettingsWindow() },
					{ type: "separator" },
					{
						label: "Restart",
						click: () => {
							app.isQuiting = true;
							app.relaunch({
								args: process.argv
									.slice(1)
									.filter((a) => a !== "--reset-config"),
							});
							app.exit(0);
						},
					},
					{ type: "separator" },
					{
						label: "Quit",
						accelerator: "CmdOrCtrl+Q",
						click: () => {
							app.isQuiting = true;
							app.quit();
						},
					},
				],
			},
			{
				label: "Edit",
				submenu: [
					{ role: "undo" },
					{ role: "redo" },
					{ type: "separator" },
					{ role: "cut" },
					{ role: "copy" },
					{ role: "paste" },
					{ role: "selectAll" },
				],
			},
			{
				label: "View",
				submenu: [
					{ role: "reload" },
					{ role: "forceReload" },
					{ role: "toggleDevTools" },
					{ type: "separator" },
					{ role: "resetZoom" },
					{ role: "zoomIn" },
					{ role: "zoomOut" },
					{ type: "separator" },
					{ role: "togglefullscreen" },
				],
			},
		])
	);

	const primaryDisplay = screen.getPrimaryDisplay();
	const { width, height } = primaryDisplay.size;
	const assetsDir = path.join(__dirname, "assets");
	await OvRn.init(width, height, assetsDir);

	registerDiscordProtocol();

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
				console.log(
					"[arRPC Bridge] WebSocket server started on port 1337"
				);

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
						"clients"
					);
				});
				console.log("[arRPC] Rich Presence server started");
			} else {
				console.log(
					"[arRPC Bridge] Port 1337 is already in use, skipping websocket"
				);
				const arrpc = await new Server();
				arrpc.on("activity", (data) => {
					console.log("[arRPC] Activity received:", data);
				});
				console.log(
					"[arRPC] Rich Presence server started (without websocket)"
				);
			}
		} catch (e) {
			console.error("[arRPC] Failed to start:", e);
		}
	}, 500);
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
