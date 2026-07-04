import { ipcRenderer } from 'electron';

// global search view: bandcamp's own public search api, with playable results.
// tracks/albums play (or queue) via the same resolve path the collection uses;
// artists open their page.

ipcRenderer.send('gsearch:log', 'booted');

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const q = $('q') as HTMLInputElement;
const list = $('list');

interface Result { type: string; id: string; name: string; band: string; album: string; art: string; url: string; bandId: string; albumId: string }

let filter: '' | 't' | 'a' | 'b' = '';
let seq = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

function setState(msg: string): void {
    list.innerHTML = `<div class="state">${msg}</div>`;
}

function escapeHtml(s: string): string {
    return (s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

const BADGE: Record<string, string> = { t: 'track', a: 'album', b: 'artist' };

function playReq(r: Result): any {
    // a track rides inside its album when known so metadata resolves correctly
    if (r.type === 't') {
        return r.albumId
            ? { tralbumId: r.albumId, tralbumType: 'a', bandId: r.bandId, trackId: r.id, trackOnly: true }
            : { tralbumId: r.id, tralbumType: 't', bandId: r.bandId, trackOnly: true };
    }
    return { tralbumId: r.id, tralbumType: 'a', bandId: r.bandId };
}

function render(results: Result[]): void {
    if (!results.length) { setState('no results.'); return; }
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const r of results) {
        const row = document.createElement('div');
        row.className = 'row';
        row.innerHTML =
            `<img class="rart" loading="lazy"${r.art ? ` src="${r.art}"` : ''}>` +
            `<div class="rmeta"><div class="rname">${escapeHtml(r.name)}</div>` +
            `<div class="rsub">${escapeHtml(r.band)}${r.album && r.type === 't' ? ' — ' + escapeHtml(r.album) : ''}</div></div>` +
            `<span class="rbadge${r.type === 'b' ? ' b' : ''}">${BADGE[r.type] || escapeHtml(r.type)}</span>`;
        if (r.type === 't' || r.type === 'a') {
            const act = document.createElement('div');
            act.className = 'ract';
            const play = document.createElement('button');
            play.title = 'play';
            play.textContent = '▶';
            play.addEventListener('click', (e) => { e.stopPropagation(); ipcRenderer.invoke('collection:play', playReq(r)); });
            const enq = document.createElement('button');
            enq.title = 'add to queue';
            enq.textContent = '+';
            enq.addEventListener('click', async (e) => {
                e.stopPropagation();
                const req = playReq(r);
                const res = await ipcRenderer.invoke('collection:enqueue', {
                    tralbumId: req.tralbumId, tralbumType: req.tralbumType, bandId: req.bandId,
                    trackId: r.type === 't' ? r.id : undefined,
                });
                enq.textContent = res && res.ok ? '✓' : '×';
                setTimeout(() => { enq.textContent = '+'; }, 900);
            });
            act.appendChild(play);
            act.appendChild(enq);
            row.appendChild(act);
        }
        row.addEventListener('click', () => { if (r.url) ipcRenderer.send('app:navigate', r.url); });
        frag.appendChild(row);
    }
    list.appendChild(frag);
}

async function run(): Promise<void> {
    const text = q.value.trim();
    if (!text) { setState('Type to search Bandcamp. Results play straight into the queue.'); return; }
    const mySeq = ++seq;
    setState('searching…');
    const res: { ok: boolean; results: Result[]; error?: string } =
        await ipcRenderer.invoke('gsearch:query', { text, filter });
    if (mySeq !== seq) return; // superseded by newer keystrokes
    if (!res.ok) { setState('search failed' + (res.error ? ': ' + res.error : '')); return; }
    render(res.results || []);
}

q.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(run, 350); });
q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); run(); } });

function setFilter(f: '' | 't' | 'a' | 'b'): void {
    filter = f;
    $('f-all').classList.toggle('on', f === '');
    $('f-t').classList.toggle('on', f === 't');
    $('f-a').classList.toggle('on', f === 'a');
    $('f-b').classList.toggle('on', f === 'b');
    if (q.value.trim()) run();
}
$('f-all').addEventListener('click', () => setFilter(''));
$('f-t').addEventListener('click', () => setFilter('t'));
$('f-a').addEventListener('click', () => setFilter('a'));
$('f-b').addEventListener('click', () => setFilter('b'));

$('close').addEventListener('click', () => ipcRenderer.send('gsearch:close'));
ipcRenderer.on('gsearch:shown', () => q.focus());
// nothing from a search is kept: closing the view wipes the query & results
// (search itself never writes to any cache — this clears the visible leftovers)
ipcRenderer.on('gsearch:hidden', () => {
    seq++; // invalidate any in-flight request
    q.value = '';
    setState('Type to search Bandcamp. Results play straight into the queue.');
});
