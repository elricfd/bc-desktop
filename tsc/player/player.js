"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const queue_1 = require("./queue");
const $ = (id) => document.getElementById(id);
const audio = $('engine');
const elArt = $('art');
const elTitle = $('title');
const elArtist = $('artist');
const iPlay = $('i-play');
const iPause = $('i-pause');
const seek = $('seek');
const vol = $('vol');
const tCur = $('t-cur');
const tDur = $('t-dur');
const btnRepeat = $('btn-repeat');
const btnShuffle = $('btn-shuffle');
const btnQueue = $('btn-queue');
const panel = $('queue-panel');
const queueList = $('queue-list');
const queue = new queue_1.Queue();
// a failed art load would show a broken-image glyph; drop the src so it falls back to the grey box
elArt.addEventListener('error', () => elArt.removeAttribute('src'));
let hls = null;
let scrubbing = false;
let resolveToken = 0;
let lastSentPos = -1;
const fmt = (s) => isNaN(s) || s < 0 ? '0:00' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
// stream res
async function ensureSrc(track) {
    if (track.src)
        return track.src;
    if (!track.tralbumId)
        return '';
    const token = `r${++resolveToken}`;
    try {
        const res = await electron_1.ipcRenderer.invoke('player:resolve-stream', {
            token,
            bandId: track.bandId,
            tralbumId: track.tralbumId,
            tralbumType: track.tralbumType,
            trackId: track.id,
            url: track.url,
        });
        if (res?.ok && res.src) {
            track.src = res.src;
            if (res.duration)
                track.duration = res.duration;
            if (res.art && !track.art)
                track.art = res.art;
            if (res.title)
                track.title = res.title;
            if (res.artist)
                track.artist = res.artist;
        }
    }
    catch {
        // leave src empty; playcurrent will skip
    }
    return track.src;
}
// playback
let playToken = 0;
async function playCurrent() {
    const track = queue.current();
    if (!track)
        return;
    // stop outgoing track & reset prog ui now (possibly async) stream res otherwise time keeps advancing audibly & on seek bar until new url ready then snaps back
    const token = ++playToken;
    try {
        audio.pause();
    }
    catch { }
    if (hls) {
        hls.destroy();
        hls = null;
    }
    seek.value = '0';
    tCur.textContent = '0:00';
    tDur.textContent = track.duration ? fmt(track.duration) : '0:00';
    renderNowPlaying(track);
    renderQueue();
    const src = await ensureSrc(track);
    // newer play started while resolving, abandon this
    if (token !== playToken)
        return;
    if (!src) {
        // couldn't resolve, skip forward so queue doesn't wedge
        const next = queue.next();
        if (next)
            return playCurrent();
        return;
    }
    if (src.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(audio);
    }
    else {
        audio.src = src;
    }
    try {
        await audio.play();
    }
    catch {
        // autoplay rejection, ui stays paused
    }
}
// title navs to album page (falling back to track/release page); artist navs to artist page, url is artist landing page
function albumUrlOf(track) {
    return track?.albumUrl || track?.url || '';
}
function artistUrlOf(track) {
    const u = albumUrlOf(track);
    if (!u)
        return '';
    try {
        return new URL(u).origin;
    }
    catch {
        return '';
    }
}
// a page url can be resolved on demand (playlist tracks ship without one) as long
// as we know the track/release id, so treat those as linkable too
function linkable(track) {
    return Boolean(track && (albumUrlOf(track) || track.id || track.tralbumId));
}
function renderNowPlaying(track) {
    elTitle.textContent = track.title || 'Unknown Track';
    elArtist.textContent = track.artist || 'Bandcamp';
    elTitle.classList.toggle('link', linkable(track));
    elArtist.classList.toggle('link', linkable(track));
    // something's playing now, so reveal the art box (hidden at idle). no art ->
    // leave the src off so it shows the grey box, not a broken-image glyph
    elArt.style.display = 'block';
    if (track.art)
        elArt.src = track.art;
    else
        elArt.removeAttribute('src');
    document.querySelectorAll('.q-row').forEach((row) => row.classList.toggle('active', Number(row.dataset.index) === queue.currentTrackIndex()));
}
function renderQueue() {
    queueList.innerHTML = '';
    queue.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'q-row' + (i === queue.currentTrackIndex() ? ' active' : '');
        row.dataset.index = String(i);
        row.innerHTML =
            `<img class="q-art"${t.art ? ` src="${t.art}"` : ''}>` +
                `<div class="q-meta"><div class="q-title">${escapeHtml(t.title)}</div>` +
                `<div class="q-artist">${escapeHtml(t.artist)}</div></div>` +
                `<div class="q-dur">${t.duration ? fmt(t.duration) : ''}</div>`;
        row.addEventListener('click', () => {
            if (queue.jumpTo(i))
                playCurrent();
        });
        queueList.appendChild(row);
    });
}
function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
// now playing (discord + last.fm)
function emitNowPlaying(force = false) {
    const track = queue.current();
    if (!track)
        return;
    const pos = Math.floor(audio.currentTime || 0);
    if (!force && pos === lastSentPos)
        return;
    lastSentPos = pos;
    const payload = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        art: track.art,
        url: track.url,
        duration: Math.floor(audio.duration || track.duration || 0),
        position: pos,
        isPlaying: !audio.paused,
    };
    electron_1.ipcRenderer.send('player:now-playing', payload);
}
// incoming streams
let loadedSig = '';
let loadedSigAt = 0;
electron_1.ipcRenderer.on('player:stream-incoming', (_e, data) => {
    if (!data?.queue?.length)
        return;
    const target = data.queue[data.activeIndex] || data.queue[0];
    // ignore retrap of track already playing (multi chunk reqs)
    if (queue.current()?.id === target?.id && queue.current()?.id)
        return;
    // once loaded release muted page player keeps advancing thru it (each cancelled stream makes it skip to next track) firing burst of identical queue events. acting on them makes player race to last track & floods bandcamp w/ stream reqs (http 429). ignore same queue events for short window; diff release (or deliberate replay after burst) still loads.
    const sig = data.queue.length + ':' + (data.queue[0]?.id || '') + ':' + (data.queue[data.queue.length - 1]?.id || '');
    const now = Date.now();
    if (sig === loadedSig && now - loadedSigAt < 4000) {
        // same queue resent for diff track, deliberate click on another row in current playlist/release. jump w/in loaded queue rather than reloading.
        const idx = queue.tracks.findIndex((t) => t.id === target?.id);
        if (idx !== -1 && queue.jumpTo(idx))
            playCurrent();
        return;
    }
    loadedSig = sig;
    loadedSigAt = now;
    queue.load(data.queue, data.activeIndex, data.context);
    playCurrent();
});
// append tracks to the queue without interrupting playback (add-to-queue). if
// nothing was playing, start with the first newly-added track.
electron_1.ipcRenderer.on('player:enqueue', (_e, data) => {
    const tracks = (data && data.tracks) || [];
    if (!tracks.length)
        return;
    const wasEmpty = queue.append(tracks);
    renderQueue();
    if (wasEmpty)
        playCurrent();
});
// transport/ audio events
audio.addEventListener('play', () => {
    iPlay.style.display = 'none';
    iPause.style.display = 'block';
    emitNowPlaying(true);
});
audio.addEventListener('pause', () => {
    iPlay.style.display = 'block';
    iPause.style.display = 'none';
    emitNowPlaying(true);
});
audio.addEventListener('timeupdate', () => {
    if (!scrubbing && audio.duration) {
        seek.max = String(audio.duration);
        seek.value = String(audio.currentTime);
        tCur.textContent = fmt(audio.currentTime);
        tDur.textContent = fmt(audio.duration);
    }
    emitNowPlaying();
});
audio.addEventListener('ended', () => {
    if (queue.repeat === 'one') {
        audio.currentTime = 0;
        audio.play().catch(() => { });
        return;
    }
    const next = queue.advanceOnEnd();
    if (next)
        playCurrent();
});
// transport does nothing until something is actually loaded
$('btn-play').addEventListener('click', () => {
    if (!queue.current())
        return;
    audio.paused ? audio.play().catch(() => { }) : audio.pause();
});
$('btn-prev').addEventListener('click', () => {
    if (!queue.current())
        return;
    // restart current track if past 3s mark, otherwise go back
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }
    if (queue.prev())
        playCurrent();
});
$('btn-next').addEventListener('click', () => {
    if (!queue.current())
        return;
    const next = queue.next();
    if (next)
        playCurrent();
});
const REPEAT_CYCLE = ['off', 'all', 'one'];
btnRepeat.addEventListener('click', () => {
    const idx = REPEAT_CYCLE.indexOf(queue.repeat);
    const mode = REPEAT_CYCLE[(idx + 1) % REPEAT_CYCLE.length];
    queue.setRepeat(mode);
    btnRepeat.classList.toggle('on', mode !== 'off');
    btnRepeat.classList.toggle('one', mode === 'one');
    btnRepeat.title = `Repeat: ${mode}`;
});
btnShuffle.addEventListener('click', () => {
    queue.setShuffle(!queue.shuffle);
    btnShuffle.classList.toggle('on', queue.shuffle);
    renderQueue();
});
let panelOpen = false;
function setPanel(open) {
    panelOpen = open;
    panel.classList.toggle('open', panelOpen);
    btnQueue.classList.toggle('on', panelOpen);
    electron_1.ipcRenderer.send('player:queue-panel', panelOpen);
}
btnQueue.addEventListener('click', () => setPanel(!panelOpen));
$('btn-queue-close').addEventListener('click', () => setPanel(false));
// title -> album page, artist -> artist page/discog, in content view.
// resolve a missing page url on demand (playlist tracks), caching it on the track
async function ensurePageUrl(track) {
    if (!track)
        return '';
    const have = albumUrlOf(track);
    if (have)
        return have;
    try {
        const res = await electron_1.ipcRenderer.invoke('player:resolve-page', {
            trackId: track.id, bandId: track.bandId, tralbumId: track.tralbumId, tralbumType: track.tralbumType,
        });
        if (res?.ok && res.url) {
            track.url = res.url;
            return res.url;
        }
    }
    catch { /* leave unlinked */ }
    return '';
}
const navigate = (url) => { if (url.startsWith('https://'))
    electron_1.ipcRenderer.send('app:navigate', url); };
elTitle.addEventListener('click', async () => navigate(await ensurePageUrl(queue.current())));
elArt.addEventListener('click', async () => navigate(await ensurePageUrl(queue.current())));
elArtist.addEventListener('click', async () => { await ensurePageUrl(queue.current()); navigate(artistUrlOf(queue.current())); });
// right click anything in now playing area to copy link.
const copyLink = (url) => { if (url.startsWith('https://')) {
    electron_1.clipboard.writeText(url);
    flashCopied();
} };
elTitle.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(albumUrlOf(queue.current())); });
elArt.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(albumUrlOf(queue.current())); });
elArtist.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(artistUrlOf(queue.current())); });
let copiedTimer = null;
function flashCopied() {
    const prev = elArtist.textContent;
    elArtist.textContent = 'Link copied';
    if (copiedTimer)
        clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { elArtist.textContent = prev; }, 1100);
}
seek.addEventListener('mousedown', () => (scrubbing = true));
seek.addEventListener('change', () => {
    audio.currentTime = Number(seek.value);
    scrubbing = false;
    emitNowPlaying(true);
});
vol.addEventListener('input', () => (audio.volume = Number(vol.value)));
audio.volume = Number(vol.value);
