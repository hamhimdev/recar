const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electron", {
  onCallData: (callback) =>
    ipcRenderer.on("call-data", (event, data) => callback(data)),
  dismissCall: () => ipcRenderer.send("call-dismiss"),
  answerCall: () => ipcRenderer.send("call-answer"),
  adjustCallHeight: (delta) => ipcRenderer.send("call-adjust-height", delta),
});
