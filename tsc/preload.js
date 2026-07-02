"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// dark cloak hiding bandcamp own audio bars (our player is only transport)
const antiFlashStyle = document.createElement('style');
antiFlashStyle.textContent = `
    html { background-color: #181a1b !important; }
    html:not([data-darkreader-scheme="dark"]) body { opacity: 0 !important; }
    #collection-player, .inline_player,
    .floating-player, .floating-player.has-track { display: none !important; }
`;
if (document.head)
    document.head.appendChild(antiFlashStyle);
else
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(antiFlashStyle));
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
function injectMainWorld(code) {
    try {
        const root = document.head || document.documentElement;
        if (!root)
            return false;
        const s = document.createElement('script');
        s.textContent = code;
        root.appendChild(s);
        s.remove();
        return true;
    }
    catch (e) {
        return false;
    }
}
// inject moment html exists ahead of page own scripts
if (!injectMainWorld(CAPTURE_SRC)) {
    const obs = new MutationObserver(() => { if (injectMainWorld(CAPTURE_SRC))
        obs.disconnect(); });
    obs.observe(document, { childList: true, subtree: true });
}
// tell main about real user gestures; acts only on audio trap following one so muted page player auto advance can't hijack queue. mousedown fires 1st
const sendGesture = () => { try {
    electron_1.ipcRenderer.send('player:user-gesture');
}
catch (e) { } };
document.addEventListener('mousedown', sendGesture, true);
document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'MediaPlayPause')
        sendGesture();
}, true);
// mouse back/forward -> main (debounced) so don't double w/ os app command
window.addEventListener('mouseup', (e) => {
    if (e.button === 3)
        electron_1.ipcRenderer.send('app:back');
    if (e.button === 4)
        electron_1.ipcRenderer.send('app:forward');
});
// middle click a link -> open in a new tab. handling it here (rather than relying
// on chromium's window-open disposition, which was inconsistent) reliably catches
// every anchor. preventDefault stops the native new-window from also firing.
document.addEventListener('auxclick', (e) => {
    if (e.button !== 1)
        return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a || !a.href)
        return;
    e.preventDefault();
    e.stopPropagation();
    electron_1.ipcRenderer.send('app:open-tab', a.href);
}, true);
// shift+click an album/track link -> add that release to the queue instead of
// navigating. works anywhere on bandcamp (collection page, release pages, feeds).
document.addEventListener('click', (e) => {
    if (!e.shiftKey || e.button !== 0)
        return;
    const t = e.target;
    const a = t && t.closest ? t.closest('a[href]') : null;
    if (!a || !a.href || !/\/(album|track)\//.test(a.href))
        return;
    e.preventDefault();
    e.stopPropagation();
    electron_1.ipcRenderer.send('app:enqueue-url', a.href);
}, true);
