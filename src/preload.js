const { webFrame, ipcRenderer, contextBridge } = require("electron");
const path = require("path");
const fs = require("fs");

contextBridge.exposeInMainWorld("callBridge", {
  ringStarted: (data) => ipcRenderer.send("call-ring-started", data),
  ringStopped: (data) => ipcRenderer.send("call-ring-stopped", data),
});

contextBridge.exposeInMainWorld("recarBridge", {
  themeChanged: () => ipcRenderer.send("discord-theme-changed"),
});

(async () => {
  try {
    const settings = await ipcRenderer.invoke("get-settings");
    const selectedMod = settings.mod || "equicord";

    console.log(`[Preload] Using mod: ${selectedMod}`);

    let modPath, modCssPath;
    if (selectedMod === "equicord") {
      modPath = path.join(
        __dirname,
        "..",
        "equicord",
        "dist",
        "browser",
        "browser.js",
      );
      modCssPath = path.join(
        __dirname,
        "..",
        "equicord",
        "dist",
        "browser",
        "browser.css",
      );
    } else {
      modPath = path.join(__dirname, "..", "vencord", "dist", "browser.js");
      modCssPath = path.join(__dirname, "..", "vencord", "dist", "browser.css");
    }

    if (!fs.existsSync(modPath)) {
      console.error(
        `[Preload] ${selectedMod} build not found at ${modPath}. Please run pnpm build:${selectedMod}!!`,
      );
      return;
    }

    let script = fs.readFileSync(modPath, "utf8");
    const css = fs.readFileSync(modCssPath, "utf8");

    webFrame.insertCSS(css);

    // get call inject code (./call_inject.js) and append it to the mod script
    const callInjectPath = path.join(__dirname, "call_inject.js");
    if (fs.existsSync(callInjectPath)) {
      const callInjectCode = fs.readFileSync(callInjectPath, "utf8");
      script += `\n\n${callInjectCode}`;
    } else {
      console.warn(
        `[Preload] call_inject.js not found at ${callInjectPath}. Call ring logging will be disabled.`,
      );
    }

    webFrame.executeJavaScriptInIsolatedWorld(0, [
      {
        // world 0 = main world
        code: `
            //window.legcord = { version: "1.0.0" };
            const modName = "${selectedMod === "equicord" ? "Equicord" : "Vencord"}Settings";
            const rpcEnabled = ${settings.autoEnableWebRPC ?? true};
            try {
              const config = JSON.parse(localStorage.getItem(modName) || "{}");
              config.plugins = config.plugins || {};
              ["arRPC.web", "WebRichPresence", "WebRichPresence (arRPC)"].forEach(id => {
                config.plugins[id] = config.plugins[id] || {};
                config.plugins[id].enabled = rpcEnabled;
              });
              localStorage.setItem(modName, JSON.stringify(config));
              console.log("[Preload] arRPC.web enabled: " + rpcEnabled + " for " + modName);
            } catch (e) {
              console.error("[Preload] Failed to update arRPC settings:", e);
            }

            (function observeTheme() {
              if (document.documentElement) {
                new MutationObserver(() => {
                  if (window.recarBridge) window.recarBridge.themeChanged();
                }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
              } else {
                setTimeout(observeTheme, 100);
              }
            })();

            ${script}
          `,
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
