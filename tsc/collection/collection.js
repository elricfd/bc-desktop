"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
// prove view actually booted (shows in --dev terminal)
electron_1.ipcRenderer.send('collection:log', 'booted');
const $ = (id) => document.getElementById(id);
const grid = $('grid');
const searchEl = $('search');
const sortEl = $('sort');
const dirBtn = $('dir');
const countEl = $('count');
let items = [];
let loading = false;
let descending = true;
function setState(msg) {
    grid.innerHTML = `<div class="state">${msg}</div>`;
}
function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
let expected = 0; // total collection size reported by the backend (for the count label)
// pull the collection from main, rendering each page as it streams in so a big
// collection paints almost immediately instead of blocking on the full fetch
async function load() {
    if (loading || items.length)
        return;
    loading = true;
    items = [];
    expected = 0;
    setState('loading your collection…');
    electron_1.ipcRenderer.send('collection:log', 'fetch start');
    const onItems = (_e, p) => {
        if (p?.items?.length)
            items.push(...p.items);
        if (p?.total)
            expected = p.total;
        render();
    };
    electron_1.ipcRenderer.on('collection:items', onItems);
    try {
        const res = await electron_1.ipcRenderer.invoke('collection:fetch');
        electron_1.ipcRenderer.send('collection:log', 'fetch done ok=' + res.ok + ' n=' + items.length + (res.error ? ' err=' + res.error : ''));
        if (!res.ok && !items.length) {
            setState('could not load the collection' + (res.error ? ': ' + res.error : '') + '. are you logged in on bandcamp?');
            return;
        }
        if (!items.length) {
            setState('no items found. are you logged in on bandcamp?');
            return;
        }
    }
    catch (err) {
        electron_1.ipcRenderer.send('collection:log', 'fetch threw ' + (err && err.message));
        if (!items.length)
            setState('error loading the collection: ' + (err && err.message));
    }
    finally {
        electron_1.ipcRenderer.removeListener('collection:items', onItems);
        loading = false;
        if (items.length)
            render(); // final paint drops the "loading…" suffix
    }
}
// current view = search filter + chosen sort + direction
function sortedFiltered() {
    const q = searchEl.value.trim().toLowerCase();
    const key = sortEl.value;
    let list = items;
    if (q)
        list = list.filter((i) => (i.artist + ' ' + i.title).toLowerCase().includes(q));
    const cmp = (a, b) => {
        if (key === 'artist')
            return a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title);
        if (key === 'title')
            return a.title.localeCompare(b.title);
        if (key === 'year')
            return (a.year || 0) - (b.year || 0);
        return (a.addedAt || 0) - (b.addedAt || 0);
    };
    const out = [...list].sort(cmp);
    if (descending)
        out.reverse();
    return out;
}
function render() {
    const list = sortedFiltered();
    const total = list.length === items.length ? '' : ' / ' + items.length;
    const progress = loading ? ` — loading… ${expected ? items.length + ' / ' + expected : items.length}` : '';
    countEl.textContent = list.length + total + ' releases' + progress;
    if (!list.length) {
        if (!loading)
            setState('nothing matches your search.');
        return;
    }
    grid.innerHTML = '';
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
            const res = await electron_1.ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
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
        card.addEventListener('click', () => play(it));
        frag.appendChild(card);
    }
    grid.appendChild(frag);
}
// resolve release and hand it to player
async function play(it) {
    await electron_1.ipcRenderer.invoke('collection:play', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
}
// --- download menu ----------------------------------------------------------
let menuEl = null;
function closeMenu() { if (menuEl) {
    menuEl.remove();
    menuEl = null;
} }
// pin the menu to the anchor, flipping upward when there's no room below so a card
// near the bottom of the grid doesn't get its menu clipped / pushed off screen
function positionMenu(menu, anchor) {
    const r = anchor.getBoundingClientRect();
    menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 196)) + 'px';
    const menuH = Math.min(menu.offsetHeight || 120, 320);
    const top = r.bottom + 4 + menuH > window.innerHeight ? Math.max(6, r.top - menuH - 4) : r.bottom + 4;
    menu.style.top = top + 'px';
}
async function openDownloadMenu(it, anchor) {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dlmenu';
    menu.textContent = 'loading formats…';
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    menuEl = menu;
    positionMenu(menu, anchor);
    const res = await electron_1.ipcRenderer.invoke('download:formats', it.downloadUrl);
    if (menuEl !== menu)
        return; // closed while loading
    if (!res.ok || !res.formats.length) {
        menu.textContent = 'no downloads available';
        return;
    }
    menu.innerHTML = '';
    for (const f of res.formats) {
        const b = document.createElement('button');
        b.className = 'dlfmt';
        b.textContent = f.label;
        b.addEventListener('click', async (e) => {
            e.stopPropagation();
            b.textContent = f.label + ' — preparing…';
            await electron_1.ipcRenderer.invoke('download:start', f.url);
            b.textContent = f.label + ' — started ✓';
            setTimeout(closeMenu, 900);
        });
        menu.appendChild(b);
    }
    positionMenu(menu, anchor); // re-clamp now that the real height is known
}
document.addEventListener('click', () => closeMenu());
searchEl.addEventListener('input', () => { if (items.length)
    render(); });
sortEl.addEventListener('change', () => { if (items.length)
    render(); });
dirBtn.addEventListener('click', () => {
    descending = !descending;
    dirBtn.textContent = descending ? '↓' : '↑';
    if (items.length)
        render();
});
$('refresh').addEventListener('click', () => { items = []; load(); });
$('close').addEventListener('click', () => electron_1.ipcRenderer.send('collection:close'));
// load on first open, and retry if previous open failed to fill it
electron_1.ipcRenderer.on('collection:load', () => load());
electron_1.ipcRenderer.on('collection:shown', () => { if (!items.length)
    load(); });
