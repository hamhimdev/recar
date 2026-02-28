const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("streamAPI", {
	getSources: () => ipcRenderer.invoke("get-stream-sources"),
	getAudioSources: () => ipcRenderer.invoke("get-audio-sources"),
	selectSource: (data) => ipcRenderer.send("stream-selected", data),
	resizeWindow: (width, height) => ipcRenderer.send("stream-resize", width, height),
	getSessionType: () => ipcRenderer.invoke("get-session-type"),
});
