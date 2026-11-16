const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, powerSaveBlocker, powerMonitor,
  nativeImage, dialog, globalShortcut, session, desktopCapturer,
} = require('electron');
const fs = require('fs');
const path = require('path');
const createPlayers = require('./players');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const APP = 'Lyrikx';

// single instance
if (!app.requestSingleInstanceLock()) { app.quit(); }

// let the lights listen to whatever the computer is playing (system-audio loopback)
if (isMac) app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');

// ───────────────────────── settings ─────────────────────────
const STYLES = [
  'Ship', 'Fisheye', 'Visual', 'Fisheye Visual',
  'Codestyle', 'Codestyle Visual', 'Branches', 'Web', 'Constellation',
];
const FONTS = ['SF Pro', 'SF Rounded', 'New York', 'Helvetica Neue', 'Avenir Next', 'Futura', 'Didot'];
const LIGHT_MODES = [
  ['auto', 'Album Art (auto)'], ['ends', 'Body + Ends (2 colors)'], ['single', 'Single Color'], ['gradient', 'Two-Color Gradient'],
  ['palette', 'Three-Color Palette'], ['rainbow', 'Rainbow'],
];

const DEFAULT_LIGHTS = {
  on: true,
  reaction: 'moving',            // moving = constant motion · beat = moves and pulses with the music
  colorMode: 'auto',             // auto | ends | single | gradient | palette | rainbow
  colors: ['#ffaa58', '#e63c14', '#e0451a'],   // ends mode: [body, ends]
  edges: { top: true, right: true, bottom: true, left: true },
  direction: 'ccw',              // ccw (as in the reference video) | cw
  strips: 1,                     // how many strips circle the screen (1–3)
  speed: 0.59,                   // lap time: 9 s (0) … 1.4 s (1); 0.59 = 3 s (as in the video)
  tail: 0.5,                     // strip length (0.5 ≈ 55% of the screen border)
  thickness: 0.6,                // line thickness
  glow: 0.35,                    // soft light around the line
  outline: 0,                    // optional faint line that always traces the whole border
  intensity: 0.9,                // overall brightness
  sensitivity: 0.5,              // beat mode: how easily beats trigger
  fade: 0.5,                     // beat mode: how slowly each pulse fades
  audio: 'system',               // system | mic | off
  preview: false,                // metronome preview for beat mode (never saved as on)
};

const DEFAULTS = {
  style: 'Fisheye Visual',
  keepAwake: true,
  nonLockscreen: false,          // "Non-lockscreen Visibility"
  font: 'SF Pro',
  size: 1,                       // text size multiplier (0.6 – 1.6)
  displays: [],                  // display ids that show lyrics ([] = primary)
  autoSync: true,                // lyric colours follow the album art
  colors: { lyric: '#ffd2a6', highlight: '#ffffff', secondary: '#ff944d' },
  dim: true,
  showArt: true,
  offset: 0,                     // lyric sync offset (seconds)
  fullscreen: true,
  lights: DEFAULT_LIGHTS,
};

const mergeLights = (base, patch) => ({
  ...base, ...patch,
  colors: (patch && patch.colors) ? patch.colors.slice(0, 3) : base.colors,
  edges: { ...base.edges, ...((patch && patch.edges) || {}) },
});

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
let settings = { ...DEFAULTS };
function loadSettings() {
  try {
    const j = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = { ...DEFAULTS, ...j };
    settings.colors = { ...DEFAULTS.colors, ...(j.colors || {}) };
  } catch (_) { settings = { ...DEFAULTS }; }
  settings.lights = mergeLights(DEFAULT_LIGHTS, settings.lights || {});
  if (!['moving', 'beat'].includes(settings.lights.reaction)) settings.lights.reaction = 'moving';   // older builds had breathe/steady
  settings.lights.preview = false;
}
const saveSettings = () => {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2)); } catch (_) {}
};

// ───────────────────────── state ─────────────────────────
let tray = null;
let wins = new Map();            // displayId -> BrowserWindow (lyrics + lights)
let lyricsVisible = false;
let lastState = null;
let blockerId = null;
let screenLocked = false;
let colorWin = null;
let lightsWin = null;
let lightsStatus = '';
let players = null;
let activeKey = '';
let track = null;
const artCache = new Map();
const lyricCache = new Map();

const send = (channel, payload) => {
  for (const w of wins.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  if (lightsWin && !lightsWin.isDestroyed() && channel === 'settings') lightsWin.webContents.send(channel, payload);
};
const goFullscreen = (w, on) => { if (isMac) w.setSimpleFullScreen(!!on); else w.setFullScreen(!!on); };

// ───────────────────────── now playing ─────────────────────────
async function poll() {
  const found = await players.poll();
  if (!found) { track = null; activeKey = ''; push({ track: null }); return; }
  const key = `${found.player}|${found.title}|${found.artist}|${found.album}`;
  if (key !== activeKey) {
    activeKey = key;
    track = { ...found, artwork: null, lyrics: null };
    loadExtras(key, found);
  }
  push({
    track: { title: found.title, artist: found.artist, album: found.album, duration: found.duration,
             artwork: track && track.artwork, lyrics: track && track.lyrics, key },
    playing: found.playing, position: found.position,
  });
}

function push(payload) { lastState = payload; send('state', payload); }

async function loadExtras(key, t) {
  (async () => {                                           // artwork
    let art = artCache.get(key) || null;
    if (!art) {
      art = await players.art(t);
      if (!art && t.artUrl) art = await fetchDataUrl(t.artUrl.replace(/\/\d+x\d+bb/, '/1000x1000bb'));
      if (!art) art = await itunesArt(t);
      if (art) artCache.set(key, art);
    }
    if (activeKey === key && track) { track.artwork = art; pushNow(); }
  })();
  (async () => {                                           // lyrics
    let l = lyricCache.get(key);
    if (l === undefined) { l = await fetchLyrics(t); lyricCache.set(key, l); }
    if (activeKey === key && track) { track.lyrics = l || { synced: false, lines: [] }; pushNow(); }
  })();
}
function pushNow() {
  if (!track || !lastState || !lastState.track) return;
  push({ ...lastState, track: { ...lastState.track, artwork: track.artwork, lyrics: track.lyrics } });
}

// ───────────────────────── network helpers ─────────────────────────
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Lyrikx/1.0' } });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}
async function fetchDataUrl(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
}
async function itunesArt(t) {
  const j = await fetchJson(`https://itunes.apple.com/search?entity=song&limit=1&term=${encodeURIComponent(`${t.artist} ${t.title}`)}`);
  const u = j && j.results && j.results[0] && j.results[0].artworkUrl100;
  return u ? fetchDataUrl(u.replace('100x100bb', '1000x1000bb')) : null;
}

const clean = (s) => String(s).replace(/\s*[\(\[].*?(remaster|version|feat|with|live|deluxe|edit).*?[\)\]]/gi, '').replace(/\s*-\s*(remaster|single|live).*/i, '').trim();

async function fetchLyrics(t) {
  const title = clean(t.title);
  const artist = String(t.artist).split(/,|&| feat\.?| x /i)[0].trim();
  const q = (o) => new URLSearchParams(o).toString();
  let j = await fetchJson(`https://lrclib.net/api/get?${q({
    track_name: title, artist_name: artist, album_name: t.album, duration: Math.round(t.duration),
  })}`);
  if (!j || (!j.syncedLyrics && !j.plainLyrics)) {
    const list = await fetchJson(`https://lrclib.net/api/search?${q({ track_name: title, artist_name: artist })}`);
    if (Array.isArray(list) && list.length) {
      const near = (x) => Math.abs((x.duration || 0) - t.duration);
      j = list.filter((x) => x.syncedLyrics).sort((a, b) => near(a) - near(b))[0]
        || list.sort((a, b) => near(a) - near(b))[0];
    }
  }
  if (!j) return null;
  if (j.syncedLyrics) return { synced: true, lines: parseLrc(j.syncedLyrics) };
  if (j.plainLyrics) return { synced: false, lines: j.plainLyrics.split(/\r?\n/).map((text) => ({ t: 0, text })) };
  return null;
}
function parseLrc(txt) {
  const out = [];
  for (const row of txt.split(/\r?\n/)) {
    const m = row.match(/^((?:\[\d+:\d+(?:[.:]\d+)?\])+)\s*(.*)$/);
    if (!m) continue;
    const text = m[2].replace(/<\d+:\d+(?:\.\d+)?>/g, '').trim();
    for (const ts of m[1].matchAll(/\[(\d+):(\d+)(?:[.:](\d+))?\]/g)) {
      const frac = ts[3] ? parseFloat('0.' + ts[3]) : 0;
      out.push({ t: +ts[1] * 60 + +ts[2] + frac, text });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// ───────────────────────── windows ─────────────────────────
const webPrefs = () => ({
  preload: path.join(__dirname, 'preload.js'), contextIsolation: true, autoplayPolicy: 'no-user-gesture-required',
});
const appIcon = () => path.join(__dirname, 'assets', isWin ? 'icon.ico' : 'icon.png');

function createWindowFor(display) {
  const b = display.bounds;
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, show: false, backgroundColor: '#000000', icon: appIcon(),
    hasShadow: false, resizable: true, fullscreenable: !isMac, skipTaskbar: true,
    webPreferences: webPrefs(),
  });
  win.setAlwaysOnTop(true, isWin ? 'screen-saver' : 'floating');
  if (isMac) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    win.webContents.send('settings', settings);
    if (lastState) win.webContents.send('state', lastState);
  });
  win.on('closed', () => wins.delete(display.id));
  return win;
}

function targetDisplays() {
  const all = screen.getAllDisplays();
  const chosen = all.filter((d) => settings.displays.includes(d.id));
  return chosen.length ? chosen : [screen.getPrimaryDisplay()];
}

function showLyrics() {
  lyricsVisible = true;
  const want = targetDisplays();
  for (const [id, w] of wins) if (!want.find((d) => d.id === id)) { w.destroy(); wins.delete(id); }
  for (const d of want) {
    let w = wins.get(d.id);
    if (!w || w.isDestroyed()) { w = createWindowFor(d); wins.set(d.id, w); }
    w.setBounds(d.bounds);
    const reveal = () => { w.show(); if (settings.fullscreen) goFullscreen(w, true); };
    if (w.webContents.isLoading()) w.once('ready-to-show', reveal); else reveal();
  }
  applyVisibility();
  refreshTray();
}
function hideLyrics() {
  lyricsVisible = false;
  for (const w of wins.values()) if (!w.isDestroyed()) { goFullscreen(w, false); w.hide(); }
  refreshTray();
}
const toggleLyrics = () => (lyricsVisible ? hideLyrics() : showLyrics());

function applyVisibility() {       // "Non-lockscreen Visibility": hide while the screen is locked
  for (const w of wins.values()) {
    if (w.isDestroyed()) continue;
    if (settings.nonLockscreen && screenLocked) w.hide(); else if (lyricsVisible) w.show();
  }
}
function applyAwake() {
  if (settings.keepAwake && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  if (!settings.keepAwake && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
}

function openLightsWindow() {
  if (lightsWin && !lightsWin.isDestroyed()) { lightsWin.show(); lightsWin.focus(); return; }
  lightsWin = new BrowserWindow({
    width: 480, height: 760, minWidth: 420, minHeight: 560, title: `${APP} — Edge Lights`, icon: appIcon(),
    backgroundColor: '#1c1c1f', autoHideMenuBar: true, webPreferences: webPrefs(),
  });
  lightsWin.setMenuBarVisibility(false);
  lightsWin.loadFile(path.join(__dirname, 'renderer', 'lights-settings.html'));
  lightsWin.webContents.on('did-finish-load', () => {
    lightsWin.webContents.send('settings', settings);
    lightsWin.webContents.send('lights-status', lightsStatus);
  });
  lightsWin.on('closed', () => { lightsWin = null; if (settings.lights.preview) patchLights({ preview: false }); });
}
function openSizeWindow(key, label) {
  if (colorWin && !colorWin.isDestroyed()) colorWin.close();
  colorWin = new BrowserWindow({
    width: 320, height: 150, resizable: false, minimizable: false, maximizable: false,
    title: label.replace('…', ''), alwaysOnTop: true, icon: appIcon(), webPreferences: webPrefs(),
  });
  colorWin.setMenuBarVisibility(false);
  colorWin.loadFile(path.join(__dirname, 'renderer', 'color.html'), {
    query: { key, value: key === 'size' ? settings.size : settings.colors[key], label },
  });
}

function patchLights(patch) {
  settings.lights = mergeLights(settings.lights, patch);
  const toSave = settings.lights.preview;
  settings.lights.preview = false; saveSettings(); settings.lights.preview = toSave;
  send('settings', settings); refreshTray();
}

// ───────────────────────── tray / menu-bar menu ─────────────────────────
const header = (label) => ({ label, enabled: false });
function buildMenu() {
  const change = (key, value) => () => {
    settings[key] = value; saveSettings(); send('settings', settings); refreshTray();
    if (key === 'keepAwake') applyAwake();
    if (key === 'nonLockscreen') applyVisibility();
  };
  const colorItem = (label, key) => ({ label, click: () => openSizeWindow(key, label) });
  const displays = screen.getAllDisplays();
  const chosen = new Set(targetDisplays().map((d) => d.id));
  const L = settings.lights;

  return Menu.buildFromTemplate([
    { label: lyricsVisible ? 'Hide Lyrics' : 'Show Lyrics', accelerator: 'CommandOrControl+Alt+L', click: toggleLyrics },
    { type: 'separator' },
    header('Style'),
    ...STYLES.map((s) => ({ label: s, type: 'checkbox', checked: settings.style === s, click: change('style', s) })),
    { type: 'separator' },
    { label: 'Keep Screen Awake', type: 'checkbox', checked: settings.keepAwake, click: () => change('keepAwake', !settings.keepAwake)() },
    { label: 'Non-lockscreen Visibility', type: 'checkbox', checked: settings.nonLockscreen, click: () => change('nonLockscreen', !settings.nonLockscreen)() },
    { type: 'separator' },
    header('Font'),
    ...FONTS.map((f) => ({ label: f, type: 'checkbox', checked: settings.font === f, click: change('font', f) })),
    { type: 'separator' },
    header('Text Size'),
    { label: `Adjust Size… (${Math.round(settings.size * 100)}%)`, click: () => openSizeWindow('size', 'Text Size') },
    { label: 'Reset Size', click: change('size', 1) },
    { type: 'separator' },
    header('Display'),
    ...displays.map((d, i) => ({
      label: d.label || (isMac && i === 0 ? 'Built-in Retina Display' : `Display ${i + 1}`),
      type: 'checkbox', checked: chosen.has(d.id),
      click: () => {
        const set = new Set(chosen);
        set.has(d.id) ? set.delete(d.id) : set.add(d.id);
        if (!set.size) set.add(d.id);
        settings.displays = [...set]; saveSettings();
        if (lyricsVisible) showLyrics();
        refreshTray();
      },
    })),
    { type: 'separator' },
    header('Color'),
    { label: 'Auto Sync', type: 'checkbox', checked: settings.autoSync, click: () => change('autoSync', !settings.autoSync)() },
    colorItem('Lyric Text…', 'lyric'),
    colorItem('Highlight…', 'highlight'),
    colorItem('Secondary Text…', 'secondary'),
    { label: 'Reset Colors', click: () => { settings.colors = { ...DEFAULTS.colors }; settings.autoSync = true; saveSettings(); send('settings', settings); refreshTray(); } },
    { type: 'separator' },
    header('Edge Lights'),
    { label: 'Edge Lights', type: 'checkbox', checked: L.on, click: () => patchLights({ on: !L.on }) },
    { label: 'Constant Moving', type: 'checkbox', checked: L.reaction === 'moving', click: () => patchLights({ reaction: 'moving' }) },
    { label: 'Beat Sync', type: 'checkbox', checked: L.reaction === 'beat', click: () => patchLights({ reaction: 'beat' }) },
    { type: 'separator' },
    ...LIGHT_MODES.map(([id, label]) => ({ label, type: 'checkbox', checked: L.colorMode === id, click: () => patchLights({ colorMode: id }) })),
    { type: 'separator' },
    { label: 'Light Settings…', click: openLightsWindow },
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => dialog.showMessageBox({ message: `${APP} is up to date.`, detail: `Version ${app.getVersion()}` }) },
    { label: 'License…', click: () => dialog.showMessageBox({ message: APP, detail: `Personal-use build. Lyrics are provided by LRCLIB (lrclib.net); song info comes from ${isMac ? 'the Music and Spotify apps on your Mac' : 'Windows media controls (Spotify, Apple Music, iTunes, browsers and more)'}.` }) },
    { type: 'separator' },
    { label: `Quit ${APP}`, accelerator: 'CommandOrControl+Q', click: () => app.quit() },
  ]);
}
function refreshTray() { if (tray) tray.setContextMenu(buildMenu()); }

// ───────────────────────── IPC ─────────────────────────
ipcMain.on('ready', (e) => {
  e.sender.send('settings', settings);
  if (lastState) e.sender.send('state', lastState);
  e.sender.send('lights-status', lightsStatus);
});
ipcMain.on('cmd', async (_e, name) => { await players.cmd(name); poll(); });
ipcMain.on('set', (_e, key, value) => {
  settings[key] = value; saveSettings(); send('settings', settings);
  if (key === 'fullscreen') for (const w of wins.values()) goFullscreen(w, !!value);
});
ipcMain.on('settings-menu', () => buildMenu().popup());
ipcMain.on('hide', hideLyrics);
ipcMain.on('lights', (_e, patch) => patchLights(patch));
ipcMain.on('open-lights', openLightsWindow);
ipcMain.on('lights-status', (_e, text) => {
  lightsStatus = text;
  if (lightsWin && !lightsWin.isDestroyed()) lightsWin.webContents.send('lights-status', text);
});
ipcMain.on('color-result', (_e, key, value) => {
  if (key === 'size') { settings.size = +value; saveSettings(); send('settings', settings); refreshTray(); return; }
  settings.colors[key] = value; settings.autoSync = false;
  saveSettings(); send('settings', settings); refreshTray();
});

// ───────────────────────── app lifecycle ─────────────────────────
app.whenReady().then(() => {
  loadSettings();
  players = createPlayers({ nativeImage });
  if (isMac && app.dock) app.dock.hide();

  // system-audio loopback for the beat-synced lights
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    try {
      if (isWin) {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        cb({ video: sources[0], audio: 'loopback' });
      } else cb({ audio: 'loopback' });
    } catch (_) { cb({}); }
  });

  const iconFile = isMac ? 'trayTemplate.png' : 'tray.png';
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', iconFile));
  if (isMac) icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip(APP);
  refreshTray();
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('right-click', () => tray.popUpContextMenu());

  applyAwake();
  powerMonitor.on('lock-screen', () => { screenLocked = true; applyVisibility(); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; applyVisibility(); });
  screen.on('display-added', refreshTray);
  screen.on('display-removed', refreshTray);
  globalShortcut.register('CommandOrControl+Alt+L', toggleLyrics);

  poll();
  setInterval(poll, 700);
  showLyrics();
});

app.on('second-instance', () => { if (!lyricsVisible) showLyrics(); });
app.on('window-all-closed', (e) => e.preventDefault());
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (players && players.stop) players.stop(); });
