import { app, BrowserWindow, BrowserView, ipcMain, Menu, Tray, nativeImage, shell, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { pathToFileURL } from 'url';
import { platform } from 'os';
import { execFile } from 'child_process';
import Store from 'electron-store';
import { autoUpdater } from 'electron-updater';

import { PresenceService } from './services/presenceService';
import { LastfmService } from './services/lastfmService';
import { BandcampApi, parseBandcampPlaylistBlob } from './services/bandcampApi';
import { buildExtractorScript } from './services/queueExtractor';
import { buildId3v23 } from './services/id3';
import { readLocalTags, AUDIO_EXTENSIONS } from './services/localTags';
import type { NowPlaying, ResolveStreamRequest, ResolveStreamResponse, TralbumType, PlayerTrack } from './shared/types';

const darkReaderPath = require.resolve('darkreader/darkreader.js');
const darkReaderJS = fs.readFileSync(darkReaderPath, 'utf8');

// last-resort crash telemetry: log to userData/crash.log
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

// light theme: keep bandcamp's own look, just hide scrollbars & the banner
const LIGHT_CSS = `
    * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
    ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
    .editorial-recommendations-banner { display: none !important; }
    body.home .editorial-recommendations-banner { display: block !important; }
`;

// per-navigation theme css
const ANTI_FLASH_CSS = `
    html { background-color: #181a1b !important; }
    html:not([data-darkreader-scheme="dark"]) body { opacity: 0 !important; }

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

// --- big on-disk caches (own files, debounced writes) ------------------------
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
// custom playlists built from the collection view
type PlaylistEntryT = {
    id: string; title: string; artist: string; album: string; art: string;
    duration: number; url: string; bandId: string; tralbumId: string; tralbumType: TralbumType;
};
type PlaylistT = {
    id: string; name: string; createdAt: number; entries: PlaylistEntryT[]; desc?: string; cover?: string;
    bcId?: number;
};
// local files library: files are parsed once into an index keyed by path
type LocalTrackT = {
    id: string; file: string; title: string; artist: string; album: string; albumArtist: string;
    year: number; trackNum: number; genre: string[]; duration: number;
    art: string;
    addedAt: number;
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

// --- local files library helpers (ids are namespaced 'local:…') -------------
const LOCAL_PREFIX = 'local:';
/** owned = collection item with a redownload url; all downloading is gated on this. */
function ownsRelease(type: unknown, id: unknown): boolean {
    const tid = toIdStr(id);
    if (!tid) return false;
    const t = type === 't' ? 't' : 'a';
    return collectionItemsDisk.get().some((c: any) => !c.wish && c.tralbumType === t && c.tralbumId === tid && c.downloadUrl);
}
const isLocalId = (id: unknown): boolean => String(id || '').startsWith(LOCAL_PREFIX);
const localFileUrl = (p: string): string => { try { return p ? pathToFileURL(p).href : ''; } catch { return ''; } };
function localAlbumKey(t: { albumArtist: string; artist: string; album: string; id: string }): string {
    if (!t.album) return LOCAL_PREFIX + t.id;
    const h = crypto.createHash('md5').update(((t.albumArtist || t.artist) + '\0' + t.album).toLowerCase()).digest('hex').slice(0, 16);
    return LOCAL_PREFIX + h;
}
// grouped local library memoized against array identity + length
let localGroupsCache: { src: LocalTrackT[]; len: number; map: Map<string, LocalTrackT[]> } | null = null;
function localGroups(): Map<string, LocalTrackT[]> {
    const lib = localFilesDisk.get();
    if (localGroupsCache && localGroupsCache.src === lib && localGroupsCache.len === lib.length) return localGroupsCache.map;
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
// contentView is an alias for the *active* tab's view; every place that navigates / traps / injects operates on it
let contentView: BrowserView;
let playerView: BrowserView;
let collectionView: BrowserView;
let collectionVisible = false;
let feedView: BrowserView;
let feedVisible = false;
let spotlightWin: BrowserWindow | null = null;

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
const isMac = platform() === 'darwin';
const globalUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
app.userAgentFallback = globalUserAgent;

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

// second-instance launch while hidden to tray: bring the window back
function showMainWindow() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
}
app.on('second-instance', showMainWindow);
app.on('activate', showMainWindow);

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
    if (collectionView && collectionVisible) collectionView.setBounds(contentRect);
    if (feedView && feedVisible) feedView.setBounds(contentRect);
}

function setupTray() {
    // macOS menu bar wants a 16pt template image (trayTemplate.png + @2x)
    const iconPath = path.join(__dirname, isMac ? '../assets/trayTemplate.png' : '../assets/bandcamp-button-circle-black-64.png');
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Bandcamp Desktop');
    // right click menu is only reliable way to quit when close to tray is on
    const menu = Menu.buildFromTemplate([
        { label: 'Show Bandcamp', click: () => { mainWindow.show(); mainWindow.focus(); } },
        { label: 'Hide to tray', click: () => mainWindow.hide() },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
    ]);
    const toggle = () => {
        const hideIt = isMac ? (mainWindow.isVisible() && mainWindow.isFocused()) : mainWindow.isVisible();
        if (hideIt) mainWindow.hide();
        else showMainWindow();
    };
    if (isMac) {
        // macOS: setContextMenu would make a left click open the menu instead of toggling
        tray.on('click', toggle);
        tray.on('right-click', () => tray?.popUpContextMenu(menu));
    } else {
        tray.setContextMenu(menu);
        tray.on('click', toggle);
    }
}

// mac: after a drag-install the .dmg is usually still mounted
const run = (file: string, args: string[], timeout: number) => new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout }, (err, out) => (err ? reject(err) : resolve(String(out)))));
async function offerInstallerCleanup(): Promise<void> {
    if (!isMac || !app.isPackaged || !mainWindow || mainWindow.isDestroyed()) return;
    const bundle = path.resolve(process.execPath, '../../..');
    if (bundle.startsWith('/Volumes/')) return;
    let images: any[] = [];
    try {
        images = JSON.parse(await run('/bin/sh', ['-c', 'hdiutil info -plist | plutil -convert json -o - -'], 8000)).images || [];
    } catch { return; }
    for (const img of images) {
        const dmg = String(img['image-path'] || '');
        const mount = ((img['system-entities'] || []) as any[])
            .map((e) => String(e['mount-point'] || ''))
            .find((m) => m && fs.existsSync(path.join(m, path.basename(bundle))));
        if (!dmg || !mount) continue;
        if (store.get('installerCleanupAsked') === dmg) return;
        store.set('installerCleanupAsked', dmg);
        const { response } = await dialog.showMessageBox(mainWindow, {
            type: 'question', buttons: ['Eject and Move to Trash', 'Not Now'], defaultId: 0, cancelId: 1,
            message: 'Bandcamp is installed',
            detail: `Eject the installer disk image "${path.basename(dmg)}" and move it to the Trash?`,
        });
        if (response !== 0) return;
        try { await run('hdiutil', ['detach', mount], 15000); }
        catch { try { await run('hdiutil', ['detach', '-force', mount], 15000); } catch { return; } }
        try { await shell.trashItem(dmg); } catch { /* image already gone */ }
        return;
    }
}

// child popups of a fullscreen mac window otherwise land on another Space (invisible)
function keepChildVisible(win: BrowserWindow): void {
    if (!isMac || !mainWindow || mainWindow.isDestroyed()) return;
    try { if (mainWindow.isFullScreen()) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch { /* ignore */ }
}

function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        if (settingsWindow.isMinimized()) settingsWindow.restore();
        if (!settingsWindow.isVisible()) settingsWindow.show();
        keepChildVisible(settingsWindow);
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
        frame: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    keepChildVisible(settingsWindow);
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

// external hosts that pop a separate window
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

// ui theme: dark (darkreader) by default
function getTheme(): 'dark' | 'light' {
    return store.get('theme', 'dark') === 'light' ? 'light' : 'dark';
}

// artist/label pages
function isArtistPage(url: string): boolean {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return !(h === 'bandcamp.com' || h === 'www.bandcamp.com' || h === 'daily.bandcamp.com');
    } catch { return false; }
}

// fan playlist pages ship their own dark design
function isPlaylistPage(url: string): boolean {
    try {
        const u = new URL(url);
        return /(^|\.)bandcamp\.com$/i.test(u.hostname) && /\/playlist(\/|$)/.test(u.pathname);
    } catch { return false; }
}

// effective theme per page: dark, except artist pages (unless opted in) and natively-dark playlist pages
function themeForUrl(url: string): 'dark' | 'light' {
    if (getTheme() === 'light') return 'light';
    if (isPlaylistPage(url)) return 'light';
    if (store.get('darkArtistPages', false) !== true && isArtistPage(url)) return 'light';
    return 'dark';
}

// opt-in on-disk release cache: covers + the release index
function cacheReleasesOn(): boolean { return store.get('cacheReleases', false) === true; }
// which window-bar controls are visible; home defaults hidden
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
// covers dir, resolved once
let artDirMemo = '';
function artCacheDir(): string {
    if (artDirMemo) return artDirMemo;
    const custom = store.get('cacheDir', '') as string;
    const base = custom && typeof custom === 'string' && fs.existsSync(custom) ? custom : app.getPath('userData');
    const d = path.join(base, 'art-cache');
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* exists */ }
    artDirMemo = d;
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
// one directory listing serves every cover lookup
let artNamesMemo: { dir: string; names: Set<string> } | null = null;
function artCacheNames(): Set<string> {
    const dir = artCacheDir();
    if (artNamesMemo && artNamesMemo.dir === dir) return artNamesMemo.names;
    let names: Set<string>;
    try { names = new Set(fs.readdirSync(dir)); } catch { names = new Set(); }
    artNamesMemo = { dir, names };
    return names;
}
/** a freshly mirrored cover is usable immediately, without re-listing. */
function artCacheRemember(file: string): void {
    if (artNamesMemo) artNamesMemo.names.add(path.basename(file));
}
function invalidateArtCache(): void { artDirMemo = ''; artNamesMemo = null; }
function localArtUrl(type: string, id: string): string {
    const name = type + toIdStr(id) + '.jpg';
    if (!artCacheNames().has(name)) return '';
    try { return pathToFileURL(path.join(artCacheDir(), name)).href; } catch { return ''; }
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

// small transient toast painted into the content page
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

// open a bandcamp url in a plain secondary window (middle click / open in new window)
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
    initDiskCaches();
    presenceService = new PresenceService(store);
    lastfmService = new LastfmService(store);
    bandcampApi = new BandcampApi(() => (contentView ? contentView.webContents.session : null));

    // surface bandcamp's HTTP 429 throttling in our own styled window, at most once per session
    let notice429Shown = false;
    let notice429Win: BrowserWindow | null = null;
    bandcampApi.on429 = () => {
        if (notice429Shown || store.get('hide429Notice', false) === true) return;
        if (!mainWindow || mainWindow.isDestroyed()) return;
        notice429Shown = true;
        try {
            notice429Win = new BrowserWindow({
                width: 470, height: 220, parent: mainWindow, frame: false, resizable: false,
                backgroundColor: '#181a1b',
                webPreferences: { nodeIntegration: true, contextIsolation: false },
            });
            keepChildVisible(notice429Win);
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
        ...(isMac ? { trafficLightPosition: { x: 12, y: 13 } } : {}),
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

    wireContentView(contentView);

    collectionView.webContents.loadFile(path.join(__dirname, 'collection', 'collection.html'));
    feedView.webContents.loadFile(path.join(__dirname, 'feed', 'feed.html'));
    for (const v of [headerView, playerView, collectionView, feedView]) wireShortcutsOn(v.webContents);

    // opt-in (off by default): pre-fetch the collection shortly after startup so opening the view is instant
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

    // which track a trapped stream url is for, so the throttle can dedupe by track (urls carry rotating tokens)
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

    // act only on traps that follow a real user gesture
    let lastActedId = '';
    let lastActedAt = 0;
    let userGestureAt = 0;
    let gestureSeen = false;
    let fallbackCooldownUntil = 0;
    // app-wide customizable shortcuts (collection / feed / home / downloads / search)
    function handleShortcut(input: Electron.Input): boolean {
        if (input.type !== 'keyDown') return false;
        if (!input.control && !input.alt && !input.meta) return false;
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
    // assigned once the collection fetcher exists
    let onCollectAction: ((removal: boolean) => void) | null = null;
    ipcMain.on('player:user-gesture', () => { gestureSeen = true; userGestureAt = Date.now(); });

    session.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
        const reqUrl = details.url;

        if (isAudioStream(reqUrl)) {
            if (contentView && details.webContentsId === contentView.webContents.id) {
                callback({ cancel: true });

                const now = Date.now();
                const trapId = streamTrackId(reqUrl);
                if (trapId && trapId === lastActedId && now - lastActedAt < 1500) {
                    if (devMode) console.log('[bcrpc] trap skip (dup) id=' + trapId);
                    return;
                }
                const authorized = gestureSeen
                    ? (userGestureAt !== 0 && now - userGestureAt < 5000)
                    : (now >= fallbackCooldownUntil);
                if (!authorized) {
                    if (devMode) console.log('[bcrpc] trap skip (' + (gestureSeen ? 'no gesture' : 'cooldown') + ') id=' + trapId);
                    return;
                }
                if (gestureSeen) userGestureAt = 0;
                else fallbackCooldownUntil = now + 1200;
                lastActedId = trapId;
                lastActedAt = now;

                const format = reqUrl.includes('.m3u8') ? 'hls' : 'raw';
                const seq = ++trapSeq;


                if (devMode) {
                    console.log('[bcrpc] trap fire id=' + trapId + ' ' + reqUrl.slice(0, 90));
                    contentView.webContents.executeJavaScript(
                        "({u:location.href,cap:!!window.__bcrpcCapture,dn:Object.keys((window.__bcrpc&&window.__bcrpc.discover)||{}).length,pl:!!document.getElementById('PlaylistPage'),td:!!window.TralbumData})"
                    ).then((s: any) => console.log('[bcrpc] page ' + JSON.stringify(s))).catch(() => {});
                }

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
                        if (stale) return;
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


        if (/\/(?:un)?collect_item_cb|\/wishlist_cb|hide_unhide_item/.test(reqUrl)) {
            const removal = /uncollect_item_cb|hide_unhide_item/.test(reqUrl);
            try { onCollectAction && onCollectAction(removal); } catch { /* not ready yet */ }
        }

        callback({ cancel: false });
    });

    // fan playlist page play buttons: the preload intercepts them
    ipcMain.on('app:playlist-play', (_e, index?: unknown) => {
        if (!contentView || contentView.webContents.isDestroyed()) return;
        const seq = ++trapSeq;
        const wanted = Math.max(0, Math.floor(Number(index) || 0));
        contentView.webContents.executeJavaScript(
            `(function(){var el=document.getElementById('PlaylistPage')||document.querySelector('[data-blob]');return el?(el.getAttribute('data-blob')||''):'';})()`
        ).then((raw: any) => {
            if (seq !== trapSeq) return;
            const page = parseBandcampPlaylistBlob(String(raw || ''));
            if (page.ok && page.tracks.length) {
                const queue: PlayerTrack[] = page.tracks.map((t) => ({
                    id: t.id, title: t.title, artist: t.artist, album: t.album,
                    art: t.artId ? `https://f4.bcbits.com/img/a${t.artId}_9.jpg` : '',
                    src: '', duration: t.duration, url: t.url,
                    bandId: t.bandId, tralbumId: t.albumId || t.id, tralbumType: (t.albumId ? 'a' : 't') as TralbumType,
                }));
                const active = Math.min(wanted, queue.length - 1);
                if (devMode) console.log('[bcrpc] playlist-play blob n=' + queue.length + ' active=' + active);
                if (playerView && !playerView.webContents.isDestroyed()) {
                    playerView.webContents.send('player:stream-incoming', { queue, activeIndex: active, context: 'playlist', format: 'raw' });
                }
                return;
            }
            contentView.webContents.executeJavaScript(buildExtractorScript('about:playlist', 'raw'))
                .then((data: any) => {
                    if (seq !== trapSeq) return;
                    if (devMode) console.log('[bcrpc] playlist-play legacy ' + (data?.queue ? 'n=' + data.queue.length : 'EMPTY'));
                    if (data?.queue?.length && playerView && !playerView.webContents.isDestroyed()) {
                        playerView.webContents.send('player:stream-incoming', data);
                    }
                })
                .catch(() => { /* nothing to play */ });
        }).catch((err: any) => { if (devMode) console.log('[bcrpc] playlist-play ERROR ' + (err && (err.message || err))); });
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

    session.webRequest.onBeforeSendHeaders((details, callback) => {
        if (details.url.includes('google') || details.url.includes('discord')) {
            callback({ requestHeaders: details.requestHeaders });
            return;
        }
        const headers = { ...details.requestHeaders };
        let host = '';
        try { host = new URL(details.url).hostname.toLowerCase(); } catch { /* leave blank */ }
        // exact-suffix host checks
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

    // a mouse back/fwd click can fire BOTH an os app-command and a page mouseup
    let lastNavAt = 0;
    const navGo = (dir: 'back' | 'forward') => {
        const now = Date.now();
        if (now - lastNavAt < 600) return;
        lastNavAt = now;
        const nav = contentView.webContents.navigationHistory;
        if (dir === 'back' && nav.canGoBack()) nav.goBack();
        else if (dir === 'forward' && nav.canGoForward()) nav.goForward();
    };
    // force navigation even when the page is wedged
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
    // home btn returns to the homepage, closing the collection overlay if it's open
    ipcMain.on('app:home', () => {
        closeCollection();
        closeFeed();
        closeSearch();
        hardLoad('https://bandcamp.com');
    });

    // clicking track title / artist name in player bar (or a feed card) navs page
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
            closeFeed(); closeSearch();
            mainWindow.addBrowserView(collectionView);
            mainWindow.setTopBrowserView(headerView);
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
            closeCollection(); closeSearch();
            mainWindow.addBrowserView(feedView);
            mainWindow.setTopBrowserView(headerView);
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

    // one page of the fan feed
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
            keepChildVisible(spotlightWin);
            spotlightWin.loadFile(path.join(__dirname, 'search', 'search.html'));
            spotlightWin.webContents.on('did-finish-load', () => {
                if (spotlightWin && !spotlightWin.isDestroyed()) spotlightWin.webContents.send('gsearch:shown');
            });
            // esc handled in MAIN so it works no matter what the page does
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

    // fetch the whole fan collection (paginated), streaming a running count back
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
    // cache-first: the saved listing loads instantly and the network only fetches items newer than the cache
    let collFetchActive = false;
    const fetchCollectionAndWishlist = async (fullRescan = false): Promise<{ ok: boolean; count: number; cached?: boolean; error?: string }> => {
        if (collFetchActive) return { ok: true, count: 0 };
        collFetchActive = true;
        try {
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
                    const ownedKeys = new Set<string>(freshOwned.map((c) => c.tralbumType + c.tralbumId));
                    const fresh = [...freshOwned, ...freshWish.filter((c) => !ownedKeys.has(c.tralbumType + c.tralbumId))];
                    if (devMode) console.log('[bcrpc] collection:fetch cache=' + cached.length + ' new=' + fresh.length);
                    const ownedTotal = await bandcampApi.fetchOwnedTotal();
                    const ownedHave = [...fresh, ...cached.filter((c: any) => !fresh.some((f) => f.tralbumType + f.tralbumId === c.tralbumType + c.tralbumId))]
                        .filter((c: any) => !c.wish).length;
                    if (ownedTotal > 0 && ownedTotal < ownedHave) {
                        setTimeout(() => { void fetchCollectionAndWishlist(true); }, 1500);
                    }
                    if (fresh.length) {
                        const freshKeys = new Set<string>(fresh.map((c) => c.tralbumType + c.tralbumId));
                        const merged = [...fresh, ...cached.filter((c: any) => !freshKeys.has(c.tralbumType + c.tralbumId))];
                        const byKey = new Map<string, any>();
                        for (const it of merged) {
                            const k = it.tralbumType + it.tralbumId;
                            const prev = byKey.get(k);
                            if (!prev || (prev.wish === true && it.wish !== true)) byKey.set(k, it);
                        }
                        merged.length = 0;
                        merged.push(...byKey.values());
                        const total = merged.length;
                        sendCollItems(fresh, total, total);
                        collectionItemsDisk.replace(merged);
                        return { ok: true, count: total };
                    }
                } catch { /* cache alone is fine */ }
                return { ok: true, count: cached.length, cached: true };
            }
            try {
                const owned = await bandcampApi.fetchCollection(20000, sendCollItems, undefined, 'collection');
                const ownedKeys = new Set<string>(owned.map((c) => c.tralbumType + c.tralbumId));
                const wishRaw = await bandcampApi.fetchCollection(20000, sendCollItems, undefined, 'wishlist');
                const wish = wishRaw.filter((c) => !ownedKeys.has(c.tralbumType + c.tralbumId));
                const items = [...owned, ...wish];
                if (devMode) console.log('[bcrpc] collection:fetch ' + owned.length + ' owned + ' + wish.length + ' wishlist');
                if (items.length) {
                    if (cacheReleasesOn()) collectionItemsDisk.replace(items);
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
            collectTimer = setTimeout(() => {
                const full = collectRemoval;
                collectRemoval = false;
                void fetchCollectionAndWishlist(full);
            }, 3000);
        };
    }

    // a purchased TRACK in an album carries no artist/art of its own - resolve it through its parent album
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
                let active = typeof req.activeIndex === 'number' ? req.activeIndex : resolved.activeIndex;
                if (req.trackId) { const i = tracks.findIndex((t) => t.id === toIdStr(req.trackId) || t.id === String(req.trackId)); if (i !== -1) active = i; }
                active = Math.max(0, Math.min(active, tracks.length - 1));
                if (req.trackOnly) {
                    tracks = [tracks[active]];
                    active = 0;
                }
                trapSeq++;
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
            let tags: string[] = idxCache[k]?.g || sessionDetails.get(k)?.g || [];
            if (!tags.length && !idxCache[k] && !sessionDetails.get(k)) {
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

    // fill in real release years for the collection (bandcamp's collection api omits them)
    ipcMain.on('collection:enrich-years', async (_e, reqs: { tralbumId: string; tralbumType: TralbumType; bandId: string }[]) => {
        if (!Array.isArray(reqs) || !reqs.length) return;
        reqs = reqs.filter((r) => !isLocalId(r.tralbumId));
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
        await Promise.all([worker(), worker(), worker()]);
        send(pending.splice(0));
        yearsDisk.save();
        if (collectionView && !collectionView.webContents.isDestroyed()) collectionView.webContents.send('collection:years-done');
    });

    // build the release index (tags + tracklist per item) for search & the list view; cached to disk
    interface IndexRow { key: string; blob: string; tags: string[]; tracks: [string, number][] }
    type IndexCacheEntry = { g: string[]; t: [string, number][]; y: number; a?: string };
    const indexRowOf = (k: string, c: IndexCacheEntry): IndexRow => ({
        key: k,
        blob: ((c.g || []).join(' ') + ' ' + (c.t || []).map((x) => x[0]).join(' ')).toLowerCase().replace(/\s+/g, ' ').trim(),
        tags: c.g || [],
        tracks: c.t || [],
    });
    let indexRunActive = false;
    // keys of releases actually in the user's collection: the ONLY ones whose details are persisted to disk
    const collectionKeys = new Set<string>();
    // last request list (with art urls)
    let lastIndexReqs: { tralbumId: string; tralbumType: TralbumType; bandId: string; art?: string }[] = [];
    const idxAlive = () => collectionView && !collectionView.webContents.isDestroyed();
    const idxSleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    const sendIndexStatus = (text: string) => { if (idxAlive()) collectionView.webContents.send('collection:index-status', text); };

    // mirror covers to disk (cdn fetches, light pacing)
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
                if (artCacheNames().has(path.basename(ap))) continue;
                const buf = await bandcampApi.fetchBinary(art);
                if (buf && buf.length) { try { fs.writeFileSync(ap, buf); artCacheRemember(ap); } catch { /* disk */ } }
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
        void mirrorArt(reqs);

        // rest for a while, streaming a countdown into the toolbar indicator
        const rest = async (seconds: number, why: string) => {
            for (let left = seconds; left > 0 && idxAlive(); left -= 5) {
                sendIndexStatus(`${why}, resuming in ${left}s`);
                await idxSleep(Math.min(5, left) * 1000);
            }
            sendIndexStatus('');
        };

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
                while (bandcampApi.interactiveIdleMs() < 4000) await idxSleep(1500);
                let info: { tags: string[]; tracks: { title: string; duration: number }[]; year: number; about: string } | null = null;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const res = await bandcampApi.fetchSearchIndex(r);
                    if (res.ok) { info = res; break; }
                    if (!res.retryable) break;
                    await idxSleep(1500 * Math.pow(2, attempt));
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

    // release details for feed cards etc: collection items go to the persistent index
    const sessionDetails = new Map<string, IndexCacheEntry>();
    ipcMain.handle('release:details', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string }) => {
        const type: TralbumType = req.tralbumType === 't' ? 't' : 'a';
        const k = type + toIdStr(req.tralbumId);
        const cache = releaseIndexDisk.get();
        let c = cache[k] || sessionDetails.get(k);
        if (!c) {
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

    // queue a release (or one song via trackId/trackIndex) without interrupting playback
    ipcMain.handle('collection:enqueue', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string; trackId?: string; trackIndex?: number }) => {
        try {
            const resolved = await resolveRelease(req);
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
    // add a whole release or one song to a playlist
    ipcMain.handle('playlists:add', async (_e, req: { id: string; tralbumId: string; tralbumType: TralbumType; bandId: string; trackId?: string; trackIndex?: number }) => {
        try {
            const p = playlistById(req?.id);
            if (!p) return { ok: false, error: 'no such playlist' };
            const resolved = await resolveRelease(req);
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
                if (have.has(t.tralbumType + t.tralbumId + ':' + t.id)) continue;
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
        trapSeq++;
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
    // custom cover: picked from disk, normalized to png immediately
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
    // download a playlist into <downloads>/<name>/ with cover, description and order file
    ipcMain.handle('playlists:download', (_e, id: unknown) => {
        const p = playlistById(id);
        if (!p || !p.entries.length) return { ok: false, error: 'empty playlist' };
        if (streamDlActive) return { ok: false, error: 'a download is already running' };
        streamDlActive = true;
        openDownloadsPanel();
        const entryId = ++dlSeq;
        const dlState = { canceled: false };
        streamDownloads.set(entryId, dlState);
        const entry: DlEntry = { id: entryId, name: `Playlist - ${p.name}`, state: 'progressing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
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

                const orderLines = p.entries.map((e, i) => `${String(i + 1).padStart(2, '0')}. ${e.artist} - ${e.title}`);
                const descTxt = p.name + '\n' + '='.repeat(Math.max(4, Math.min(60, p.name.length))) + '\n\n' +
                    (p.desc ? p.desc + '\n\n' : '') + 'Track order:\n' + orderLines.join('\n') + '\n';
                try { fs.writeFileSync(path.join(dir, 'description.txt'), descTxt, 'utf8'); } catch { /* disk */ }

                const artCache = new Map<string, Buffer | null>();
                const files: { file: string; title: string; artist: string; duration: number }[] = [];
                let skipped = 0;
                for (let i = 0; i < p.entries.length; i++) {
                    if (dlState.canceled) {
                        prog('cancelled', Math.round((i / p.entries.length) * 100));
                        break;
                    }
                    const e = p.entries[i];
                    const pos = i + 1;
                    entry.name = `${p.name} - ${e.title} (${pos}/${p.entries.length})`;
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
                            if (!fs.existsSync(lt.file)) continue;
                            const file = path.join(dir, nameOf(path.extname(lt.file).toLowerCase() || '.mp3'));
                            fs.copyFileSync(lt.file, file);
                            files.push({ file, title: e.title, artist: e.artist, duration: e.duration || 0 });
                            continue;
                        }
                        if (!ownsRelease(e.tralbumType, e.tralbumId)) { skipped++; continue; }
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
                        await new Promise((res) => setTimeout(res, 250));
                    } catch { /* skip this entry, carry on */ }
                }

                if (!dlState.canceled) {
                    writePlaylistFile(dir, sanitizeName(p.name), p.name, files);
                    entry.name = `${p.name} (${files.length}/${p.entries.length} tracks` +
                        (skipped ? `, ${skipped} not owned` : '') + ')';
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

    // import a bandcamp playlist by url (toolbar menu or the on-page button)
    ipcMain.handle('playlists:import', async (_e, url: unknown) => {
        const u = String(url || '').trim().split(/[?#]/)[0];
        if (!/^https:\/\/[^/]*bandcamp\.com\/(?:[^/]+\/)?playlist\/[^/]+/.test(u)) {
            return { ok: false, error: 'that is not a bandcamp playlist url' };
        }
        const page = await bandcampApi.fetchBandcampPlaylist(u);
        if (!page.ok) return { ok: false, error: page.error };
        if (!page.tracks.length) return { ok: false, error: 'that playlist has no tracks' };
        const entries: PlaylistEntryT[] = page.tracks.map((t) => ({
            id: t.id, title: t.title, artist: t.artist, album: t.album,
            art: t.artId ? `https://f4.bcbits.com/img/a${t.artId}_9.jpg` : '',
            duration: t.duration, url: t.url, bandId: t.bandId,
            tralbumId: t.albumId || t.id, tralbumType: (t.albumId ? 'a' : 't') as TralbumType,
        }));
        const all = playlistsDisk.get();
        let p = page.playlistId ? all.find((x) => x.bcId === page.playlistId) : undefined;
        const created = !p;
        if (!p) {
            p = {
                id: 'pl' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
                name: page.title, createdAt: Date.now(), entries: [],
            };
            all.push(p);
        }
        p.bcId = page.playlistId || undefined;
        p.name = page.title;
        if (page.description) p.desc = page.description.slice(0, 2000);
        p.entries = entries;
        playlistsDisk.save();
        if (page.imageId && !p.cover) {
            for (const iu of [`https://f4.bcbits.com/img/a${page.imageId}_10.jpg`, `https://f4.bcbits.com/img/${page.imageId}_10.jpg`]) {
                try {
                    const buf = await bandcampApi.fetchBinary(iu);
                    if (!buf || buf.length < 100) continue;
                    const img = nativeImage.createFromBuffer(buf);
                    if (img.isEmpty()) continue;
                    const coversDir = path.join(app.getPath('userData'), 'playlist-covers');
                    fs.mkdirSync(coversDir, { recursive: true });
                    const file = path.join(coversDir, p.id + '.png');
                    fs.writeFileSync(file, img.toPNG());
                    p.cover = file;
                    playlistsDisk.save();
                    break;
                } catch { /* try the other form */ }
            }
        }
        if (devMode) console.log(`[bcrpc] playlists:import ${created ? 'created' : 'updated'} "${p.name}" n=${entries.length}`);
        return { ok: true, id: p.id, name: p.name, count: entries.length, updated: !created };
    });

    // --- local files library ----------------------------------------------------
    const announceLocal = () => {
        const locals = localCollectionItems();
        if (locals.length && collectionView && !collectionView.webContents.isDestroyed()) {
            collectionView.webContents.send('collection:items', { items: locals, soFar: locals.length, total: 0 });
        }
    };
    // shared by the picker and the folder scan
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
    // music-folder scan (opt-in): walk the folder, import new/changed audio, drop entries whose files vanished
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
        for (const t of lib) {
            if (localAlbumKey(t) === want && t.art) { try { fs.unlinkSync(t.art); } catch { /* gone */ } }
        }
        localFilesDisk.replace(keep);
        if (collectionView && !collectionView.webContents.isDestroyed()) {
            collectionView.webContents.send('collection:remove-keys', ['a' + want]);
        }
        return { ok: true, removed };
    });

    // drag a cover out of the grid as a real file
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
            const url = String(req?.art || '').replace(/_\d+\.jpg([?#].*)?$/, '_10.jpg');
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

    // resolve a bandcamp release/track url to tracks & append to the queue
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

    // media hotkeys pressed in any view
    ipcMain.on('player:hotkey', (_e, cmd: unknown) => {
        if (playerView && !playerView.webContents.isDestroyed()) {
            playerView.webContents.send('player:hotkey', String(cmd || ''));
        }
    });

    // keep the address bar in sync with the content view (full loads + spa routes)
    const pushUrl = () => {
        if (headerView && !headerView.webContents.isDestroyed()) {
            headerView.webContents.send('nav:url', contentView.webContents.getURL());
        }
    };
    // per-view did-navigate bindings live in wireContentView
    headerView.webContents.on('did-finish-load', () => { pushUrl(); sendTabsState(); headerView.webContents.send('header:buttons', getHeaderButtons()); });

    // lazily resolve a queued track's stream url (collection items only ship metadata)
    ipcMain.handle('player:resolve-stream', async (_e, req: ResolveStreamRequest): Promise<ResolveStreamResponse> => {
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
        }
        return { token: req.token, ok: false, src: '', duration: 0, error: 'unresolved' };
    });

    // downloads land in the chosen folder w/o a save dialog
    interface DlEntry { id: number; name: string; state: string; percent: number; file: string; at: number; receivedBytes: number; totalBytes: number; speed: number; lastTime: number; lastBytes: number; }
    const dlRegistry: DlEntry[] = [];
    let dlSeq = 0;
    let downloadsWin: BrowserWindow | null = null;
    let downloadsJustOpened = false;
    let downloadsClosedAt = 0;

    const getDlHeight = () => {
        const activeCount = dlRegistry.filter(d => d.state === 'progressing').length;
        const visibleRows = Math.max(1, Math.min(3, dlRegistry.length));
        let h = 42 + (visibleRows * 54) + 16;
        if (activeCount > 1) h += 44;
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

        downloadsWin.webContents.send('downloads:list', {
            items: dlRegistry, activeCount, overallPercent, eta
        });
    };

    // progress fires many times a second per download
    let dlBroadcastTimer: ReturnType<typeof setTimeout> | null = null;
    const broadcastDownloadsSoon = () => {
        if (dlBroadcastTimer) return;
        dlBroadcastTimer = setTimeout(() => { dlBroadcastTimer = null; broadcastDownloads(); }, 100);
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

            keepChildVisible(downloadsWin);
            downloadsWin.on('blur', () => {
                if (downloadsJustOpened) return;
                if (downloadsWin && !downloadsWin.isDestroyed()) downloadsWin.close();
            });

            downloadsWin.on('closed', () => {
                downloadsClosedAt = Date.now();
                downloadsWin = null;
                if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('downloads:state', false);
            });

            downloadsWin.loadFile(path.join(__dirname, 'downloads', 'downloads.html'));
            downloadsWin.webContents.on('did-finish-load', () => broadcastDownloads());
            if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('downloads:state', true);
        } catch { downloadsWin = null; }
    };

    ipcMain.on('downloads:toggle', () => {
        if (Date.now() - downloadsClosedAt < 200) return;

        if (downloadsWin && !downloadsWin.isDestroyed()) { 
            if (downloadsJustOpened) return;
            downloadsWin.close(); 
        } else { 
            openDownloadsPanel(); 
        }
    });

    // the popup measures its real content and asks for that height
    ipcMain.on('downloads:resize', (_e, h: unknown) => {
        if (!downloadsWin || downloadsWin.isDestroyed()) return;
        const want = Math.max(80, Math.min(600, Math.round(Number(h) || 0)));
        if (!want) return;
        const b = mainWindow.getContentBounds();
        downloadsWin.setBounds({ width: 360, height: want, x: Math.max(0, b.x + b.width - 372), y: b.y + 44 });
    });

    ipcMain.on('downloads:cancel', (_e, id: number) => {
        const entry = dlRegistry.find(d => d.id === id);
        if (entry && (entry.state === 'progressing' || entry.state === 'preparing')) {
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
        const claimedId = awaitingTransfer.shift();
        const claimed = claimedId ? dlRegistry.find((d) => d.id === claimedId && d.state === 'preparing') : undefined;
        const entryId = claimed ? claimed.id : ++dlSeq;
        const entry: DlEntry = claimed || { id: entryId, name, state: 'progressing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
        if (claimed) {
            entry.name = name;
            entry.state = 'progressing';
            entry.at = Date.now();
            entry.lastTime = Date.now();
        } else {
            dlRegistry.unshift(entry);
        }
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

            if (headerView && !headerView.webContents.isDestroyed()) {
                headerView.webContents.send('download:progress', { name, percent: entry.percent, state: 'progressing' });
            }
            broadcastDownloadsSoon();
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
        } else {
            out = '#EXTM3U\n' + files.map((f, i) =>
                `#EXTINF:${f.duration || -1},${f.artist} - ${f.title}\n${names[i]}`).join('\n') + '\n';
        }
        try { fs.writeFileSync(path.join(dir, (baseName || sanitizeName(album)) + '.' + fmt), out, 'utf8'); } catch { /* disk */ }
    }
    // ownership check for the on-page download button: owned collection items carry their bandcamp redownload page url
    ipcMain.handle('release:download-info', (_e, req: { tralbumId?: string; tralbumType?: string }) => {
        const id = toIdStr(req?.tralbumId);
        const type = req?.tralbumType === 't' ? 't' : 'a';
        if (!id || !ownsRelease(type, id)) return { owned: false };
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
    const awaitingTransfer: number[] = [];
    ipcMain.handle('download:start', async (_e, formatUrl: string) => {
        openDownloadsPanel();
        const entryId = ++dlSeq;
        const entry: DlEntry = { id: entryId, name: 'Preparing on Bandcamp...', state: 'preparing', percent: 0, file: '', at: Date.now(), receivedBytes: 0, totalBytes: 0, speed: 0, lastTime: Date.now(), lastBytes: 0 };
        dlRegistry.unshift(entry);
        const prep = { canceled: false };
        streamDownloads.set(entryId, prep);
        broadcastDownloads();
        try {
            const finalUrl = await bandcampApi.prepareDownload(formatUrl, {
                onWait: (secs) => {
                    if (prep.canceled || entry.state !== 'preparing') return;
                    entry.name = `Preparing on Bandcamp... (${secs}s)`;
                    broadcastDownloads();
                },
                canceled: () => prep.canceled,
            });
            if (prep.canceled) return { ok: false, error: 'cancelled' };
            if (!finalUrl) { entry.state = 'interrupted'; broadcastDownloads(); return { ok: false, error: 'cancelled' }; }
            awaitingTransfer.push(entryId);
            session.downloadURL(finalUrl);
            setTimeout(() => {
                if (entry.state !== 'preparing') return;
                const i = awaitingTransfer.indexOf(entryId);
                if (i !== -1) awaitingTransfer.splice(i, 1);
                entry.state = 'interrupted';
                entry.name = 'Bandcamp never started the transfer';
                broadcastDownloads();
            }, 90000);
            if (devMode) console.log('[bcrpc] download:start ' + finalUrl.slice(0, 70));
            return { ok: true };
        } catch (err: any) {
            entry.state = 'interrupted';
            entry.name = String(err?.message || 'download failed');
            broadcastDownloads();
            return { ok: false, error: err?.message || 'failed' };
        } finally {
            streamDownloads.delete(entryId);
        }
    });

    // custom player is the single source of now-playing truth (discord + last.fm)
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
    // preload reads the effective theme synchronously at document-start so its anti-flash cloak matches
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
        invalidateArtCache();
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
        if (store.get('musicFolderScan', false) === true) setTimeout(() => { void scanMusicFolder(); }, 300);
        return { ok: true, dir: res.filePaths[0] };
    });


    // settings + last.fm auth bridge
    ipcMain.on('settings:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:settings] ' + String(msg)); });
    ipcMain.handle('settings:get', () => {
        if (devMode) console.log('[bcrpc] settings:get');
        return {
            lastfm: store.get('lastfm', { apiKey: '', apiSecret: '', username: '', enabled: true }),
            lastfmStatus: lastfmService.status(),
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
            const incomingLfm = { ...(data.lastfm || {}) };
            if (!String(incomingLfm.apiKey || '').trim() && existing.apiKey) delete incomingLfm.apiKey;
            if (!String(incomingLfm.apiSecret || '').trim() && existing.apiSecret) delete incomingLfm.apiSecret;
            store.set('lastfm', { ...existing, ...incomingLfm });
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
                presenceService.reconnect();
            }
            if (typeof data.autoLoadCollection === 'boolean') store.set('autoLoadCollection', data.autoLoadCollection);
            if (typeof data.musicFolderScan === 'boolean') {
                const was = store.get('musicFolderScan', false) === true;
                store.set('musicFolderScan', data.musicFolderScan);
                if (data.musicFolderScan && !was) setTimeout(() => { void scanMusicFolder(); }, 300);
            }
            if (typeof data.dlPlaylistFormat === 'string' && ['m3u', 'pls', 'wpl', 'zpl', 'none'].includes(data.dlPlaylistFormat)) store.set('dlPlaylistFormat', data.dlPlaylistFormat);
            if (typeof data.cacheReleases === 'boolean') {
                const wasOn = cacheReleasesOn();
                store.set('cacheReleases', data.cacheReleases);
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
                presenceService.refresh();
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

        // nav invalidates in-flight extractor results (a late trap must not load into the player after moving on)
        wc.on('did-start-navigation', (...args: any[]) => {
            const isMainFrame = args.length >= 4 ? Boolean(args[3]) : true;
            if (isMainFrame && isActive()) { trapSeq++; userGestureAt = 0; bandcampApi.noteInteractive(); }
        });

        wc.setWindowOpenHandler((details) => {
            const asNew = details.disposition === 'background-tab' || details.disposition === 'new-window';
            if (asNew && isBandcampUrl(details.url)) newTab(details.url, details.disposition !== 'background-tab');
            else if (asNew) openInNewWindow(details.url);
            else wc.loadURL(details.url).catch(() => {});
            return { action: 'deny' };
        });

        // right-click menu: add-to-queue
        wc.on('context-menu', (_e, params) => {
            const link = params.linkURL || '';
            const pageUrl = wc.getURL();
            const linkIsRelease = isBandcampUrl(link) && /\/(album|track)\//.test(link);
            const pageIsRelease = isBandcampUrl(pageUrl) && /\/(album|track)\//.test(pageUrl);
            const tmpl: Electron.MenuItemConstructorOptions[] = [];
            if (linkIsRelease) tmpl.push({ label: 'Add to queue', click: () => enqueueFromUrl(link) });
            else if (pageIsRelease) tmpl.push({ label: 'Add this release to queue', click: () => enqueueFromUrl(pageUrl) });
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

        // social/promo links open a separate window
        wc.on('will-navigate', (event, url) => {
            if (isSocialHost(url)) { event.preventDefault(); openInNewWindow(url); }
        });

        // keep url bar + tab title in sync
        const onNav = () => {
            const tab = tabs.find((t) => t.view === view);
            if (tab) {
                let ti = wc.getTitle() || '';
                
                if (ti.endsWith(' | Bandcamp')) {
                    ti = ti.replace(' | Bandcamp', '');
                }
                
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

        // grey-hang failsafe: lift the cloak if darkreader never paints
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
                liftCloakIfStuck();
                if (themeForUrl(wc.getURL()) === 'light') return;
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

        // a navigation that itself gets HTTP 429 renders an empty shell: say why and offer reload
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
                        '<div style="font-size:18px;font-weight:600;margin-bottom:10px;">Error 429 - too many requests</div>' +
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

        // track when the page's renderer wedges so hardLoad can drop it
        wc.on('unresponsive', () => { (wc as any).__hung = true; });
        wc.on('responsive', () => { (wc as any).__hung = false; });

        // ignore page beforeunload guards (electron cancels navigations they try to block)
        wc.on('will-prevent-unload', (event) => { event.preventDefault(); });
    }

    // swap the visible tab
    function setActiveTab(id: number): void {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) return;
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

    // open a new tab (bandcamp link)
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
        if (!tabs.length) newTab('https://bandcamp.com', true);
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
    // middle-click from preload: bandcamp links -> background in-app tab
    ipcMain.on('app:open-tab', (_e, url: unknown) => {
        const u = typeof url === 'string' ? url : '';
        if (!/^https?:\/\//i.test(u)) return;
        if (isBandcampUrl(u)) newTab(u, false);
        else openInNewWindow(u);
    });

    // resolve a page url for a now-playing track that has none
    ipcMain.handle('player:resolve-page', async (_e, req: { trackId?: string; bandId?: string; tralbumId?: string; tralbumType?: TralbumType }) => {
        if (isLocalId(req?.tralbumId) || String(req?.trackId || '').startsWith('L')) return { ok: false, url: '' };
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
    setTimeout(() => { void offerInstallerCleanup(); }, 1500);

    if (store.get('musicFolderScan', false) === true) {
        setTimeout(() => { void scanMusicFolder(); }, 4000);
    }

    // --- auto updates (packaged builds only) ----------------------------------
    let updStatus: { state: string; info: string } = { state: 'idle', info: '' };
    const pushUpdStatus = (state: string, info = '') => {
        updStatus = { state, info };
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('updates:status', updStatus);
    };
    if (app.isPackaged) {
        try {
            autoUpdater.setFeedURL({ provider: 'github', owner: 'elricfd', repo: 'bc-desktop' });
            autoUpdater.autoDownload = true;
            autoUpdater.on('checking-for-update', () => pushUpdStatus('checking'));
            autoUpdater.on('update-available', (info: any) => pushUpdStatus('downloading', String(info?.version || '')));
            autoUpdater.on('download-progress', (p: any) => pushUpdStatus('downloading', Math.round(Number(p?.percent) || 0) + '%'));
            autoUpdater.on('update-not-available', () => pushUpdStatus('latest'));
            autoUpdater.on('error', (err: any) => pushUpdStatus('error', String((err && (err.message || err)) || 'update check failed').slice(0, 200)));
            autoUpdater.on('update-downloaded', (info: any) => {
                pushUpdStatus('downloaded', String(info?.version || ''));
                if (headerView && !headerView.webContents.isDestroyed()) {
                    headerView.webContents.send('download:progress', { name: 'update ready - restart to install', percent: 100, state: 'completed' });
                }
            });
            autoUpdater.checkForUpdatesAndNotify().catch(() => {});
            setInterval(() => { autoUpdater.checkForUpdatesAndNotify().catch(() => {}); }, 4 * 60 * 60 * 1000);
        } catch { /* no update feed configured */ }
    }
    ipcMain.handle('updates:info', () => ({ version: app.getVersion(), packaged: app.isPackaged, status: updStatus }));
    ipcMain.handle('updates:check', async () => {
        if (!app.isPackaged) return { ok: false, error: 'dev build - self-update only works in packaged installs' };
        try {
            await autoUpdater.checkForUpdates();
            return { ok: true };
        } catch (err: any) {
            pushUpdStatus('error', String(err?.message || 'update check failed').slice(0, 200));
            return { ok: false, error: err?.message || 'check failed' };
        }
    });
    ipcMain.on('updates:install', () => { try { autoUpdater.quitAndInstall(); } catch { /* nothing downloaded */ } });
}

app.whenReady().then(init);
app.on('before-quit', () => {
    isQuitting = true;
    try { releaseIndexDisk?.flush(); collectionItemsDisk?.flush(); yearsDisk?.flush(); playlistsDisk?.flush(); localFilesDisk?.flush(); } catch { /* disk */ }
});
