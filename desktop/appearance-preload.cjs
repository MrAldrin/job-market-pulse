const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pulseAppearance", {
  get: () => ipcRenderer.invoke("pulse:appearance:get"),
  set: (choice) => ipcRenderer.invoke("pulse:appearance:set", choice),
});
