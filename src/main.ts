import { app, BrowserWindow, BrowserView, ipcMain, Menu, Tray, nativeImage, shell, dialog, clipboard } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { platform } from 'os';
import Store from 'electron-store';
import { autoUpdater } from 'electron-updater';

import { PresenceService } from './services/presenceService';
import { LastfmService } from './services/lastfmService';
import { BandcampApi } from './services/bandcampApi';
import { buildExtractorScript } from './services/queueExtractor';
import type { NowPlaying, ResolveStreamRequest, ResolveStreamResponse, TralbumType } from './shared/types';

const darkReaderPath = require.resolve('darkreader/darkreader.js');
const darkReaderJS = fs.readFileSync(darkReaderPath, 'utf8');

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
let mainWindow: BrowserWindow;
let headerView: BrowserView;
// contentView is an alias for the *active* tab's view; every place that navigates
// / traps / injects operates on it. background tabs stay alive but off screen.
let contentView: BrowserView;
let playerView: BrowserView;
let collectionView: BrowserView;
let collectionVisible = false;

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
    // collection view (added only while open) fills content area
    if (collectionView && collectionVisible) collectionView.setBounds(contentRect);
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

// ui theme: 'dark' (darkreader) default, or 'light' (bandcamp's native look)
function getTheme(): 'dark' | 'light' {
    return store.get('theme', 'dark') === 'light' ? 'light' : 'dark';
}

// persist a resolved release year so year-sort enrichment is a one-time cost
function persistYear(type: string, id: string, year: number): void {
    if (!id || !year) return;
    const c = store.get('yearCache', {}) as Record<string, number>;
    c[type + ':' + id] = year;
    store.set('yearCache', c);
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
    presenceService = new PresenceService(store);
    lastfmService = new LastfmService(store);
    bandcampApi = new BandcampApi(() => (contentView ? contentView.webContents.session : null));
    setupTray();

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 850,
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

    mainWindow.addBrowserView(contentView);
    mainWindow.addBrowserView(headerView);
    mainWindow.addBrowserView(playerView);
    // collectionview added on demand when toggled open (see collection:toggle)

    wireContentView(contentView); // attach nav/trap/theme/context-menu handlers

    collectionView.webContents.loadFile(path.join(__dirname, 'collection', 'collection.html'));

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
    let trapSeq = 0;
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

        callback({ cancel: false });
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
        const isBaseBandcamp = host === 'bandcamp.com' || host === 'www.bandcamp.com';
        if (isBaseBandcamp || host.endsWith('bcbits.com') || host.includes('sndcdn')) {
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
        hardLoad('https://bandcamp.com');
    });

    // clicking track title / artist name in player bar navs page
    ipcMain.on('app:navigate', (_e, url: unknown) => {
        if (typeof url === 'string' && url.startsWith('https://')) hardLoad(url);
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

    // fetch fan whole collection (paginated) for custom view; stream running count back so the view can show load progress on big collections
    ipcMain.handle('collection:fetch', async () => {
        try {
            const items = await bandcampApi.fetchCollection(20000, (added, soFar, total) => {
                if (collectionView && !collectionView.webContents.isDestroyed()) {
                    collectionView.webContents.send('collection:items', { items: added, soFar, total });
                }
            });
            if (devMode) console.log('[bcrpc] collection:fetch ' + items.length + ' items');
            return { ok: true, count: items.length };
        } catch (err: any) {
            if (devMode) console.log('[bcrpc] collection:fetch FAILED ' + (err && (err.message || err)));
            return { ok: false, count: 0, error: err?.message || 'fetch failed' };
        }
    });

    // play release chosen in custom view: resolve full tracklist & hand to player (bypasses page trap entirely)
    ipcMain.handle('collection:play', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string; activeIndex?: number; trackId?: string }) => {
        try {
            const tracks = await bandcampApi.fetchTralbum({
                tralbumId: req.tralbumId,
                tralbumType: req.tralbumType,
                bandId: req.bandId,
            });
            if (tracks.length && playerView && !playerView.webContents.isDestroyed()) {
                // start at the chosen track (by id, else index) so the whole album
                // becomes the queue with the rest of it queued behind
                let active = typeof req.activeIndex === 'number' ? req.activeIndex : 0;
                if (req.trackId) { const i = tracks.findIndex((t) => t.id === toIdStr(req.trackId)); if (i !== -1) active = i; }
                active = Math.max(0, Math.min(active, tracks.length - 1));
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
            const tracks = await bandcampApi.fetchTralbum({ tralbumId: req.tralbumId, tralbumType: req.tralbumType, bandId: req.bandId });
            if (!tracks.length) return { ok: false, error: 'no tracks' };
            const year = bandcampApi.getReleaseYear(req.tralbumType, req.tralbumId) || await bandcampApi.fetchReleaseYear(req);
            if (year) persistYear(req.tralbumType, req.tralbumId, year);
            const first = tracks[0];
            return {
                ok: true, year,
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
        const store2 = store.get('yearCache', {}) as Record<string, number>;
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
                if (pending.length >= 25) { send(pending.splice(0)); store.set('yearCache', store2); }
            }
        };
        await Promise.all([worker(), worker(), worker()]); // modest concurrency to avoid 429s
        send(pending.splice(0));
        store.set('yearCache', store2);
        if (collectionView && !collectionView.webContents.isDestroyed()) collectionView.webContents.send('collection:years-done');
    });

    // add a release chosen in the custom collection view to the queue (no interrupt)
    ipcMain.handle('collection:enqueue', async (_e, req: { tralbumId: string; tralbumType: TralbumType; bandId: string }) => {
        try {
            const tracks = await bandcampApi.fetchTralbum({ tralbumId: req.tralbumId, tralbumType: req.tralbumType, bandId: req.bandId });
            if (tracks.length && playerView && !playerView.webContents.isDestroyed()) {
                playerView.webContents.send('player:enqueue', { tracks });
                return { ok: true, count: tracks.length };
            }
            return { ok: false, error: 'no tracks' };
        } catch (err: any) {
            return { ok: false, error: err?.message || 'enqueue failed' };
        }
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

    // keep address bar in sync w/ content view (full loads + spa route changes) & re send once header finishes loading so it isn't blank
    const pushUrl = () => {
        if (headerView && !headerView.webContents.isDestroyed()) {
            headerView.webContents.send('nav:url', contentView.webContents.getURL());
        }
    };
    // per-view did-navigate bindings live in wireContentView; on header (re)load
    // resync the url bar and tab strip so they aren't blank
    headerView.webContents.on('did-finish-load', () => { pushUrl(); sendTabsState(); });

    // lazily resolve stream url for queued track (collection items only ship metadata; actual stream fetched on demand from tralbum api)
    ipcMain.handle('player:resolve-stream', async (_e, req: ResolveStreamRequest): Promise<ResolveStreamResponse> => {
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
    session.on('will-download', (_e, item) => {
        const name = item.getFilename();
        try { item.setSavePath(path.join(getDownloadDir(), name)); } catch { /* let electron pick */ }
        const send = (o: any) => {
            if (headerView && !headerView.webContents.isDestroyed()) headerView.webContents.send('download:progress', o);
        };
        send({ name, percent: 0, state: 'progressing' });
        item.on('updated', (_ev, state) => {
            if (state !== 'progressing') return;
            const total = item.getTotalBytes();
            const percent = total > 0 ? Math.floor((item.getReceivedBytes() / total) * 100) : -1;
            send({ name, percent, state: 'progressing' });
        });
        item.on('done', (_ev, state) => {
            send({ name, percent: 100, state });
            if (state === 'completed') pageToast('downloaded ' + name);
            if (devMode) console.log('[bcrpc] download ' + state + ' ' + name);
        });
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
    ipcMain.on('player:now-playing', (_e, track: NowPlaying) => {
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
    // preload reads the theme synchronously at document-start so its anti-flash
    // cloak matches (no opacity cloak in light mode, else the page stays blank grey)
    ipcMain.on('app:get-theme', (e) => { e.returnValue = getTheme(); });

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

    // settings + last.fm auth bridge
    ipcMain.on('settings:log', (_e, msg: unknown) => { if (devMode) console.log('[bcrpc:settings] ' + String(msg)); });
    ipcMain.handle('settings:get', () => {
        if (devMode) console.log('[bcrpc] settings:get');
        return {
            lastfm: store.get('lastfm', { apiKey: '', apiSecret: '', username: '', enabled: true }),
            discordEnabled: store.get('discordEnabled', true),
            discordClientId: store.get('discordClientId', ''),
            closeToTray: store.get('closeToTray', true),
            downloadDir: getDownloadDir(),
            theme: getTheme(),
        };
    });

    ipcMain.handle('settings:save', (_e, data: any) => {
        try {
            const existing = (store.get('lastfm') as any) || {};
            store.set('lastfm', { ...existing, ...(data.lastfm || {}) });
            if (typeof data.discordEnabled === 'boolean') store.set('discordEnabled', data.discordEnabled);
            if (typeof data.closeToTray === 'boolean') store.set('closeToTray', data.closeToTray);
            if (typeof data.discordClientId === 'string') {
                store.set('discordClientId', data.discordClientId.trim());
                presenceService.reconnect(); // apply new app id now
            }
            if (typeof data.theme === 'string') {
                const next = data.theme === 'light' ? 'light' : 'dark';
                const changed = next !== getTheme();
                store.set('theme', next);
                // reload every tab so the cloak/darkreader state flips
                if (changed) tabs.forEach((t) => { if (!t.view.webContents.isDestroyed()) t.view.webContents.reload(); });
            }
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
            if (isMainFrame && isActive()) { trapSeq++; userGestureAt = 0; }
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
        const onNav = () => {
            const tab = tabs.find((t) => t.view === view);
            if (tab) { const ti = wc.getTitle(); if (ti) tab.title = ti; }
            if (isActive()) pushUrl();
            sendTabsState();
        };
        wc.on('did-navigate', onNav);
        wc.on('did-navigate-in-page', onNav);
        wc.on('page-title-updated', onNav);

        // dark theme once the dom is ready
        wc.on('dom-ready', async () => {
            try {
                await wc.insertCSS(SEARCHBOX_CSS);
                if (getTheme() === 'light') return; // no darkreader in light mode
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
                const key = await wc.insertCSS(getTheme() === 'light' ? LIGHT_CSS : ANTI_FLASH_CSS, { cssOrigin: 'user' });
                antiFlashKeys.set(wc, key);
            } catch (err) { console.error('Failed to inject Pre-Theme CSS:', err); }
        });

        wc.on('before-input-event', (event, input) => {
            if (input.key === 'F12' && input.type === 'keyDown') { wc.toggleDevTools(); event.preventDefault(); }
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
app.on('before-quit', () => isQuitting = true);
