<div align="center">
  <img src="assets/icon.png" alt="Lyrikx app icon" width="128" />
  <h1>Lyrikx</h1>
  <p><strong>Lyrics on screen. Light on the beat.</strong></p>
  <p>Full-screen, word-by-word lyrics with a moving, customizable edge-light strip for macOS and Windows.</p>
  <p>
    <a href="https://github.com/sarthak045130/lyrik/actions/workflows/build.yml"><img alt="Build installers" src="https://github.com/sarthak045130/lyrik/actions/workflows/build.yml/badge.svg"></a>
    <img alt="macOS and Windows" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-6c63ff">
    <img alt="Electron" src="https://img.shields.io/badge/built%20with-Electron-47848f">
  </p>
</div>

## What it does

- Shows synchronized lyrics over the current album artwork in a full-screen view.
- Adds a moving edge-light strip with **Constant Moving** and **Beat Sync** modes.
- Lets you customize color, direction, speed, strip count, edges, glow, brightness, and more.
- Supports Apple Music and Spotify on Mac, plus media sessions available through Windows media controls.
- Offers nine lyric styles, text and color controls, and multi-display support.

Lyrics are provided by [LRCLIB](https://lrclib.net/). Lyrikx uses the current player’s artwork when available and can look up artwork when it is not.

## Install

Download a build from the repository’s **Actions** tab:

1. Open the latest successful **Build Lyrikx** run.
2. Under **Artifacts**, download the package for your operating system.
3. On Mac, open the `.dmg` and drag **Lyrikx.app** to **Applications**. The Mac build is unsigned; on first launch, Control-click the app and choose **Open**.
4. On Windows, run the setup `.exe` or use the portable `.exe`.

To build it yourself, install [Node.js](https://nodejs.org), open a terminal in this folder, then run:

```sh
npm install
npm start
```

Build an installer locally:

```sh
npm run dist:mac  # macOS DMG for the current Mac architecture
npm run dist:win  # Windows installer and portable executable
```

## Beat-synced lights

Open **Light Settings…** from the menu-bar/system-tray menu, or right-click the star button on the lyrics screen.

- **Constant Moving** keeps the strip moving without audio access.
- **Beat Sync** listens to system audio and makes the strip surge and flare on beats.
- Choose colors, direction, one to three strips, edges, speed, length, thickness, glow, brightness, and pulse fade.

On macOS 14.2 and later, allow **System Audio Recording** for Lyrikx when prompted. Windows captures system audio automatically. If audio capture is unavailable, the strip continues moving steadily and Light Settings explains the status.

## Supported players

| Platform | Players |
| --- | --- |
| macOS | Apple Music, Spotify |
| Windows | Apps available through Windows media controls, including Spotify, Apple Music, iTunes, browsers, and VLC |

On Mac, allow Lyrikx to control Music or Spotify when macOS asks. Lyrics and artwork depend on what the player and online lookup can provide.

## Build installers with GitHub Actions

The **Build Lyrikx** workflow can build for both macOS and Windows:

- Open **Actions → Build Lyrikx → Run workflow** to start a build.
- Push a version tag such as `v1.0.1` to trigger a build automatically.
- Download the resulting `.dmg` and `.exe` files from that run’s artifacts.

## Project notes

- The Mac build is unsigned, so macOS may require **Control-click → Open** on first launch.
- No license file is included yet.
