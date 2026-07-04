import { ipcRenderer } from 'electron';

// anti-flash + hide bandcamp's own audio bars (our player is the only transport).
// in DARK mode we cloak the body until darkreader paints (avoids a white flash);
// in LIGHT mode we must NOT do that (darkreader never runs, so the body would stay
// hidden and the whole page shows blank grey). theme is read synchronously so the
// right cloak applies at document-start.
let bcTheme = 'dark';
try { bcTheme = (ipcRenderer.sendSync('app:theme-for', location.href) as string) || 'dark'; } catch (e) { /* default dark */ }
const antiFlashStyle = document.createElement('style');
antiFlashStyle.textContent = (bcTheme === 'light'
    ? ''
    : `html { background-color: #181a1b !important; }
       html:not([data-darkreader-scheme="dark"]) body { opacity: 0 !important; }`)
    // keep the release-page .inline_player visible: on single-track pages it's the
    // ONLY play control (albums have their tracklist rows), so hiding it left singles
    // with no way to start playback. hide only the persistent floating/collection bars.
    + `\n#collection-player, .floating-player { display: none !important; }`;
const antiFlashRoot = document.head || document.documentElement;
if (antiFlashRoot) antiFlashRoot.appendChild(antiFlashStyle);
else document.addEventListener('DOMContentLoaded', () => (document.head || document.documentElement).appendChild(antiFlashStyle));

// failsafe: if darkreader never paints (script error, throttled subresources),
// the cloak used to leave the page an empty grey forever. lift it after a few
// seconds — worst case is a brief unthemed flash instead of a hang.
if (bcTheme !== 'light') {
    setTimeout(() => {
        try {
            if (!document.documentElement.getAttribute('data-darkreader-scheme')) {
                antiFlashStyle.textContent = antiFlashStyle.textContent.replace('opacity: 0 !important', 'opacity: 1');
            }
        } catch (e) { /* keep cloak */ }
    }, 6000);
}

// mirror discover grid (/api/discover/1/discover_web) into window.__bcrpc.discover so extractor resolves genre page play to full album w/out track -> album lookup. injected as main world script at document start (csp stripped) before page grabs fetch. passive read of resp clone
const CAPTURE_SRC = `
(function () {
    if (window.__bcrpcCapture) return;
    window.__bcrpcCapture = true;
    window.__bcrpc = window.__bcrpc || { tralbum: {}, trackAlbum: {}, discover: {} };
    if (!window.__bcrpc.discover) window.__bcrpc.discover = {};
    var STORE = window.__bcrpc.discover;

    function toId(v) { if (v == null) return ''; var m = String(v).match(/\\d+/); return m ? m[0] : ''; }
    function artFromId(id) { id = toId(id); return id ? 'https://f4.bcbits.com/img/a' + id + '_10.jpg' : ''; }
    function streamOf(file) {
        if (!file) return '';
        if (typeof file === 'string') return file;
        if (typeof file === 'object') { return file['mp3-128'] || file['mp3-v0'] || file['mp3-320'] || ''; }
        return '';
    }
    function trackFromStream(u) {
        try {
            var url = new URL(u, location.href);
            var q = toId(url.searchParams.get('track_id') || url.searchParams.get('id'));
            if (q) return q;
            var segs = url.pathname.split('/').filter(Boolean);
            for (var i = segs.length - 1; i >= 0; i--) { if (/^\\d{4,}$/.test(segs[i])) return segs[i]; }
        } catch (e) {}
        return '';
    }
    function ingest(json) {
        try {
            var results = (json && (json.results || (json.discovery && json.discovery.results))) || [];
            for (var i = 0; i < results.length; i++) {
                var it = results[i];
                if (!it || typeof it !== 'object') continue;
                var ft = it.featured_track || {};
                var streamUrl = streamOf(ft.stream_url || ft.streamUrl || ft.file);
                var trackId = toId(it.track_id) || toId(ft.track_id) || trackFromStream(streamUrl);
                if (!trackId) continue;
                STORE[trackId] = {
                    trackId: trackId,
                    bandId: toId(it.band_id) || toId(it.bandId) || toId(it.selling_band_id) || toId(ft.band_id),
                    tralbumId: toId(it.tralbum_id) || toId(it.tralbumId) || toId(it.item_id) || toId(it.id),
                    type: (function (x) { x = String(x || ''); return (x === 't' || x === 'track') ? 't' : 'a'; })(it.tralbum_type || it.tralbumType || it.item_type),
                    title: String(it.title || ft.title || '').trim(),
                    artist: String(it.artist || it.album_artist || it.band_name || ft.band_name || '').trim(),
                    album: String(it.album_title || it.albumTitle || it.release_title || '').trim(),
                    art: artFromId(it.art_id || it.item_art_id || ft.art_id),
                    url: String(it.item_url || it.tralbum_url || it.url || '').trim(),
                    streamUrl: streamUrl
                };
            }
        } catch (e) {}
    }
    function isDiscover(u) { return String(u || '').indexOf('/api/discover/1/discover_web') !== -1; }

    var of = window.fetch;
    if (of) {
        window.fetch = function () {
            var args = arguments, url = '';
            try { var r = args[0]; url = (r && typeof r === 'object' && 'url' in r) ? r.url : String(r || ''); } catch (e) {}
            return of.apply(window, args).then(function (res) {
                try { if (isDiscover(url) || isDiscover(res && res.url)) res.clone().json().then(ingest).catch(function () {}); } catch (e) {}
                return res;
            });
        };
    }
    var os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
        try {
            this.addEventListener('load', function () {
                try { if (isDiscover(this.responseURL)) ingest(JSON.parse(this.responseText || '{}')); } catch (e) {}
            });
        } catch (e) {}
        return os.apply(this, arguments);
    };
})();
`;

function injectMainWorld(code: string): boolean {
    try {
        const root = document.head || document.documentElement;
        if (!root) return false;
        const s = document.createElement('script');
        s.textContent = code;
        root.appendChild(s);
        s.remove();
        return true;
    } catch (e) {
        return false;
    }
}

// inject moment html exists ahead of page own scripts
if (!injectMainWorld(CAPTURE_SRC)) {
    const obs = new MutationObserver(() => { if (injectMainWorld(CAPTURE_SRC)) obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
}

// tell main about real user gestures; acts only on audio trap following one so muted page player auto advance can't hijack queue. mousedown fires 1st
const sendGesture = () => { try { ipcRenderer.send('player:user-gesture'); } catch (e) {} };
document.addEventListener('mousedown', sendGesture, true);
document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'MediaPlayPause') sendGesture();
}, true);

// media hotkeys (soundcloud-style) from bandcamp pages: space play/pause,
// ←/→ scrub 5s (hold to keep scrubbing), shift+←/→ prev/next, shift+↑/↓ volume.
// mapped here (not in main) so typing in the page's inputs is never hijacked.
// NOTE: keep in sync with player.ts / collection.ts / header.html — this preload
// is sandboxed so the mapping can't live in a shared module.
const mediaHotkeyOf = (e: KeyboardEvent): string => {
    const t = e.target as HTMLElement | null;
    const tag = t ? t.tagName : '';
    if (t && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable)) return '';
    const space = e.key === ' ' || e.code === 'Space';
    if (space && tag === 'BUTTON') return '';
    if (space) return 'toggle';
    if (e.key === 'ArrowLeft') return e.shiftKey ? 'prev' : 'seek-back';
    if (e.key === 'ArrowRight') return e.shiftKey ? 'next' : 'seek-fwd';
    if (e.key === 'ArrowUp' && e.shiftKey) return 'vol-up';
    if (e.key === 'ArrowDown' && e.shiftKey) return 'vol-down';
    // bare digit = jump to that tenth of the track (soundcloud style: 5 -> 50%)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key >= '0' && e.key <= '9') return 'seek-pct-' + e.key;
    return '';
};
document.addEventListener('keydown', (e) => {
    const cmd = mediaHotkeyOf(e);
    if (!cmd) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && (cmd === 'toggle' || cmd === 'prev' || cmd === 'next')) return;
    try { ipcRenderer.send('player:hotkey', cmd); } catch (err) { /* bridge gone */ }
}, true);

// the big play button on a fan playlist page toggles bandcamp's own (muted,
// hidden) player without firing a stream request, so the audio trap never sees
// it & nothing plays. drive the extractor directly: the #PlaylistPage blob has
// the whole tracklist with stream urls, so main can queue it straight away.
document.addEventListener('click', (e) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    // header-level button only: it sits in .play-pause-container and carries
    // tracklistkey="playlist:<id>". per-track buttons (.play-target in .over-art)
    // stream normally & get trapped, so they don't need this.
    const btn = t && t.closest ? t.closest('.play-pause-container .play-pause-button[tracklistkey^="playlist"], .play-pause-container .play-pause-button') : null;
    if (!btn || !document.getElementById('PlaylistPage')) return;
    ipcRenderer.send('app:playlist-play');
}, true);

// mouse back/forward -> main (debounced) so don't double w/ os app command
window.addEventListener('mouseup', (e) => {
    if (e.button === 3) ipcRenderer.send('app:back');
    if (e.button === 4) ipcRenderer.send('app:forward');
});

// middle click a link -> open in a new tab. handling it here (rather than relying
// on chromium's window-open disposition, which was inconsistent) reliably catches
// every anchor. preventDefault stops the native new-window from also firing.
document.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const t = e.target as HTMLElement;
    const a = t && t.closest ? (t.closest('a[href]') as HTMLAnchorElement | null) : null;
    if (!a || !a.href) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('app:open-tab', a.href);
}, true);

// shift+click an album/track link -> add that release to the queue instead of
// navigating. works anywhere on bandcamp (collection page, release pages, feeds).
document.addEventListener('click', (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    const t = e.target as HTMLElement;
    const a = t && t.closest ? (t.closest('a[href]') as HTMLAnchorElement | null) : null;
    if (!a || !a.href || !/\/(album|track)\//.test(a.href)) return;
    e.preventDefault();
    e.stopPropagation();
    ipcRenderer.send('app:enqueue-url', a.href);
}, true);
