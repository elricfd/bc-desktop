import { ipcRenderer } from 'electron';
import type { CollectionItem } from '../shared/types';

// prove view actually booted (shows in --dev terminal)
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

function setState(msg: string): void {
    grid.innerHTML = `<div class="state">${msg}</div>`;
}

function escapeHtml(s: string): string {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

let expected = 0; // total collection size reported by the backend (for the count label)

// pull the collection from main, rendering each page as it streams in so a big
// collection paints almost immediately instead of blocking on the full fetch
async function load(): Promise<void> {
    if (loading || items.length) return;
    loading = true;
    items = [];
    expected = 0;
    setState('loading your collection…');
    ipcRenderer.send('collection:log', 'fetch start');
    const onItems = (_e: unknown, p: { items: CollectionItem[]; soFar: number; total: number }) => {
        if (p?.items?.length) items.push(...p.items);
        if (p?.total) expected = p.total;
        render();
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
        if (items.length) render(); // final paint drops the "loading…" suffix
    }
}

// current view = search filter + chosen sort + direction
function sortedFiltered(): CollectionItem[] {
    const q = searchEl.value.trim().toLowerCase();
    const key = sortEl.value;
    let list = items;
    if (q) list = list.filter((i) => (i.artist + ' ' + i.title).toLowerCase().includes(q));
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

function render(): void {
    const list = sortedFiltered();
    const total = list.length === items.length ? '' : ' / ' + items.length;
    const progress = loading ? ` — loading… ${expected ? items.length + ' / ' + expected : items.length}` : '';
    countEl.textContent = list.length + total + ' releases' + progress;
    if (!list.length) { if (!loading) setState('nothing matches your search.'); return; }
    grid.innerHTML = ''; // drops any open inline tracklist
    tlEl = null; openId = '';
    const frag = document.createDocumentFragment();
    for (const it of list) {
        const card = document.createElement('div');
        card.className = 'card';
        const wrap = document.createElement('div');
        wrap.className = 'artwrap';
        wrap.innerHTML = `<img class="art" loading="lazy" src="${it.art}">`;
        // add-to-queue button (every item)
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
        // owned items get a small download button that expands into a format menu
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
        // clicking a cover expands its tracklist inline (rather than auto-playing)
        card.addEventListener('click', () => toggleTracklist(it, card));
        frag.appendChild(card);
    }
    grid.appendChild(frag);
}

// play a release, optionally starting at a chosen track index (queue becomes the
// whole album; the rest queues behind the chosen track)
async function play(it: CollectionItem, activeIndex = 0): Promise<void> {
    await ipcRenderer.invoke('collection:play', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, activeIndex });
}

// --- inline tracklist -------------------------------------------------------
// clicking a cover expands a full-width panel inline after that release's row; the
// grid still scrolls normally and clicking the cover again collapses it.
let tlEl: HTMLElement | null = null;
let openId = '';
function closeTracklist(): void { if (tlEl) { tlEl.remove(); tlEl = null; } openId = ''; }
const fmtDur = (s: number): string => (!s || s < 0 ? '' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`);

// the last card element on the same visual row as `card` (so the panel drops below
// the whole row, not mid-row) regardless of how many columns are showing
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
    if (wasOpen) return; // second click on the same release closes it
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
    if (tlEl !== panel) return; // collapsed while loading
    if (res.year && res.year !== it.year) { it.year = res.year; (panel.querySelector('.tlyear') as HTMLElement).textContent = String(res.year); scheduleRender(); }
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
        row.addEventListener('click', () => play(it, i));
        right.appendChild(row);
    });
}

// --- download menu ----------------------------------------------------------
let menuEl: HTMLElement | null = null;
function closeMenu(): void { if (menuEl) { menuEl.remove(); menuEl = null; } }

// pin the menu to the anchor, flipping upward when there's no room below so a card
// near the bottom of the grid doesn't get its menu clipped / pushed off screen
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
    if (menuEl !== menu) return; // closed while loading
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
    positionMenu(menu, anchor); // re-clamp now that the real height is known
}
document.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeTracklist(); } });

// --- release-year enrichment ------------------------------------------------
// bandcamp's collection api omits release years, so they arrive as 0. when the
// user sorts by year we resolve them in the background (main caches to disk).
let yearsRequested = false;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRender(): void {
    if (renderTimer) return;
    renderTimer = setTimeout(() => { renderTimer = null; if (items.length) render(); }, 300);
}
function requestYears(): void {
    if (yearsRequested || !items.length) return;
    yearsRequested = true;
    const need = items.filter((i) => !i.year).map((i) => ({ tralbumId: i.tralbumId, tralbumType: i.tralbumType, bandId: i.bandId }));
    if (need.length) ipcRenderer.send('collection:enrich-years', need);
}
ipcRenderer.on('collection:years', (_e, updates: { tralbumId: string; year: number }[]) => {
    const byId = new Map(updates.map((u) => [u.tralbumId, u.year]));
    for (const it of items) { const y = byId.get(it.tralbumId); if (y) it.year = y; }
    scheduleRender();
});
ipcRenderer.on('collection:years-done', () => scheduleRender());

searchEl.addEventListener('input', () => { if (items.length) render(); });
sortEl.addEventListener('change', () => { if (sortEl.value === 'year') requestYears(); if (items.length) render(); });
dirBtn.addEventListener('click', () => {
    descending = !descending;
    dirBtn.textContent = descending ? '↓' : '↑';
    if (items.length) render();
});
$('refresh').addEventListener('click', () => { items = []; yearsRequested = false; load(); });
$('close').addEventListener('click', () => ipcRenderer.send('collection:close'));

// load on first open, and retry if previous open failed to fill it
ipcRenderer.on('collection:load', () => load());
ipcRenderer.on('collection:shown', () => { if (!items.length) load(); });
