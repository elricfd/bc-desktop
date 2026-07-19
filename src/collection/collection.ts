import { ipcRenderer } from 'electron';
import type { CollectionItem, TralbumType } from '../shared/types';

ipcRenderer.send('collection:log', 'booted');

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const grid = $('grid');
const searchEl = $('search') as HTMLInputElement;
const sortEl = $('sort') as HTMLSelectElement;
const scopeEl = $('scope') as HTMLSelectElement;
const dirBtn = $('dir');
const countEl = $('count');

let items: CollectionItem[] = [];
const itemKeys = new Map<string, number>(); // key -> index into items
let loading = false;
let fullRescan = false; // set by shift+Reload
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
    itemKeys.clear();
    expected = 0;
    currentlyRenderedCount = 0;
    setState('loading your collection…');
    ipcRenderer.send('collection:log', 'fetch start');
    
    const onItems = (_e: unknown, p: { items: CollectionItem[]; soFar: number; total: number }) => {
        for (const it of p?.items || []) {
            const key = it.tralbumType + it.tralbumId;
            const existing = itemKeys.get(key);
            if (existing !== undefined) {
                // wishlist item got purchased (or metadata refreshed): update in place
                items[existing] = { ...items[existing], ...it };
                continue;
            }
            itemKeys.set(key, items.length);
            items.push(it);
        }
        if (p?.total) expected = p.total;
        
        // CRITICAL: Soft render. Only append new items to avoid destroying the open tracklist.
        softRender();
    };
    
    ipcRenderer.on('collection:items', onItems);
    
    try {
        const res: { ok: boolean; count: number; error?: string } = await ipcRenderer.invoke('collection:fetch', fullRescan);
        fullRescan = false;
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
            maybeShowBigCollectionNotice();
        }
    }
}

// one-time advice for big collections: recommend the permanent release cache.
let cacheSettingOn = false; // filled from settings:get below
function maybeShowBigCollectionNotice(): void {
    if (items.length <= 1000 || cacheSettingOn) return;
    if (localStorage.getItem('bigCollNoticeDismissed') === '1') return;
    if (document.querySelector('.modalback')) return;
    const back = document.createElement('div');
    back.className = 'modalback';
    back.innerHTML =
        `<div class="modal"><h3>That's a lot of music 🎶</h3>` +
        `<p>Large collections (1000+ releases) can take a while to load and index, which may cause some lag while browsing. ` +
        `Turning on <b>permanently cache release data</b> (Settings → Storage) saves the tracklists, tags and album covers to disk, ` +
        `making the next startup much faster.</p>` +
        `<div class="mrow"><button class="m-settings primary">Open Settings</button>` +
        `<button class="m-ok">Ok</button><button class="m-never">Don't show again</button></div></div>`;
    const close = () => back.remove();
    back.querySelector('.m-settings')!.addEventListener('click', () => { ipcRenderer.send('app:settings'); close(); });
    back.querySelector('.m-ok')!.addEventListener('click', close);
    back.querySelector('.m-never')!.addEventListener('click', () => { localStorage.setItem('bigCollNoticeDismissed', '1'); close(); });
    document.body.appendChild(back);
}

function sortedFiltered(): CollectionItem[] {
    const q = searchEl.value.trim().toLowerCase();
    const key = sortEl.value;
    let list = items;
    // owned / wishlist / local-files scope
    if (scopeEl.value === 'own') list = list.filter((i) => !i.wish && !i.local);
    else if (scopeEl.value === 'wish') list = list.filter((i) => i.wish === true);
    else if (scopeEl.value === 'local') list = list.filter((i) => i.local === true);
    // match artist/title always; genre tags & track titles once the search index
    // (built in the background, cached on disk) has that item
    if (q) list = list.filter((i) =>
        (i.artist + ' ' + i.title).toLowerCase().includes(q) ||
        (searchIndex.get(i.tralbumType + i.tralbumId)?.blob || '').includes(q));
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

// terse status line: "importing x/y" while loading, "indexing x/y" while the
// index builds, else just the release count (filtered as "n / total")
function updateHeaderCount(): void {
    if (loading) { countEl.textContent = `importing ${items.length}/${expected || '?'}`; return; }
    if (indexing) {
        countEl.textContent = `indexing ${searchIndex.size}/${items.length}` + (indexStatus ? ` (${indexStatus})` : '');
        return;
    }
    const list = sortedFiltered();
    const total = list.length === items.length ? String(items.length) : `${list.length} / ${items.length}`;
    countEl.textContent = total + ' releases';
}
let indexStatus = ''; // e.g. "throttled (429), resuming in 45s" from main
ipcRenderer.on('collection:index-status', (_e, text: unknown) => {
    indexStatus = typeof text === 'string' ? text : '';
    updateHeaderCount();
});

// release index (genre tags + tracklist per item), built by main in the
// background & streamed in. lets the search box match tags and song names.
interface IndexEntry { blob: string; tags: string[]; tracks: [string, number][] }
const searchIndex = new Map<string, IndexEntry>();
let indexRequested = false;
let indexing = false;
function requestIndex(): void {
    if (indexRequested || !items.length) return;
    indexRequested = true;
    indexing = true;
    ipcRenderer.send('collection:enrich-index',
        items.map((i) => ({ tralbumId: i.tralbumId, tralbumType: i.tralbumType, bandId: i.bandId, art: i.art })));
    updateHeaderCount();
}
ipcRenderer.on('collection:index', (_e, rows: ({ key: string } & IndexEntry)[]) => {
    for (const r of rows || []) searchIndex.set(r.key, { blob: r.blob || '', tags: r.tags || [], tracks: r.tracks || [] });
    // an active tag/track search refines live as index entries arrive; the list
    // view also grows rows, but only refresh it while the user is at the top so
    // we never yank the scroll position out from under them
    if (viewMode === 'list') { if (grid.scrollTop < 50) forceRender(); else updateHeaderCount(); }
    else if (searchEl.value.trim()) forceRender();
    else updateHeaderCount();
});
ipcRenderer.on('collection:index-done', () => {
    indexing = false;
    // a throttled run stops early; let the next Reload (or app restart) resume it
    if (searchIndex.size < items.length) indexRequested = false;
    updateHeaderCount();
});

// Generates a single DOM node for an album card
function createCard(it: CollectionItem): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.id = `card-${it.tralbumType}${it.tralbumId}`;
    
    const wrap = document.createElement('div');
    wrap.className = 'artwrap';
    wrap.innerHTML = `<img class="art" loading="lazy" src="${it.art}">`;
    // dragging a cover exports the full-size art as a real file. hover prefetches
    // the full-size jpg; dragstart checks (sync) that it's ready and only then
    // hands the drag to main — startDrag must run inside the live drag gesture,
    // so if the file isn't there yet the default (thumbnail) drag proceeds.
    const img = wrap.querySelector('img.art') as HTMLImageElement;
    const artReq = { tralbumType: it.tralbumType, tralbumId: it.tralbumId, art: it.art, title: it.title, artist: it.artist };
    img.addEventListener('mouseenter', () => ipcRenderer.send('collection:prefetch-art', artReq), { once: true });
    img.addEventListener('dragstart', (e) => {
        let file = '';
        try { file = ipcRenderer.sendSync('collection:art-ready', artReq) || ''; } catch { /* default drag */ }
        if (!file) return; // full-size not downloaded yet: browser drag as usual
        e.preventDefault();
        ipcRenderer.send('collection:drag-art', file);
    });
    
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
    
    if (it.wish) {
        const b = document.createElement('span');
        b.className = 'wishb';
        b.title = 'on your wishlist';
        b.textContent = '♡';
        wrap.appendChild(b);
    }
    if (it.local) {
        const b = document.createElement('span');
        b.className = 'localb';
        b.title = 'from your local files';
        b.textContent = 'LOCAL';
        wrap.appendChild(b);
    }
    if (it.downloadUrl) {
        const dl = document.createElement('button');
        dl.className = 'dl';
        dl.title = 'download';
        dl.textContent = '⤓';
        dl.addEventListener('click', (e) => { e.stopPropagation(); openDownloadMenu(it, dl); });
        wrap.appendChild(dl);
    } else if (it.wish) {
        // not owned: download the mp3-128 streams instead (tagged, with cover)
        const dl = document.createElement('button');
        dl.className = 'dl';
        dl.title = 'download streams (mp3-128, tagged)';
        dl.textContent = '⤓';
        dl.addEventListener('click', async (e) => {
            e.stopPropagation();
            dl.textContent = '…';
            const r = await ipcRenderer.invoke('download:release', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, url: it.url });
            dl.textContent = r && r.ok ? '✓' : '×';
            setTimeout(() => { dl.textContent = '⤓'; }, 1200);
        });
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
    // right-click a cover: add the whole release to a playlist (local cards get
    // a small menu with a "remove from library" entry too)
    card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (it.local) openLocalCardMenu(e, it);
        else openPlaylistPicker({ tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId }, e.clientX, e.clientY);
    });
    return card;
}

// right-click menu for local pseudo-releases
function openLocalCardMenu(e: MouseEvent, it: CollectionItem): void {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dlmenu';
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    const mk = (label: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = 'dlfmt';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
        menu.appendChild(b);
    };
    // the picker replaces this menu itself — no closeMenu() here (it would
    // tear down the picker it just opened)
    mk('+ Add to playlist…', () => openPlaylistPicker({ tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId }, e.clientX, e.clientY));
    mk('Remove from library', async () => {
        closeMenu();
        await ipcRenderer.invoke('library:remove', it.tralbumId);
    });
    document.body.appendChild(menu);
    menuEl = menu;
    menu.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - 196)) + 'px';
    menu.style.top = Math.max(6, Math.min(e.clientY, window.innerHeight - (menu.offsetHeight || 90) - 6)) + 'px';
}

// CRITICAL FIX: Only appends new items during load so the open tracklist isn't destroyed
function softRender(): void {
    const list = sortedFiltered();
    updateHeaderCount();

    if (viewMode === 'list') { renderList(list); return; }

    if (!list.length) {
        // ALWAYS clear stale results. previously, while loading, an unmatched query
        // returned early and left the previous (shorter-prefix) match rendered —
        // typing "helloa" kept showing the results for "hello".
        closeTracklist();
        currentlyRenderedCount = 0;
        setState(loading ? 'nothing matches yet — still loading…' : 'nothing matches your search.');
        return;
    }

    // If we are applying a search/sort filter, group headers, or it's the very
    // first chunk, we MUST wipe the grid.
    if (currentlyRenderedCount === 0 || searchEl.value.trim() !== '' || sortEl.value !== 'added' || gridHeadersOn) {
        // detach the open tracklist (don't destroy it) so re-renders during load —
        // new item batches, index updates — can re-seat it instead of closing it
        const openCardId = openId;
        if (tlEl) tlEl.remove();
        grid.innerHTML = '';
        const frag = document.createDocumentFragment();
        let lastGroup = '';
        for (const it of list) {
            if (gridHeadersOn) {
                const g = gridGroupLabel(it);
                if (g !== lastGroup) {
                    lastGroup = g;
                    const sep = document.createElement('div');
                    sep.className = 'gridsep';
                    sep.textContent = g;
                    frag.appendChild(sep);
                }
            }
            frag.appendChild(createCard(it));
        }
        grid.appendChild(frag);
        currentlyRenderedCount = list.length;
        if (tlEl && openCardId) {
            const card = document.getElementById('card-' + openCardId);
            if (card) endOfRow(card).after(tlEl);
            else { tlEl.remove(); tlEl = null; openId = ''; } // its item got filtered out
        }
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

// track list view: every track of every (filtered) release as one flat table.
// track rows come from the release index; releases not indexed yet render as a
// single album row. rendered in chunks so a 20k-row collection stays snappy.
interface ListRow { it: CollectionItem | null; trackIdx: number; title: string; dur: number; isAlbumRow: boolean; genreHead?: string }
let listRows: ListRow[] = [];
let listRendered = 0;
// render the whole table at once: chunked lazy-append made the scrollbar jump
// around and meant the "full" list was never actually all there
const LIST_CHUNK = Number.MAX_SAFE_INTEGER;
// list view sorts by clicking column headers (the toolbar dropdown is grid-only)
type ListSortKey = 'num' | 'artist' | 'title' | 'album' | 'year' | 'genre' | 'time';
let listSort: { key: ListSortKey; desc: boolean } = { key: 'artist', desc: false };


// grouped sorts (genre / artist / album / year) render a header row per group.
// genre rows belong to EVERY tag on their release (so a release shows under
// each of its genres, duplicated); the others have exactly one group.
function groupLabelsOf(r: ListRow): string[] {
    if (!r.it) return [];
    if (listSort.key === 'genre') {
        const idx = searchIndex.get(r.it.tralbumType + r.it.tralbumId);
        const tags = (idx?.tags || []).map((t) => t.trim()).filter(Boolean);
        return tags.length ? tags : ['(no genre)'];
    }
    if (listSort.key === 'artist') return [r.it.artist || '(unknown artist)'];
    if (listSort.key === 'album') return [r.it.title || '(unknown album)'];
    if (listSort.key === 'year') return [r.it.year ? String(r.it.year) : '(unknown year)'];
    return [];
}
const GROUPED_KEYS: ListSortKey[] = ['genre', 'artist', 'album', 'year'];

function applyListSort(rows: ListRow[]): ListRow[] {
    const dir = listSort.desc ? -1 : 1;
    const s = (x: string) => x.toLowerCase();
    const tiebreak = (a: ListRow, b: ListRow) =>
        s(a.it!.artist).localeCompare(s(b.it!.artist)) || s(a.it!.title).localeCompare(s(b.it!.title)) || a.trackIdx - b.trackIdx;

    if (GROUPED_KEYS.includes(listSort.key)) {
        // bucket rows by group, order groups alphabetically (years numerically),
        // and emit a header row announcing each group; unknowns always last.
        // genre buckets a row under EVERY tag of its release (duplicates intended).
        const groups = new Map<string, { label: string; rows: ListRow[] }>();
        for (const r of rows) {
            for (const label of groupLabelsOf(r)) {
                const k = label.toLowerCase();
                let g = groups.get(k);
                if (!g) { g = { label, rows: [] }; groups.set(k, g); }
                g.rows.push(r);
            }
        }
        const isUnknown = (n: string) => n.startsWith('(');
        const names = [...groups.keys()].filter((n) => !isUnknown(n)).sort((a, b) =>
            listSort.key === 'year' ? Number(a) - Number(b) : a.localeCompare(b));
        if (listSort.desc) names.reverse();
        for (const n of [...groups.keys()].filter(isUnknown)) names.push(n);
        const out: ListRow[] = [];
        for (const n of names) {
            const g = groups.get(n)!;
            out.push({ it: null, trackIdx: 0, title: '', dur: 0, isAlbumRow: false, genreHead: g.label });
            g.rows.sort(tiebreak);
            out.push(...g.rows);
        }
        return out;
    }

    const val = (r: ListRow): number | string =>
        listSort.key === 'num' ? r.trackIdx :
        listSort.key === 'artist' ? s(r.it!.artist) :
        listSort.key === 'title' ? s(r.title) :
        listSort.key === 'album' ? s(r.it!.title) :
        r.dur; // time
    rows.sort((a, b) => {
        const va = val(a), vb = val(b);
        const c = typeof va === 'number' ? (va as number) - (vb as number) : (va as string).localeCompare(vb as string);
        return (c || tiebreak(a, b)) * dir;
    });
    return rows;
}

function buildListRows(list: CollectionItem[]): ListRow[] {
    const q = searchEl.value.trim().toLowerCase();
    const rows: ListRow[] = [];
    for (const it of list) {
        const idx = searchIndex.get(it.tralbumType + it.tralbumId);
        const tracks = idx ? idx.tracks : [];
        if (!tracks.length) {
            rows.push({ it, trackIdx: 0, title: it.title, dur: 0, isAlbumRow: true });
            continue;
        }
        // when the release only matched the query via its index blob, narrow to the
        // matching tracks (searching a song name lists that song, not the whole album)
        const releaseMatches = !q || (it.artist + ' ' + it.title).toLowerCase().includes(q)
            || (idx as IndexEntry).tags.join(' ').toLowerCase().includes(q);
        tracks.forEach(([title, dur], i) => {
            if (releaseMatches || title.toLowerCase().includes(q)) {
                rows.push({ it, trackIdx: i, title, dur, isAlbumRow: false });
            }
        });
    }
    return rows;
}

function appendListChunk(): void {
    const frag = document.createDocumentFragment();
    const end = Math.min(listRows.length, listRendered + LIST_CHUNK);
    for (let i = listRendered; i < end; i++) {
        const r = listRows[i];
        if (r.genreHead !== undefined) {
            const h = document.createElement('div');
            h.className = 'lv-genrehead';
            h.textContent = r.genreHead;
            frag.appendChild(h);
            continue;
        }
        const it = r.it as CollectionItem;
        const idx = searchIndex.get(it.tralbumType + it.tralbumId);
        const rowTags = idx ? idx.tags.slice(0, 3) : [];
        const row = document.createElement('div');
        row.className = 'lv-row';
        // genre cell: each tag is its own link to that genre's group
        const genreHtml = rowTags.map((t) => `<span class="lv-tag" data-tag="${escapeHtml(t)}">${escapeHtml(t)}</span>`).join(', ');
        row.innerHTML =
            `<span class="lv-num">${r.isAlbumRow ? '' : r.trackIdx + 1}.</span>` +
            `<span class="lv-art">${escapeHtml(it.artist)}</span>` +
            `<span class="lv-trk">${escapeHtml(r.title)}${r.isAlbumRow ? ' <span style="color:#848079">(album)</span>' : ''}</span>` +
            `<span class="lv-alb">${escapeHtml(it.title)}</span>` +
            `<span class="lv-yr">${it.year || ''}</span>` +
            `<span class="lv-gen">${genreHtml}</span>` +
            `<span class="lv-dur">${fmtDur(r.dur)}</span>`;
        row.addEventListener('click', (e) => {
            const tagEl = (e.target as HTMLElement).closest?.('.lv-tag') as HTMLElement | null;
            if (tagEl) { e.stopPropagation(); jumpToListGroup('genre', tagEl.dataset.tag || ''); return; }
            play(it, r.trackIdx);
        });
        row.addEventListener('contextmenu', (e) => { e.preventDefault(); openRowMenu(e, r); });
        frag.appendChild(row);
    }
    grid.appendChild(frag);
    listRendered = end;
}

function renderList(list: CollectionItem[]): void {
    closeTracklist();
    grid.innerHTML = '';
    listRows = applyListSort(buildListRows(list));
    listRendered = 0;
    if (!listRows.length) {
        setState(loading ? 'nothing matches yet — still loading…' : 'nothing matches your search.');
        return;
    }
    const head = document.createElement('div');
    head.className = 'lv-head';
    const cols: { key: ListSortKey; label: string; cls: string }[] = [
        { key: 'num', label: '#', cls: 'lv-num' },
        { key: 'artist', label: 'Artist', cls: '' },
        { key: 'title', label: 'Title', cls: '' },
        { key: 'album', label: 'Album', cls: '' },
        { key: 'year', label: 'Year', cls: '' },
        { key: 'genre', label: 'Genre', cls: '' },
        { key: 'time', label: 'Time', cls: 'lv-dur' },
    ];
    for (const c of cols) {
        const sp = document.createElement('span');
        const active = listSort.key === c.key;
        sp.className = (c.cls + (active ? ' on' : '')).trim();
        sp.textContent = c.label + (active ? (listSort.desc ? ' ↓' : ' ↑') : '');
        sp.title = 'Sort by ' + c.label;
        sp.addEventListener('click', () => {
            if (c.key === 'year') requestYears(); // fill missing years like the dropdown did
            if (listSort.key === c.key) listSort.desc = !listSort.desc;
            else listSort = { key: c.key, desc: false };
            forceRender();
        });
        head.appendChild(sp);
    }
    grid.appendChild(head);
    appendListChunk();
}


let viewMode: 'grid' | 'list' = 'grid';
const viewBtn = $('viewmode');
function setViewMode(mode: 'grid' | 'list'): void {
    viewMode = mode;
    grid.classList.toggle('listmode', viewMode === 'list');
    viewBtn.textContent = viewMode === 'list' ? '⊞' : '≡';
    viewBtn.title = viewMode === 'list' ? 'Switch to album grid view' : 'Switch to track list view';
    // list view sorts via its column headers; the dropdown/direction are grid-only
    sortEl.style.display = viewMode === 'list' ? 'none' : '';
    dirBtn.style.display = viewMode === 'list' ? 'none' : '';
    closeTracklist();
    forceRender();
}
viewBtn.addEventListener('click', () => setViewMode(viewMode === 'grid' ? 'list' : 'grid'));

// jump from panel text (artist / album / tag) to its group in the list view:
// switch to that grouped sort, render everything, and scroll to the group. a
// clicked tag might not be any release's PRIMARY tag (groups use the primary),
// so fall back to the nearest alphabetical position instead of not scrolling.
function jumpToListGroup(key: ListSortKey, label: string): void {
    listSort = { key, desc: false };
    if (key === 'year') requestYears();
    setViewMode('list');
    const target = label.trim().toLowerCase();
    const heads = Array.from(grid.querySelectorAll('.lv-genrehead')) as HTMLElement[];
    let exact: HTMLElement | null = null;
    let nearest: HTMLElement | null = null;
    for (const h of heads) {
        const name = (h.textContent || '').trim().toLowerCase();
        if (name === target) { exact = h; break; }
        // first group alphabetically past the target = where it would have been
        if (!nearest && !name.startsWith('(') && name.localeCompare(target) > 0) nearest = h;
    }
    const head = exact || nearest || (heads.length ? heads[heads.length - 1] : null);
    // manual scroll (scrollIntoView would tuck the header under the sticky column bar)
    if (head) grid.scrollTop = Math.max(0, head.offsetTop - 38);
}

// right-click a list row: play / add to queue (the row's single track, or the
// whole release for not-yet-indexed album rows)
function openRowMenu(e: MouseEvent, r: ListRow): void {
    if (!r.it) return;
    const it = r.it;
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dlmenu';
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    const add = (label: string, fn: () => void) => {
        const b = document.createElement('button');
        b.className = 'dlfmt';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); closeMenu(); });
        menu.appendChild(b);
    };
    add('▶ Play', () => play(it, r.trackIdx));
    add(r.isAlbumRow ? '+ Add release to queue' : '+ Add track to queue', async () => {
        await ipcRenderer.invoke('collection:enqueue', {
            tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId,
            trackIndex: r.isAlbumRow ? undefined : r.trackIdx,
        });
    });
    if (!r.isAlbumRow) add('+ Add whole release to queue', async () => {
        await ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
    });
    // NOT via add(): add() closes the menu after the callback, which would tear
    // down the picker the callback just opened (the picker replaces this menu)
    const plb = document.createElement('button');
    plb.className = 'dlfmt';
    plb.textContent = '+ Add to playlist…';
    plb.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openPlaylistPicker({
            tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId,
            trackIndex: r.isAlbumRow ? undefined : r.trackIdx,
        }, e.clientX, e.clientY);
    });
    menu.appendChild(plb);
    document.body.appendChild(menu);
    menuEl = menu;
    menu.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - 196)) + 'px';
    menu.style.top = Math.max(6, Math.min(e.clientY, window.innerHeight - (menu.offsetHeight || 110) - 6)) + 'px';
}

// optional group headers in the GRID view (settings toggle; off by default).
// grouped by the active dropdown sort: date added -> month, artist -> name,
// title -> first letter, year -> year.
let gridHeadersOn = false;
function gridGroupLabel(it: CollectionItem): string {
    const key = sortEl.value;
    if (key === 'artist') return it.artist || '(unknown artist)';
    if (key === 'year') return it.year ? String(it.year) : '(unknown year)';
    if (key === 'title') {
        const c = (it.title || '').trim().charAt(0).toUpperCase();
        return /[A-Z]/.test(c) ? c : '#';
    }
    if (!it.addedAt) return '(unknown date)';
    return new Date(it.addedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}
ipcRenderer.on('collection:grid-headers', (_e, on: unknown) => {
    gridHeadersOn = on === true;
    if (viewMode === 'grid') forceRender();
});
ipcRenderer.invoke('settings:get').then((s: any) => {
    gridHeadersOn = !!(s && s.gridHeaders);
    cacheSettingOn = !!(s && s.cacheReleases);
    if (gridHeadersOn && items.length && viewMode === 'grid') forceRender();
}).catch(() => { /* keep off */ });

// explicitRow: user clicked a specific row of an expanded album tracklist (play
// that album from there). otherwise a single-track purchase plays JUST its track —
// the parent album is only resolved for metadata, not queued wholesale.
async function play(it: CollectionItem, activeIndex = 0, explicitRow = false): Promise<void> {
    const trackOnly = it.tralbumType === 't' && !explicitRow;
    await ipcRenderer.invoke('collection:play', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, activeIndex: trackOnly ? undefined : activeIndex, trackOnly });
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
        `<div class="tltags"></div>` +
        `<div class="tlbtns"><button class="tlplayall">▶ Play all</button>` +
        `<button class="tlqueue">+ Queue</button><button class="tlpl">+ Playlist</button>` +
        `<button class="tlclosebtn">Close</button></div></div>` +
        `<div class="tlright"><div class="tlstate">loading tracklist…</div></div>`;

    endOfRow(card).after(panel);
    tlEl = panel;

    panel.querySelector('.tlclosebtn')!.addEventListener('click', closeTracklist);
    panel.querySelector('.tlpl')!.addEventListener('click', (e) => {
        const r = (e.target as HTMLElement).getBoundingClientRect();
        openPlaylistPicker({ tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId }, r.left, r.bottom + 4);
    });
    panel.querySelector('.tlplayall')!.addEventListener('click', () => { play(it, 0); });
    panel.querySelector('.tlqueue')!.addEventListener('click', async (e) => {
        const b = e.target as HTMLElement; b.textContent = 'adding…';
        const r = await ipcRenderer.invoke('collection:enqueue', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
        b.textContent = r && r.ok ? 'added ✓' : 'failed';
    });

    const res: { ok: boolean; cached?: boolean; year?: number; tags?: string[]; tracks?: { id: string; title: string; artist: string; duration: number }[] } =
        await ipcRenderer.invoke('collection:tracklist', { tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId });
    if (tlEl !== panel) return;

    if (res.year && res.year !== it.year) {
        it.year = res.year;
        (panel.querySelector('.tlyear') as HTMLElement).textContent = String(res.year);
    }
    // genre tags: prefer the fresh response, fall back to the local index.
    // tags / artist / album text link to their group in the list view.
    const tagList = (res.tags && res.tags.length ? res.tags : searchIndex.get(it.tralbumType + it.tralbumId)?.tags) || [];
    const tagsWrap = panel.querySelector('.tltags') as HTMLElement;
    tagsWrap.innerHTML = '';
    for (const t of tagList) {
        const chip = document.createElement('span');
        chip.className = 'tltag';
        chip.textContent = t;
        chip.title = 'Show all "' + t + '" in list view';
        chip.addEventListener('click', () => jumpToListGroup('genre', t));
        tagsWrap.appendChild(chip);
    }
    const titleEl = panel.querySelector('.tltitle') as HTMLElement;
    const artistEl = panel.querySelector('.tlartist') as HTMLElement;
    titleEl.title = 'Show albums A→Z in list view';
    artistEl.title = 'Show artists A→Z in list view';
    titleEl.addEventListener('click', () => jumpToListGroup('album', it.title));
    artistEl.addEventListener('click', () => jumpToListGroup('artist', it.artist));
    
    const right = panel.querySelector('.tlright') as HTMLElement;
    if (!res.ok || !res.tracks || !res.tracks.length) { right.innerHTML = `<div class="tlstate">couldn't load the tracklist</div>`; return; }

    right.innerHTML = '';
    if (res.cached) {
        // network was unavailable: this list came from the saved index
        const note = document.createElement('div');
        note.className = 'tlstate';
        note.textContent = 'offline — showing the saved tracklist';
        right.appendChild(note);
    }
    res.tracks.forEach((t, i) => {
        const row = document.createElement('div');
        row.className = 'tlrow';
        row.innerHTML =
            `<span class="tlnum">${i + 1}</span>` +
            `<span class="tltrk">${escapeHtml(t.title)}</span>` +
            `<span class="tldur">${fmtDur(t.duration)}</span>`;
        row.addEventListener('click', () => play(it, i, true));
        // right-click a song: add just that track to a playlist
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openPlaylistPicker({ tralbumId: it.tralbumId, tralbumType: it.tralbumType, bandId: it.bandId, trackId: t.id }, e.clientX, e.clientY);
        });
        // per-song add-to-queue (revealed on row hover); click plays as before.
        // cached (offline) rows carry no track id, so the button is omitted —
        // it would queue the whole release instead of the song
        if (t.id) {
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
        }
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
// esc peels one layer at a time: menu -> playlist detail -> playlists panel -> tracklist
document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuEl) { closeMenu(); return; }
    if (plOpen) {
        if (plDetailId) void renderPlaylistBrowser();
        else setPlaylistsOpen(false);
        return;
    }
    closeTracklist();
});

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
scopeEl.addEventListener('change', forceRender);
dirBtn.addEventListener('click', () => {
    descending = !descending;
    dirBtn.textContent = descending ? '↓' : '↑';
    forceRender();
});
$('refresh').addEventListener('click', (e) => {
    fullRescan = (e as MouseEvent).shiftKey; // shift+click re-scans everything
    items = [];
    itemKeys.clear();
    yearsRequested = false;
    load();
});
$('close').addEventListener('click', () => ipcRenderer.send('collection:close'));

// import audio files from the pc into the collection (local pseudo-releases);
// main parses tags/duration/art and streams the new items back over collection:items
const addLocalBtn = $('addlocal');
addLocalBtn.addEventListener('click', async () => {
    const prev = addLocalBtn.textContent;
    addLocalBtn.textContent = 'importing…';
    try {
        const r = await ipcRenderer.invoke('library:add');
        addLocalBtn.textContent = r && r.ok && !r.canceled ? `added ${r.added || 0} ✓` : prev;
    } catch { addLocalBtn.textContent = '× failed'; }
    setTimeout(() => { addLocalBtn.textContent = prev; }, 1400);
});

// drop items whose keys vanished (library removals, bandcamp-side hides)
function removeItemKeys(keys: Set<string>): void {
    if (!keys.size) return;
    const before = items.length;
    items = items.filter((i) => !keys.has(i.tralbumType + i.tralbumId));
    if (items.length === before) return;
    itemKeys.clear();
    items.forEach((it, idx) => itemKeys.set(it.tralbumType + it.tralbumId, idx));
    forceRender();
}
ipcRenderer.on('collection:remove-keys', (_e, keys: unknown) => {
    removeItemKeys(new Set(Array.isArray(keys) ? keys.map(String) : []));
});
// full re-scan sends the complete list of keys to KEEP
ipcRenderer.on('collection:prune', (_e, keep: unknown) => {
    if (!Array.isArray(keep) || loading) return;
    const keepSet = new Set(keep.map(String));
    removeItemKeys(new Set(items.filter((i) => !keepSet.has(i.tralbumType + i.tralbumId)).map((i) => i.tralbumType + i.tralbumId)));
});

// incremental refreshes (wishlist hearts, purchases) stream in outside load()
ipcRenderer.on('collection:items', (_e, p: { items: CollectionItem[] }) => {
    if (loading) return; // load() has its own listener with progress accounting
    let added = 0;
    for (const it of p?.items || []) {
        const key = it.tralbumType + it.tralbumId;
        const existing = itemKeys.get(key);
        if (existing !== undefined) { items[existing] = { ...items[existing], ...it }; continue; }
        itemKeys.set(key, items.length);
        items.push(it);
        added++;
    }
    if (added || (p?.items || []).length) forceRender();
});

ipcRenderer.on('collection:load', () => load());
ipcRenderer.on('collection:shown', () => { if (!items.length) load(); });

// ---- playlists: build & play custom playlists out of your collection --------
// the panel swaps in for the grid (which keeps rendering hidden underneath, so
// streaming item batches / index updates never touch playlist DOM). entries are
// added from anywhere in the collection: right-click a cover or song, the
// "+ Playlist" button in the tracklist panel, or the list view's row menu.
const plov = $('plov');
const plBtn = $('plbtn');
let plOpen = false;
let plDetailId = ''; // '' = browser (all playlists)
let plDragFrom: number | null = null;

interface PlSummary { id: string; name: string; count: number; duration: number; arts: string[]; desc: string; cover: string }
interface PlEntry { id: string; title: string; artist: string; album: string; art: string; duration: number }
interface PlAddReq { tralbumId: string; tralbumType: TralbumType; bandId: string; trackId?: string; trackIndex?: number }

function setPlaylistsOpen(open: boolean): void {
    plOpen = open;
    plov.style.display = open ? '' : 'none';
    grid.style.display = open ? 'none' : '';
    plBtn.classList.toggle('on', open);
    if (open) void refreshPlaylists();
}
plBtn.addEventListener('click', () => setPlaylistsOpen(!plOpen));

async function refreshPlaylists(): Promise<void> {
    if (!plOpen) return;
    if (plDetailId) await renderPlaylistDetail(plDetailId);
    else await renderPlaylistBrowser();
}

const fmtLong = (secs: number): string => {
    const s = Math.round(secs);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}h ${m}m` : `${m}m`;
};

// 2×2 art collage; a custom cover (or a single art) renders full-bleed instead
function plCollage(arts: string[], cover = ''): HTMLElement {
    const cov = document.createElement('div');
    cov.className = 'pl-cover';
    const use = cover ? [cover] : (arts || []).length >= 4 ? arts.slice(0, 4) : (arts || []).slice(0, 1);
    if (!use.length) cov.innerHTML = '<div class="pl-empty">♫</div>';
    else for (const a of use) {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = a;
        cov.appendChild(img);
    }
    return cov;
}

async function renderPlaylistBrowser(): Promise<void> {
    plDetailId = '';
    const res = await ipcRenderer.invoke('playlists:all').catch(() => null);
    if (!plOpen || plDetailId) return;
    const lists: PlSummary[] = (res && res.playlists) || [];
    plov.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pl-grid';
    const mkNew = document.createElement('button');
    mkNew.className = 'pl-new';
    mkNew.innerHTML = '<span class="big">+</span><span>New playlist</span>';
    mkNew.addEventListener('click', async () => {
        const name = await namePrompt('New playlist', '');
        if (!name) return;
        const c = await ipcRenderer.invoke('playlists:create', name);
        if (c && c.ok) void renderPlaylistDetail(c.id);
    });
    wrap.appendChild(mkNew);
    for (const pl of lists) {
        const card = document.createElement('div');
        card.className = 'pl-card';
        card.appendChild(plCollage(pl.arts, pl.cover));
        const name = document.createElement('div');
        name.className = 'pl-name';
        name.textContent = pl.name;
        const sub = document.createElement('div');
        sub.className = 'pl-sub';
        sub.textContent = pl.count + (pl.count === 1 ? ' track' : ' tracks') + (pl.duration ? ' · ' + fmtLong(pl.duration) : '');
        card.appendChild(name);
        card.appendChild(sub);
        card.addEventListener('click', () => void renderPlaylistDetail(pl.id));
        wrap.appendChild(card);
    }
    plov.appendChild(wrap);
    if (!lists.length) {
        const st = document.createElement('div');
        st.className = 'state';
        st.textContent = 'No playlists yet. Create one, then right-click any cover or song in your collection to add it.';
        plov.appendChild(st);
    }
}

async function renderPlaylistDetail(id: string): Promise<void> {
    plDetailId = id;
    const res = await ipcRenderer.invoke('playlists:get', id).catch(() => null);
    if (!plOpen || plDetailId !== id) return;
    if (!res || !res.ok) { void renderPlaylistBrowser(); return; }
    const p: { id: string; name: string; entries: PlEntry[]; desc?: string; coverUrl?: string } = res.playlist;
    plov.innerHTML = '';

    const head = document.createElement('div');
    head.className = 'pl-head';
    const back = document.createElement('button');
    back.className = 'tbtn';
    back.textContent = '←';
    back.title = 'All playlists';
    back.addEventListener('click', () => void renderPlaylistBrowser());
    head.appendChild(back);
    // cover: custom image when set, else the entry-art collage. click to change.
    const cov = plCollage([...new Set(p.entries.map((e) => e.art).filter(Boolean))], p.coverUrl || '');
    cov.classList.add('sm', 'clickable');
    cov.title = 'Change cover';
    cov.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        const menu = document.createElement('div');
        menu.className = 'dlmenu';
        menu.addEventListener('click', (ev) => ev.stopPropagation());
        const mk = (label: string, fn: () => void) => {
            const b = document.createElement('button');
            b.className = 'dlfmt';
            b.textContent = label;
            b.addEventListener('click', async (ev) => { ev.stopPropagation(); fn(); });
            menu.appendChild(b);
        };
        mk('Choose cover image…', async () => {
            closeMenu();
            const r = await ipcRenderer.invoke('playlists:cover-pick', id);
            if (r && r.ok) void renderPlaylistDetail(id);
        });
        if (p.coverUrl) mk('Remove custom cover', async () => {
            closeMenu();
            await ipcRenderer.invoke('playlists:cover-clear', id);
            void renderPlaylistDetail(id);
        });
        document.body.appendChild(menu);
        menuEl = menu;
        const r = cov.getBoundingClientRect();
        menu.style.left = Math.max(6, Math.min(r.left, window.innerWidth - 196)) + 'px';
        menu.style.top = Math.min(r.bottom + 4, window.innerHeight - 90) + 'px';
    });
    head.appendChild(cov);
    const twrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'pl-title';
    title.textContent = p.name;
    title.title = 'Rename';
    title.addEventListener('click', async () => {
        const n = await namePrompt('Rename playlist', p.name);
        if (!n || n === p.name) return;
        await ipcRenderer.invoke('playlists:rename', { id, name: n });
        void renderPlaylistDetail(id);
    });
    const meta = document.createElement('div');
    meta.className = 'pl-meta';
    const dur = p.entries.reduce((s, e) => s + (e.duration || 0), 0);
    meta.textContent = p.entries.length + (p.entries.length === 1 ? ' track' : ' tracks') + (dur ? ' · ' + fmtLong(dur) : '');
    twrap.appendChild(title);
    twrap.appendChild(meta);
    // description under the title; click to edit (multiline)
    const desc = document.createElement('div');
    desc.className = 'pl-desc' + (p.desc ? '' : ' empty');
    desc.textContent = p.desc || 'Add a description…';
    desc.title = 'Edit description';
    desc.addEventListener('click', async () => {
        const d = await textPrompt('Playlist description', p.desc || '', true);
        if (d === null) return; // cancelled ('' clears)
        await ipcRenderer.invoke('playlists:set-desc', { id, desc: d });
        void renderPlaylistDetail(id);
    });
    twrap.appendChild(desc);
    head.appendChild(twrap);

    const actions = document.createElement('div');
    actions.className = 'pl-actions';
    const act = (label: string, cls: string, fn: (b: HTMLButtonElement) => void): HTMLButtonElement => {
        const b = document.createElement('button');
        b.className = ('tbtn ' + cls).trim();
        b.textContent = label;
        b.addEventListener('click', () => fn(b));
        actions.appendChild(b);
        return b;
    };
    act('▶ Play', 'primary', () => void ipcRenderer.invoke('playlists:play', { id }));
    act('+ Queue', '', async (b) => {
        const r = await ipcRenderer.invoke('playlists:enqueue', id);
        b.textContent = r && r.ok ? 'added ✓' : 'failed';
        setTimeout(() => { b.textContent = '+ Queue'; }, 900);
    });
    // downloads the tracks in order + playlist-cover.png + description.txt +
    // the order file (m3u/pls/… per the download settings)
    act('⤓ Download', '', async (b) => {
        const r = await ipcRenderer.invoke('playlists:download', id);
        b.textContent = r && r.ok ? 'started ✓' : '× ' + ((r && r.error) || 'failed');
        setTimeout(() => { b.textContent = '⤓ Download'; }, 1600);
    });
    // delete arms on the first click instead of a confirm dialog
    let armed = false;
    act('Delete', '', async (b) => {
        if (!armed) {
            armed = true;
            b.textContent = 'Really delete?';
            setTimeout(() => { armed = false; b.textContent = 'Delete'; }, 2500);
            return;
        }
        await ipcRenderer.invoke('playlists:delete', id);
        void renderPlaylistBrowser();
    });
    head.appendChild(actions);
    plov.appendChild(head);

    if (!p.entries.length) {
        const st = document.createElement('div');
        st.className = 'state';
        st.textContent = 'This playlist is empty — right-click covers or songs in your collection to add them.';
        plov.appendChild(st);
        return;
    }

    p.entries.forEach((en, i) => {
        const row = document.createElement('div');
        row.className = 'pl-row';
        row.draggable = true;
        row.title = 'Play the playlist from here (drag to reorder)';
        row.innerHTML =
            `<span class="pl-num">${i + 1}.</span>` +
            `<span>${escapeHtml(en.title)}</span>` +
            `<span class="pl-art2">${escapeHtml(en.artist)}</span>` +
            `<span class="pl-alb2">${escapeHtml(en.album)}</span>` +
            `<span class="pl-dur">${fmtDur(en.duration)}</span>`;
        const x = document.createElement('button');
        x.className = 'pl-x';
        x.title = 'Remove from playlist';
        x.textContent = '✕';
        x.addEventListener('click', async (e) => {
            e.stopPropagation();
            await ipcRenderer.invoke('playlists:remove', { id, index: i });
            void renderPlaylistDetail(id);
        });
        row.appendChild(x);
        row.addEventListener('click', () => void ipcRenderer.invoke('playlists:play', { id, startIndex: i }));
        row.addEventListener('dragstart', (e) => {
            plDragFrom = i;
            row.classList.add('dragging');
            if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragend', () => {
            row.classList.remove('dragging');
            for (const el of Array.from(plov.querySelectorAll('.dragover'))) el.classList.remove('dragover');
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (plDragFrom !== null && plDragFrom !== i) row.classList.add('dragover');
        });
        row.addEventListener('dragleave', () => row.classList.remove('dragover'));
        row.addEventListener('drop', async (e) => {
            e.preventDefault();
            row.classList.remove('dragover');
            if (plDragFrom === null || plDragFrom === i) return;
            const from = plDragFrom;
            plDragFrom = null;
            await ipcRenderer.invoke('playlists:move', { id, from, to: i });
            void renderPlaylistDetail(id);
        });
        plov.appendChild(row);
    });
}

// pick a playlist to add a release/track to. opened by right-click on covers,
// tracklist rows & list-view rows, and the tracklist panel's "+ Playlist".
async function openPlaylistPicker(req: PlAddReq, x: number, y: number): Promise<void> {
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'dlmenu';
    menu.addEventListener('click', (ev) => ev.stopPropagation());
    const title = document.createElement('div');
    title.className = 'plm-title';
    title.textContent = req.trackId !== undefined || req.trackIndex !== undefined ? 'Add song to playlist' : 'Add release to playlist';
    menu.appendChild(title);
    document.body.appendChild(menu);
    menuEl = menu;
    const place = () => {
        menu.style.left = Math.max(6, Math.min(x, window.innerWidth - 196)) + 'px';
        menu.style.top = Math.max(6, Math.min(y, window.innerHeight - (menu.offsetHeight || 120) - 6)) + 'px';
    };
    place();
    const addRow = (label: string, fn: (b: HTMLButtonElement) => void): void => {
        const b = document.createElement('button');
        b.className = 'dlfmt';
        b.textContent = label;
        b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(b); });
        menu.appendChild(b);
    };
    const res = await ipcRenderer.invoke('playlists:all').catch(() => null);
    if (menuEl !== menu) return; // superseded by another menu
    const lists: PlSummary[] = (res && res.playlists) || [];
    for (const pl of lists) {
        addRow(pl.name, async (b) => {
            b.textContent = 'adding…';
            const r = await ipcRenderer.invoke('playlists:add', { id: pl.id, ...req });
            b.textContent = !r || !r.ok ? '× ' + (r?.error || 'failed')
                : r.added ? '✓ added' + (r.added > 1 ? ' ' + r.added + ' tracks' : '')
                : 'already on it';
            setTimeout(closeMenu, 900);
            if (plOpen) void refreshPlaylists();
        });
    }
    addRow('+ New playlist…', async () => {
        closeMenu();
        const name = await namePrompt('New playlist', '');
        if (!name) return;
        const c = await ipcRenderer.invoke('playlists:create', name);
        if (c && c.ok) {
            await ipcRenderer.invoke('playlists:add', { id: c.id, ...req });
            if (plOpen) void refreshPlaylists();
        }
    });
    place();
}

// window.prompt doesn't exist in electron renderers: tiny one-field modal.
// resolves the trimmed text ('' allowed — that's how a description is cleared)
// or null when cancelled. multiline uses a textarea (Ctrl+Enter submits).
function textPrompt(title: string, initial: string, multiline = false): Promise<string | null> {
    return new Promise((resolve) => {
        const back = document.createElement('div');
        back.className = 'modalback';
        back.innerHTML =
            `<div class="modal"><h3></h3>` +
            (multiline
                ? `<textarea spellcheck="false" maxlength="2000"></textarea>` +
                  `<div class="mrow" style="margin-top:10px"><span style="flex:1;font-size:11px;color:#848079;align-self:center">Ctrl+Enter to save</span>`
                : `<input type="text" spellcheck="false" autocomplete="off" maxlength="100" style="width:100%">` +
                  `<div class="mrow" style="margin-top:14px">`) +
            `<button class="m-ok primary">OK</button>` +
            `<button class="m-cancel">Cancel</button></div></div>`;
        (back.querySelector('h3') as HTMLElement).textContent = title;
        // (textarea shares every member used here; one type keeps listeners simple)
        const input = back.querySelector(multiline ? 'textarea' : 'input') as HTMLInputElement;
        input.value = initial;
        let settled = false;
        const done = (v: string | null) => { if (settled) return; settled = true; back.remove(); resolve(v); };
        back.querySelector('.m-ok')!.addEventListener('click', () => done(input.value.trim()));
        back.querySelector('.m-cancel')!.addEventListener('click', () => done(null));
        back.addEventListener('click', (e) => { e.stopPropagation(); if (e.target === back) done(null); });
        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // keep esc/media hotkeys from firing behind the modal
            if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) done(input.value.trim());
            if (e.key === 'Escape') done(null);
        });
        document.body.appendChild(back);
        input.focus();
        input.select();
    });
}
// name prompts treat an empty submit as a cancel
async function namePrompt(title: string, initial: string): Promise<string | null> {
    const v = await textPrompt(title, initial, false);
    return v ? v : null;
}
