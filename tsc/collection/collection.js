"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
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
let expected = 0;
let currentlyRenderedCount = 0;
function setState(msg) {
    grid.innerHTML = `<div class="state">${msg}</div>`;
}
function escapeHtml(s) {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
async function load() {
    if (loading || items.length)
        return;
    loading = true;
    items = [];
    expected = 0;
    currentlyRenderedCount = 0;
    setState('loading your collection…');
    electron_1.ipcRenderer.send('collection:log', 'fetch start');
    const onItems = (_e, p) => {
        if (p?.items?.length)
            items.push(...p.items);
        if (p?.total)
            expected = p.total;
        // CRITICAL: Soft render. Only append new items to avoid destroying the open tracklist.
        softRender();
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
            updateHeaderCount();
    }
}
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
function updateHeaderCount() {
    const list = sortedFiltered();
    const total = list.length === items.length ? '' : ' / ' + items.length;
    const progress = loading ? ` — loading… ${expected ? items.length + ' / ' + expected : items.length}` : '';
    countEl.textContent = list.length + total + ' releases' + progress;
}
// Generates a single DOM node for an album card
function createCard(it) {
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
        const res = await electron_1.ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
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
function softRender() {
    const list = sortedFiltered();
    updateHeaderCount();
    if (!list.length) {
        if (!loading)
            setState('nothing matches your search.');
        return;
    }
    // If we are applying a search/sort filter, or it's the very first chunk, we MUST wipe the grid.
    if (currentlyRenderedCount === 0 || searchEl.value.trim() !== '' || sortEl.value !== 'added') {
        grid.innerHTML = '';
        tlEl = null;
        openId = '';
        const frag = document.createDocumentFragment();
        for (const it of list) {
            frag.appendChild(createCard(it));
        }
        grid.appendChild(frag);
        currentlyRenderedCount = list.length;
    }
    else {
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
function forceRender() {
    currentlyRenderedCount = 0;
    softRender();
}
async function play(it, activeIndex = 0) {
    await electron_1.ipcRenderer.invoke('collection:play', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, activeIndex });
}
let tlEl = null;
let openId = '';
function closeTracklist() { if (tlEl) {
    tlEl.remove();
    tlEl = null;
} openId = ''; }
const fmtDur = (s) => (!s || s < 0 ? '' : `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`);
function endOfRow(card) {
    const cards = Array.from(grid.querySelectorAll('.card'));
    const top = card.offsetTop;
    let last = card;
    for (const c of cards) {
        if (c.offsetTop === top)
            last = c;
        else if (c.offsetTop > top)
            break;
    }
    return last;
}
async function toggleTracklist(it, card) {
    const id = it.tralbumType + it.tralbumId;
    const wasOpen = openId === id && !!tlEl;
    closeTracklist();
    if (wasOpen)
        return;
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
    panel.querySelector('.tlclosebtn').addEventListener('click', closeTracklist);
    panel.querySelector('.tlplayall').addEventListener('click', () => { play(it, 0); });
    panel.querySelector('.tlqueue').addEventListener('click', async (e) => {
        const b = e.target;
        b.textContent = 'adding…';
        const r = await electron_1.ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
        b.textContent = r && r.ok ? 'added ✓' : 'failed';
    });
    const res = await electron_1.ipcRenderer.invoke('collection:tracklist', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
    if (tlEl !== panel)
        return;
    if (res.year && res.year !== it.year) {
        it.year = res.year;
        panel.querySelector('.tlyear').textContent = String(res.year);
    }
    const right = panel.querySelector('.tlright');
    if (!res.ok || !res.tracks || !res.tracks.length) {
        right.innerHTML = `<div class="tlstate">couldn't load the tracklist</div>`;
        return;
    }
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
let menuEl = null;
function closeMenu() { if (menuEl) {
    menuEl.remove();
    menuEl = null;
} }
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
        return;
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
    positionMenu(menu, anchor);
}
document.addEventListener('click', () => closeMenu());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') {
    closeMenu();
    closeTracklist();
} });
let yearsRequested = false;
function requestYears() {
    if (yearsRequested || !items.length)
        return;
    yearsRequested = true;
    const need = items.filter((i) => !i.year).map((i) => ({ tralbumId: i.tralbumId, tralbumType: i.tralbumType, bandId: i.bandId }));
    if (need.length)
        electron_1.ipcRenderer.send('collection:enrich-years', need);
}
electron_1.ipcRenderer.on('collection:years', (_e, updates) => {
    const byId = new Map(updates.map((u) => [u.tralbumId, u.year]));
    for (const it of items) {
        const y = byId.get(it.tralbumId);
        if (y) {
            it.year = y;
            const cardEl = document.getElementById(`card-${it.tralbumType}${it.tralbumId}`);
            if (cardEl) {
                const yearLabel = cardEl.querySelector('.y');
                if (yearLabel)
                    yearLabel.textContent = String(y);
            }
        }
    }
});
searchEl.addEventListener('input', forceRender);
sortEl.addEventListener('change', () => { if (sortEl.value === 'year')
    requestYears(); forceRender(); });
dirBtn.addEventListener('click', () => {
    descending = !descending;
    dirBtn.textContent = descending ? '↓' : '↑';
    forceRender();
});
$('refresh').addEventListener('click', () => { items = []; yearsRequested = false; load(); });
$('close').addEventListener('click', () => electron_1.ipcRenderer.send('collection:close'));
electron_1.ipcRenderer.on('collection:load', () => load());
electron_1.ipcRenderer.on('collection:shown', () => { if (!items.length)
    load(); });
