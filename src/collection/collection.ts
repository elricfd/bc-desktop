import { ipcRenderer } from 'electron';
import type { CollectionItem } from '../shared/types';

ipcRenderer.send('collection:log', 'booted');

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const grid = $('grid');
const searchEl = $('search') as HTMLInputElement;
const sortEl = $('sort') as HTMLSelectElement;
const dirBtn = $('dir');
const countEl = $('count');

let items: CollectionItem[] = [];
let loading = false;
let descending = true;
let expected = 0; 
let currentlyRenderedCount = 0;

function setState(msg: string): void {
    grid.innerHTML = `<div class="state">${msg}</div>`;
}

function escapeHtml(s: string): string {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

async function load(): Promise<void> {
    if (loading || items.length) return;
    loading = true;
    items = [];
    expected = 0;
    currentlyRenderedCount = 0;
    setState('loading your collection…');
    ipcRenderer.send('collection:log', 'fetch start');
    
    const onItems = (_e: unknown, p: { items: CollectionItem[]; soFar: number; total: number }) => {
        if (p?.items?.length) items.push(...p.items);
        if (p?.total) expected = p.total;
        
        // CRITICAL: Soft render. Only append new items to avoid destroying the open tracklist.
        softRender();
    };
    
    ipcRenderer.on('collection:items', onItems);
    
    try {
        const res: { ok: boolean; count: number; error?: string } = await ipcRenderer.invoke('collection:fetch');
        ipcRenderer.send('collection:log', 'fetch done ok=' + res.ok + ' n=' + items.length + (res.error ? ' err=' + res.error : ''));
        if (!res.ok && !items.length) { setState('could not load the collection' + (res.error ? ': ' + res.error : '') + '. are you logged in on bandcamp?'); return; }
        if (!items.length) { setState('no items found. are you logged in on bandcamp?'); return; }
    } catch (err: any) {
        ipcRenderer.send('collection:log', 'fetch threw ' + (err && err.message));
        if (!items.length) setState('error loading the collection: ' + (err && err.message));
    } finally {
        ipcRenderer.removeListener('collection:items', onItems);
        loading = false;
        if (items.length) {
            updateHeaderCount();
            requestIndex(); // tags + track titles for search (disk-cached after first run)
        }
    }
}

function sortedFiltered(): CollectionItem[] {
    const q = searchEl.value.trim().toLowerCase();
    const key = sortEl.value;
    let list = items;
    // match artist/title always; genre tags & track titles once the search index
    // (built in the background, cached on disk) has that item
    if (q) list = list.filter((i) =>
        (i.artist + ' ' + i.title).toLowerCase().includes(q) ||
        (searchIndex.get(i.tralbumType + i.tralbumId) || '').includes(q));
    const cmp = (a: CollectionItem, b: CollectionItem): number => {
        if (key === 'artist') return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
        if (key === 'title') return a.title.localeCompare(b.title);
        if (key === 'year') return (a.year || 0) - (b.year || 0);
        return (a.addedAt || 0) - (b.addedAt || 0);
    };
    const out = [...list].sort(cmp);
    if (descending) out.reverse();
    return out;
}

function updateHeaderCount(): void {
    const list = sortedFiltered();
    const total = list.length === items.length ? '' : ' / ' + items.length;
    const progress = loading ? ` — loading… ${expected ? items.length + ' / ' + expected : items.length}` : '';
    const idxNote = indexing ? ` — indexing tags & tracks… ${searchIndex.size} / ${items.length}` : '';
    countEl.textContent = list.length + total + ' releases' + progress + idxNote;
}

// search index (genre tags + track titles per item), built by main in the
// background & streamed in. lets the search box match tags and song names.
const searchIndex = new Map<string, string>();
let indexRequested = false;
let indexing = false;
function requestIndex(): void {
    if (indexRequested || !items.length) return;
    indexRequested = true;
    indexing = true;
    ipcRenderer.send('collection:enrich-index',
        items.map((i) => ({ tralbumId: i.tralbumId, tralbumType: i.tralbumType, bandId: i.bandId })));
    updateHeaderCount();
}
ipcRenderer.on('collection:index', (_e, rows: { key: string; blob: string }[]) => {
    for (const r of rows || []) searchIndex.set(r.key, r.blob || '');
    // an active tag/track search refines live as index entries arrive
    if (searchEl.value.trim()) forceRender();
    else updateHeaderCount();
});
ipcRenderer.on('collection:index-done', () => { indexing = false; updateHeaderCount(); });

// Generates a single DOM node for an album card
function createCard(it: CollectionItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `card-${it.tralbumType}${it.tralbumId}`;
    
    const wrap = document.createElement('div');
    wrap.className = 'artwrap';
    wrap.innerHTML = `<img class="art" loading="lazy" src="${it.art}">`;
    
    const enq = document.createElement('button');
    enq.className = 'enq';
    enq.title = 'add to queue';
    enq.textContent = '+';
    enq.addEventListener('click', async (e) => {
        e.stopPropagation();
        const prev = enq.textContent;
        const res = await ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
        enq.textContent = res && res.ok ? '✓' : '×';
        setTimeout(() => { enq.textContent = prev; }, 900);
    });
    wrap.appendChild(enq);
    
    if (it.downloadUrl) {
        const dl = document.createElement('button');
        dl.className = 'dl';
        dl.title = 'download';
        dl.textContent = '⤓';
        dl.addEventListener('click', (e) => { e.stopPropagation(); openDownloadMenu(it, dl); });
        wrap.appendChild(dl);
    }
    card.appendChild(wrap);
    
    const meta = document.createElement('div');
    meta.innerHTML =
        `<div class="t">${escapeHtml(it.title)}</div>` +
        `<div class="a">${escapeHtml(it.artist)}</div>` +
        `<div class="y">${it.year || ''}</div>`;
    card.appendChild(meta);
    
    card.addEventListener('click', () => toggleTracklist(it, card));
    return card;
}

// CRITICAL FIX: Only appends new items during load so the open tracklist isn't destroyed
function softRender(): void {
    const list = sortedFiltered();
    updateHeaderCount();

    if (!list.length) { 
        if (!loading) setState('nothing matches your search.'); 
        return; 
    }

    // If we are applying a search/sort filter, or it's the very first chunk, we MUST wipe the grid.
    if (currentlyRenderedCount === 0 || searchEl.value.trim() !== '' || sortEl.value !== 'added') {
        grid.innerHTML = ''; 
        tlEl = null; openId = '';
        const frag = document.createDocumentFragment();
        for (const it of list) {
            frag.appendChild(createCard(it));
        }
        grid.appendChild(frag);
        currentlyRenderedCount = list.length;
    } else {
        // We are streaming in base data without filters. Only append the NEW items to the bottom.
        const newItems = list.slice(currentlyRenderedCount);
        if (newItems.length > 0) {
            const frag = document.createDocumentFragment();
            for (const it of newItems) {
                frag.appendChild(createCard(it));
            }
            grid.appendChild(frag);
            currentlyRenderedCount = list.length;
        }
    }
}

// Hard reset the grid (used when user actually types in search or changes sort dropdown)
function forceRender(): void {
    currentlyRenderedCount = 0;
    softRender();
}

async function play(it: CollectionItem, activeIndex = 0): Promise<void> {
    await ipcRenderer.invoke('collection:play', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, activeIndex });
}

let tlEl: HTMLElement | null = null;
let openId = '';
function closeTracklist(): void { if (tlEl) { tlEl.remove(); tlEl = null; } openId = ''; }
const fmtDur = (s: number): string => (!s || s < 0 ? '' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`);

function endOfRow(card: HTMLElement): HTMLElement {
    const cards = Array.from(grid.querySelectorAll('.card')) as HTMLElement[];
    const top = card.offsetTop;
    let last = card;
    for (const c of cards) { if (c.offsetTop === top) last = c; else if (c.offsetTop > top) break; }
    return last;
}

async function toggleTracklist(it: CollectionItem, card: HTMLElement): Promise<void> {
    const id = it.tralbumType + it.tralbumId;
    const wasOpen = openId === id && !!tlEl;
    closeTracklist();
    if (wasOpen) return; 
    
    openId = id;
    const panel = document.createElement('div');
    panel.className = 'tlinline';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML =
        `<div class="tlleft"><img class="tlart" src="${it.art}">` +
        `<div class="tltitle">${escapeHtml(it.title)}</div>` +
        `<div class="tlartist">${escapeHtml(it.artist)}</div>` +
        `<div class="tlyear">${it.year || ''}</div>` +
        `<div class="tlbtns"><button class="tlplayall">▶ Play all</button>` +
        `<button class="tlqueue">+ Queue</button><button class="tlclosebtn">Close</button></div></div>` +
        `<div class="tlright"><div class="tlstate">loading tracklist…</div></div>`;
    
    endOfRow(card).after(panel);
    tlEl = panel;
    
    panel.querySelector('.tlclosebtn')!.addEventListener('click', closeTracklist);
    panel.querySelector('.tlplayall')!.addEventListener('click', () => { play(it, 0); });
    panel.querySelector('.tlqueue')!.addEventListener('click', async (e) => {
        const b = e.target as HTMLElement; b.textContent = 'adding…';
        const r = await ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
        b.textContent = r && r.ok ? 'added ✓' : 'failed';
    });

    const res: { ok: boolean; year?: number; tracks?: { id: string; title: string; artist: string; duration: number }[] } =
        await ipcRenderer.invoke('collection:tracklist', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
    if (tlEl !== panel) return; 
    
    if (res.year && res.year !== it.year) { 
        it.year = res.year; 
        (panel.querySelector('.tlyear') as HTMLElement).textContent = String(res.year); 
    }
    
    const right = panel.querySelector('.tlright') as HTMLElement;
    if (!res.ok || !res.tracks || !res.tracks.length) { right.innerHTML = `<div class="tlstate">couldn't load the tracklist</div>`; return; }
    
    right.innerHTML = '';
    res.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'tlrow';
        row.innerHTML =
            `<span class="tlnum">${i + 1}</span>` +
            `<span class="tltrk">${escapeHtml(t.title)}</span>` +
            `<span class="tldur">${fmtDur(t.duration)}</span>`;
        // per-song add-to-queue (revealed on row hover); click plays as before
        const q = document.createElement('button');
        q.className = 'tlq';
        q.title = 'add this song to queue';
        q.textContent = '+';
        q.addEventListener('click', async (e) => {
            e.stopPropagation();
            q.textContent = '…';
            const r = await ipcRenderer.invoke('collection:enqueue',
                { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, trackId: t.id });
            q.textContent = r && r.ok ? '✓' : '×';
            setTimeout(() => { q.textContent = '+'; }, 900);
        });
        row.appendChild(q);
        row.addEventListener('click', () => play(it, i));
        right.appendChild(row);
    });
}

// the inline tracklist is inserted after the last card of the opened card's row;
// when the window is resized the rows re-wrap and that DOM position can land
// mid-row, leaving a partial row of cards + blank space above the panel. re-seat
// the panel at the end of the (new) current row after every resize.
function repositionTracklist(): void {
    if (!tlEl || !openId) return;
    const card = document.getElementById('card-' + openId);
    if (!card) return;
    tlEl.remove(); // detach first so the panel itself doesn't skew row offsets
    endOfRow(card).after(tlEl);
}
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(repositionTracklist, 80);
});

let menuEl: HTMLElement | null = null;
function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 196)) + 'px';
    const menuH = Math.min(menu.offsetHeight || 120, 320);
    const top = r.bottom + 4 + menuH > window.innerHeight ? Math.max(6, r.top - menuH - 4) : r.bottom + 4;
    menu.style.top = top + 'px';
}

async function openDownloadMenu(it: CollectionItem, anchor: HTMLElement): Promise<void> {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dlmenu';
    menu.textContent = 'loading formats…';
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    menuEl = menu;
    positionMenu(menu, anchor);

    const res: { ok: boolean; formats: { encoding: string; label: string; url: string }[]; error?: string } =
        await ipcRenderer.invoke('download:formats', it.downloadUrl);
    if (menuEl !== menu) return; 
    if (!res.ok || !res.formats.length) { menu.textContent = 'no downloads available'; return; }
    menu.innerHTML = '';
    for (const f of res.formats) {
        const b = document.createElement('button');
        b.className = 'dlfmt';
        b.textContent = f.label;
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            b.textContent = f.label + ' — preparing…';
            await ipcRenderer.invoke('download:start', f.url);
            b.textContent = f.label + ' — started ✓';
            setTimeout(closeMenu, 900);
        });
        menu.appendChild(b);
    }
    positionMenu(menu, anchor); 
}
document.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeTracklist(); } });

// media hotkeys while the collection is focused (space play/pause, ←/→ scrub,
// shift+←/→ prev/next, shift+↑/↓ volume) forwarded to the player via main.
// NOTE: keep in sync with preload.ts / player.ts / header.html.
function mediaHotkeyOf(e: KeyboardEvent): string {
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
}
document.addEventListener('keydown', (e) => {
    const cmd = mediaHotkeyOf(e);
    if (!cmd) return;
    e.preventDefault();
    if (e.repeat && (cmd === 'toggle' || cmd === 'prev' || cmd === 'next')) return;
    ipcRenderer.send('player:hotkey', cmd);
});

let yearsRequested = false;

function requestYears(): void {
    if (yearsRequested || !items.length) return;
    yearsRequested = true;
    const need = items.filter((i) => !i.year).map((i) => ({ tralbumId: i.tralbumId, tralbumType: i.tralbumType, bandId: i.bandId }));
    if (need.length) ipcRenderer.send('collection:enrich-years', need);
}

ipcRenderer.on('collection:years', (_e, updates: { tralbumId: string; year: number }[]) => {
    const byId = new Map(updates.map((u) => [u.tralbumId, u.year]));
    for (const it of items) { 
        const y = byId.get(it.tralbumId); 
        if (y) {
            it.year = y;
            const cardEl = document.getElementById(`card-${it.tralbumType}${it.tralbumId}`);
            if (cardEl) {
                const yearLabel = cardEl.querySelector('.y');
                if (yearLabel) yearLabel.textContent = String(y);
            }
        } 
    }
});

searchEl.addEventListener('input', forceRender);
sortEl.addEventListener('change', () => { if (sortEl.value === 'year') requestYears(); forceRender(); });
dirBtn.addEventListener('click', () => {
    descending = !descending;
    dirBtn.textContent = descending ? '↓' : '↑';
    forceRender();
});
$('refresh').addEventListener('click', () => { items = []; yearsRequested = false; load(); });
$('close').addEventListener('click', () => ipcRenderer.send('collection:close'));

ipcRenderer.on('collection:load', () => load());
ipcRenderer.on('collection:shown', () => { if (!items.length) load(); });
