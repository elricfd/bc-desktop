import { ipcRenderer } from 'electron';
import type { FeedStory } from '../shared/types';

// custom feed view: a clean, endlessly-scrollable grid of stories from artists
// (new releases) & fans you follow, replacing bandcamp's own feed page. data
// comes from main (feed:fetch) which pages the fan_dash_feed_updates endpoint.

ipcRenderer.send('feed:log', 'booted');

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const list = $('list');
const countEl = $('count');

let stories: FeedStory[] = [];
const seen = new Set<string>();
let filter = ''; // '' = all, 'nr' = new releases, 'df' = fan activity
let oldest = 0; // unix ts to page back from
let fetching = false;
let exhausted = false;
let pagesLoaded = 0;

function setState(msg: string): void {
    list.innerHTML = `<div class="state">${msg}</div>`;
}

function escapeHtml(s: string): string {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

// "today" / "yesterday" / "3 Jul 2026" bucket for the date separators
function dayLabel(ts: number): string {
    if (!ts) return 'earlier';
    const d = new Date(ts * 1000);
    const now = new Date();
    const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((midnight(now) - midnight(d)) / 86400000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function visible(): FeedStory[] {
    return filter ? stories.filter((s) => s.type === filter) : stories;
}

function updateCount(): void {
    const v = visible();
    countEl.textContent = v.length + (v.length === 1 ? ' story' : ' stories') + (fetching ? ' — loading…' : '');
}

const storyKey = (s: FeedStory): string => s.type + ':' + s.tralbumType + s.tralbumId + ':' + s.date;

function createCard(s: FeedStory): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.key = storyKey(s);

    const wrap = document.createElement('div');
    wrap.className = 'artwrap';
    wrap.innerHTML =
        `<img class="art" loading="lazy"${s.art ? ` src="${s.art}"` : ''}>` +
        `<span class="badge${s.type === 'df' ? ' df' : ''}">${s.type === 'nr' ? 'new' : s.type === 'df' ? 'collected' : escapeHtml(s.type)}</span>`;

    const play = document.createElement('button');
    play.className = 'play';
    play.title = 'play';
    play.textContent = '▶';
    play.addEventListener('click', async (e) => {
        e.stopPropagation();
        await ipcRenderer.invoke('collection:play', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId, trackId: s.trackId || undefined });
    });
    wrap.appendChild(play);

    const enq = document.createElement('button');
    enq.className = 'enq';
    enq.title = 'add to queue';
    enq.textContent = '+';
    enq.addEventListener('click', async (e) => {
        e.stopPropagation();
        const prev = enq.textContent;
        const res = await ipcRenderer.invoke('collection:enqueue', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId });
        enq.textContent = res && res.ok ? '✓' : '×';
        setTimeout(() => { enq.textContent = prev; }, 900);
    });
    wrap.appendChild(enq);
    card.appendChild(wrap);

    const meta = document.createElement('div');
    meta.innerHTML =
        `<div class="t">${escapeHtml(s.title || 'Untitled')}</div>` +
        `<div class="a">${escapeHtml(s.artist)}</div>` +
        (s.via ? `<div class="w">collected by ${escapeHtml(s.via)}</div>` : '');
    card.appendChild(meta);

    // expand the story inline (tracklist / tags / description)
    card.addEventListener('click', () => togglePanel(s, card));
    return card;
}

// --- expanded story panel -------------------------------------------------

const fmtDur = (x: number): string => (!x || x < 0 ? '' : `${Math.floor(x / 60)}:${Math.floor(x % 60).toString().padStart(2, '0')}`);
let panelEl: HTMLElement | null = null;
let panelKey = '';
function closePanel(): void { if (panelEl) { panelEl.remove(); panelEl = null; } panelKey = ''; }

// last card in the clicked card's visual row (panel spans the full grid width)
function endOfRow(card: HTMLElement): HTMLElement {
    const cards = Array.from(list.querySelectorAll('.card')) as HTMLElement[];
    const top = card.offsetTop;
    let last = card;
    for (const c of cards) { if (c.offsetTop === top) last = c; else if (c.offsetTop > top) break; }
    return last;
}

async function togglePanel(s: FeedStory, card: HTMLElement): Promise<void> {
    const key = storyKey(s);
    const wasOpen = panelKey === key && !!panelEl;
    closePanel();
    if (wasOpen) return;
    panelKey = key;

    const panel = document.createElement('div');
    panel.className = 'fdpanel';
    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.innerHTML =
        `<div class="fdleft"><img class="fdart"${s.art ? ` src="${s.art}"` : ''}>` +
        `<div class="fdtitle">${escapeHtml(s.title || 'Untitled')}</div>` +
        `<div class="fdartist">${escapeHtml(s.artist)}</div>` +
        `<div class="fdwhen">${escapeHtml(dayLabel(s.date))}${s.via ? ' — collected by ' + escapeHtml(s.via) : ''}</div>` +
        `<div class="fdbtns"><button class="fdplayall">▶ Play</button>` +
        `<button class="fdqueue">+ Queue</button><button class="fdopen">Open page</button><button class="fdclose">Close</button></div></div>` +
        `<div class="fdright"><div class="fdtags"></div><div class="fdabout" style="display:none"></div>` +
        `<div class="fdtracks"><div class="fdstate">loading tracklist…</div></div></div>`;

    endOfRow(card).after(panel);
    panelEl = panel;

    panel.querySelector('.fdclose')!.addEventListener('click', closePanel);
    panel.querySelector('.fdopen')!.addEventListener('click', () => { if (s.url) ipcRenderer.send('app:navigate', s.url); });
    panel.querySelector('.fdplayall')!.addEventListener('click', () => {
        ipcRenderer.invoke('collection:play', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId, activeIndex: 0 });
    });
    panel.querySelector('.fdqueue')!.addEventListener('click', async (e) => {
        const b = e.target as HTMLElement; b.textContent = 'adding…';
        const r = await ipcRenderer.invoke('collection:enqueue', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId });
        b.textContent = r && r.ok ? 'added ✓' : 'failed';
    });

    const res: { ok: boolean; tags: string[]; tracks: [string, number][]; about: string } =
        await ipcRenderer.invoke('release:details', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId });
    if (panelEl !== panel) return;

    const tagsEl = panel.querySelector('.fdtags') as HTMLElement;
    const aboutEl = panel.querySelector('.fdabout') as HTMLElement;
    const tracksEl = panel.querySelector('.fdtracks') as HTMLElement;
    if (!res || !res.ok) { tracksEl.innerHTML = '<div class="fdstate">couldn\'t load the details</div>'; return; }

    // tag chips open that tag's discover page on bandcamp (e.g. /discover/experimental)
    tagsEl.innerHTML = '';
    for (const t of res.tags || []) {
        const chip = document.createElement('span');
        chip.className = 'fdtag';
        chip.textContent = t;
        chip.title = 'Browse "' + t + '" on Bandcamp';
        chip.style.cursor = 'pointer';
        chip.addEventListener('click', () => {
            const norm = t.trim().toLowerCase().replace(/\s+/g, '-');
            ipcRenderer.send('app:navigate', 'https://bandcamp.com/discover/' + encodeURIComponent(norm));
        });
        tagsEl.appendChild(chip);
    }
    if (res.about) { aboutEl.style.display = 'block'; aboutEl.textContent = res.about; }

    const tracks = res.tracks || [];
    if (!tracks.length) { tracksEl.innerHTML = '<div class="fdstate">no tracklist available</div>'; return; }
    tracksEl.innerHTML = '';
    tracks.forEach(([title, dur], i) => {
        const row = document.createElement('div');
        row.className = 'fdrow';
        row.innerHTML =
            `<span class="fdnum">${i + 1}</span>` +
            `<span class="fdtrk">${escapeHtml(title)}</span>` +
            `<span class="fddur">${fmtDur(dur)}</span>`;
        row.addEventListener('click', () => {
            ipcRenderer.invoke('collection:play', { tralbumId: s.tralbumId, tralbumType: s.tralbumType, bandId: s.bandId, activeIndex: i });
        });
        tracksEl.appendChild(row);
    });
}

// keep the panel seated at its row end through resizes & re-renders
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        if (!panelEl || !panelKey) return;
        // find the card whose story key matches by re-walking current cards
        const anchor = panelEl.previousElementSibling as HTMLElement | null;
        if (anchor && anchor.classList.contains('card')) { panelEl.remove(); endOfRow(anchor).after(panelEl); }
    }, 80);
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

function render(): void {
    const v = visible();
    updateCount();
    if (!v.length) {
        closePanel();
        setState(fetching ? 'Loading your feed…' : 'nothing here — follow some artists on bandcamp and check back.');
        return;
    }
    // detach the open panel so a re-render (new page / filter) doesn't destroy it
    if (panelEl) panelEl.remove();
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    let lastDay = '';
    for (const s of v) {
        const day = dayLabel(s.date);
        if (day !== lastDay) {
            lastDay = day;
            const sep = document.createElement('div');
            sep.className = 'daysep';
            sep.textContent = day;
            frag.appendChild(sep);
        }
        frag.appendChild(createCard(s));
    }
    list.appendChild(frag);
    if (panelEl && panelKey) {
        const card = list.querySelector(`.card[data-key="${CSS.escape(panelKey)}"]`) as HTMLElement | null;
        if (card) endOfRow(card).after(panelEl);
        else { panelEl = null; panelKey = ''; } // its story got filtered out
    }
}

async function fetchPage(reset = false): Promise<void> {
    if (fetching) return;
    if (reset) { stories = []; seen.clear(); oldest = 0; exhausted = false; pagesLoaded = 0; setState('Loading your feed…'); }
    if (exhausted || pagesLoaded >= 100) return;
    fetching = true;
    updateCount();
    try {
        const res: { ok: boolean; stories: FeedStory[]; oldest: number; error?: string } =
            await ipcRenderer.invoke('feed:fetch', oldest);
        ipcRenderer.send('feed:log', 'page ' + pagesLoaded + ' ok=' + res.ok + ' n=' + (res.stories || []).length + (res.error ? ' err=' + res.error : ''));
        if (!res.ok) {
            if (!stories.length) setState('could not load the feed' + (res.error ? ': ' + res.error : '') + '. are you logged in on bandcamp?');
            exhausted = true;
            return;
        }
        pagesLoaded++;
        let added = 0;
        for (const s of res.stories || []) {
            const key = s.type + ':' + s.tralbumType + s.tralbumId + ':' + s.date;
            if (seen.has(key)) continue;
            seen.add(key);
            stories.push(s);
            added++;
        }
        stories.sort((a, b) => (b.date || 0) - (a.date || 0));
        const nextOldest = res.oldest || 0;
        // no forward progress = end of the feed
        if (!added || !nextOldest || (oldest && nextOldest >= oldest)) exhausted = true;
        oldest = nextOldest || oldest;
        render();
    } finally {
        fetching = false;
        updateCount();
        // keep filling until the view is actually scrollable (small pages)
        if (!exhausted && list.scrollHeight <= list.clientHeight + 40) fetchPage();
    }
}

// infinite scroll: pull the next page as the bottom approaches
list.addEventListener('scroll', () => {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 600) fetchPage();
});

function setFilter(f: string): void {
    filter = f;
    $('f-all').classList.toggle('on', f === '');
    $('f-nr').classList.toggle('on', f === 'nr');
    $('f-df').classList.toggle('on', f === 'df');
    render();
    // a sparse filter may leave the view short; top it up
    if (!exhausted && list.scrollHeight <= list.clientHeight + 40) fetchPage();
}
$('f-all').addEventListener('click', () => setFilter(''));
$('f-nr').addEventListener('click', () => setFilter('nr'));
$('f-df').addEventListener('click', () => setFilter('df'));

$('refresh').addEventListener('click', () => fetchPage(true));
$('close').addEventListener('click', () => ipcRenderer.send('feed:close'));

ipcRenderer.on('feed:shown', () => { if (!stories.length && !fetching) fetchPage(true); });
ipcRenderer.on('feed:load', () => { if (!stories.length && !fetching) fetchPage(true); });
