const { app, BrowserWindow } = require("electron");
const { createServer } = require("../server.js");

let mainWindow;
let httpServer;

function startLocalServer() {
  return new Promise((resolve) => {
    httpServer = createServer();
    // Port 0 = let the OS pick a free local port; avoids clashing with anything
    // else on the machine (including a dev instance of `npm start`).
    httpServer.listen(0, "127.0.0.1", () => {
      resolve(httpServer.address().port);
    });
  });
}

async function createWindow() {
  const port = await startLocalServer();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0b0d",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}/`);
  mainWindow.once("ready-to-show", () => mainWindow.show());

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (httpServer) httpServer.close();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
