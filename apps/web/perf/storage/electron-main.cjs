const { app, BrowserWindow } = require("electron");

app.setPath("userData", process.env.STORAGE_BENCH_PROFILE);
app.setPath("sessionData", process.env.STORAGE_BENCH_PROFILE);
app.commandLine.appendSwitch("disable-renderer-backgrounding");

app.whenReady().then(() => {
  app.dock?.hide();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) =>
    new URL(url).origin === new URL(process.env.STORAGE_BENCH_URL).origin
      ? { action: "allow", overrideBrowserWindowOptions: { show: false } }
      : { action: "deny" },
  );
  void window.loadURL(process.env.STORAGE_BENCH_URL);
});

app.on("window-all-closed", () => app.quit());
