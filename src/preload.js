const { webFrame, ipcRenderer, contextBridge } = require("electron");
const path = require("path");
const fs = require("fs");

contextBridge.exposeInMainWorld("callBridge", {
	ringStarted: (data) => ipcRenderer.send("call-ring-started", data),
	ringStopped: (data) => ipcRenderer.send("call-ring-stopped", data),
});

contextBridge.exposeInMainWorld("recarBridge", {
	themeChanged: () => ipcRenderer.send("discord-theme-changed"),
	openSettings: () => ipcRenderer.send("open-settings"),
	getStreamSettings: () => ipcRenderer.invoke("get-current-stream-settings"),
});

let cachedStreamSettings = null;
ipcRenderer.on("stream-settings-update", (e, settings) => {
	cachedStreamSettings = settings;
});

contextBridge.exposeInMainWorld("recarInternalBridge", {
	getSyncStreamSettings: () => cachedStreamSettings,
});

(async () => {
	try {
		const settings = await ipcRenderer.invoke("get-settings");
		const selectedMod = settings.mod || "equicord";

		console.log(`[Preload] Using mod: ${selectedMod}`);

		let modPath, modCssPath;
		if (selectedMod === "equicord") {
			modPath = path.join(__dirname, "..", "equicord", "dist", "browser", "browser.js");
			modCssPath = path.join(__dirname, "..", "equicord", "dist", "browser", "browser.css");
		} else {
			modPath = path.join(__dirname, "..", "vencord", "dist", "browser.js");
			modCssPath = path.join(__dirname, "..", "vencord", "dist", "browser.css");
		}

		if (!fs.existsSync(modPath)) {
			console.error(`[Preload] ${selectedMod} build not found at ${modPath}. Please run pnpm build:${selectedMod}!!`);
			return;
		}

		let script = fs.readFileSync(modPath, "utf8");
		const css = fs.readFileSync(modCssPath, "utf8");

		webFrame.insertCSS(css);

		webFrame
			.executeJavaScriptInIsolatedWorld(0, [
				{
					// world 0 = main world
					code: `window.__recarRpcEnabled = ${settings.autoEnableWebRPC ?? true};
            		${script}`,
				},
			])
			.then(() => {
				console.log(`[Preload] ${selectedMod} injected successfully`);
			})
			.catch((e) => {
				console.error(`[Preload] Failed to inject ${selectedMod}:`, e);
			});
	} catch (err) {
		console.error("[Preload] Error during mod injection:", err);
	}
})();
