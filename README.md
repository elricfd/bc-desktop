# Bandcamp Desktop (bandcamp-rpc)

🎵 A standalone **Bandcamp desktop client** for Windows & Linux, built on Electron.
It wraps Bandcamp in a clean, dark-themed shell with a snappier custom player,
**Discord Rich Presence**, **Last.fm scrobbling**, a fast sortable collection
view, and one click downloads of ur purchases. YAAAAAAA :D

---

## Features

- **Custom player bar**: a single, consistent transport (play/pause, prev/next,
  seek, volume, shuffle, repeat, queue panel) that works across release pages,
  playlists, the homepage, your feed, discover/genre pages, your collection and
  wishlist, instead of Bandcamp's per-page players.
- **Discord Rich Presence**: shows what you're listening to. Works out of the
  box with a built-in app id; the Discord desktop app just needs to be running.
- **Last.fm scrobbling**: enter your API key/secret, connect once, and it
  scrobbles + updates "now playing" automatically (authorization is auto-detected,
  no manual confirm step).
- **Custom collection view**: a sortable/searchable grid of your whole
  collection (by artist, title, year, or date added). It pages in progressively
  and sorts client side, so it isn't affected by Bandcamp's "can't sort over 1000
  items" limit on the native page.
- **Download your purchases**: a download button on owned collection items lets
  you pick a format (FLAC / MP3 / ALAC / WAV / ...) and downloads straight to your
  chosen folder, with a progress indicator.
- **Add to queue**: queue releases without interrupting playback: the **+** on a
  collection grid card, or **shift-click** any album/track link on Bandcamp (the
  collection page, a release page, feeds…).
- **Light or dark**: dark (via Dark Reader) by default; switch to Bandcamp's
  native light theme in Settings.
- **Tabs**: middle-click a Bandcamp link to open it in a new in-app tab; all
  tabs share the one player.
- **Quality-of-life**: dark theme everywhere, hidden scrollbars, address bar,
  right click copy links, close to tray, and an auto updater for packaged
  builds.

---

## Install

### Download a build
Grab the latest installer/AppImage from the
[Releases](https://github.com/elricfd/bandcamp-rpc/releases) page.

- **Windows**: `Bandcamp-Setup-<version>.exe` (NSIS installer; lets you choose
  the install location and creates desktop/start-menu shortcuts).
- **Linux**: `.AppImage` (portable) or `.deb`.

### Build from source
```bash
git clone https://github.com/elricfd/bandcamp-rpc.git
cd bandcamp-rpc
npm install

# run in development (opens the app, --dev enables devtools / logging)
npm run dev

# build installers
npm run build-win        # Windows NSIS installer
npm run build-win-ptb    # Windows portable .exe
npm run build-linux      # Linux AppImage + deb
```
Build output lands in `build/`.

Requires Node 18+ and npm.

---

## Configuration

Open **Settings** from the gear icon in the top bar.

### Last.fm scrobbling
1. Create an API account at <https://www.last.fm/api/account/create> to get an
   **API key** and **shared secret**.
2. Paste both into Settings -> Last.fm and click **Save**.
3. Click **Connect account**: your browser opens to authorize the app. Once you
   approve, the app detects it automatically and shows "Connected as \<you\>".

### Discord Rich Presence
Just have the Discord desktop app running: presence works with the built in
application id. To use your own Discord application, paste its **Application ID**
into Settings -> Discord Rich Presence.

### Downloads
Set **Download location** in Settings -> General (defaults to your OS Downloads
folder). Owned collection items show a ⤓ button; click it to pick a format.

---

## Usage notes

- **Collection grid**: open it with the grid icon in the top bar. Use it (rather
  than Bandcamp's native collection page) to sort/search large collections; the
  native page can't sort collections over 1000 items.
- **Tabs**: middle-click a Bandcamp link for a new tab; the **+** button opens a
  blank tab. External (non-Bandcamp) links open in a separate window.
- **Add to queue**: hover a collection grid card and click **+**, or
  **shift click** an album/track link anywhere on Bandcamp. It's added to the end
  of the queue; if nothing's playing, it starts.
- **Navigation**: back/forward mouse buttons and the on screen arrows work; the
  logo returns to the Bandcamp homepage.
- **Copy a link**: right click it. **F12** toggles devtools on the active view.
- **Theme**: toggle light/dark in Settings → General.

---

## How it works (brief)

Bandcamp exposes different players/data shapes per surface. The app runs the real
Bandcamp site in a sandboxed view, traps outbound audio stream requests on a
genuine user gesture, and resolves the full tracklist from the page's embedded
data (or Bandcamp's `tralbum` API with your login cookies) so the custom player
can own playback and the queue. The collection view uses the `fancollection` API
with retry/backoff and streams pages in as they arrive.

---

## Disclaimer

This is an unofficial, fan-made client and is not affiliated with or endorsed by
Bandcamp. It uses your own logged in session and Bandcamp's own endpoints; please
support artists by buying music. Respect Bandcamp's terms of service.
