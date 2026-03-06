const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("settingsAPI", {
	getSettings: () => ipcRenderer.invoke("get-settings"),
	saveSettings: (settings) => ipcRenderer.invoke("save-settings", settings),
	restartApp: () => ipcRenderer.invoke("restart-app"),
	getVersions: () => ipcRenderer.invoke("get-versions"),
	openDevWindow: (which) => ipcRenderer.invoke("open-dev-window", which),
	openExternal: (url) => ipcRenderer.invoke("open-external", url),
	roverppStatus: () => ipcRenderer.invoke("roverpp-status"),
	roverppInstall: () => ipcRenderer.invoke("roverpp-install"),
	roverppUninstall: () => ipcRenderer.invoke("roverpp-uninstall"),
});
