const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
	onSplashUpdate: (callback) =>
		ipcRenderer.on("splash-status", (event, value) => callback(value)),
});
