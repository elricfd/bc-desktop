import { ipcRenderer, clipboard } from 'electron';
import { Queue } from './queue';
import type {
    StreamPayload,
    PlayerTrack,
    RepeatMode,
    NowPlaying,
    ResolveStreamResponse,
} from '../shared/types';

declare const Hls: any;

const $ = (id: string) => document.getElementById(id) as HTMLElement;

const audio = $('engine') as HTMLAudioElement;
const elArt = $('art') as HTMLImageElement;
const elTitle = $('title');
const elArtist = $('artist');
const iPlay = $('i-play');
const iPause = $('i-pause');
const seek = $('seek') as HTMLInputElement;
const vol = $('vol') as HTMLInputElement;
const tCur = $('t-cur');
const tDur = $('t-dur');
const btnRepeat = $('btn-repeat');
const btnShuffle = $('btn-shuffle');
const btnQueue = $('btn-queue');
const panel = $('queue-panel');
const queueList = $('queue-list');

const queue = new Queue();
// a failed art load would show a broken-image glyph; drop the src so it falls back to the grey box
elArt.addEventListener('error', () => elArt.removeAttribute('src'));
let hls: any = null;
let scrubbing = false;
let resolveToken = 0;
let lastSentPos = -1;

const fmt = (s: number): string =>
    isNaN(s) || s < 0 ? '0:00' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;

// stream res

async function ensureSrc(track: PlayerTrack): Promise<string> {
    if (track.src) return track.src;
    if (!track.tralbumId) return '';
    const token = `r${++resolveToken}`;
    try {
        const res: ResolveStreamResponse = await ipcRenderer.invoke('player:resolve-stream', {
            token,
            bandId: track.bandId,
            tralbumId: track.tralbumId,
            tralbumType: track.tralbumType,
            trackId: track.id,
            url: track.url,
        });
        if (res?.ok && res.src) {
            track.src = res.src;
            if (res.duration) track.duration = res.duration;
            if (res.art && !track.art) track.art = res.art;
            if (res.title) track.title = res.title;
            if (res.artist) track.artist = res.artist;
        }
    } catch {
        // leave src empty; playcurrent will skip
    }
    return track.src;
}

// playback

let playToken = 0;

async function playCurrent(): Promise<void> {
    const track = queue.current();
    if (!track) return;

    // stop outgoing track & reset prog ui now (possibly async) stream res otherwise time keeps advancing audibly & on seek bar until new url ready then snaps back
    const token = ++playToken;
    try { audio.pause(); } catch { }
    if (hls) { hls.destroy(); hls = null; }
    seek.value = '0';
    tCur.textContent = '0:00';
    tDur.textContent = track.duration ? fmt(track.duration) : '0:00';

    renderNowPlaying(track);
    renderQueue();

    const src = await ensureSrc(track);
    // newer play started while resolving, abandon this
    if (token !== playToken) return;
    if (!src) {
        // couldn't resolve, skip forward so queue doesn't wedge
        const next = queue.next();
        if (next) return playCurrent();
        return;
    }

    if (src.includes('.m3u8') && typeof Hls !== 'undefined' && Hls.isSupported()) {
        hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(audio);
    } else {
        audio.src = src;
    }
    try {
        await audio.play();
    } catch {
        // autoplay rejection, ui stays paused
    }
}

// title navs to album page (falling back to track/release page); artist navs to artist page, url is artist landing page
function albumUrlOf(track: PlayerTrack | null): string {
    return track?.albumUrl || track?.url || '';
}
function artistUrlOf(track: PlayerTrack | null): string {
    const u = albumUrlOf(track);
    if (!u) return '';
    try { return new URL(u).origin; } catch { return ''; }
}

// a page url can be resolved on demand (playlist tracks ship without one) as long
// as we know the track/release id, so treat those as linkable too
function linkable(track: PlayerTrack | null): boolean {
    return Boolean(track && (albumUrlOf(track) || track.id || track.tralbumId));
}

function renderNowPlaying(track: PlayerTrack): void {
    elTitle.textContent = track.title || 'Unknown Track';
    elArtist.textContent = track.artist || 'Bandcamp';
    elTitle.classList.toggle('link', linkable(track));
    elArtist.classList.toggle('link', linkable(track));
    // something's playing now, so reveal the art box (hidden at idle). no art ->
    // leave the src off so it shows the grey box, not a broken-image glyph
    elArt.style.display = 'block';
    if (track.art) elArt.src = track.art;
    else elArt.removeAttribute('src');
    document.querySelectorAll('.q-row').forEach((row) =>
        row.classList.toggle('active', Number((row as HTMLElement).dataset.index) === queue.currentTrackIndex())
    );
}

function renderQueue(): void {
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
            if (queue.jumpTo(i)) playCurrent();
        });
        queueList.appendChild(row);
    });
}

function escapeHtml(s: string): string {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// now playing (discord + last.fm)

function emitNowPlaying(force = false): void {
    const track = queue.current();
    if (!track) return;
    const pos = Math.floor(audio.currentTime || 0);
    if (!force && pos === lastSentPos) return;
    lastSentPos = pos;
    const payload: NowPlaying = {
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
    ipcRenderer.send('player:now-playing', payload);
}

// incoming streams

let loadedSig = '';
let loadedSigAt = 0;

ipcRenderer.on('player:stream-incoming', (_e, data: StreamPayload) => {
    if (!data?.queue?.length) return;
    const target = data.queue[data.activeIndex] || data.queue[0];
    // ignore retrap of track already playing (multi chunk reqs)
    if (queue.current()?.id === target?.id && queue.current()?.id) return;

    // once loaded release muted page player keeps advancing thru it (each cancelled stream makes it skip to next track) firing burst of identical queue events. acting on them makes player race to last track & floods bandcamp w/ stream reqs (http 429). ignore same queue events for short window; diff release (or deliberate replay after burst) still loads.
    const sig = data.queue.length + ':' + (data.queue[0]?.id || '') + ':' + (data.queue[data.queue.length - 1]?.id || '');
    const now = Date.now();
    if (sig === loadedSig && now - loadedSigAt < 4000) {
        // same queue resent for diff track, deliberate click on another row in current playlist/release. jump w/in loaded queue rather than reloading.
        const idx = queue.tracks.findIndex((t) => t.id === target?.id);
        if (idx !== -1 && queue.jumpTo(idx)) playCurrent();
        return;
    }
    loadedSig = sig;
    loadedSigAt = now;

    queue.load(data.queue, data.activeIndex, data.context);
    playCurrent();
});

// append tracks to the queue without interrupting playback (add-to-queue). if
// nothing was playing, start with the first newly-added track.
ipcRenderer.on('player:enqueue', (_e, data: { tracks?: PlayerTrack[] }) => {
    const tracks = (data && data.tracks) || [];
    if (!tracks.length) return;
    const wasEmpty = queue.append(tracks);
    renderQueue();
    if (wasEmpty) playCurrent();
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
        audio.play().catch(() => {});
        return;
    }
    const next = queue.advanceOnEnd();
    if (next) playCurrent();
});

// transport does nothing until something is actually loaded. shared by the
// buttons and the app-wide media hotkeys.
function doToggle(): void {
    if (!queue.current()) return;
    audio.paused ? audio.play().catch(() => {}) : audio.pause();
}
function doPrev(): void {
    if (!queue.current()) return;
    // restart current track if past 3s mark, otherwise go back
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    if (queue.prev()) playCurrent();
}
function doNext(): void {
    if (!queue.current()) return;
    if (queue.next()) playCurrent();
}
function doSeekBy(delta: number): void {
    if (!queue.current() || !audio.duration) return;
    // stop just shy of the end so a big forward jump doesn't fire 'ended'
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + delta), Math.max(0, audio.duration - 0.25));
    emitNowPlaying(true);
}
function doVolBy(delta: number): void {
    const v = Math.min(1, Math.max(0, Number(vol.value) + delta));
    vol.value = String(v);
    audio.volume = v;
}
$('btn-play').addEventListener('click', doToggle);
$('btn-prev').addEventListener('click', doPrev);
$('btn-next').addEventListener('click', doNext);

// media hotkeys (soundcloud-style): space play/pause, ←/→ scrub 5s (hold to keep
// scrubbing), shift+←/→ prev/next track, shift+↑/↓ volume. every view maps keys
// itself (so typing in inputs is never hijacked) & forwards here via main.
function runHotkey(cmd: string): void {
    if (cmd === 'toggle') doToggle();
    else if (cmd === 'prev') doPrev();
    else if (cmd === 'next') doNext();
    else if (cmd === 'seek-back') doSeekBy(-5);
    else if (cmd === 'seek-fwd') doSeekBy(5);
    else if (cmd === 'vol-up') doVolBy(0.05);
    else if (cmd === 'vol-down') doVolBy(-0.05);
    else if (cmd.startsWith('seek-pct-')) {
        const n = Number(cmd.slice(9));
        if (queue.current() && audio.duration && n >= 0 && n <= 9) {
            audio.currentTime = audio.duration * (n / 10);
            emitNowPlaying(true);
        }
    }
}
ipcRenderer.on('player:hotkey', (_e, cmd: unknown) => runHotkey(String(cmd || '')));

// same mapping for keys pressed while the player view itself is focused.
// NOTE: keep in sync with the copies in preload.ts / collection.ts / header.html
// (the content preload is sandboxed, so this can't live in a shared module).
function mediaHotkeyOf(e: KeyboardEvent): string {
    const t = e.target as HTMLElement | null;
    const tag = t ? t.tagName : '';
    if (t && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable)) return '';
    const space = e.key === ' ' || e.code === 'Space';
    if (space && tag === 'BUTTON') return ''; // let a focused button click natively
    if (space) return 'toggle';
    if (e.key === 'ArrowLeft') return e.shiftKey ? 'prev' : 'seek-back';
    if (e.key === 'ArrowRight') return e.shiftKey ? 'next' : 'seek-fwd';
    if (e.key === 'ArrowUp' && e.shiftKey) return 'vol-up';
    if (e.key === 'ArrowDown' && e.shiftKey) return 'vol-down';
    // bare digit = jump to that tenth of the track (soundcloud style: 5 -> 50%)
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key >= '0' && e.key <= '9') return 'seek-pct-' + e.key;
    return '';
}
document.addEventListener('keydown', (e) => {
    const cmd = mediaHotkeyOf(e);
    if (!cmd) return;
    e.preventDefault();
    // holding a key repeats seek/volume (that's the scrub) but not transport toggles
    if (e.repeat && (cmd === 'toggle' || cmd === 'prev' || cmd === 'next')) return;
    runHotkey(cmd);
});

const REPEAT_CYCLE: RepeatMode[] = ['off', 'all', 'one'];
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
function setPanel(open: boolean): void {
    panelOpen = open;
    panel.classList.toggle('open', panelOpen);
    btnQueue.classList.toggle('on', panelOpen);
    ipcRenderer.send('player:queue-panel', panelOpen);
}
btnQueue.addEventListener('click', () => setPanel(!panelOpen));
$('btn-queue-close').addEventListener('click', () => setPanel(false));

// title -> album page, artist -> artist page/discog, in content view.
// resolve a missing page url on demand (playlist tracks), caching it on the track
async function ensurePageUrl(track: PlayerTrack | null): Promise<string> {
    if (!track) return '';
    const have = albumUrlOf(track);
    if (have) return have;
    try {
        const res: { ok: boolean; url: string } = await ipcRenderer.invoke('player:resolve-page', {
            trackId: track.id, bandId: track.bandId, tralbumId: track.tralbumId, tralbumType: track.tralbumType,
        });
        if (res?.ok && res.url) { track.url = res.url; return res.url; }
    } catch { /* leave unlinked */ }
    return '';
}
const navigate = (url: string) => { if (url.startsWith('https://')) ipcRenderer.send('app:navigate', url); };
elTitle.addEventListener('click', async () => navigate(await ensurePageUrl(queue.current())));
elArt.addEventListener('click', async () => navigate(await ensurePageUrl(queue.current())));
elArtist.addEventListener('click', async () => { await ensurePageUrl(queue.current()); navigate(artistUrlOf(queue.current())); });

// right click anything in now playing area to copy link.
const copyLink = (url: string) => { if (url.startsWith('https://')) { clipboard.writeText(url); flashCopied(); } };
elTitle.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(albumUrlOf(queue.current())); });
elArt.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(albumUrlOf(queue.current())); });
elArtist.addEventListener('contextmenu', (e) => { e.preventDefault(); copyLink(artistUrlOf(queue.current())); });

let copiedTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopied(): void {
    const prev = elArtist.textContent;
    elArtist.textContent = 'Link copied';
    if (copiedTimer) clearTimeout(copiedTimer);
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
