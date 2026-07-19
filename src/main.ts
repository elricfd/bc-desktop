import { app, BrowserWindow, BrowserView, ipcMain, Menu, Tray, nativeImage, shell, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { platform } from 'os';
import Store from 'electron-store';
import { autoUpdater } from 'electron-updater';

import { PresenceService } from './services/presenceService';
import { LastfmService } from './services/lastfmService';
import { BandcampApi } from './services/bandcampApi';
import { buildExtractorScript } from './services/queueExtractor';
import { buildId3v23 } from './services/id3';
import { readLocalTags, AUDIO_EXTENSIONS } from './services/localTags';
import type { NowPlaying, ResolveStreamRequest, ResolveStreamResponse, TralbumType, PlayerTrack } from './shared/types';

const darkReaderPath = require.resolve('darkreader/darkreader.js');
const darkReaderJS = fs.readFileSync(darkReaderPath, 'utf8');

// last-resort crash telemetry: log to userData/crash.log (and the console) so a
// hard crash actually says WHERE it happened instead of just closing the app.
process.on('uncaughtException', (err) => {
    const line = new Date().toISOString() + ' uncaught: ' + ((err && (err.stack || err)) || 'unknown') + '\n';
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line); } catch { /* disk */ }
    console.error('[bcrpc] ' + line);
});
process.on('unhandledRejection', (err: any) => {
    const line = new Date().toISOString() + ' unhandled rejection: ' + ((err && (err.stack || err)) || 'unknown') + '\n';
    try { fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), line); } catch { /* disk */ }
    console.error('[bcrpc] ' + line);
});

// search-box padding tweak injected on dom-ready
const SEARCHBOX_CSS = `
    #collection-search .search-box,
    #wishlist-search .search-box,
    .owner-controls .search-box {
        padding-left: 28px !important;
        padding-right: 28px !important;
    }
`;

// light theme: keep bandcamp's own look, just hide scrollbars & the banner. no
// opacity cloak (that waits on darkreader, which is off in light mode).
const LIGHT_CSS = `
    * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
    .editorial-recommendations-banner { display: none !important; }
    body.home .editorial-recommendations-banner { display: block !important; }
`;

// per-navigation theme css. the html-bg / body-opacity cloak is intentionally
// injected here too (webContents-level, applies very early per navigation) AND in
// the preload — dropping either one lets a flash of light-mode bandcamp show on
// page change, so both are kept on purpose.
const ANTI_FLASH_CSS = `
    html { background-color: #181a1b !important; }
    html:not([data-darkreader-scheme="dark"]) body { opacity: 0 !important; }

    /* hide every scrollbar app wide (content still scrolls). */
    * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }

    :root, html, body {
        --menubar-background-color: #1e2021 !important;
        --header-background-color: #1e2021 !important;
    }
    .header-wrapper, #menubar, .menubar, .menu-bar {
        transition: none !important;
        background-color: #1e2021 !important;
    }

    .editorial-recommendations-banner { display: none !important; }
    body.home .editorial-recommendations-banner { display: block !important; }

    .bandcamp-logo-link svg, .logo-mobile svg, .horizontal-nav__logo svg {
        visibility: hidden !important;
    }

    .bandcamp-logo-link, .horizontal-nav__logo, .logo-mobile, #page-footer .bandcamp-logo-link {
        background-color: #ffffff !important;
        -webkit-mask-image: url('https://upload.wikimedia.org/wikipedia/commons/0/06/Bandcamp-logotype-light.svg') !important;
        mask-image: url('https://upload.wikimedia.org/wikipedia/commons/0/06/Bandcamp-logotype-light.svg') !important;
        -webkit-mask-size: contain !important;
        mask-size: contain !important;
        -webkit-mask-repeat: no-repeat !important;
        mask-repeat: no-repeat !important;
        -webkit-mask-position: left center !important;
        mask-position: left center !important;
        display: inline-block !important;
    }

    @media (max-width: 743px) {
        .bandcamp-logo-link, .logo-mobile, .horizontal-nav__logo {
            -webkit-mask-image: url('https://upload.wikimedia.org/wikipedia/commons/0/07/Bandcamp-bc-logotype-light.svg') !important;
            mask-image: url('https://upload.wikimedia.org/wikipedia/commons/0/07/Bandcamp-bc-logotype-light.svg') !important;
        }
    }
`;

const store = new Store({ clearInvalidConfig: true });

// --- big on-disk caches -------------------------------------------------------
// the release index / collection listing / year cache used to live in
// electron-store, but conf re-reads AND re-writes the entire config.json
// SYNCHRONOUSLY on every access — once these caches grew to megabytes the main
// process spent seconds blocked on json i/o and the window went "not responding"
// (looked like a crash). they now live in their own files with in-memory state
// and debounced async writes.
class DiskCache<T> {
    private data: T;
    private timer: ReturnType<typeof setTimeout> | null = null;
    constructor(private readonly file: string, fallback: T) {
        let d: T = fallback;
        try { d = JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { /* fresh cache */ }
        this.data = d;
    }
    get(): T { return this.data; }
    replace(d: T): void { this.data = d; this.save(); }
    /** schedule a write; call after mutating the object returned by get() */
    save(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => { this.timer = null; this.writeNow(); }, 2000);
    }
    flush(): void {
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        try { fs.writeFileSync(this.file, JSON.stringify(this.data)); } catch { /* disk */ }
    }
    private writeNow(): void {
        try { fs.writeFile(this.file, JSON.stringify(this.data), () => { /* async */ }); } catch { /* disk */ }
    }
    sizeBytes(): number { try { return fs.statSync(this.file).size; } catch { return 0; } }
}
type IndexCacheEntryT = { g: string[]; t: [string, number][]; y: number; a?: string };
// custom playlists built from the collection view. entries are fully
// materialized tracks (display metadata + resolver handle); stream urls are
// NOT stored — they expire, so playback resolves them lazily like any queued
// collection track (player:resolve-stream).
type PlaylistEntryT = {
    id: string; title: string; artist: string; album: string; art: string;
    duration: number; url: string; bandId: string; tralbumId: string; tralbumType: TralbumType;
};
type PlaylistT = { id: string; name: string; createdAt: number; entries: PlaylistEntryT[]; desc?: string; cover?: string };
// local files library (quodlibet-style: files are parsed once into a queryable
// index keyed by path — the on-disk folder layout is irrelevant afterwards)
type LocalTrackT = {
    id: string; file: string; title: string; artist: string; album: string; albumArtist: string;
    year: number; trackNum: number; genre: string[]; duration: number;
    /** extracted embedded cover, cached under userData/local-art; '' when none */
    art: string;
    addedAt: number;
    /** file mtime at import; lets the folder scan skip unchanged files */
    mtime?: number;
};
let releaseIndexDisk: DiskCache<Record<string, IndexCacheEntryT>>;
let collectionItemsDisk: DiskCache<any[]>;
let yearsDisk: DiskCache<Record<string, number>>;
let playlistsDisk: DiskCache<PlaylistT[]>;
let localFilesDisk: DiskCache<LocalTrackT[]>;
function initDiskCaches(): void {
    const ud = app.getPath('userData');
    releaseIndexDisk = new DiskCache(path.join(ud, 'release-index.json'), {});
    collectionItemsDisk = new DiskCache(path.join(ud, 'collection-items.json'), []);
    yearsDisk = new DiskCache(path.join(ud, 'year-cache.json'), {});
    playlistsDisk = new DiskCache(path.join(ud, 'playlists.json'), []);
    localFilesDisk = new DiskCache(path.join(ud, 'local-files.json'), []);
    // one-time migration out of config.json (also shrinks it back to settings-only)
    try {
        const oldIdx = store.get('releaseIndexCache') as any;
        if (oldIdx && typeof oldIdx === 'object' && !Object.keys(releaseIndexDisk.get()).length) releaseIndexDisk.replace(oldIdx);
        const oldItems = store.get('collectionItemsCache') as any;
        if (Array.isArray(oldItems) && oldItems.length && !collectionItemsDisk.get().length) collectionItemsDisk.replace(oldItems);
        const oldYears = store.get('yearCache') as any;
        if (oldYears && typeof oldYears === 'object' && !Object.keys(yearsDisk.get()).length) yearsDisk.replace(oldYears);
        for (const k of ['releaseIndexCache', 'collectionItemsCache', 'yearCache', 'searchIndexCache']) {
            try { (store as any).delete(k); } catch { /* absent */ }
        }
    } catch { /* start with fresh caches */ }
}

// --- local files library helpers ---------------------------------------------
// local pseudo-releases live beside bandcamp items in the collection view; their
// ids are namespaced 'local:…' and every resolver branches on that prefix BEFORE
// any bandcamp id math (toIdStr would mangle them).
const LOCAL_PREFIX = 'local:';
const isLocalId = (id: unknown): boolean => String(id || '').startsWith(LOCAL_PREFIX);
const localFileUrl = (p: string): string => { try { return p ? pathToFileURL(p).href : ''; } catch { return ''; } };
function localAlbumKey(t: { albumArtist: string; artist: string; album: string; id: string }): string {
    if (!t.album) return LOCAL_PREFIX + t.id; // untagged file: its own card
    const h = crypto.createHash('md5').update(((t.albumArtist || t.artist) + '\0' + t.album).toLowerCase()).digest('hex').slice(0, 16);
    return LOCAL_PREFIX + h;
}
function localGroups(): Map<string, LocalTrackT[]> {
    const groups = new Map<string, LocalTrackT[]>();
    for (const t of localFilesDisk.get()) {
        const k = localAlbumKey(t);
        const g = groups.get(k);
        if (g) g.push(t); else groups.set(k, [t]);
    }
    for (const g of groups.values()) g.sort((a, b) => (a.trackNum - b.trackNum) || a.title.localeCompare(b.title));
    return groups;
}
function localCollectionItems(): any[] {
    const items: any[] = [];
    for (const [key, tracks] of localGroups()) {
        const first = tracks[0];
        const withArt = tracks.find((t) => t.art);
        items.push({
            itemId: key, tralbumId: key, tralbumType: 'a',
            title: first.album || first.title,
            artist: first.albumArtist || first.artist || '(unknown artist)',
            art: withArt ? localFileUrl(withArt.art) : '',
            url: '', bandId: '',
            addedAt: Math.max(...tracks.map((t) => t.addedAt || 0)),
            year: tracks.map((t) => t.year).find((y) => y) || 0,
            downloadUrl: '', local: true,
        });
    }
    return items;
}
function localPlayerTracks(albumKey: string): PlayerTrack[] {
    const tracks = localGroups().get(albumKey) || [];
    return tracks.map((t) => ({
        id: t.id, title: t.title, artist: t.artist || t.albumArtist, album: t.album,
        art: localFileUrl(t.art), src: localFileUrl(t.file),
        duration: t.duration || 0, url: '', bandId: '', tralbumId: albumKey, tralbumType: 'a' as TralbumType,
    }));
}
function localTrackById(id: unknown): LocalTrackT | undefined {
    const want = String(id || '');
    return want ? localFilesDisk.get().find((t) => t.id === want) : undefined;
}

let mainWindow: BrowserWindow;
let headerView: BrowserView;
// contentView is an alias for the *active* tab's view; every place that navigates
// / traps / injects operates on it. background tabs stay alive but off screen.
let contentView: BrowserView;
let playerView: BrowserView;
let collectionView: BrowserView;
let collectionVisible = false;
let feedView: BrowserView;
let feedVisible = false;
let spotlightWin: BrowserWindow | null = null; // macOS-spotlight-style search popup

interface Tab { id: number; view: BrowserView; title: string; }
let tabs: Tab[] = [];
let activeTabId = -1;
let tabSeq = 0;
// per-view anti-flash css handle so each tab can swap its own on navigation
const antiFlashKeys = new WeakMap<Electron.WebContents, string>();

function isBandcampUrl(url: string): boolean {
    try { return /(^|\.)bandcamp\.com$/i.test(new URL(url).hostname); } catch { return false; }
}
let settingsWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let presenceService: PresenceService;
let lastfmService: LastfmService;
let bandcampApi: BandcampApi;
let playerExpanded = false;
let isQuitting = false;

const devMode = process.argv.includes('--dev');
const isWin = platform() === 'win32';
const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
app.userAgentFallback = globalUserAgent;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

// relaunching the app while it's hidden to tray (clicking the desktop/taskbar
// icon) fires this in the running instance — bring the window back instead of
// silently doing nothing.
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}
app.on('second-instance', showMainWindow);
app.on('activate', showMainWindow); // macOS dock click

function adjustContentViews() {
    if (!mainWindow || !contentView || !headerView || !playerView) return;
    if (mainWindow.isMinimized()) return;

    const { width, height } = mainWindow.getContentBounds();
    if (width <= 0 || height <= 0) return;

    const headerHeight = 40;
    const playerHeight = 64;
    const panelHeight = 360;

    // when queue panel is open player view grows upward & overlays content view (added last so renders on top)
    const playerViewHeight = playerExpanded ? playerHeight + panelHeight : playerHeight;

    headerView.setBounds({ x: 0, y: 0, width, height: headerHeight });
    playerView.setBounds({ x: 0, y: height - playerViewHeight, width, height: playerViewHeight });
    const contentRect = {
        x: 0,
        y: headerHeight,
        width,
        height: height - (headerHeight + playerHeight),
    };
    contentView.setBounds(contentRect);
    // collection / feed views (added only while open) fill the content area
    if (collectionView && collectionVisible) collectionView.setBounds(contentRect);
    if (feedView && feedVisible) feedView.setBounds(contentRect);
}

function setupTray() {
    const iconPath = path.join(__dirname, '../assets/bandcamp-button-circle-black-64.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Bandcamp Desktop');
    // right click menu is only reliable way to quit when close to tray is on
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Bandcamp', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { label: 'Hide to tray', click: () => mainWindow.hide() },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]));
    tray.on('click', () => {
        if (mainWindow.isVisible()) mainWindow.hide();
        else { mainWindow.show(); mainWindow.focus(); }
    });
}

function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.focus();
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 460,
        height: 560,
        parent: mainWindow,
        modal: false,
        resizable: false,
        title: 'Settings',
        backgroundColor: '#181a1b',
        // frameless w/ our own titlebar: native close btn on windows can stick in its
        // hover state when the cursor leaves via the client area, so we own the control
        frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    settingsWindow.loadFile(path.join(__dirname, 'settings', 'settings.html'));
    settingsWindow.on('closed', () => { settingsWindow = null; });
}

// hide the custom collection overlay (shared by the close btn & the home btn)
function closeCollection() {
    if (collectionVisible && collectionView) mainWindow.removeBrowserView(collectionView);
    collectionVisible = false;
    if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('collection:state', false);
}

// hide the custom feed overlay (close btn / home btn / navigation)
function closeFeed() {
    if (feedVisible && feedView) mainWindow.removeBrowserView(feedView);
    feedVisible = false;
    if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('feed:state', false);
}

// close the spotlight search popup (results are wiped on close by the popup itself)
function closeSearch() {
    if (spotlightWin && !spotlightWin.isDestroyed()) spotlightWin.close();
    spotlightWin = null;
    if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('gsearch:state', false);
}

// external (non-bandcamp) hosts artists link to that should pop a separate window
// instead of hijacking the main view. kept to social/promo sites so checkout &
// login redirects (paypal, stripe, google, facebook oauth…) still work in-app.
const SOCIAL_HOSTS = [
    'instagram.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com', 'youtu.be',
    'tiktok.com', 'spotify.com', 'open.spotify.com', 'soundcloud.com', 'music.apple.com',
    'tumblr.com', 'twitch.tv', 'patreon.com', 'threads.net', 'bsky.app', 'linktr.ee',
    'discord.gg', 'discord.com', 'wikipedia.org', 'last.fm', 'reddit.com', 'mastodon.social',
];
function isSocialHost(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
        return SOCIAL_HOSTS.some((s) => h === s || h.endsWith('.' + s));
    } catch { return false; }
}

function toIdStr(v: unknown): string { const m = String(v ?? '').match(/\d+/); return m ? m[0] : ''; }

// ui theme: dark (darkreader) by default; unchecking the "dark mode" setting
// switches to 'light' = bandcamp's native look.
function getTheme(): 'dark' | 'light' {
    return store.get('theme', 'dark') === 'light' ? 'light' : 'dark';
}

// artist / label pages (subdomains & bandcamp-pro custom domains) as opposed to the
// core app pages (bandcamp.com, the daily). used by the "don't darken artist pages"
// option so their custom themes show through.
function isArtistPage(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return !(h === 'bandcamp.com' || h === 'www.bandcamp.com' || h === 'daily.bandcamp.com');
    } catch { return false; }
}

// fan playlist pages ship their own dark design; darkreader double-inverts it
// into weird colors, so they're always exempt (our chrome stays dark regardless).
function isPlaylistPage(url: string): boolean {
    try {
        const u = new URL(url);
        return /(^|\.)bandcamp\.com$/i.test(u.hostname) && /\/playlist(\/|$)/.test(u.pathname);
    } catch { return false; }
}

// effective theme for a specific page: dark everywhere, except artist pages are
// left light (their custom look) unless the user opted into darkening them,
// and playlist pages which are natively dark already.
function themeForUrl(url: string): 'dark' | 'light' {
    if (getTheme() === 'light') return 'light';
    if (isPlaylistPage(url)) return 'light';
    if (store.get('darkArtistPages', false) !== true && isArtistPage(url)) return 'light';
    return 'dark';
}

// opt-in on-disk release cache: covers + the release index (tracklists, tags,
// album info) + the collection listing itself. audio is never cached.
function cacheReleasesOn(): boolean { return store.get('cacheReleases', false) === true; }
// which window-bar controls are visible (min/max/close/settings are not optional).
// home defaults hidden (long-standing preference); everything else shown.
// customizable app shortcuts (settings -> Keybinds). matched in main via
// before-input-event on every view, so they work wherever focus sits.
const SHORTCUT_DEFAULTS: Record<string, string> = {
    collection: 'Ctrl+Shift+C',
    feed: 'Ctrl+Shift+F',
    home: 'Ctrl+Shift+H',
    downloads: 'Ctrl+Shift+D',
    search: 'Ctrl+K',
};
function getShortcuts(): Record<string, string> {
    const saved = store.get('shortcuts', {}) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const k of Object.keys(SHORTCUT_DEFAULTS)) {
        out[k] = typeof saved[k] === 'string' ? saved[k] : SHORTCUT_DEFAULTS[k];
    }
    return out;
}
// "Ctrl+Shift+C"-style accel from an electron before-input-event payload
function accelOfInput(input: Electron.Input): string {
    const key = String(input.key || '');
    if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
    const parts: string[] = [];
    if (input.control) parts.push('Ctrl');
    if (input.alt) parts.push('Alt');
    if (input.meta) parts.push('Cmd');
    if (input.shift) parts.push('Shift');
    parts.push(key.length === 1 ? key.toUpperCase() : key);
    return parts.join('+');
}

const HEADER_BUTTON_DEFAULTS = { home: false, back: true, forward: true, newtab: false, urlbar: true, reload: true, downloads: true, gsearch: false, collection: true, feed: true } as const;
function getHeaderButtons(): Record<string, boolean> {
    const saved = store.get('headerButtons', {}) as Record<string, boolean>;
    const out: Record<string, boolean> = {};
    for (const k of Object.keys(HEADER_BUTTON_DEFAULTS)) {
        out[k] = typeof saved[k] === 'boolean' ? saved[k] : (HEADER_BUTTON_DEFAULTS as any)[k];
    }
    return out;
}
// covers live under the user-chosen cache location (settings), else app data
function artCacheDir(): string {
    const custom = store.get('cacheDir', '') as string;
    const base = custom && typeof custom === 'string' && fs.existsSync(custom) ? custom : app.getPath('userData');
    const d = path.join(base, 'art-cache');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* exists */ }
    return d;
}
// total bytes held by the release cache (covers on disk + the metadata stores)
function cacheSizeBytes(): number {
    let total = 0;
    try {
        const dir = artCacheDir();
        for (const f of fs.readdirSync(dir)) {
            try { total += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
        }
    } catch { /* no dir */ }
    total += releaseIndexDisk.sizeBytes() + collectionItemsDisk.sizeBytes() + yearsDisk.sizeBytes();
    return total;
}
function artCachePath(type: string, id: string): string {
    return path.join(artCacheDir(), type + toIdStr(id) + '.jpg');
}
function localArtUrl(type: string, id: string): string {
    const p = artCachePath(type, id);
    try { if (fs.existsSync(p)) return pathToFileURL(p).href; } catch { /* keep remote */ }
    return '';
}

// persist a resolved release year so year-sort enrichment is a one-time cost
function persistYear(type: string, id: string, year: number): void {
    if (!id || !year) return;
    yearsDisk.get()[type + ':' + id] = year;
    yearsDisk.save();
}

// where purchased downloads land: user pick if set, else os downloads folder
function getDownloadDir(): string {
    const dir = store.get('downloadDir', '') as string;
    if (dir && typeof dir === 'string') {
        try { if (fs.existsSync(dir)) return dir; } catch { /* fall thru */ }
    }
    return app.getPath('downloads');
}

// small transient toast painted into the content page (appears right where the
// user acted, e.g. after copying a link or finishing a download)
function pageToast(msg: string) {
    if (!contentView || contentView.webContents.isDestroyed()) return;
    const js =
        '(function(){var t=document.getElementById("__bcrpc_toast");' +
        'if(!t){t=document.createElement("div");t.id="__bcrpc_toast";' +
        't.style.cssText="position:fixed;z-index:2147483647;bottom:88px;left:50%;transform:translateX(-50%);background:#1da0c3;color:#fff;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;padding:8px 15px;border-radius:20px;box-shadow:0 6px 20px rgba(0,0,0,.45);pointer-events:none;opacity:0;transition:opacity .18s ease";' +
        'document.body.appendChild(t);}t.textContent=' + JSON.stringify(msg) + ';' +
        't.style.opacity="1";clearTimeout(t.__h);t.__h=setTimeout(function(){t.style.opacity="0";},1500);})();';
    contentView.webContents.executeJavaScript(js).catch(() => {});
}

// open a bandcamp url in a plain secondary window (middle click / open in new window).
// shares the default session so fan login cookies carry over.
function openInNewWindow(url: string) {
    if (!/^https?:\/\//i.test(url)) return;
    const win = new BrowserWindow({
        width: 1100,
        height: 800,
        title: 'Bandcamp',
        backgroundColor: '#181a1b',
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, devTools: true },
    });
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') { win.webContents.toggleDevTools(); event.preventDefault(); }
    });
    win.loadURL(url).catch(() => {});
}

async function init() {
    Menu.setApplicationMenu(null);
    initDiskCaches(); // big caches out of config.json (see DiskCache)
    presenceService = new PresenceService(store);
    lastfmService = new LastfmService(store);
    bandcampApi = new BandcampApi(() => (contentView ? contentView.webContents.session : null));

    // surface bandcamp's HTTP 429 throttling to the user (previously only visible
    // in the devtools console). our own styled window, not a native dialog; shown
    // at most once per session; "Don't show again" persists the opt-out.
    let notice429Shown = false;
    let notice429Win: BrowserWindow | null = null;
    bandcampApi.on429 = () => {
        if (notice429Shown || store.get('hide429Notice', false) === true) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        notice429Shown = true;
        try {
            notice429Win = new BrowserWindow({
                width: 470, height: 220, parent: mainWindow, frame: false, resizable: false,
                backgroundColor: '#181a1b', // opaque: transparent windows are crash-prone on some setups
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            notice429Win.loadFile(path.join(__dirname, 'notice', 'notice429.html'));
            notice429Win.on('closed', () => { notice429Win = null; });
        } catch { notice429Win = null; }
    };
    ipcMain.on('notice429:close', (_e, never: unknown) => {
        if (never === true) store.set('hide429Notice', true);
        if (notice429Win && !notice429Win.isDestroyed()) notice429Win.close();
    });
    setupTray();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
        minWidth: 1080,
        minHeight: 540,
        title: 'Bandcamp',
        icon: path.join(__dirname, '../assets/bandcamp-button-circle-black-512.png'),
        backgroundColor: '#181a1b',
        show: false,
        frame: false,
        titleBarStyle: 'hidden',
        webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    headerView = new BrowserView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
    headerView.setBackgroundColor('#121415');

    playerView = new BrowserView({
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            autoplayPolicy: 'no-user-gesture-required'
        }
    });
    playerView.setBackgroundColor('#181a1b');

    // first tab. contentView aliases the *active* tab's view; more tabs open via
    // middle-click (bandcamp links) or the + button and all share the one player.
    contentView = makeContentView();
    tabs = [{ id: ++tabSeq, view: contentView, title: 'Bandcamp' }];
    activeTabId = tabSeq;

    collectionView = new BrowserView({
        webPreferences: { nodeIntegration: true, contextIsolation: false, devTools: devMode }
    });
    collectionView.setBackgroundColor('#181a1b');
    if (devMode) {
        collectionView.webContents.on('did-finish-load', () => console.log('[bcrpc] collection view loaded'));
        collectionView.webContents.on('did-fail-load', (_e, code, desc, url) =>
            console.log('[bcrpc] collection view FAILED ' + code + ' ' + desc + ' ' + url));
    }

    feedView = new BrowserView({
        webPreferences: { nodeIntegration: true, contextIsolation: false, devTools: devMode }
    });
    feedView.setBackgroundColor('#181a1b');

    if (devMode) {
        feedView.webContents.on('did-fail-load', (_e, code, desc, url) =>
            console.log('[bcrpc] feed view FAILED ' + code + ' ' + desc + ' ' + url));
    }

    mainWindow.addBrowserView(contentView);
    mainWindow.addBrowserView(headerView);
    mainWindow.addBrowserView(playerView);
    // collectionview added on demand when toggled open (see collection:toggle)

    wireContentView(contentView); // attach nav/trap/theme/context-menu handlers

    collectionView.webContents.loadFile(path.join(__dirname, 'collection', 'collection.html'));
    feedView.webContents.loadFile(path.join(__dirname, 'feed', 'feed.html'));
    // shortcuts work no matter which pane has focus
    for (const v of [headerView, playerView, collectionView, feedView]) wireShortcutsOn(v.webContents);

    // opt-in (settings, off by default): pre-fetch the collection in the background
    // right after startup so opening the view is instant. small delay so the fetch
    // doesn't compete with the initial page load for bandwidth/session cookies.
    collectionView.webContents.once('did-finish-load', () => {
        if (store.get('autoLoadCollection', false) !== true) return;
        setTimeout(() => {
            if (collectionView && !collectionView.webContents.isDestroyed()) {
                collectionView.webContents.send('collection:load');
            }
        }, 3000);
    });

    adjustContentViews();

    mainWindow.on('resize', adjustContentViews);
    mainWindow.on('restore', adjustContentViews);

    mainWindow.on('close', (event) => {
        // close to tray by default; when off closing window quits app
        const closeToTray = store.get('closeToTray', true) !== false;
        if (closeToTray && !isQuitting) { event.preventDefault(); mainWindow.hide(); }
    });

    headerView.webContents.loadFile(path.join(__dirname, 'header', 'header.html'));
    playerView.webContents.loadFile(path.join(__dirname, 'player', 'player.html'));

    const session = contentView.webContents.session;

    const isAudioStream = (url: string) => {
        return url.includes('/stream_redirect') ||
               url.includes('bcbits.com/stream/') ||
               url.includes('mp3-128') ||
               url.includes('mp3-v0') ||
               (url.includes('.m3u8') && (url.includes('sndcdn') || url.includes('soundcloud')));
    };

    // identify which track trapped stream url is for (token query param or numeric id in /stream/.../mp3-128/<id> path) so throttle below can dedupe by track rather than exact url (stream urls carry rotating tokens)
    const streamTrackId = (url: string): string => {
        try {
            const u = new URL(url);
            const q = u.searchParams.get('track_id') || u.searchParams.get('id') || '';
            const qm = q.match(/\d+/);
            if (qm) return qm[0];
            const segs = u.pathname.split('/').filter(Boolean);
            for (let i = segs.length - 1; i >= 0; i--) if (/^\d{4,}$/.test(segs[i])) return segs[i];
        } catch { }
        return '';
    };

    // content view audio trap acted on only when it follows real user gesture (relayed from preload). muted page player auto advances thru release after we cancel stream; those re reqs have no gesture so ignoring them stops it from hijacking queue w/out delaying real plays. gestureseen guards legacy cooldown fallback for case where gesture signal never arrives
    let lastActedId = '';
    let lastActedAt = 0;
    let userGestureAt = 0;
    let gestureSeen = false;
    let fallbackCooldownUntil = 0;
    // app-wide customizable shortcuts (collection / feed / home / downloads / search)
    function handleShortcut(input: Electron.Input): boolean {
        if (input.type !== 'keyDown') return false;
        if (!input.control && !input.alt && !input.meta) return false; // never hijack typing
        const accel = accelOfInput(input);
        if (!accel) return false;
        const sc = getShortcuts();
        if (accel === sc.collection) { ipcMain.emit('collection:toggle'); return true; }
        if (accel === sc.feed) { ipcMain.emit('feed:toggle'); return true; }
        if (accel === sc.home) { ipcMain.emit('app:home'); return true; }
        if (accel === sc.downloads) { ipcMain.emit('downloads:toggle'); return true; }
        if (accel === sc.search) { ipcMain.emit('gsearch:toggle'); return true; }
        return false;
    }
    function wireShortcutsOn(wc: Electron.WebContents): void {
        wc.on('before-input-event', (event, input) => { if (handleShortcut(input)) event.preventDefault(); });
    }

    let trapSeq = 0;
    // assigned once the collection fetcher exists; fired (debounced) whenever the
    // fan collects/uncollects something on a bandcamp page
    let onCollectAction: ((removal: boolean) => void) | null = null;
    ipcMain.on('player:user-gesture', () => { gestureSeen = true; userGestureAt = Date.now(); });

    // net trap & tracklist extractor
    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const reqUrl = details.url;

        if (isAudioStream(reqUrl)) {
            // only trap the active tab's audio; background tabs & the player view
            // are left to stream (background tabs are muted, so this is silent)
            if (contentView && details.webContentsId === contentView.webContents.id) {
                callback({ cancel: true });

                const now = Date.now();
                const trapId = streamTrackId(reqUrl);
                // same track re trapped for multi chunk preflight or instant retry.
                if (trapId && trapId === lastActedId && now - lastActedAt < 1500) {
                    if (devMode) console.log('[bcrpc] trap skip (dup) id=' + trapId);
                    return;
                }
                // after acting on trap muted page player errors on cancelled stream & auto advances firing burst of stream reqs for rest of release. act only on 1st trap of burst: extractor owns queue from there & acting on burst would re run tralbum api per track & trip bandcamp rate limit (http 429). genuine new play gets thru promptly. auth user initiated plays only; ignore page autonomous re reqs so they can't reload queue. when no gesture signal arrives fall back to short cooldown
                const authorized = gestureSeen
                    ? (userGestureAt !== 0 && now - userGestureAt < 5000)
                    : (now >= fallbackCooldownUntil);
                if (!authorized) {
                    if (devMode) console.log('[bcrpc] trap skip (' + (gestureSeen ? 'no gesture' : 'cooldown') + ') id=' + trapId);
                    return;
                }
                if (gestureSeen) userGestureAt = 0; // consume gesture
                else fallbackCooldownUntil = now + 1200;
                lastActedId = trapId;
                lastActedAt = now;

                const format = reqUrl.includes('.m3u8') ? 'hls' : 'raw';
                // tag res. extractor is async so 2 quick clicks or click then page nav race. apply result of most recent auth trap only; older in flight res dropped instead of flicking player back to stale track. trapseq bumped on nav so collection play resolving after click thru to release can't hijack it
                const seq = ++trapSeq;

                // note: playback is driven entirely by the resolved queue below
                // (player:stream-incoming). we intentionally don't pre-play the
                // trapped stream: on the collection page that stream is the item's
                // featured track (often not track 1), which would play the wrong
                // song for a moment before the real queue corrects it.

                if (devMode) {
                    console.log('[bcrpc] trap fire id=' + trapId + ' ' + reqUrl.slice(0, 90));
                    // snapshot page to see why surface resolved way it did: is capture hook installed, how many discover entries captured, is playlist blob present?
                    contentView.webContents.executeJavaScript(
                        "({u:location.href,cap:!!window.__bcrpcCapture,dn:Object.keys((window.__bcrpc&&window.__bcrpc.discover)||{}).length,pl:!!document.getElementById('PlaylistPage'),td:!!window.TralbumData})"
                    ).then((s: any) => console.log('[bcrpc] page ' + JSON.stringify(s))).catch(() => {});
                }

                // extractor runs in page context where it can read embedded tracklists / captured discover grid & fetch full album from tralbum api w/ fan cookies. it pauses page muted player so it stops auto advancing then resolves complete queue which main proc forwards to player
                contentView.webContents.executeJavaScript(buildExtractorScript(reqUrl, format))
                    .then((data: any) => {
                        const stale = seq !== trapSeq;
                        if (devMode) {
                            const a = data && data.queue && data.queue[data.activeIndex || 0];
                            console.log('[bcrpc] extract ' + (stale ? '(stale, dropped) ' : '') + (data && data.queue
                                ? data.context + ' n=' + data.queue.length + ' active=' + data.activeIndex +
                                  ' title=' + (a && a.title) + ' artist=' + (a && a.artist) + ' album=' + (a && a.album) + ' srcLen=' + ((a && a.src) || '').length
                                : 'EMPTY'));
                        }
                        if (stale) return; // newer play (or nav) superseded this one
                        if (data?.queue?.length && playerView && !playerView.webContents.isDestroyed()) {
                            playerView.webContents.send('player:stream-incoming', data);
                        }
                    })
                    .catch((err: any) => { if (devMode) console.log('[bcrpc] extract ERROR ' + (err && (err.message || err))); });

                return;
            } else if (playerView && details.webContentsId === playerView.webContents.id) {
                callback({ cancel: false });
                return;
            }
        }

        // (playlist header play button never streams, so it can't be trapped;
        // the preload click hook below drives the extractor directly instead)

        // wishlist hearts / collection changes post to *collect_item_cb — refresh
        // the custom collection so the change shows up right away. removals
        // (uncollect / hide) force a full silent re-scan, since only a re-scan
        // can discover which item disappeared.
        if (/\/(?:un)?collect_item_cb|\/wishlist_cb|hide_unhide_item/.test(reqUrl)) {
            const removal = /uncollect_item_cb|hide_unhide_item/.test(reqUrl);
            try { onCollectAction && onCollectAction(removal); } catch { /* not ready yet */ }
        }

        callback({ cancel: false });
    });

    // fan playlist header play button: bandcamp toggles its own (muted, hidden)
    // player without requesting a stream, so the audio trap never fires and the
    // button appears dead. the preload detects the click & we run the extractor
    // directly — #PlaylistPage embeds the full tracklist with stream urls.
    ipcMain.on('app:playlist-play', () => {
        if (!contentView || contentView.webContents.isDestroyed()) return;
        const seq = ++trapSeq;
        // no trapped stream url: fromPlaylistPage plays the embedded queue from track 1
        contentView.webContents.executeJavaScript(buildExtractorScript('about:playlist', 'raw'))
            .then((data: any) => {
                if (seq !== trapSeq) return;
                if (devMode) console.log('[bcrpc] playlist-play ' + (data?.queue ? 'n=' + data.queue.length : 'EMPTY'));
                if (data?.queue?.length && playerView && !playerView.webContents.isDestroyed()) {
                    playerView.webContents.send('player:stream-incoming', data);
                }
            })
            .catch((err: any) => { if (devMode) console.log('[bcrpc] playlist-play ERROR ' + (err && (err.message || err))); });
    });

    session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = { ...details.responseHeaders };
        for (const header in responseHeaders) {
            if (header.toLowerCase() === 'content-security-policy') {
                delete responseHeaders[header];
            }
        }
        responseHeaders['Access-Control-Allow-Origin'] = ['*'];
        callback({ cancel: false, responseHeaders });
    });

    // spoof cdn referer headers
    session.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.includes('google') || details.url.includes('discord')) {
            callback({ requestHeaders: details.requestHeaders });
            return;
        }
        const headers = { ...details.requestHeaders };
        // spoof referer/origin for the media CDNs (they gate on a bandcamp referer)
        // and for the BASE bandcamp.com domain (its apis — tralbum/fancollection —
        // want it). but NOT for artist subdomains: forcing Origin=bandcamp.com on a
        // subdomain action (e.g. c418.bandcamp.com/collect_item_cb) makes bandcamp
        // reject it ("request must use the base domain").
        let host = '';
        try { host = new URL(details.url).hostname.toLowerCase(); } catch { /* leave blank */ }
        // exact-suffix host checks (host.endsWith('bcbits.com') would also match
        // evilbcbits.com, host.includes('sndcdn') matches anything — CWE-20)
        const hostIs = (d: string) => host === d || host.endsWith('.' + d);
        const isBaseBandcamp = host === 'bandcamp.com' || host === 'www.bandcamp.com';
        if (isBaseBandcamp || hostIs('bcbits.com') || hostIs('sndcdn.com')) {
            headers['Referer'] = 'https://bandcamp.com/';
            headers['Origin'] = 'https://bandcamp.com';
        }
        headers['sec-ch-ua'] = '"Not_A Brand";v="8", "Chromium";v="136", "Google Chrome";v="136"';
        headers['sec-ch-ua-platform'] = isWin ? '"Windows"' : '"Linux"';
        headers['User-Agent'] = globalUserAgent;
        callback({ requestHeaders: headers });
    });

    ipcMain.on('window:minimize', () => mainWindow.minimize());
    ipcMain.on('window:maximize', () => {
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
    });
    ipcMain.on('window:close', () => mainWindow.close());

    // a single mouse back/fwd click can surface as BOTH an os app-command (on press)
    // & a page mouseup (on release); when the two land >350ms apart they used to
    // slip thru as two navs, skipping a page (landing you on the default bandcamp
    // home). wider window + latching on the 1st of a back/fwd burst collapses it to 1
    let lastNavAt = 0;
    const navGo = (dir: 'back' | 'forward') => {
        const now = Date.now();
        if (now - lastNavAt < 600) return;
        lastNavAt = now;
        const nav = contentView.webContents.navigationHistory;
        if (dir === 'back' && nav.canGoBack()) nav.goBack();
        else if (dir === 'forward' && nav.canGoForward()) nav.goForward();
    };
    // force a navigation onto the active tab even if its page is wedged. bandcamp's
    // collection page hangs its own renderer when you try to sort a collection over
    // 1000 items — clicks, refresh & even the home button then appear dead because
    // the stuck renderer swallows input. if the view is hung/crashed we drop that
    // renderer (loadURL then spins up a fresh one); otherwise we just stop the
    // pending load first. this is our guaranteed escape hatch.
    const hardLoad = (url: string) => {
        const wc = contentView.webContents;
        try {
            if ((wc as any).__hung || wc.isCrashed()) {
                (wc as any).__hung = false;
                wc.forcefullyCrashRenderer();
            } else {
                wc.stop();
            }
        } catch { /* best effort */ }
        wc.loadURL(url).catch(() => {});
    };

    ipcMain.on('app:back', () => navGo('back'));
    ipcMain.on('app:forward', () => navGo('forward'));
    ipcMain.on('app:reload', () => {
        const wc = contentView.webContents;
        if ((wc as any).__hung || wc.isCrashed()) hardLoad(wc.getURL() || 'https://bandcamp.com');
        else wc.reload();
    });
    // home btn returns to the homepage, closing the collection overlay if it's open.
    // uses hardLoad so it always works even from a wedged collection page.
    ipcMain.on('app:home', () => {
        closeCollection();
        closeFeed();
        closeSearch();
        hardLoad('https://bandcamp.com');
    });

    // clicking track title / artist name in player bar (or a feed card) navs page;
    // close the overlays so the page isn't loading invisibly underneath them
    ipcMain.on('app:navigate', (_e, url: unknown) => {
        if (typeof url === 'string' && url.startsWith('https://')) {
            closeCollection();
            closeFeed();
            closeSearch();
            hardLoad(url);
        }
    });

    // address bar nav: accept full url, bare domain/path, or free text search (routed to bandcamp search)
    ipcMain.on('app:navigate-url', (_e, raw: unknown) => {
        const input = (typeof raw === 'string' ? raw : '').trim();
        if (!input) return;
        let url: string;
        if (/^https?:\/\//i.test(input)) url = input;
        else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$|\?)/.test(input)) url = 'https://' + input;
        else url = 'https://bandcamp.com/search?q=' + encodeURIComponent(input);
        hardLoad(url);
    });

    // custom collection view
    ipcMain.on('collection:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:collection] ' + String(msg)); });
    ipcMain.on('collection:toggle', () => {
        collectionVisible = !collectionVisible;
        if (collectionVisible) {
            closeFeed(); closeSearch(); // one overlay at a time
            mainWindow.addBrowserView(collectionView);
            mainWindow.setTopBrowserView(headerView); // keep header/player above it
            mainWindow.setTopBrowserView(playerView);
            adjustContentViews();
            collectionView.webContents.send('collection:shown');
            collectionView.webContents.send('collection:load');
        } else {
            mainWindow.removeBrowserView(collectionView);
        }
        if (headerView && !headerView.webContents.isDestroyed()) {
            headerView.webContents.send('collection:state', collectionVisible);
        }
    });
    ipcMain.on('collection:close', () => closeCollection());

    // custom feed view (stories from artists & fans you follow)
    ipcMain.on('feed:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:feed] ' + String(msg)); });
    ipcMain.on('feed:toggle', () => {
        feedVisible = !feedVisible;
        if (feedVisible) {
            closeCollection(); closeSearch(); // one overlay at a time
            mainWindow.addBrowserView(feedView);
            mainWindow.setTopBrowserView(headerView); // keep header/player above it
            mainWindow.setTopBrowserView(playerView);
            adjustContentViews();
            feedView.webContents.send('feed:shown');
        } else {
            mainWindow.removeBrowserView(feedView);
        }
        if (headerView && !headerView.webContents.isDestroyed()) {
            headerView.webContents.send('feed:state', feedVisible);
        }
    });
    ipcMain.on('feed:close', () => closeFeed());

    // one page of the fan feed; olderThan pages backwards (0 = newest)
    ipcMain.handle('feed:fetch', async (_e, olderThan: unknown) => {
        const res = await bandcampApi.fetchFeed(Number(olderThan) || 0);
        if (devMode) console.log('[bcrpc] feed:fetch older=' + olderThan + ' -> ' + res.stories.length + (res.error ? ' err=' + res.error : ''));
        return res;
    });

    // global bandcamp search view
    ipcMain.on('gsearch:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:gsearch] ' + String(msg)); });
    const openSpotlight = () => {
        if (spotlightWin && !spotlightWin.isDestroyed()) { closeSearch(); return; }
        try {
            const b = mainWindow.getContentBounds();
            spotlightWin = new BrowserWindow({
                width: 620, height: 460, frame: false, resizable: false, parent: mainWindow,
                x: Math.max(0, b.x + Math.round((b.width - 620) / 2)), y: b.y + 110,
                backgroundColor: '#181a1b',
                webPreferences: { nodeIntegration: true, contextIsolation: false, devTools: devMode },
            });
            spotlightWin.loadFile(path.join(__dirname, 'search', 'search.html'));
            spotlightWin.webContents.on('did-finish-load', () => {
                if (spotlightWin && !spotlightWin.isDestroyed()) spotlightWin.webContents.send('gsearch:shown');
            });
            // esc dismisses — handled in MAIN so it works no matter what the
            // page is doing (the renderer listener alone proved unreliable).
            // the search shortcut itself also toggles the popup closed.
            spotlightWin.webContents.on('before-input-event', (event, input) => {
                if (input.type !== 'keyDown') return;
                if (input.key === 'Escape') { event.preventDefault(); closeSearch(); return; }
                const accel = accelOfInput(input);
                if (accel && accel === getShortcuts().search) { event.preventDefault(); closeSearch(); }
            });
            // spotlight behavior: clicking elsewhere dismisses it
            spotlightWin.on('blur', () => closeSearch());
            spotlightWin.on('closed', () => {
                spotlightWin = null;
                if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('gsearch:state', false);
            });
            if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('gsearch:state', true);
        } catch { spotlightWin = null; }
    };
    ipcMain.on('gsearch:toggle', openSpotlight);
    ipcMain.on('gsearch:close', () => closeSearch());
    ipcMain.handle('gsearch:query', async (_e, req: { text?: string; filter?: string }) => {
        const f = (req?.filter === 't' || req?.filter === 'a' || req?.filter === 'b') ? req.filter : '';
        return bandcampApi.searchPublic(String(req?.text || ''), f as any);
    });

    // fetch fan whole collection (paginated) for custom view; stream running count back so the view can show load progress on big collections
    // with the release cache on, items are persisted so the collection still opens
    // offline, and art urls are swapped to locally cached covers when present.
    const mapCachedArt = (list: any[]): any[] => {
        if (!cacheReleasesOn()) return list;
        return list.map((i) => {
            const local = localArtUrl(i.tralbumType, i.tralbumId);
            return local ? { ...i, art: local } : i;
        });
    };
    const sendCollItems = (added: any[], soFar: number, total: number) => {
        if (collectionView && !collectionView.webContents.isDestroyed()) {
            collectionView.webContents.send('collection:items', { items: mapCachedArt(added), soFar, total });
        }
    };
    // cache-first: with the release cache on, the saved listing loads instantly
    // and the network is only asked for items NEWER than the cache (the
    // fancollection api pages newest-first, so we stop at the first known item).
    // Reload therefore "checks for new ones" instead of re-scanning everything.
    // the wishlist rides along: same api family, items tagged wish:true.
    let collFetchActive = false;
    const fetchCollectionAndWishlist = async (fullRescan = false): Promise<{ ok: boolean; count: number; cached?: boolean; error?: string }> => {
        if (collFetchActive) return { ok: true, count: 0 };
        collFetchActive = true;
        try {
            // local files first: they live on disk, so they show even offline /
            // logged out (total 0 = don't touch the loader's progress accounting)
            const locals = localCollectionItems();
            if (locals.length) sendCollItems(locals, locals.length, 0);
            const cached = (!fullRescan && cacheReleasesOn()) ? collectionItemsDisk.get() : [];
            if (Array.isArray(cached) && cached.length) {
                sendCollItems(cached, cached.length, cached.length);
                try {
                    const knownOwned = new Set<string>(cached.filter((c: any) => !c.wish).map((c: any) => c.tralbumType + c.tralbumId));
                    const knownWish = new Set<string>(cached.filter((c: any) => c.wish).map((c: any) => c.tralbumType + c.tralbumId));
                    const freshOwned = await bandcampApi.fetchCollection(20000, undefined, knownOwned, 'collection');
                    const freshWish = await bandcampApi.fetchCollection(20000, undefined, knownWish, 'wishlist');
                    // an item that got purchased graduates from wishlist to owned
                    const ownedKeys = new Set<string>(freshOwned.map((c) => c.tralbumType + c.tralbumId));
                    const fresh = [...freshOwned, ...freshWish.filter((c) => !ownedKeys.has(c.tralbumType + c.tralbumId))];
                    if (devMode) console.log('[bcrpc] collection:fetch cache=' + cached.length + ' new=' + fresh.length);
                    // owned count DROPPED on bandcamp's side (something was hidden):
                    // schedule a silent full re-scan so the vanished item disappears
                    // here too (runs after this refresh finishes)
                    const ownedTotal = await bandcampApi.fetchOwnedTotal();
                    const ownedHave = [...fresh, ...cached.filter((c: any) => !fresh.some((f) => f.tralbumType + f.tralbumId === c.tralbumType + c.tralbumId))]
                        .filter((c: any) => !c.wish).length;
                    if (ownedTotal > 0 && ownedTotal < ownedHave) {
                        setTimeout(() => { void fetchCollectionAndWishlist(true); }, 1500);
                    }
                    if (fresh.length) {
                        const freshKeys = new Set<string>(fresh.map((c) => c.tralbumType + c.tralbumId));
                        const merged = [...fresh, ...cached.filter((c: any) => !freshKeys.has(c.tralbumType + c.tralbumId))];
                        const total = merged.length;
                        sendCollItems(fresh, total, total);
                        collectionItemsDisk.replace(merged);
                        return { ok: true, count: total };
                    }
                } catch { /* cache alone is fine */ }
                return { ok: true, count: cached.length, cached: true };
            }
            // no cache (or forced rescan): full paginated fetch of both lists
            try {
                const owned = await bandcampApi.fetchCollection(20000, sendCollItems, undefined, 'collection');
                const ownedKeys = new Set<string>(owned.map((c) => c.tralbumType + c.tralbumId));
                const wishRaw = await bandcampApi.fetchCollection(20000, sendCollItems, undefined, 'wishlist');
                const wish = wishRaw.filter((c) => !ownedKeys.has(c.tralbumType + c.tralbumId));
                const items = [...owned, ...wish];
                if (devMode) console.log('[bcrpc] collection:fetch ' + owned.length + ' owned + ' + wish.length + ' wishlist');
                if (items.length) {
                    if (cacheReleasesOn()) collectionItemsDisk.replace(items);
                    // a re-scan is the source of truth: drop anything the view still
                    // shows that bandcamp no longer lists (hidden / un-wishlisted).
                    // local pseudo-items aren't bandcamp's to prune — keep their keys
                    if (collectionView && !collectionView.webContents.isDestroyed()) {
                        collectionView.webContents.send('collection:prune',
                            [...items.map((c) => c.tralbumType + c.tralbumId), ...localCollectionItems().map((c) => c.tralbumType + c.tralbumId)]);
                    }
                    return { ok: true, count: items.length };
                }
            } catch (err: any) {
                if (devMode) console.log('[bcrpc] collection:fetch FAILED ' + (err && (err.message || err)));
            }
            return { ok: false, count: 0, error: 'fetch failed' };
        } finally {
            collFetchActive = false;
        }
    };
    ipcMain.handle('collection:fetch', (_e, fullRescan: unknown) => fetchCollectionAndWishlist(fullRescan === true));
    {
        let collectTimer: ReturnType<typeof setTimeout> | null = null;
        let collectRemoval = false;
        onCollectAction = (removal: boolean) => {
            collectRemoval = collectRemoval || removal;
            if (collectTimer) clearTimeout(collectTimer);
            // small delay so bandcamp finishes committing the change first
            collectTimer = setTimeout(() => {
                const full = collectRemoval;
                collectRemoval = false;
                void fetchCollectionAndWishlist(full);
            }, 3000);
        };
    }

    // resolve a collection item to a full tracklist. a purchased TRACK that's part
    // of an album carries no artist/art of its own, so resolve it through its parent
    // album (which has them) rather than the bare track endpoint.
    const resolveRelease = async (req: { tralbumId: string; tralbumType: TralbumType; bandId: string }): Promise<{ tracks: PlayerTrack[]; activeIndex: number }> => {
        if (isLocalId(req.tralbumId)) return { tracks: localPlayerTracks(String(req.tralbumId)), activeIndex: 0 };
        if (req.tralbumType === 't') {
            const r = await bandcampApi.resolveQueueForTrack(req.tralbumId, req.bandId);
            if (r.tracks.length) return r;
        }
        const tracks = await bandcampApi.fetchTralbum({ tralbumId: req.tralbumId, tralbumType: req.tralbumType === 't' ? 't' : 'a', bandId: req.bandId });
        return { tracks, activeIndex: 0 };
    };

    // play release chosen in custom view: resolve full tracklist & hand to player (bypasses page trap entirely)
    ipcMain.handle('collection:play', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string; activeIndex?: number; trackId?: string; trackOnly?: boolean }) => {
        try {
            const resolved = await resolveRelease(req);
            let tracks = resolved.tracks;
            if (tracks.length && playerView && !playerView.webContents.isDestroyed()) {
                // start at the chosen track (by id, else index) so the whole album
                // becomes the queue with the rest of it queued behind
                let active = typeof req.activeIndex === 'number' ? req.activeIndex : resolved.activeIndex;
                // raw compare too: local track ids ('L…') aren't numeric
                if (req.trackId) { const i = tracks.findIndex((t) => t.id === toIdStr(req.trackId) || t.id === String(req.trackId)); if (i !== -1) active = i; }
                active = Math.max(0, Math.min(active, tracks.length - 1));
                // a single-track purchase plays JUST that track — resolving through
                // the parent album is only for metadata, not to queue the whole thing
                if (req.trackOnly) {
                    tracks = [tracks[active]];
                    active = 0;
                }
                trapSeq++; // supersede any in flight page trap
                playerView.webContents.send('player:stream-incoming', {
                    queue: tracks, activeIndex: active, context: 'collection', format: 'raw',
                });
                return { ok: true };
            }
            return { ok: false, error: 'no tracks' };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'play failed' };
        }
    });

    // fetch a release's tracklist (+ resolved release year) for the collection view
    ipcMain.handle('collection:tracklist', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string }) => {
        try {
            if (isLocalId(req.tralbumId)) {
                // local pseudo-album: everything comes from the library, no network
                const group = localGroups().get(String(req.tralbumId)) || [];
                if (!group.length) return { ok: false, error: 'no tracks' };
                const first = group[0];
                return {
                    ok: true,
                    year: group.map((t) => t.year).find((y) => y) || 0,
                    tags: [...new Set(group.flatMap((t) => t.genre || []))],
                    title: first.album || first.title,
                    artist: first.albumArtist || first.artist,
                    art: localFileUrl((group.find((t) => t.art) || first).art),
                    tracks: group.map((t) => ({ id: t.id, title: t.title, artist: t.artist || t.albumArtist, duration: t.duration || 0 })),
                };
            }
            const k = (req.tralbumType === 't' ? 't' : 'a') + toIdStr(req.tralbumId);
            const idxCache = releaseIndexDisk.get();
            // the live fetch is opportunistic, NOT a requirement: when it fails
            // (offline, api down) the saved index serves the tracklist instead.
            let tracks: PlayerTrack[] = [];
            try { tracks = (await resolveRelease(req)).tracks; } catch { tracks = []; }
            if (devMode) console.log('[bcrpc] collection:tracklist ' + req.tralbumType + req.tralbumId + ' band=' + req.bandId + ' -> ' + tracks.length + ' tracks');
            if (!tracks.length) {
                const cachedEntry = idxCache[k] || sessionDetails.get(k);
                if (cachedEntry && (cachedEntry.t || []).length) {
                    const y = cachedEntry.y || yearsDisk.get()[req.tralbumType + ':' + req.tralbumId] || 0;
                    return {
                        ok: true, cached: true, year: y, tags: cachedEntry.g || [],
                        title: '', artist: '', art: '',
                        tracks: (cachedEntry.t || []).map(([title, duration]) => ({ id: '', title, artist: '', duration: duration || 0 })),
                    };
                }
                return { ok: false, error: 'no tracks' };
            }
            let year = 0;
            try { year = bandcampApi.getReleaseYear(req.tralbumType, req.tralbumId) || await bandcampApi.fetchReleaseYear(req); } catch { year = 0; }
            if (year) persistYear(req.tralbumType, req.tralbumId, year);
            // genre tags for the panel: from the release index when it has them
            // (a collection item's fetch here also fills the persistent cache)
            let tags: string[] = idxCache[k]?.g || sessionDetails.get(k)?.g || [];
            if (!tags.length && !idxCache[k] && !sessionDetails.get(k)) {
                // tags are decoration — their fetch failing must not sink the panel
                let d: Awaited<ReturnType<typeof bandcampApi.fetchSearchIndex>> | null = null;
                try { d = await bandcampApi.fetchSearchIndex({ tralbumId: req.tralbumId, tralbumType: req.tralbumType === 't' ? 't' : 'a', bandId: req.bandId }, true); } catch { d = null; }
                if (d && d.ok) {
                    tags = d.tags;
                    const entry: IndexCacheEntry = { g: d.tags, t: d.tracks.map((t) => [t.title, t.duration] as [string, number]), y: d.year };
                    if (d.about) entry.a = d.about;
                    if (collectionKeys.has(k)) { idxCache[k] = entry; releaseIndexDisk.save(); }
                    else sessionDetails.set(k, entry);
                }
            } else if (req.tralbumType !== 't') {
                // opening an album re-confirms the saved index against the freshly
                // resolved tracklist: renamed/added/removed songs heal the stored
                // entry (and the view's search index) instead of lingering stale.
                // 't' requests resolve through the PARENT album, so their per-track
                // index entries are left alone.
                const entry = idxCache[k] || sessionDetails.get(k);
                if (entry) {
                    const fresh = tracks.map((t) => [t.title, t.duration] as [string, number]);
                    const drifted = JSON.stringify(entry.t || []) !== JSON.stringify(fresh) || (year > 0 && entry.y !== year);
                    if (drifted) {
                        entry.t = fresh;
                        if (year > 0) entry.y = year;
                        if (idxCache[k]) releaseIndexDisk.save();
                        if (collectionView && !collectionView.webContents.isDestroyed()) {
                            collectionView.webContents.send('collection:index', [indexRowOf(k, entry)]);
                        }
                        if (devMode) console.log('[bcrpc] index re-confirmed (drift healed) ' + k);
                    }
                }
            }
            const first = tracks[0];
            return {
                ok: true, year, tags,
                title: (first.album || first.title || '').toString(),
                artist: first.artist, art: first.art,
                tracks: tracks.map((t) => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration })),
            };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'tracklist failed' };
        }
    });

    // fill in real release years for the collection (bandcamp's collection api omits
    // them). cached to disk so it's a one-time cost. streams results back as they land.
    ipcMain.on('collection:enrich-years', async (_e, reqs: { tralbumId: string; tralbumType: TralbumType; bandId: string }[]) => {
        if (!Array.isArray(reqs) || !reqs.length) return;
        reqs = reqs.filter((r) => !isLocalId(r.tralbumId)); // local years come from tags, never the network
        if (!reqs.length) return;
        const store2 = yearsDisk.get();
        const send = (updates: { tralbumId: string; year: number }[]) => {
            if (updates.length && collectionView && !collectionView.webContents.isDestroyed()) {
                collectionView.webContents.send('collection:years', updates);
            }
        };
        const cached: { tralbumId: string; year: number }[] = [];
        const todo: typeof reqs = [];
        for (const r of reqs) {
            const k = r.tralbumType + ':' + r.tralbumId;
            // only treat a real (non-zero) year as cached; 0 usually means a prior
            // fetch was throttled, so retry those rather than caching the failure
            if (store2[k]) { cached.push({ tralbumId: r.tralbumId, year: store2[k] }); bandcampApi.primeYear(r.tralbumType, r.tralbumId, store2[k]); }
            else todo.push(r);
        }
        send(cached);
        let idx = 0;
        const pending: { tralbumId: string; year: number }[] = [];
        const worker = async () => {
            while (idx < todo.length) {
                const r = todo[idx++];
                let y = 0;
                try { y = await bandcampApi.fetchReleaseYear(r); } catch { /* skip */ }
                if (y) { store2[r.tralbumType + ':' + r.tralbumId] = y; pending.push({ tralbumId: r.tralbumId, year: y }); }
                if (pending.length >= 25) { send(pending.splice(0)); yearsDisk.save(); }
            }
        };
        await Promise.all([worker(), worker(), worker()]); // modest concurrency to avoid 429s
        send(pending.splice(0));
        yearsDisk.save();
        if (collectionView && !collectionView.webContents.isDestroyed()) collectionView.webContents.send('collection:years-done');
    });

    // build the collection's release index (genre tags + tracklist per item) so
    // search can match tags/track names & the list view can show every track.
    // cached to disk so the tralbum fetches are a one-time cost; the same payload
    // primes the year cache for free.
    //
    // pacing: bandcamp throttles bursts of tralbum reads hard (the previous
    // 3-worker/no-delay version wedged at ~50 items of a 2300-item collection on
    // 429s). requests are now strictly serialized with a delay between releases,
    // 429s exponentially back off, and a run aborts after repeated hard failures —
    // the cache resumes where it left off on the next reload/launch.
    interface IndexRow { key: string; blob: string; tags: string[]; tracks: [string, number][] }
    type IndexCacheEntry = { g: string[]; t: [string, number][]; y: number; a?: string };
    const indexRowOf = (k: string, c: IndexCacheEntry): IndexRow => ({
        key: k,
        blob: ((c.g || []).join(' ') + ' ' + (c.t || []).map((x) => x[0]).join(' ')).toLowerCase().replace(/\s+/g, ' ').trim(),
        tags: c.g || [],
        tracks: c.t || [],
    });
    let indexRunActive = false;
    // keys of releases actually in the user's collection: the ONLY ones whose
    // details are persisted to disk (feed items etc. stay session-only).
    const collectionKeys = new Set<string>();
    // last request list (with art urls) so enabling the release cache in settings
    // can kick off a cover mirror pass without waiting for the next index run
    let lastIndexReqs: { tralbumId: string; tralbumType: TralbumType; bandId: string; art?: string }[] = [];
    const idxAlive = () => collectionView && !collectionView.webContents.isDestroyed();
    const idxSleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const sendIndexStatus = (text: string) => { if (idxAlive()) collectionView.webContents.send('collection:index-status', text); };

    // mirror covers to disk (cdn fetches, light pacing). runs over all items so an
    // index built before the setting was enabled still gets its covers.
    let artPassActive = false;
    const mirrorArt = async (reqs: typeof lastIndexReqs) => {
        if (artPassActive || !cacheReleasesOn()) return;
        artPassActive = true;
        try {
            for (const r of reqs) {
                if (!idxAlive()) break;
                const art = String(r.art || '');
                if (!art.startsWith('https://')) continue;
                const ap = artCachePath(r.tralbumType, r.tralbumId);
                if (fs.existsSync(ap)) continue;
                const buf = await bandcampApi.fetchBinary(art);
                if (buf && buf.length) { try { fs.writeFileSync(ap, buf); } catch { /* disk */ } }
                await idxSleep(60);
            }
        } finally {
            artPassActive = false;
        }
    };

    ipcMain.on('collection:enrich-index', async (_e, reqs: { tralbumId: string; tralbumType: TralbumType; bandId: string; art?: string }[]) => {
        if (!Array.isArray(reqs) || !reqs.length || indexRunActive) return;
        indexRunActive = true;
        const send = (rows: IndexRow[]) => { if (rows.length && idxAlive()) collectionView.webContents.send('collection:index', rows); };
        // local pseudo-albums index instantly from the library (no crawling, and
        // they must never reach the bandcamp id paths below) — search & list view
        // get their tracks/genres the same way as crawled releases
        const localReqs = reqs.filter((r) => isLocalId(r.tralbumId));
        reqs = reqs.filter((r) => !isLocalId(r.tralbumId));
        if (localReqs.length) {
            const groups = localGroups();
            const rows: IndexRow[] = [];
            for (const r of localReqs) {
                const g = groups.get(String(r.tralbumId));
                if (!g || !g.length) continue;
                const first = g[0];
                const tags = [...new Set(g.flatMap((t) => t.genre || []))];
                rows.push({
                    key: r.tralbumType + String(r.tralbumId),
                    blob: [first.albumArtist, first.album, ...g.map((t) => t.artist + ' ' + t.title), tags.join(' ')].join(' ').toLowerCase(),
                    tags,
                    tracks: g.map((t) => [t.title, t.duration || 0] as [string, number]),
                });
            }
            send(rows);
        }
        if (!reqs.length) {
            if (idxAlive()) collectionView.webContents.send('collection:index-done');
            indexRunActive = false;
            return;
        }
        const cache = releaseIndexDisk.get();
        // the request list IS the collection: remember it & evict anything else
        // that leaked into the persistent cache (e.g. feed items opened earlier)
        collectionKeys.clear();
        for (const r of reqs) collectionKeys.add(r.tralbumType + toIdStr(r.tralbumId));
        for (const k of Object.keys(cache)) { if (!collectionKeys.has(k)) delete cache[k]; }
        lastIndexReqs = reqs;

        const cached: IndexRow[] = [];
        const todo: typeof reqs = [];
        for (const r of reqs) {
            const k = r.tralbumType + toIdStr(r.tralbumId);
            if (cache[k]) cached.push(indexRowOf(k, cache[k]));
            else todo.push(r);
        }
        send(cached);
        // covers mirror concurrently (light cdn fetches) — previously this waited
        // for the whole metadata crawl, so covers never cached on big collections
        void mirrorArt(reqs);

        // rest for a while, streaming a countdown into the toolbar indicator
        const rest = async (seconds: number, why: string) => {
            for (let left = seconds; left > 0 && idxAlive(); left -= 5) {
                sendIndexStatus(`${why}, resuming in ${left}s`);
                await idxSleep(Math.min(5, left) * 1000);
            }
            sendIndexStatus('');
        };

        // pacing: bandcamp's throttle punishes sustained crawls, not just bursts.
        // work in chunks of 500 releases with a long rest between chunks, and when
        // repeatedly 429'd mid-chunk take an immediate long rest instead of giving
        // up (the old behavior stranded big collections partly indexed).
        const CHUNK = 500;
        const CHUNK_REST_S = 60;
        const THROTTLE_REST_S = 120;
        const MAX_RESTS = 30;
        const pending: IndexRow[] = [];
        let hardFails = 0;
        let doneInChunk = 0;
        let rests = 0;
        try {
            for (const r of todo) {
                if (!idxAlive()) break;
                // yield to user actions: an interactive fetch (tracklist click, feed
                // page…) parks the crawl briefly so it never steals the 429 budget
                while (bandcampApi.interactiveIdleMs() < 4000) await idxSleep(1500);
                let info: { tags: string[]; tracks: { title: string; duration: number }[]; year: number; about: string } | null = null;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const res = await bandcampApi.fetchSearchIndex(r);
                    if (res.ok) { info = res; break; }
                    if (!res.retryable) break;
                    await idxSleep(1500 * Math.pow(2, attempt)); // 429: back off & retry
                }
                if (info) {
                    hardFails = 0;
                    const k = r.tralbumType + toIdStr(r.tralbumId);
                    cache[k] = { g: info.tags, t: info.tracks.map((t) => [t.title, t.duration] as [string, number]), y: info.year };
                    if (info.about) cache[k].a = info.about;
                    if (info.year) persistYear(r.tralbumType, r.tralbumId, info.year);
                    pending.push(indexRowOf(k, cache[k]));
                    if (pending.length >= 10) { send(pending.splice(0)); releaseIndexDisk.save(); }
                    doneInChunk++;
                } else if (++hardFails >= 8) {
                    // persistently throttled: take a long rest & carry on
                    if (++rests > MAX_RESTS) { if (devMode) console.log('[bcrpc] enrich-index giving up for this session'); break; }
                    hardFails = 0;
                    send(pending.splice(0));
                    releaseIndexDisk.save();
                    await rest(THROTTLE_REST_S, 'throttled (429)');
                    continue;
                }
                if (doneInChunk >= CHUNK) {
                    doneInChunk = 0;
                    if (++rests > MAX_RESTS) break;
                    send(pending.splice(0));
                    releaseIndexDisk.save();
                    await rest(CHUNK_REST_S, 'chunk done');
                }
                // adaptive pacing: an idle user's budget goes to the crawl (fast,
                // the 429 backoff is the brake); an actively browsing user keeps
                // the budget & the crawl slows right down
                const idleMs = bandcampApi.interactiveIdleMs();
                await idxSleep(idleMs > 120_000 ? 200 : idleMs > 30_000 ? 600 : 1500);
            }
        } finally {
            send(pending.splice(0));
            releaseIndexDisk.save();
            sendIndexStatus('');
            if (idxAlive()) collectionView.webContents.send('collection:index-done');
            indexRunActive = false;
        }
    });

    // release details (tags / tracklist / about) for the feed's expanded cards &
    // anything else that wants them. collection releases are served from / added
    // to the persistent index cache; anything else (feed items…) lives in a
    // session-only cache so nothing outside the collection is written to disk.
    const sessionDetails = new Map<string, IndexCacheEntry>();
    ipcMain.handle('release:details', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string }) => {
        const type: TralbumType = req.tralbumType === 't' ? 't' : 'a';
        const k = type + toIdStr(req.tralbumId);
        const cache = releaseIndexDisk.get();
        let c = cache[k] || sessionDetails.get(k);
        if (!c) {
            // interactive: user is looking at the panel right now (crawler yields)
            const res = await bandcampApi.fetchSearchIndex({ tralbumId: req.tralbumId, tralbumType: type, bandId: req.bandId }, true);
            if (res.ok) {
                c = { g: res.tags, t: res.tracks.map((t) => [t.title, t.duration] as [string, number]), y: res.year };
                if (res.about) c.a = res.about;
                if (collectionKeys.has(k)) {
                    cache[k] = c;
                    releaseIndexDisk.save();
                    if (res.year) persistYear(type, req.tralbumId, res.year);
                } else {
                    sessionDetails.set(k, c);
                }
            }
        }
        if (!c) return { ok: false };
        return { ok: true, tags: c.g || [], tracks: c.t || [], about: c.a || '', year: c.y || 0 };
    });

    // add a release chosen in the custom collection view to the queue (no interrupt).
    // with trackId (or trackIndex, e.g. from the list view whose rows carry no ids)
    // set, queue only that one song from the release's tracklist.
    ipcMain.handle('collection:enqueue', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string; trackId?: string; trackIndex?: number }) => {
        try {
            const resolved = await resolveRelease(req);
            // for a purchased single track, queue just that track (not the whole album)
            let tracks = req.tralbumType === 't' && resolved.tracks[resolved.activeIndex]
                ? [resolved.tracks[resolved.activeIndex]]
                : resolved.tracks;
            if (req.trackId) {
                const one = resolved.tracks.find((t) => t.id === toIdStr(req.trackId) || t.id === String(req.trackId));
                if (!one) return { ok: false, error: 'track not found' };
                tracks = [one];
            } else if (typeof req.trackIndex === 'number' && req.trackIndex >= 0) {
                const one = resolved.tracks[req.trackIndex];
                if (!one) return { ok: false, error: 'track not found' };
                tracks = [one];
            }
            if (tracks.length && playerView && !playerView.webContents.isDestroyed()) {
                playerView.webContents.send('player:enqueue', { tracks });
                return { ok: true, count: tracks.length };
            }
            return { ok: false, error: 'no tracks' };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'enqueue failed' };
        }
    });

    // --- custom playlists (built from the collection view) ---------------------
    const playlistById = (id: unknown): PlaylistT | undefined =>
        playlistsDisk.get().find((p) => p && p.id === String(id || ''));
    const playlistSummaries = () => playlistsDisk.get().map((p) => ({
        id: p.id, name: p.name, createdAt: p.createdAt, count: p.entries.length,
        arts: [...new Set(p.entries.map((e) => e.art).filter(Boolean))].slice(0, 4),
        duration: p.entries.reduce((s, e) => s + (e.duration || 0), 0),
        desc: p.desc || '',
        cover: p.cover ? localFileUrl(p.cover) : '',
    }));
    ipcMain.handle('playlists:all', () => ({ ok: true, playlists: playlistSummaries() }));
    ipcMain.handle('playlists:get', (_e, id: unknown) => {
        const p = playlistById(id);
        return p ? { ok: true, playlist: { ...p, coverUrl: p.cover ? localFileUrl(p.cover) : '' } } : { ok: false, error: 'not found' };
    });
    ipcMain.handle('playlists:create', (_e, name: unknown) => {
        const n = String(name || '').trim().slice(0, 100);
        if (!n) return { ok: false, error: 'empty name' };
        const p: PlaylistT = {
            id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: n, createdAt: Date.now(), entries: [],
        };
        playlistsDisk.get().push(p);
        playlistsDisk.save();
        return { ok: true, id: p.id };
    });
    ipcMain.handle('playlists:rename', (_e, req: { id: string; name: string }) => {
        const p = playlistById(req?.id);
        const n = String(req?.name || '').trim().slice(0, 100);
        if (!p || !n) return { ok: false };
        p.name = n;
        playlistsDisk.save();
        return { ok: true };
    });
    ipcMain.handle('playlists:delete', (_e, id: unknown) => {
        const all = playlistsDisk.get();
        const i = all.findIndex((p) => p && p.id === String(id || ''));
        if (i === -1) return { ok: false };
        all.splice(i, 1);
        playlistsDisk.save();
        return { ok: true };
    });
    // add a whole release (every track) or one song (trackId / trackIndex) to a
    // playlist. resolution goes through the same path as the tracklist panel, so
    // anything playable from the collection — owned or wishlisted — can be added.
    ipcMain.handle('playlists:add', async (_e, req: { id: string; tralbumId: string; tralbumType: TralbumType; bandId: string; trackId?: string; trackIndex?: number }) => {
        try {
            const p = playlistById(req?.id);
            if (!p) return { ok: false, error: 'no such playlist' };
            const resolved = await resolveRelease(req);
            // a purchased single track adds just itself, not its parent album
            let tracks = req.tralbumType === 't' && resolved.tracks[resolved.activeIndex]
                ? [resolved.tracks[resolved.activeIndex]]
                : resolved.tracks;
            if (req.trackId) {
                const one = resolved.tracks.find((t) => t.id === toIdStr(req.trackId) || t.id === String(req.trackId));
                if (!one) return { ok: false, error: 'track not found' };
                tracks = [one];
            } else if (typeof req.trackIndex === 'number' && req.trackIndex >= 0) {
                const one = resolved.tracks[req.trackIndex];
                if (!one) return { ok: false, error: 'track not found' };
                tracks = [one];
            }
            if (!tracks.length) return { ok: false, error: 'no tracks' };
            const have = new Set(p.entries.map((en) => en.tralbumType + en.tralbumId + ':' + en.id));
            let added = 0;
            for (const t of tracks) {
                if (have.has(t.tralbumType + t.tralbumId + ':' + t.id)) continue; // already on it
                p.entries.push({
                    id: t.id, title: t.title, artist: t.artist, album: t.album, art: t.art,
                    duration: t.duration || 0, url: t.url,
                    bandId: t.bandId, tralbumId: t.tralbumId, tralbumType: t.tralbumType,
                });
                added++;
            }
            if (added) playlistsDisk.save();
            return { ok: true, added, count: p.entries.length };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'add failed' };
        }
    });
    ipcMain.handle('playlists:remove', (_e, req: { id: string; index: number }) => {
        const p = playlistById(req?.id);
        if (!p || !Number.isInteger(req?.index) || req.index < 0 || req.index >= p.entries.length) return { ok: false };
        p.entries.splice(req.index, 1);
        playlistsDisk.save();
        return { ok: true, count: p.entries.length };
    });
    ipcMain.handle('playlists:move', (_e, req: { id: string; from: number; to: number }) => {
        const p = playlistById(req?.id);
        const n = p ? p.entries.length : 0;
        const from = Number(req?.from), to = Number(req?.to);
        if (!p || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= n || to < 0 || to >= n) return { ok: false };
        const [en] = p.entries.splice(from, 1);
        p.entries.splice(to, 0, en);
        playlistsDisk.save();
        return { ok: true };
    });
    const playlistQueue = (p: PlaylistT): PlayerTrack[] => p.entries.map((e) => {
        // local entries point straight at the file; bandcamp streams resolve lazily
        const lt = isLocalId(e.tralbumId) ? localTrackById(e.id) : undefined;
        return {
            id: e.id, title: e.title, artist: e.artist, album: e.album, art: e.art,
            src: lt ? localFileUrl(lt.file) : '', duration: e.duration || 0, url: e.url,
            bandId: e.bandId, tralbumId: e.tralbumId, tralbumType: e.tralbumType,
        };
    });
    ipcMain.handle('playlists:play', (_e, req: { id: string; startIndex?: number }) => {
        const p = playlistById(req?.id);
        if (!p || !p.entries.length) return { ok: false, error: 'empty playlist' };
        if (!playerView || playerView.webContents.isDestroyed()) return { ok: false, error: 'no player' };
        const queue = playlistQueue(p);
        const active = Math.max(0, Math.min(typeof req.startIndex === 'number' ? req.startIndex : 0, queue.length - 1));
        trapSeq++; // supersede any in-flight page trap
        playerView.webContents.send('player:stream-incoming', { queue, activeIndex: active, context: 'playlist', format: 'raw' });
        return { ok: true, count: queue.length };
    });
    ipcMain.handle('playlists:enqueue', (_e, id: unknown) => {
        const p = playlistById(id);
        if (!p || !p.entries.length) return { ok: false, error: 'empty playlist' };
        if (!playerView || playerView.webContents.isDestroyed()) return { ok: false, error: 'no player' };
        playerView.webContents.send('player:enqueue', { tracks: playlistQueue(p) });
        return { ok: true, count: p.entries.length };
    });
    ipcMain.handle('playlists:set-desc', (_e, req: { id: string; desc: string }) => {
        const p = playlistById(req?.id);
        if (!p) return { ok: false };
        p.desc = String(req?.desc || '').slice(0, 2000);
        playlistsDisk.save();
        return { ok: true };
    });
    // custom cover: picked from disk, normalized to png immediately (that's also
    // exactly what the download writes out as playlist-cover.png)
    ipcMain.handle('playlists:cover-pick', async (_e, id: unknown) => {
        const p = playlistById(id);
        if (!p) return { ok: false };
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Choose a playlist cover',
            properties: ['openFile'],
            filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
        });
        if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
        try {
            const img = nativeImage.createFromPath(res.filePaths[0]);
            if (img.isEmpty()) return { ok: false, error: 'could not read that image' };
            const coversDir = path.join(app.getPath('userData'), 'playlist-covers');
            fs.mkdirSync(coversDir, { recursive: true });
            const w = img.getSize().width || 1024;
            const file = path.join(coversDir, p.id + '.png');
            fs.writeFileSync(file, (w > 1024 ? img.resize({ width: 1024 }) : img).toPNG());
            p.cover = file;
            playlistsDisk.save();
            return { ok: true, cover: localFileUrl(file) };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'cover failed' };
        }
    });
    ipcMain.handle('playlists:cover-clear', (_e, id: unknown) => {
        const p = playlistById(id);
        if (!p) return { ok: false };
        if (p.cover) { try { fs.unlinkSync(p.cover); } catch { /* gone */ } }
        delete p.cover;
        playlistsDisk.save();
        return { ok: true };
    });
    // download a whole playlist into <downloads>/<playlist name>/: the tracks in
    // playlist order (streams tagged like release downloads, local files copied
    // as-is), playlist-cover.png, description.txt (description + explicit track
    // order) and the order file in the configured playlist format (m3u default).
    ipcMain.handle('playlists:download', (_e, id: unknown) => {
        const p = playlistById(id);
        if (!p || !p.entries.length) return { ok: false, error: 'empty playlist' };
        if (streamDlActive) return { ok: false, error: 'a download is already running' };
        streamDlActive = true;
        openDownloadsPanel();
        const entryId = ++dlSeq;
        const dlState = { canceled: false };
        streamDownloads.set(entryId, dlState);
        const entry: DlEntry = { id: entryId, name: `Playlist — ${p.name}`, state: 'progressing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
        dlRegistry.unshift(entry);
        const prog = (state: string, percent: number) => {
            entry.state = state;
            entry.percent = Math.max(0, percent);
            broadcastDownloads();
        };
        void (async () => {
            try {
                const fileFmt = store.get('fileNameFmt', '{tracknum} {artist} - {title}') as string;
                const modifyTags = store.get('modifyTags', true) !== false;
                const tagOn = (k: string) => store.get(k, true) !== false;
                const coverInTags = tagOn('coverInTags');
                const dir = path.join(getDownloadDir(), sanitizeName(p.name) || 'playlist');
                fs.mkdirSync(dir, { recursive: true });
                entry.file = dir;

                // playlist-cover.png: the custom cover, else the first entry's art
                let coverPng: Buffer | null = null;
                if (p.cover && fs.existsSync(p.cover)) coverPng = fs.readFileSync(p.cover);
                else {
                    const webArt = p.entries.find((e) => (e.art || '').startsWith('https://'));
                    if (webArt) {
                        const buf = await bandcampApi.fetchBinary(webArt.art);
                        if (buf && buf.length) {
                            const img = nativeImage.createFromBuffer(buf);
                            if (!img.isEmpty()) coverPng = img.toPNG();
                        }
                    } else {
                        const localArt = p.entries.map((e) => localTrackById(e.id)).find((t) => t && t.art && fs.existsSync(t.art));
                        if (localArt) {
                            const img = nativeImage.createFromPath(localArt.art);
                            if (!img.isEmpty()) coverPng = img.toPNG();
                        }
                    }
                }
                if (coverPng) { try { fs.writeFileSync(path.join(dir, 'playlist-cover.png'), coverPng); } catch { /* disk */ } }

                // description.txt: name, the description, and the explicit order
                const orderLines = p.entries.map((e, i) => `${String(i + 1).padStart(2, '0')}. ${e.artist} - ${e.title}`);
                const descTxt = p.name + '\n' + '='.repeat(Math.max(4, Math.min(60, p.name.length))) + '\n\n' +
                    (p.desc ? p.desc + '\n\n' : '') + 'Track order:\n' + orderLines.join('\n') + '\n';
                try { fs.writeFileSync(path.join(dir, 'description.txt'), descTxt, 'utf8'); } catch { /* disk */ }

                const artCache = new Map<string, Buffer | null>();
                const files: { file: string; title: string; artist: string; duration: number }[] = [];
                for (let i = 0; i < p.entries.length; i++) {
                    if (dlState.canceled) {
                        prog('cancelled', Math.round((i / p.entries.length) * 100));
                        break;
                    }
                    const e = p.entries[i];
                    const pos = i + 1;
                    entry.name = `${p.name} — ${e.title} (${pos}/${p.entries.length})`;
                    prog('progressing', Math.round((i / p.entries.length) * 100));
                    const nameOf = (extension: string) => {
                        let name = (fileFmt || '{tracknum} {artist} - {title}')
                            .replace(/\{albumartist\}/gi, sanitizeName(e.artist))
                            .replace(/\{artist\}/gi, sanitizeName(e.artist))
                            .replace(/\{album\}/gi, sanitizeName(e.album || p.name))
                            .replace(/\{title\}/gi, sanitizeName(e.title))
                            .replace(/\{year\}/gi, '')
                            .replace(/\{tracknum\}/gi, String(pos).padStart(2, '0'));
                        if (!name.toLowerCase().endsWith(extension)) name += extension;
                        return name;
                    };
                    try {
                        const lt = isLocalId(e.tralbumId) ? localTrackById(e.id) : undefined;
                        if (lt) {
                            // local file: copied as-is — we never rewrite user files
                            if (!fs.existsSync(lt.file)) continue;
                            const file = path.join(dir, nameOf(path.extname(lt.file).toLowerCase() || '.mp3'));
                            fs.copyFileSync(lt.file, file);
                            files.push({ file, title: e.title, artist: e.artist, duration: e.duration || 0 });
                            continue;
                        }
                        const track = await bandcampApi.resolveStream({ bandId: e.bandId, tralbumId: e.tralbumId, tralbumType: e.tralbumType, trackId: e.id });
                        if (!track || !track.src) continue;
                        const t0 = Date.now();
                        const buf = await bandcampApi.fetchBinary(track.src);
                        const dt = (Date.now() - t0) / 1000;
                        if (!buf || !buf.length) continue;
                        if (dt > 0) { entry.speed = buf.length / dt; entry.receivedBytes += buf.length; }
                        let art: Buffer | null = null;
                        if (coverInTags && (e.art || '').startsWith('https://')) {
                            if (!artCache.has(e.art)) artCache.set(e.art, await bandcampApi.fetchBinary(e.art));
                            art = artCache.get(e.art) || null;
                        }
                        const file = path.join(dir, nameOf('.mp3'));
                        if (modifyTags) {
                            const tag = buildId3v23({
                                title: tagOn('tagTitle') ? e.title : '',
                                artist: tagOn('tagArtist') ? e.artist : '',
                                albumArtist: tagOn('tagAlbumArtist') ? e.artist : '',
                                album: tagOn('tagAlbum') ? (e.album || p.name) : '',
                                trackNum: tagOn('tagTrackNum') ? pos : 0,
                                trackTotal: tagOn('tagTrackNum') ? p.entries.length : undefined,
                                year: 0,
                                lyrics: '',
                                art: art || undefined,
                            });
                            fs.writeFileSync(file, Buffer.concat([tag, buf]));
                        } else {
                            fs.writeFileSync(file, buf);
                        }
                        files.push({ file, title: e.title, artist: e.artist, duration: e.duration || track.duration || 0 });
                        await new Promise((res) => setTimeout(res, 250)); // gentle on the cdn
                    } catch { /* skip this entry, carry on */ }
                }

                if (!dlState.canceled) {
                    writePlaylistFile(dir, sanitizeName(p.name), p.name, files);
                    entry.name = `${p.name} (${files.length}/${p.entries.length} tracks)`;
                    prog(files.length ? 'completed' : 'interrupted', 100);
                }
            } catch (err: any) {
                if (devMode) console.log('[bcrpc] playlist download FAILED ' + (err && (err.message || err)));
                prog('interrupted', 0);
            } finally {
                streamDownloads.delete(entryId);
                streamDlActive = false;
                entry.speed = 0;
                broadcastDownloads();
            }
        })();
        return { ok: true, count: p.entries.length };
    });

    // --- local files library ----------------------------------------------------
    // "add files from your pc to your collection": files are parsed ONCE (tags,
    // duration, embedded art) into the on-disk library index and appear as
    // pseudo-releases in the collection view. playback goes straight to the file.
    const announceLocal = () => {
        const locals = localCollectionItems();
        if (locals.length && collectionView && !collectionView.webContents.isDestroyed()) {
            collectionView.webContents.send('collection:items', { items: locals, soFar: locals.length, total: 0 });
        }
    };
    // shared by the "+ Files" picker and the music-folder scan. parsing is
    // synchronous fs work, so yield the event loop every few files — a big
    // import must never freeze the main process (the electron-store lesson).
    const localArtDir = path.join(app.getPath('userData'), 'local-art');
    const importLocalFiles = async (paths: string[], skipUnchanged: boolean): Promise<{ added: number; updated: number; skipped: number }> => {
        const lib = localFilesDisk.get();
        const byId = new Map(lib.map((t, i) => [t.id, i]));
        let added = 0, updated = 0, skipped = 0, sinceYield = 0;
        for (const file of paths) {
            try {
                if (!AUDIO_EXTENSIONS.includes(path.extname(file).toLowerCase())) continue;
                const id = 'L' + crypto.createHash('md5').update(file).digest('hex').slice(0, 16);
                const existing = byId.get(id);
                let mtime = 0;
                try { mtime = Math.floor(fs.statSync(file).mtimeMs); } catch { /* keep 0 */ }
                if (skipUnchanged && existing !== undefined && mtime && lib[existing].mtime === mtime) { skipped++; continue; }
                const tags = readLocalTags(file);
                let artPath = '';
                if (tags.art && tags.art.length) {
                    try {
                        fs.mkdirSync(localArtDir, { recursive: true });
                        artPath = path.join(localArtDir, id + '.jpg');
                        fs.writeFileSync(artPath, tags.art);
                    } catch { artPath = ''; }
                }
                const entry: LocalTrackT = {
                    id, file,
                    title: tags.title,
                    artist: tags.artist || tags.albumArtist,
                    album: tags.album,
                    albumArtist: tags.albumArtist || tags.artist,
                    year: tags.year, trackNum: tags.trackNum, genre: tags.genre,
                    duration: tags.duration, art: artPath, mtime,
                    addedAt: existing !== undefined ? lib[existing].addedAt : Date.now(),
                };
                if (existing !== undefined) { lib[existing] = entry; updated++; }
                else { byId.set(id, lib.length); lib.push(entry); added++; }
                if (++sinceYield >= 10) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
            } catch { /* unreadable file: skip it */ }
        }
        if (added || updated) localFilesDisk.save();
        return { added, updated, skipped };
    };
    ipcMain.handle('library:add', async () => {
        const res = await dialog.showOpenDialog(mainWindow, {
            title: 'Add audio files to your collection',
            properties: ['openFile', 'multiSelections'],
            filters: [
                { name: 'Audio', extensions: AUDIO_EXTENSIONS.map((e) => e.slice(1)) },
                { name: 'All files', extensions: ['*'] },
            ],
        });
        if (res.canceled || !res.filePaths.length) return { ok: true, added: 0, canceled: true };
        const r = await importLocalFiles(res.filePaths, false);
        if (r.added || r.updated) announceLocal();
        if (devMode) console.log('[bcrpc] library:add +' + r.added + ' ~' + r.updated);
        return { ok: true, added: r.added, updated: r.updated };
    });
    // music-folder scan: OPT-IN (off until enabled in settings). walks the chosen
    // folder, imports new/changed audio files, and drops library entries whose
    // files vanished from the folder. runs at startup, when enabled, after
    // picking a folder, and via the settings "Scan now" button.
    let musicScanActive = false;
    const scanMusicFolder = async (): Promise<{ ok: boolean; scanned?: number; added?: number; updated?: number; removed?: number; error?: string }> => {
        if (store.get('musicFolderScan', false) !== true) return { ok: false, error: 'scanning is disabled' };
        const dir = String(store.get('musicFolder', '') || '');
        if (!dir) return { ok: false, error: 'no music folder selected' };
        if (!fs.existsSync(dir)) return { ok: false, error: 'music folder does not exist' };
        if (musicScanActive) return { ok: false, error: 'a scan is already running' };
        musicScanActive = true;
        try {
            const beforeKeys = new Set(localGroups().keys());
            const found: string[] = [];
            const walk = (d: string, depth: number): void => {
                if (depth > 12 || found.length >= 50000) return;
                let entries: fs.Dirent[] = [];
                try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
                for (const e of entries) {
                    if (e.name.startsWith('.')) continue;
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) walk(p, depth + 1);
                    else if (e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) found.push(p);
                }
            };
            walk(dir, 0);
            const r = await importLocalFiles(found, true);
            // files gone from the folder leave the library (their audio was the
            // folder's; manual imports from elsewhere are never touched)
            const foundSet = new Set(found);
            const norm = dir.endsWith(path.sep) ? dir : dir + path.sep;
            const lib = localFilesDisk.get();
            const keep = lib.filter((t) => !(t.file.startsWith(norm) && !foundSet.has(t.file) && !fs.existsSync(t.file)));
            const removed = lib.length - keep.length;
            if (removed) {
                const keepSet = new Set(keep.map((t) => t.id));
                for (const t of lib) {
                    if (!keepSet.has(t.id) && t.art) { try { fs.unlinkSync(t.art); } catch { /* gone */ } }
                }
                localFilesDisk.replace(keep);
            }
            // tell the view about albums that disappeared, then upsert the rest
            const afterKeys = new Set(localGroups().keys());
            const gone = [...beforeKeys].filter((k) => !afterKeys.has(k));
            if (gone.length && collectionView && !collectionView.webContents.isDestroyed()) {
                collectionView.webContents.send('collection:remove-keys', gone.map((k) => 'a' + k));
            }
            if (r.added || r.updated || removed) announceLocal();
            if (devMode) console.log(`[bcrpc] music scan: ${found.length} files, +${r.added} ~${r.updated} -${removed} (${r.skipped} unchanged)`);
            return { ok: true, scanned: found.length, added: r.added, updated: r.updated, removed };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'scan failed' };
        } finally {
            musicScanActive = false;
        }
    };
    ipcMain.handle('library:scan', () => scanMusicFolder());
    ipcMain.handle('library:remove', (_e, albumKey: unknown) => {
        if (!isLocalId(albumKey)) return { ok: false };
        const want = String(albumKey);
        const lib = localFilesDisk.get();
        const keep = lib.filter((t) => localAlbumKey(t) !== want);
        const removed = lib.length - keep.length;
        if (!removed) return { ok: false };
        // library entries and their cached art go; the audio files themselves stay
        for (const t of lib) {
            if (localAlbumKey(t) === want && t.art) { try { fs.unlinkSync(t.art); } catch { /* gone */ } }
        }
        localFilesDisk.replace(keep);
        if (collectionView && !collectionView.webContents.isDestroyed()) {
            collectionView.webContents.send('collection:remove-keys', ['a' + want]);
        }
        return { ok: true, removed };
    });

    // dragging a cover out of the collection grid exports the FULL-SIZE cover as
    // a real file (native drag). CRITICAL: webContents.startDrag must be called
    // SYNCHRONOUSLY while the drag gesture is live — awaiting a download first
    // enters the OS drag loop with no active drag, which wedges/crashes the main
    // process. so: hovering a card prefetches the full-size art to temp, the
    // dragstart asks (sync) whether the file is ready, and only then hands the
    // drag to us; otherwise the browser's default thumbnail drag proceeds.
    const dragArtFile = (req: { title?: string; artist?: string }): string => {
        const safe = (((req?.artist || '') + ' - ' + (req?.title || 'cover'))
            .replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').slice(0, 80).trim()) || 'cover';
        return path.join(app.getPath('temp'), 'bcrpc-art', safe + '.jpg');
    };
    const artPrefetching = new Set<string>();
    ipcMain.on('collection:prefetch-art', async (_e, req: { art?: string; title?: string; artist?: string }) => {
        try {
            const file = dragArtFile(req);
            if (fs.existsSync(file) || artPrefetching.has(file)) return;
            const url = String(req?.art || '').replace(/_\d+\.jpg([?#].*)?$/, '_10.jpg'); // _10 = full size
            if (!url.startsWith('https://')) return;
            artPrefetching.add(file);
            const buf = await bandcampApi.fetchBinary(url);
            if (buf && buf.length) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, buf);
            }
        } catch { /* no prefetch, default drag will be used */ }
        finally { artPrefetching.delete(dragArtFile(req)); }
    });
    ipcMain.on('collection:art-ready', (e, req: { title?: string; artist?: string }) => {
        try {
            const file = dragArtFile(req);
            e.returnValue = fs.existsSync(file) ? file : '';
        } catch { e.returnValue = ''; }
    });
    ipcMain.on('collection:drag-art', (e, file: unknown) => {
        try {
            if (typeof file !== 'string' || !file || !fs.existsSync(file)) return;
            let icon = nativeImage.createFromPath(file);
            if (!icon.isEmpty()) icon = icon.resize({ width: 128 });
            else icon = nativeImage.createFromPath(path.join(__dirname, '../assets/bandcamp-button-circle-black-64.png'));
            e.sender.startDrag({ file, icon });
        } catch { /* drag just doesn't start */ }
    });

    // resolve a bandcamp release/track url to tracks & append to the queue. shared
    // by the right-click menu & the shift-click gesture.
    const enqueueFromUrl = async (url: string) => {
        if (!isBandcampUrl(url) || !/\/(album|track)\//.test(url)) { pageToast('nothing to queue here'); return; }
        try {
            const tracks = await bandcampApi.fetchTracksFromUrl(url);
            if (tracks.length && playerView && !playerView.webContents.isDestroyed()) {
                playerView.webContents.send('player:enqueue', { tracks });
                pageToast(tracks.length > 1 ? `added ${tracks.length} tracks to queue` : 'added to queue');
            } else {
                pageToast('could not add to queue');
            }
        } catch {
            pageToast('could not add to queue');
        }
    };
    ipcMain.on('app:enqueue-url', (_e, raw: unknown) => enqueueFromUrl(typeof raw === 'string' ? raw : ''));

    // media hotkeys pressed in any view (content pages, header, collection) are
    // relayed to the player, which owns the audio element.
    ipcMain.on('player:hotkey', (_e, cmd: unknown) => {
        if (playerView && !playerView.webContents.isDestroyed()) {
            playerView.webContents.send('player:hotkey', String(cmd || ''));
        }
    });

    // keep address bar in sync w/ content view (full loads + spa route changes) & re send once header finishes loading so it isn't blank
    const pushUrl = () => {
        if (headerView && !headerView.webContents.isDestroyed()) {
            headerView.webContents.send('nav:url', contentView.webContents.getURL());
        }
    };
    // per-view did-navigate bindings live in wireContentView; on header (re)load
    // resync the url bar and tab strip so they aren't blank
    headerView.webContents.on('did-finish-load', () => { pushUrl(); sendTabsState(); headerView.webContents.send('header:buttons', getHeaderButtons()); });

    // lazily resolve stream url for queued track (collection items only ship metadata; actual stream fetched on demand from tralbum api)
    ipcMain.handle('player:resolve-stream', async (_e, req: ResolveStreamRequest): Promise<ResolveStreamResponse> => {
        // local library tracks resolve straight to their file on disk
        if (isLocalId(req?.tralbumId) || String(req?.trackId || '').startsWith('L')) {
            const lt = localTrackById(req?.trackId);
            if (lt && fs.existsSync(lt.file)) {
                return { token: req.token, ok: true, src: localFileUrl(lt.file), duration: lt.duration || 0, title: lt.title, artist: lt.artist || lt.albumArtist, art: localFileUrl(lt.art) };
            }
            return { token: req.token, ok: false, src: '', duration: 0, error: 'local file missing' };
        }
        try {
            const track = await bandcampApi.resolveStream({
                bandId: req.bandId,
                tralbumId: req.tralbumId,
                tralbumType: req.tralbumType,
                trackId: req.trackId,
            });
            if (track?.src) {
                return {
                    token: req.token,
                    ok: true,
                    src: track.src,
                    duration: track.duration,
                    title: track.title,
                    artist: track.artist,
                    art: track.art,
                };
            }
        } catch {
            // fall thru to failure resp
        }
        return { token: req.token, ok: false, src: '', duration: 0, error: 'unresolved' };
    });

    // downloads land in the chosen (or os default) folder w/o a save dialog, and
    // report progress to the header so there's a visible indicator
    // downloads registry: everything ever downloaded this session, with live
    // status, backing the header's downloads panel. Clear drops finished entries.
    interface DlEntry { id: number; name: string; state: string; percent: number; file: string; at: number; receivedBytes: number; totalBytes: number; speed: number; lastTime: number; lastBytes: number; }
    const dlRegistry: DlEntry[] = [];
    let dlSeq = 0;
    let downloadsWin: BrowserWindow | null = null;
    let downloadsJustOpened = false;
    let downloadsClosedAt = 0; // Fixes the double-toggle race condition

    // Dynamically calculate the window height based on active/visible rows
    const getDlHeight = () => {
        const activeCount = dlRegistry.filter(d => d.state === 'progressing').length;
        const visibleRows = Math.max(1, Math.min(3, dlRegistry.length));
        let h = 42 + (visibleRows * 54) + 16; // 42px header + ~54px per row + padding
        if (activeCount > 1) h += 44; // 44px footer for overall progress
        return h;
    };

    const updateDownloadsHeight = () => {
        if (downloadsWin && !downloadsWin.isDestroyed()) {
            const b = mainWindow.getContentBounds();
            const h = getDlHeight();
            downloadsWin.setBounds({ width: 360, height: h, x: Math.max(0, b.x + b.width - 372), y: b.y + 44 });
        }
    };

    const broadcastDownloads = () => {
        if (!downloadsWin || downloadsWin.isDestroyed()) return;

        let activeCount = 0;
        let overallPercentSum = 0;
        let totalSpeed = 0;
        let totalRemainingBytes = 0;

        for (const d of dlRegistry) {
            if (d.state === 'progressing') {
                activeCount++;
                overallPercentSum += d.percent;
                totalSpeed += (d.speed || 0);
                if (d.totalBytes > 0 && d.receivedBytes > 0) {
                    totalRemainingBytes += Math.max(0, d.totalBytes - d.receivedBytes);
                } else {
                    // Fallback for streams where total size isn't initially known (weights it roughly as a 15MB file)
                    const remainingPct = Math.max(0, 100 - d.percent);
                    totalRemainingBytes += (remainingPct / 100) * 15_000_000; 
                }
            }
        }

        const overallPercent = activeCount > 0 ? Math.floor(overallPercentSum / activeCount) : 0;
        let eta = -1;
        if (activeCount > 0 && totalSpeed > 0) {
            eta = Math.ceil(totalRemainingBytes / totalSpeed);
        }

        updateDownloadsHeight(); // Check bounds before drawing

        downloadsWin.webContents.send('downloads:list', {
            items: dlRegistry, activeCount, overallPercent, eta
        });
    };

    const nativeDownloads = new Map<number, Electron.DownloadItem>();
    const streamDownloads = new Map<number, { canceled: boolean }>();

    const openDownloadsPanel = () => {
        if (downloadsWin && !downloadsWin.isDestroyed()) return;
        try {
            downloadsJustOpened = true;
            setTimeout(() => { downloadsJustOpened = false; }, 250);

            const b = mainWindow.getContentBounds();
            const h = getDlHeight();

            downloadsWin = new BrowserWindow({
                width: 360, height: h, frame: false, resizable: false, parent: mainWindow,
                x: Math.max(0, b.x + b.width - 372), y: b.y + 44,
                backgroundColor: '#181a1b',
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });

            downloadsWin.on('blur', () => {
                if (downloadsJustOpened) return;
                if (downloadsWin && !downloadsWin.isDestroyed()) downloadsWin.close();
            });

            downloadsWin.on('closed', () => {
                downloadsClosedAt = Date.now(); // Arm the debounce timer
                downloadsWin = null;
                if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('downloads:state', false);
            });

            downloadsWin.loadFile(path.join(__dirname, 'downloads', 'downloads.html'));
            downloadsWin.webContents.on('did-finish-load', () => broadcastDownloads());
            if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('downloads:state', true);
        } catch { downloadsWin = null; }
    };

    ipcMain.on('downloads:toggle', () => {
        // Prevents the window instantly reopening if it was just closed by clicking the toggle button
        if (Date.now() - downloadsClosedAt < 200) return;

        if (downloadsWin && !downloadsWin.isDestroyed()) { 
            if (downloadsJustOpened) return;
            downloadsWin.close(); 
        } else { 
            openDownloadsPanel(); 
        }
    });

    // the popup measures its real content and asks for that height (the old
    // main-side row estimate under-sized the empty state, showing a phantom
    // scrollbar). clamped; >4 rows caps renderer-side so the list scrolls.
    ipcMain.on('downloads:resize', (_e, h: unknown) => {
        if (!downloadsWin || downloadsWin.isDestroyed()) return;
        const want = Math.max(80, Math.min(600, Math.round(Number(h) || 0)));
        if (!want) return;
        const b = mainWindow.getContentBounds();
        downloadsWin.setBounds({ width: 360, height: want, x: Math.max(0, b.x + b.width - 372), y: b.y + 44 });
    });

    ipcMain.on('downloads:cancel', (_e, id: number) => {
        const entry = dlRegistry.find(d => d.id === id);
        if (entry && entry.state === 'progressing') {
            entry.state = 'cancelled';
            if (nativeDownloads.has(id)) {
                nativeDownloads.get(id)!.cancel();
                nativeDownloads.delete(id);
            }
            if (streamDownloads.has(id)) {
                streamDownloads.get(id)!.canceled = true;
            }
            broadcastDownloads();
        }
    });

    session.on('will-download', (_e, item) => {
        openDownloadsPanel();

        const name = item.getFilename();
        try { item.setSavePath(path.join(getDownloadDir(), name)); } catch { /* let electron pick */ }
        const entryId = ++dlSeq;
        const entry: DlEntry = { id: entryId, name, state: 'progressing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
        dlRegistry.unshift(entry);
        nativeDownloads.set(entryId, item);

        const send = (o: any) => {
            if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('download:progress', o);
            broadcastDownloads();
        };
        send({ name, percent: 0, state: 'progressing' });
        
        item.on('updated', (_ev, state) => {
            if (state !== 'progressing') return;
            const now = Date.now();
            const dt = (now - entry.lastTime) / 1000;
            if (dt > 0.5) {
                const diff = item.getReceivedBytes() - entry.lastBytes;
                if (diff > 0) entry.speed = diff / dt;
                entry.lastBytes = item.getReceivedBytes();
                entry.lastTime = now;
            }
            
            entry.receivedBytes = item.getReceivedBytes();
            entry.totalBytes = item.getTotalBytes();
            entry.percent = entry.totalBytes > 0 ? Math.floor((entry.receivedBytes / entry.totalBytes) * 100) : entry.percent;
            
            send({ name, percent: entry.percent, state: 'progressing' });
        });
        
        item.on('done', (_ev, state) => {
            nativeDownloads.delete(entryId);
            entry.state = state;
            entry.percent = 100;
            entry.speed = 0;
            try { entry.file = item.getSavePath(); } catch { /* keep '' */ }
            send({ name, percent: 100, state });
            if (state === 'completed') pageToast('downloaded ' + name);
            if (devMode) console.log('[bcrpc] download ' + state + ' ' + name);
        });
    });

    ipcMain.on('downloads:close', () => { 
        if (downloadsJustOpened) return; 
        if (downloadsWin && !downloadsWin.isDestroyed()) downloadsWin.close(); 
    });
    
    ipcMain.handle('downloads:get', () => {
        return { items: dlRegistry, activeCount: dlRegistry.filter(d => d.state === 'progressing').length, overallPercent: 0, eta: -1 };
    });
    
    ipcMain.on('downloads:clear', () => {
        for (let i = dlRegistry.length - 1; i >= 0; i--) {
            if (dlRegistry[i].state !== 'progressing') dlRegistry.splice(i, 1);
        }
        broadcastDownloads();
    });
    
    ipcMain.on('downloads:open-file', (_e, file: unknown) => {
        if (typeof file === 'string' && file && fs.existsSync(file)) shell.showItemInFolder(file);
    });

    const sanitizeName = (x: string) => (x || '').replace(/[<>:"/\\|?*]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'untitled';
    let streamDlActive = false;
    const startStreamDownload = async (req: { url?: string; tralbumId?: string; tralbumType?: TralbumType; bandId?: string }): Promise<{ ok: boolean; count?: number; error?: string }> => {
        if (streamDlActive) return { ok: false, error: 'a download is already running' };
        const rel = await bandcampApi.fetchReleaseForDownload(req);
        if (!rel.ok) return { ok: false, error: rel.error };
        streamDlActive = true;
        
        openDownloadsPanel();

        const entryId = ++dlSeq;
        const dlState = { canceled: false };
        streamDownloads.set(entryId, dlState);

        const entry: DlEntry = { id: entryId, name: `${rel.albumArtist} — ${rel.album}`, state: 'progressing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
        dlRegistry.unshift(entry);
        
        const prog = (state: string, percent: number, name: string) => {
            entry.state = state;
            entry.percent = Math.max(0, percent);
            broadcastDownloads();
        };
        
        void (async () => {
            try {
                const fileFmt = store.get('fileNameFmt', '{tracknum} {artist} - {title}') as string;
                const folderFmt = store.get('folderNameFmt', '{artist}/{album}') as string;
                const modifyTags = store.get('modifyTags', true) !== false;
                // per-tag toggles + cover/playlist options (BandcampDownloader-style)
                const tagOn = (k: string) => store.get(k, true) !== false;
                const coverInTags = tagOn('coverInTags');
                const coverInFolder = tagOn('coverInFolder');
                const coverNameFmt = String(store.get('coverNameFmt', 'cover') || 'cover');
                const playlistNameFmt = String(store.get('playlistNameFmt', '{album}') || '{album}');

                const formatPath = (fmt: string) => {
                    return (fmt || '').replace(/\{albumartist\}/gi, sanitizeName(rel.albumArtist))
                                      .replace(/\{artist\}/gi, sanitizeName(rel.albumArtist))
                                      .replace(/\{album\}/gi, sanitizeName(rel.album))
                                      .replace(/\{year\}/gi, rel.year ? String(rel.year) : '');
                };

                const dir = path.join(getDownloadDir(), formatPath(folderFmt));
                fs.mkdirSync(dir, { recursive: true });
                entry.file = dir;
                
                let art: Buffer | null = null;
                if (rel.artUrl && (coverInTags || coverInFolder)) {
                    art = await bandcampApi.fetchBinary(rel.artUrl);
                    if (art && art.length && coverInFolder) {
                        try { fs.writeFileSync(path.join(dir, (sanitizeName(formatPath(coverNameFmt)) || 'cover') + '.jpg'), art); } catch { /* disk */ }
                    }
                }
                
                const files: { file: string; title: string; artist: string; duration: number }[] = [];
                for (let i = 0; i < rel.tracks.length; i++) {
                    if (dlState.canceled) {
                        prog('cancelled', Math.round((i / rel.tracks.length) * 100), `${rel.album} (Cancelled)`);
                        break;
                    }

                    const t = rel.tracks[i];
                    prog('progressing', Math.round((i / rel.tracks.length) * 100), `${t.title} (${i + 1}/${rel.tracks.length})`);
                    
                    const t0 = Date.now();
                    const buf = await bandcampApi.fetchBinary(t.stream);
                    const dt = (Date.now() - t0) / 1000;
                    if (buf && buf.length && dt > 0) {
                        entry.speed = buf.length / dt;
                        entry.receivedBytes += buf.length;
                    }
                    
                    if (!buf || !buf.length) continue; 
                    
                    const formatFileName = (fmt: string, trackTitle: string, trackArtist: string, trackNum: string) => {
                        let name = (fmt || '{tracknum} {artist} - {title}').replace(/\{albumartist\}/gi, sanitizeName(rel.albumArtist))
                            .replace(/\{artist\}/gi, sanitizeName(trackArtist))
                            .replace(/\{album\}/gi, sanitizeName(rel.album))
                            .replace(/\{title\}/gi, sanitizeName(trackTitle))
                            .replace(/\{year\}/gi, rel.year ? String(rel.year) : '')
                            .replace(/\{tracknum\}/gi, trackNum.padStart(2, '0'));
                        if (!name.toLowerCase().endsWith('.mp3')) name += '.mp3';
                        return name;
                    };

                    const fileName = formatFileName(fileFmt, t.title, t.artist, String(t.trackNum));
                    const file = path.join(dir, fileName);

                    if (modifyTags) {
                        // an unticked tag simply isn't written
                        const tag = buildId3v23({
                            title: tagOn('tagTitle') ? t.title : '',
                            artist: tagOn('tagArtist') ? t.artist : '',
                            albumArtist: tagOn('tagAlbumArtist') ? rel.albumArtist : '',
                            album: tagOn('tagAlbum') ? rel.album : '',
                            trackNum: tagOn('tagTrackNum') ? t.trackNum : 0,
                            trackTotal: tagOn('tagTrackNum') ? rel.tracks.length : undefined,
                            year: tagOn('tagYear') ? rel.year : 0,
                            lyrics: tagOn('tagLyrics') ? t.lyrics : '',
                            art: coverInTags ? (art || undefined) : undefined,
                        });
                        fs.writeFileSync(file, Buffer.concat([tag, buf]));
                    } else {
                        fs.writeFileSync(file, buf);
                    }

                    files.push({ file, title: t.title, artist: t.artist, duration: t.duration });
                    await new Promise((res) => setTimeout(res, 250)); // gentle on the cdn
                }

                if (!dlState.canceled) {
                    writePlaylistFile(dir, sanitizeName(formatPath(playlistNameFmt)) || sanitizeName(rel.album), rel.album, files);
                    prog(files.length ? 'completed' : 'interrupted', 100, `${rel.album} (${files.length}/${rel.tracks.length} tracks)`);
                }
            } catch (err: any) {
                if (devMode) console.log('[bcrpc] stream download FAILED ' + (err && (err.message || err)));
                prog('interrupted', 0, rel.album);
            } finally {
                streamDownloads.delete(entryId);
                streamDlActive = false;
                entry.speed = 0;
            }
        })();
        return { ok: true, count: rel.tracks.length };
    };
    // playlist file in the chosen settings format, next to the tracks
    function writePlaylistFile(dir: string, baseName: string, album: string, files: { file: string; title: string; artist: string; duration: number }[]): void {
        const fmt = String(store.get('dlPlaylistFormat', 'm3u'));
        if (fmt === 'none' || !files.length) return;
        const names = files.map((f) => path.basename(f.file));
        let out = '';
        if (fmt === 'pls') {
            out = '[playlist]\n' + files.map((f, i) =>
                `File${i + 1}=${names[i]}\nTitle${i + 1}=${f.artist} - ${f.title}\nLength${i + 1}=${f.duration || -1}`).join('\n') +
                `\nNumberOfEntries=${files.length}\nVersion=2\n`;
        } else if (fmt === 'wpl' || fmt === 'zpl') {
            const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            out = `<?wpl version="1.0"?>\n<smil>\n<head><title>${esc(album)}</title></head>\n<body><seq>\n` +
                names.map((n) => `<media src="${esc(n)}"/>`).join('\n') + '\n</seq></body>\n</smil>\n';
        } else { // m3u (default)
            out = '#EXTM3U\n' + files.map((f, i) =>
                `#EXTINF:${f.duration || -1},${f.artist} - ${f.title}\n${names[i]}`).join('\n') + '\n';
        }
        try { fs.writeFileSync(path.join(dir, (baseName || sanitizeName(album)) + '.' + fmt), out, 'utf8'); } catch { /* disk */ }
    }
    ipcMain.handle('download:release', (_e, req: { url?: string; tralbumId?: string; tralbumType?: TralbumType; bandId?: string }) => startStreamDownload(req || {}));

    // ownership check for the on-page download button: owned collection items
    // carry their bandcamp redownload page url
    ipcMain.handle('release:download-info', (_e, req: { tralbumId?: string; tralbumType?: string }) => {
        const id = toIdStr(req?.tralbumId);
        const type = req?.tralbumType === 't' ? 't' : 'a';
        if (!id) return { owned: false };
        const hit = collectionItemsDisk.get().find((c: any) => !c.wish && c.tralbumType === type && c.tralbumId === id && c.downloadUrl);
        return hit ? { owned: true, downloadUrl: hit.downloadUrl } : { owned: false };
    });

    // list the formats a purchased item offers (from its download page)
    ipcMain.handle('download:formats', async (_e, url: string) => {
        try {
            const formats = await bandcampApi.fetchDownloadFormats(url);
            if (devMode) console.log('[bcrpc] download:formats ' + formats.length + ' for ' + url.slice(0, 60));
            return { ok: true, formats };
        } catch (err: any) {
            return { ok: false, formats: [], error: err?.message || 'failed' };
        }
    });

    // prepare (if needed) & start a download of a chosen format url
    ipcMain.handle('download:start', async (_e, formatUrl: string) => {
        try {
            const finalUrl = await bandcampApi.prepareDownload(formatUrl);
            session.downloadURL(finalUrl);
            if (devMode) console.log('[bcrpc] download:start ' + finalUrl.slice(0, 70));
            return { ok: true };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'failed' };
        }
    });

    // custom player is single source of now playing truth. drives discord rich presence & last.fm scrobbling
    // the release page's inline player mirrors OUR playback (the preload updates
    // its play state / progress / times from these)
    ipcMain.on('player:seek-frac', (_e, frac: unknown) => {
        if (playerView && !playerView.webContents.isDestroyed()) {
            playerView.webContents.send('player:seek-frac', Number(frac) || 0);
        }
    });
    ipcMain.on('player:now-playing', (_e, track: NowPlaying) => {
        for (const t of tabs) {
            if (!t.view.webContents.isDestroyed()) {
                t.view.webContents.send('page:now-playing', {
                    url: track.url, title: track.title, position: track.position,
                    duration: track.duration, isPlaying: track.isPlaying,
                });
            }
        }
        presenceService.update(track);
        lastfmService.updateNowPlaying(track);
        lastfmService.maybeScrobble(track);
    });

    // grow/shrink player view so slide up queue panel has room
    ipcMain.on('player:queue-panel', (_e, open: boolean) => {
        playerExpanded = Boolean(open);
        adjustContentViews();
    });

    ipcMain.on('app:settings', () => openSettings());
    ipcMain.on('settings:close', () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close(); });
    // preload reads the effective theme for its page synchronously at document-start
    // so its anti-flash cloak matches (no opacity cloak when the page will be light,
    // else it stays blank grey)
    ipcMain.on('app:theme-for', (e, url: unknown) => { e.returnValue = themeForUrl(typeof url === 'string' ? url : ''); });

    // let the user pick where purchased downloads are saved
    ipcMain.handle('settings:choose-download-dir', async () => {
        const res = await dialog.showOpenDialog(settingsWindow || mainWindow, {
            title: 'Choose download folder',
            defaultPath: getDownloadDir(),
            properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths.length) return { ok: false, dir: getDownloadDir() };
        store.set('downloadDir', res.filePaths[0]);
        return { ok: true, dir: res.filePaths[0] };
    });

    // release cache: where covers are stored + how big everything is
    ipcMain.handle('settings:choose-cache-dir', async () => {
        const current = (store.get('cacheDir', '') as string) || app.getPath('userData');
        const res = await dialog.showOpenDialog(settingsWindow || mainWindow, {
            title: 'Choose release cache folder',
            defaultPath: current,
            properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths.length) return { ok: false, dir: current };
        store.set('cacheDir', res.filePaths[0]);
        return { ok: true, dir: res.filePaths[0] };
    });
    ipcMain.handle('settings:cache-info', () => ({
        dir: (store.get('cacheDir', '') as string) || app.getPath('userData'),
        bytes: cacheSizeBytes(),
    }));

    // music folder for the local-files auto-scan (scan itself stays opt-in)
    ipcMain.handle('settings:choose-music-folder', async () => {
        const stored = String(store.get('musicFolder', '') || '');
        let fallback = stored;
        if (!fallback) { try { fallback = app.getPath('music'); } catch { fallback = app.getPath('home'); } }
        const res = await dialog.showOpenDialog(settingsWindow || mainWindow, {
            title: 'Choose your music folder',
            defaultPath: fallback,
            properties: ['openDirectory'],
        });
        if (res.canceled || !res.filePaths.length) return { ok: false, dir: stored };
        store.set('musicFolder', res.filePaths[0]);
        // folder changed while scanning is on: refresh right away
        if (store.get('musicFolderScan', false) === true) setTimeout(() => { void scanMusicFolder(); }, 300);
        return { ok: true, dir: res.filePaths[0] };
    });


    // settings + last.fm auth bridge
    ipcMain.on('settings:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:settings] ' + String(msg)); });
    ipcMain.handle('settings:get', () => {
        if (devMode) console.log('[bcrpc] settings:get');
        return {
            lastfm: store.get('lastfm', { apiKey: '', apiSecret: '', username: '', enabled: true }),
            discordEnabled: store.get('discordEnabled', true),
            discordClientId: store.get('discordClientId', ''),
            closeToTray: store.get('closeToTray', true),
            autoLoadCollection: store.get('autoLoadCollection', false) === true,
            cacheReleases: cacheReleasesOn(),
            fileNameFmt: store.get('fileNameFmt', '{tracknum} {artist} - {title}'),
            folderNameFmt: store.get('folderNameFmt', '{artist}/{album}'),
            modifyTags: store.get('modifyTags', true) !== false,
            tagTitle: store.get('tagTitle', true) !== false,
            tagArtist: store.get('tagArtist', true) !== false,
            tagAlbumArtist: store.get('tagAlbumArtist', true) !== false,
            tagAlbum: store.get('tagAlbum', true) !== false,
            tagYear: store.get('tagYear', true) !== false,
            tagTrackNum: store.get('tagTrackNum', true) !== false,
            tagLyrics: store.get('tagLyrics', true) !== false,
            coverInTags: store.get('coverInTags', true) !== false,
            coverInFolder: store.get('coverInFolder', true) !== false,
            coverNameFmt: String(store.get('coverNameFmt', 'cover')),
            playlistNameFmt: String(store.get('playlistNameFmt', '{album}')),
            gridHeaders: store.get('gridHeaders', false) === true,
            headerButtons: getHeaderButtons(),
            shortcuts: getShortcuts(),
            dlPlaylistFormat: String(store.get('dlPlaylistFormat', 'm3u')),
            downloadDir: getDownloadDir(),
            musicFolderScan: store.get('musicFolderScan', false) === true,
            musicFolder: String(store.get('musicFolder', '') || ''),
            theme: getTheme(),
            darkArtistPages: store.get('darkArtistPages', false) === true,
            discordOpts: presenceService.options(),
        };
    });

    ipcMain.handle('settings:save', (_e, data: any) => {
        try {
            const existing = (store.get('lastfm') as any) || {};
            store.set('lastfm', { ...existing, ...(data.lastfm || {}) });
            if (typeof data.fileNameFmt === 'string') store.set('fileNameFmt', data.fileNameFmt);
            if (typeof data.folderNameFmt === 'string') store.set('folderNameFmt', data.folderNameFmt);
            if (typeof data.modifyTags === 'boolean') store.set('modifyTags', data.modifyTags);
            if (data.shortcuts && typeof data.shortcuts === 'object') {
                const clean: Record<string, string> = {};
                for (const k of Object.keys(SHORTCUT_DEFAULTS)) {
                    if (typeof data.shortcuts[k] === 'string' && data.shortcuts[k].length <= 40) clean[k] = data.shortcuts[k];
                }
                store.set('shortcuts', { ...getShortcuts(), ...clean });
            }
            for (const k of ['tagTitle', 'tagArtist', 'tagAlbumArtist', 'tagAlbum', 'tagYear', 'tagTrackNum', 'tagLyrics', 'coverInTags', 'coverInFolder']) {
                if (typeof data[k] === 'boolean') store.set(k, data[k]);
            }
            if (typeof data.coverNameFmt === 'string') store.set('coverNameFmt', data.coverNameFmt.trim() || 'cover');
            if (typeof data.playlistNameFmt === 'string') store.set('playlistNameFmt', data.playlistNameFmt.trim() || '{album}');
            if (typeof data.discordEnabled === 'boolean') store.set('discordEnabled', data.discordEnabled);
            if (typeof data.closeToTray === 'boolean') store.set('closeToTray', data.closeToTray);
            if (typeof data.discordClientId === 'string') {
                store.set('discordClientId', data.discordClientId.trim());
                presenceService.reconnect(); // apply new app id now
            }
            if (typeof data.autoLoadCollection === 'boolean') store.set('autoLoadCollection', data.autoLoadCollection);
            if (typeof data.musicFolderScan === 'boolean') {
                const was = store.get('musicFolderScan', false) === true;
                store.set('musicFolderScan', data.musicFolderScan);
                // freshly enabled: scan now instead of waiting for the next boot
                if (data.musicFolderScan && !was) setTimeout(() => { void scanMusicFolder(); }, 300);
            }
            if (typeof data.dlPlaylistFormat === 'string' && ['m3u', 'pls', 'wpl', 'zpl', 'none'].includes(data.dlPlaylistFormat)) store.set('dlPlaylistFormat', data.dlPlaylistFormat);
            if (typeof data.cacheReleases === 'boolean') {
                const wasOn = cacheReleasesOn();
                store.set('cacheReleases', data.cacheReleases);
                // freshly enabled: start mirroring covers now (not on the next boot)
                if (data.cacheReleases && !wasOn && lastIndexReqs.length) void mirrorArt(lastIndexReqs);
            }
            if (data.headerButtons && typeof data.headerButtons === 'object') {
                const clean: Record<string, boolean> = {};
                for (const k of Object.keys(HEADER_BUTTON_DEFAULTS)) {
                    if (typeof data.headerButtons[k] === 'boolean') clean[k] = data.headerButtons[k];
                }
                store.set('headerButtons', { ...getHeaderButtons(), ...clean });
                if (headerView && !headerView.webContents.isDestroyed()) {
                    headerView.webContents.send('header:buttons', getHeaderButtons());
                }
            }
            if (typeof data.gridHeaders === 'boolean') {
                store.set('gridHeaders', data.gridHeaders);
                if (collectionView && !collectionView.webContents.isDestroyed()) {
                    collectionView.webContents.send('collection:grid-headers', data.gridHeaders);
                }
            }
            if (data.discordOpts && typeof data.discordOpts === 'object') {
                if (typeof data.discordOpts.showWhenPaused === 'boolean') store.set('discordShowWhenPaused', data.discordOpts.showWhenPaused);
                presenceService.refresh(); // re-send the live activity with new options
            }
            let themeChanged = false;
            if (typeof data.theme === 'string') {
                const next = data.theme === 'light' ? 'light' : 'dark';
                themeChanged = next !== getTheme();
                store.set('theme', next);
            }
            if (typeof data.darkArtistPages === 'boolean') {
                if (data.darkArtistPages !== (store.get('darkArtistPages', false) === true)) themeChanged = true;
                store.set('darkArtistPages', data.darkArtistPages);
            }
            // reload every tab so the cloak/darkreader state flips
            if (themeChanged) tabs.forEach((t) => { if (!t.view.webContents.isDestroyed()) t.view.webContents.reload(); });
            if (devMode) console.log('[bcrpc] settings:save ok keys=' + JSON.stringify(Object.keys(data || {})));
            return { ok: true };
        } catch (err: any) {
            if (devMode) console.log('[bcrpc] settings:save FAILED ' + (err && (err.message || err)));
            return { ok: false, error: err?.message || 'save failed' };
        }
    });

    ipcMain.handle('lastfm:begin-auth', async () => {
        if (devMode) console.log('[bcrpc] lastfm:begin-auth');
        const res = await lastfmService.beginAuth();
        if ('authUrl' in res) {
            shell.openExternal(res.authUrl);
            // auto-detect when the user finishes authorizing (no manual button)
            lastfmService.pollForSession().then((r) => {
                if (devMode) console.log('[bcrpc] lastfm auto-auth ' + JSON.stringify(r));
                if (settingsWindow && !settingsWindow.isDestroyed()) {
                    settingsWindow.webContents.send('lastfm:authed', r);
                }
            });
        }
        return res;
    });

    // --- tabs ---------------------------------------------------------------

    // build a content BrowserView (muted, sandboxed, our preload) for a tab
    function makeContentView(): BrowserView {
        const v = new BrowserView({
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                // webSecurity is off so the in-page extractor can hit bandcamp.com apis
                // cross-origin from artist subdomains & darkreader can pull cross-origin
                // css/fonts. the page is otherwise locked down (no node integration,
                // sandboxed, context-isolated), which is what contains the risk. CodeQL
                // flags this — it's an intentional trade-off for a browser-like client.
                webSecurity: false,
                devTools: devMode,
                autoplayPolicy: 'no-user-gesture-required',
                preload: path.join(__dirname, 'preload.js'),
            },
        });
        v.setBackgroundColor('#181a1b');
        v.webContents.setAudioMuted(true);
        return v;
    }

    // attach nav / open-in-new / theme / context-menu / devtools handlers to a tab
    function wireContentView(view: BrowserView): void {
        const wc = view.webContents;
        const isActive = () => contentView && !wc.isDestroyed() && wc.id === contentView.webContents.id;

        // nav invalidates in-flight extractor results (late trap must not load into player after moving on)
        wc.on('did-start-navigation', (...args: any[]) => {
            const isMainFrame = args.length >= 4 ? Boolean(args[3]) : true;
            if (isMainFrame && isActive()) { trapSeq++; userGestureAt = 0; bandcampApi.noteInteractive(); }
        });

        // open-in-new: bandcamp links -> new in-app tab; external links -> new window; plain foreground links stay in place
        wc.setWindowOpenHandler((details) => {
            const asNew = details.disposition === 'background-tab' || details.disposition === 'new-window';
            if (asNew && isBandcampUrl(details.url)) newTab(details.url, details.disposition !== 'background-tab');
            else if (asNew) openInNewWindow(details.url);
            else wc.loadURL(details.url).catch(() => {});
            return { action: 'deny' };
        });

        // right-click menu: add-to-queue (linked release, or the release you're on),
        // copy link, open in tab/window, copy selection
        wc.on('context-menu', (_e, params) => {
            const link = params.linkURL || '';
            const pageUrl = wc.getURL();
            const linkIsRelease = isBandcampUrl(link) && /\/(album|track)\//.test(link);
            const pageIsRelease = isBandcampUrl(pageUrl) && /\/(album|track)\//.test(pageUrl);
            const tmpl: Electron.MenuItemConstructorOptions[] = [];
            if (linkIsRelease) tmpl.push({ label: 'Add to queue', click: () => enqueueFromUrl(link) });
            else if (pageIsRelease) tmpl.push({ label: 'Add this release to queue', click: () => enqueueFromUrl(pageUrl) });
            if (linkIsRelease) tmpl.push({ label: 'Download release (mp3-128)', click: () => { void startStreamDownload({ url: link }); } });
            else if (pageIsRelease) tmpl.push({ label: 'Download this release (mp3-128)', click: () => { void startStreamDownload({ url: pageUrl }); } });
            if (link) {
                if (tmpl.length) tmpl.push({ type: 'separator' });
                tmpl.push({ label: 'Copy link', click: () => { clipboard.writeText(link); pageToast('link copied'); } });
                if (isBandcampUrl(link)) tmpl.push({ label: 'Open in new tab', click: () => newTab(link, false) });
                tmpl.push({ label: 'Open in new window', click: () => openInNewWindow(link) });
            }
            if (params.selectionText && params.selectionText.trim()) {
                if (tmpl.length) tmpl.push({ type: 'separator' });
                tmpl.push({ label: 'Copy', click: () => clipboard.writeText(params.selectionText) });
            }
            if (tmpl.length) Menu.buildFromTemplate(tmpl).popup();
        });

        // artist social/promo links (instagram, youtube, spotify…) open in a separate
        // window instead of hijacking the main view. limited to a known list so
        // bandcamp itself, bandcamp-pro custom domains, and checkout/login redirects
        // (paypal, stripe, google/facebook oauth) stay in-app & keep working.
        wc.on('will-navigate', (event, url) => {
            if (isSocialHost(url)) { event.preventDefault(); openInNewWindow(url); }
        });

        // keep url bar + tab title in sync
        // keep url bar + tab title in sync
        const onNav = () => {
            const tab = tabs.find((t) => t.view === view);
            if (tab) {
                let ti = wc.getTitle() || '';
                
                // Strip the trailing " | Bandcamp"
                if (ti.endsWith(' | Bandcamp')) {
                    ti = ti.replace(' | Bandcamp', '');
                }
                
                // Use the URL path (like /discover/) if title is just "Bandcamp" or empty
                if (ti === 'Bandcamp' || ti.trim() === '') {
                    try {
                        const u = new URL(wc.getURL());
                        if (u.pathname && u.pathname !== '/') {
                            ti = u.pathname;
                        } else {
                            ti = 'Bandcamp';
                        }
                    } catch {
                        ti = 'Bandcamp';
                    }
                }
                
                tab.title = ti;
            }
            if (isActive()) pushUrl();
            sendTabsState();
        };
        wc.on('did-navigate', onNav);
        wc.on('did-navigate-in-page', onNav);
        wc.on('page-title-updated', onNav);

        // failsafe against the grey-page hang: the dark cloak hides the body until
        // darkreader paints; if darkreader never initializes (script error, redirect
        // race like ?from=menubar hops, bfcache restores), the page stayed an empty
        // grey forever. after a few seconds, if nothing painted, drop the user-origin
        // cloak AND force the body visible — worst case is a brief unthemed flash.
        const liftCloakIfStuck = () => {
            setTimeout(() => {
                if (wc.isDestroyed()) return;
                wc.executeJavaScript('!!document.documentElement.getAttribute("data-darkreader-scheme")')
                    .then((painted: boolean) => {
                        if (painted || wc.isDestroyed()) return;
                        if (themeForUrl(wc.getURL()) !== 'light') {
                            const key = antiFlashKeys.get(wc);
                            if (key) { wc.removeInsertedCSS(key).catch(() => {}); antiFlashKeys.delete(wc); }
                        }
                        wc.executeJavaScript(
                            '(function(){var s=document.createElement("style");s.textContent="body{opacity:1 !important}";(document.head||document.documentElement).appendChild(s);})()'
                        ).catch(() => {});
                    }).catch(() => {});
            }, 4000);
        };

        // dark theme once the dom is ready
        wc.on('dom-ready', async () => {
            try {
                await wc.insertCSS(SEARCHBOX_CSS);
                liftCloakIfStuck(); // arm the de-grey failsafe on every load path
                if (themeForUrl(wc.getURL()) === 'light') return; // no darkreader in light mode / on exempt artist pages
                await wc.executeJavaScript(`
                    (function() {
                        if (window.__darkReaderActive) return;
                        window.__darkReaderActive = true;
                        const _define = window.define; const _exports = window.exports;
                        window.define = undefined; window.exports = undefined;
                        try {
                            ${darkReaderJS};
                            if (typeof window.DarkReader !== 'undefined') {
                                window.DarkReader.setFetchMethod(window.fetch);
                                window.DarkReader.enable({
                                    brightness: 100, contrast: 100, sepia: 0, mode: 1,
                                    darkSchemeBackgroundColor: '#181a1b',
                                    darkSchemeTextColor: '#e8e6e3'
                                });
                            }
                        } finally { window.define = _define; window.exports = _exports; }
                    })();
                `);
            } catch (err) { console.error('Failed to inject view assets:', err); }
        });

        // pre-theme css, swapped per navigation (light mode skips the dark cloak)
        wc.on('did-navigate', async () => {
            try {
                const prev = antiFlashKeys.get(wc);
                if (prev) await wc.removeInsertedCSS(prev).catch(() => {});
                const isLight = themeForUrl(wc.getURL()) === 'light';
                const key = await wc.insertCSS(isLight ? LIGHT_CSS : ANTI_FLASH_CSS, { cssOrigin: 'user' });
                antiFlashKeys.set(wc, key);
                if (!isLight) liftCloakIfStuck();
            } catch (err) { console.error('Failed to inject Pre-Theme CSS:', err); }
        });

        // a page navigation that itself gets HTTP 429 renders an empty shell that
        // the dark cloak turns into a silent grey hang. say WHY and offer reload.
        wc.on('did-navigate', (_e: any, _url: string, httpResponseCode: number) => {
            if (httpResponseCode !== 429) return;
            try { bandcampApi.on429?.(); } catch { /* notice best-effort */ }
            setTimeout(() => {
                if (wc.isDestroyed()) return;
                const key = antiFlashKeys.get(wc);
                if (key) { wc.removeInsertedCSS(key).catch(() => {}); antiFlashKeys.delete(wc); }
                wc.executeJavaScript(`(function () {
                    if (document.getElementById('bcrpc-429')) return;
                    var d = document.createElement('div');
                    d.id = 'bcrpc-429';
                    d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#181a1b;color:#e8e6e3;display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
                    d.innerHTML = '<div style="max-width:440px;padding:24px;text-align:center;">' +
                        '<div style="font-size:18px;font-weight:600;margin-bottom:10px;">Error 429 — too many requests</div>' +
                        '<div style="font-size:13px;color:#9a968e;line-height:1.6;">Bandcamp is throttling this session, so this page could not load. Wait a little bit T__T and try again.</div>' +
                        '<button onclick="location.reload()" style="margin-top:16px;background:#1da0c3;border:none;color:#fff;border-radius:6px;padding:9px 16px;font-size:13px;cursor:pointer;">Reload page</button></div>';
                    (document.body || document.documentElement).appendChild(d);
                    var st = document.createElement('style'); st.textContent = 'body{opacity:1 !important}';
                    document.documentElement.appendChild(st);
                })()`).catch(() => { /* view navigated away */ });
            }, 250);
        });

        wc.on('before-input-event', (event, input) => {
            if (input.key === 'F12' && input.type === 'keyDown') { wc.toggleDevTools(); event.preventDefault(); }
            if (handleShortcut(input)) event.preventDefault();
        });

        // track when the page's renderer wedges (e.g. bandcamp's >1000 collection
        // sort) so hardLoad knows to drop it rather than wait on the stuck renderer
        wc.on('unresponsive', () => { (wc as any).__hung = true; });
        wc.on('responsive', () => { (wc as any).__hung = false; });

        // ignore page beforeunload guards. bandcamp's collection reorder sets a
        // "you have unsaved changes" beforeunload; electron CANCELS any navigation a
        // beforeunload tries to block, which silently kills link clicks, refresh &
        // even our home button (it looks like the whole page is frozen). preventing
        // the default lets navigation always proceed.
        wc.on('will-prevent-unload', (event) => { event.preventDefault(); });
    }

    // swap the visible tab; restore overlay stacking (content < collection < header < player)
    function setActiveTab(id: number): void {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return;
        // re-activating the current tab: just resync the strip, don't re-add the view
        if (activeTabId === id && contentView === tab.view) { sendTabsState(); return; }
        const prev = contentView;
        activeTabId = id;
        contentView = tab.view;
        if (prev && prev !== tab.view && !prev.webContents.isDestroyed()) {
            try { mainWindow.removeBrowserView(prev); } catch { /* already gone */ }
        }
        mainWindow.addBrowserView(tab.view);
        if (collectionVisible && collectionView) mainWindow.setTopBrowserView(collectionView);
        if (feedVisible && feedView) mainWindow.setTopBrowserView(feedView);
        mainWindow.setTopBrowserView(headerView);
        mainWindow.setTopBrowserView(playerView);
        adjustContentViews();
        pushUrl();
        sendTabsState();
    }

    // open a new tab (bandcamp link); returns its id
    function newTab(url: string, activate = true): number {
        const view = makeContentView();
        wireContentView(view);
        const id = ++tabSeq;
        tabs.push({ id, view, title: 'Bandcamp' });
        view.webContents.loadURL(url).catch(() => {});
        if (activate) setActiveTab(id);
        else sendTabsState();
        return id;
    }

    function closeTab(id: number): void {
        const idx = tabs.findIndex((t) => t.id === id);
        if (idx === -1) return;
        const tab = tabs[idx];
        const wasActive = activeTabId === id;
        tabs.splice(idx, 1);
        if (!tabs.length) newTab('https://bandcamp.com', true); // never leave zero tabs
        else if (wasActive) setActiveTab(tabs[Math.min(idx, tabs.length - 1)].id);
        else sendTabsState();
        if (!tab.view.webContents.isDestroyed()) {
            try { mainWindow.removeBrowserView(tab.view); } catch { /* already gone */ }
            try { (tab.view.webContents as any).destroy?.(); } catch { /* noop */ }
        }
    }

    function sendTabsState(): void {
        if (!headerView || headerView.webContents.isDestroyed()) return;
        headerView.webContents.send('tabs:state', {
            tabs: tabs.map((t) => ({ id: t.id, title: t.title, active: t.id === activeTabId })),
        });
    }

    ipcMain.on('tab:activate', (_e, id: number) => setActiveTab(id));
    ipcMain.on('tab:close', (_e, id: number) => closeTab(id));
    ipcMain.on('tab:new', () => newTab('https://bandcamp.com', true));
    // middle-click from preload: bandcamp links -> background in-app tab; external -> new window
    ipcMain.on('app:open-tab', (_e, url: unknown) => {
        const u = typeof url === 'string' ? url : '';
        if (!/^https?:\/\//i.test(u)) return;
        if (isBandcampUrl(u)) newTab(u, false);
        else openInNewWindow(u);
    });

    // resolve a page url for a now-playing track that has none (e.g. homepage
    // playlist tracks) so the player's title/artist links work
    ipcMain.handle('player:resolve-page', async (_e, req: { trackId?: string; bandId?: string; tralbumId?: string; tralbumType?: TralbumType }) => {
        if (isLocalId(req?.tralbumId) || String(req?.trackId || '').startsWith('L')) return { ok: false, url: '' }; // no page for local files
        try {
            const url = await bandcampApi.resolvePageUrl(req);
            return { ok: Boolean(url), url: url || '' };
        } catch { return { ok: false, url: '' }; }
    });

    mainWindow.on('app-command', (_e, cmd) => {
        if (cmd === 'browser-backward') navGo('back');
        else if (cmd === 'browser-forward') navGo('forward');
    });

    await contentView.webContents.loadURL('https://bandcamp.com');
    mainWindow.show();
    adjustContentViews();

    // opt-in music-folder scan, shortly after startup so it never competes with
    // the window coming up (no-op unless enabled in settings)
    if (store.get('musicFolderScan', false) === true) {
        setTimeout(() => { void scanMusicFolder(); }, 4000);
    }

    // check for app updates in the background (packaged builds only; dev has no
    // update feed & electron-updater would just throw)
    if (app.isPackaged) {
        try {
            autoUpdater.autoDownload = true;
            autoUpdater.on('update-downloaded', () => {
                if (headerView && !headerView.webContents.isDestroyed()) {
                    headerView.webContents.send('download:progress', { name: 'update ready — restart to install', percent: 100, state: 'completed' });
                }
            });
            autoUpdater.checkForUpdatesAndNotify().catch(() => {});
        } catch { /* no update feed configured */ }
    }
}

app.whenReady().then(init);
app.on('before-quit', () => {
    isQuitting = true;
    // make sure debounced cache writes hit disk before the process dies
    try { releaseIndexDisk?.flush(); collectionItemsDisk?.flush(); yearsDisk?.flush(); playlistsDisk?.flush(); localFilesDisk?.flush(); } catch { /* disk */ }
});
