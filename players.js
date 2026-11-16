// Now-playing + transport control, one implementation per OS.
//   macOS   : AppleScript → Music and Spotify apps (same as the original app)
//   Windows : System Media Transport Controls (SMTC) through a small PowerShell helper.
//             This sees Spotify, Apple Music for Windows, iTunes, browsers, VLC… anything that reports to Windows.
// Every platform exposes the same shape:
//   poll()          -> { player, playing, title, artist, album, duration, position, artUrl } | null
//   cmd(name)       -> toggle | next | prev | repeat
//   art(item)       -> data URL | null   (platform-specific artwork; main falls back to an iTunes lookup)

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const num = (s) => parseFloat(String(s).replace(',', '.')) || 0;

// ───────────────────────── macOS ─────────────────────────
function mac(nativeImage) {
  const osa = (script) => new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 4000 }, (err, out) => resolve(err ? null : out.trim()));
  });
  const SEP = '␟';
  const P = {
    music: {
      status: () => osa(`
        if application "Music" is running then
          tell application "Music"
            if player state is playing or player state is paused then
              set t to current track
              return (player state as string) & "${SEP}" & (name of t) & "${SEP}" & (artist of t) & "${SEP}" & (album of t) & "${SEP}" & (duration of t) & "${SEP}" & player position
            end if
          end tell
        end if
        return ""`),
      cmd: (c) => osa({
        toggle: 'tell application "Music" to playpause',
        next: 'tell application "Music" to next track',
        prev: 'tell application "Music" to previous track',
        repeat: 'tell application "Music" to set song repeat to (my nextRepeat(song repeat))\non nextRepeat(r)\n if r is off then return all\n if r is all then return one\n return off\nend nextRepeat',
      }[c]),
      art: async () => {
        const f = path.join(os.tmpdir(), 'lyrik-art.bin');
        const r = await osa(`
          tell application "Music"
            try
              set d to raw data of artwork 1 of current track
              set fh to open for access POSIX file "${f}" with write permission
              set eof fh to 0
              write d to fh
              close access fh
              return "ok"
            on error
              try
                close access POSIX file "${f}"
              end try
              return ""
            end try
          end tell`);
        if (r !== 'ok') return null;
        try {
          const img = nativeImage.createFromPath(f);
          return img.isEmpty() ? null : img.resize({ width: 1000 }).toDataURL();
        } catch (_) { return null; }
      },
    },
    spotify: {
      status: () => osa(`
        if application "Spotify" is running then
          tell application "Spotify"
            if player state is playing or player state is paused then
              set t to current track
              return (player state as string) & "${SEP}" & (name of t) & "${SEP}" & (artist of t) & "${SEP}" & (album of t) & "${SEP}" & ((duration of t) / 1000) & "${SEP}" & player position & "${SEP}" & (artwork url of t)
            end if
          end tell
        end if
        return ""`),
      cmd: (c) => osa({
        toggle: 'tell application "Spotify" to playpause',
        next: 'tell application "Spotify" to next track',
        prev: 'tell application "Spotify" to previous track',
        repeat: 'tell application "Spotify" to set repeating to not repeating',
      }[c]),
      art: async () => null,       // Spotify supplies an artwork URL in the status
    },
  };
  let active = 'music';
  return {
    async poll() {
      const order = active === 'music' ? ['music', 'spotify'] : ['spotify', 'music'];
      let paused = null;
      for (const p of order) {
        const raw = await P[p].status();
        if (!raw) continue;
        const [state, title, artist, album, duration, position, artUrl] = raw.split(SEP);
        const item = { player: p, playing: state === 'playing', title, artist, album, duration: num(duration), position: num(position), artUrl };
        if (item.playing) { active = p; return item; }
        if (!paused) paused = item;
      }
      if (paused) active = paused.player;
      return paused;
    },
    cmd: (c) => P[active].cmd(c),
    art: (item) => P[item.player].art(),
  };
}

// ───────────────────────── Windows ─────────────────────────
function windows() {
  // inside a packaged app the script is unpacked from the asar archive so PowerShell can run it
  const script = path.join(__dirname, 'win', 'nowplaying.ps1').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  const psArgs = (extra) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...extra];
  let snap = null, buf = '', child = null, restarts = 0;

  function start() {
    if (child || !fs.existsSync(script)) return;
    child = spawn('powershell.exe', psArgs(['-Mode', 'watch']), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { const j = JSON.parse(line); snap = { ...j, at: Date.now() }; restarts = 0; } catch (_) { /* ignore partial line */ }
      }
    });
    child.on('exit', () => {
      child = null;
      if (restarts++ < 5) setTimeout(start, 1500);
    });
  }
  start();

  return {
    async poll() {
      if (!snap || !snap.ok || Date.now() - snap.at > 4000 || !snap.title) return null;
      // the helper reports position as of its last tick; add the time since then while playing
      const drift = snap.playing ? (Date.now() - snap.at) / 1000 : 0;
      return {
        player: 'smtc', playing: !!snap.playing, title: snap.title, artist: snap.artist || '', album: snap.album || '',
        duration: num(snap.duration), position: num(snap.position) + drift, artUrl: '',
      };
    },
    cmd: (c) => new Promise((resolve) => {
      execFile('powershell.exe', psArgs(['-Mode', 'cmd', '-Cmd', c]), { windowsHide: true, timeout: 6000 }, () => resolve());
    }),
    art: async () => null,        // main falls back to an artwork lookup by title + artist
    stop() { if (child) { try { child.kill(); } catch (_) {} } },
  };
}

// ───────────────────────── other (Linux etc.): no now-playing source ─────────────────────────
function none() {
  return { poll: async () => null, cmd: async () => {}, art: async () => null };
}

module.exports = function createPlayers({ nativeImage }) {
  if (process.platform === 'darwin') return mac(nativeImage);
  if (process.platform === 'win32') return windows();
  return none();
};
