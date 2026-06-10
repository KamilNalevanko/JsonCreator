const { contextBridge } = require("electron");

// Preload script — exposing safe APIs to renderer process
contextBridge.exposeInMainWorld("electron", {
  nodeVersion: () => process.versions.node,
  chromeVersion: () => process.versions.chrome,
  electronVersion: () => process.versions.electron,
});
