import type { Session } from 'electron';
import type { PlayerTrack, TralbumType, CollectionItem, DownloadFormat, FeedStory } from '../shared/types';

// mirrors res strat used by bandcamp player ext: hit cred tralbum endpoints to obtain full tracklist (w/ direct stream urls) for release. this is what lets player advance thru album or collection w/out scraping per track dom.

interface TralbumQuery {
    bandId?: string;
    tralbumId: string;
    tralbumType: TralbumType;
    trackId?: string;
}

const STREAM_PREFERENCE = ['mp3-128', 'mp3-v0', 'mp3-320'];

// how long fetched tracklist / track -> album map stays fresh. mirrors ext tralbum cache ttl ms so repeated traps of same release (or player's per track fallback) never rehit network.
const CACHE_TTL_MS = 15 * 60 * 1000;

function toId(value: unknown): string {
    if (value === null || value === undefined) return '';
    const match = String(value).match(/\d+/);
    return match ? match[0] : '';
}

function pickStream(file: any): string {
    if (typeof file === 'string') return file.trim();
    if (!file || typeof file !== 'object') return '';
    for (const key of STREAM_PREFERENCE) {
        if (typeof file[key] === 'string' && file[key]) return file[key];
    }
    const first = Object.values(file).find((v) => typeof v === 'string' && v);
    return (first as string) || '';
}

export class BandcampApi {
    // main proc owns content view session; we reuse it so reqs carry fan login cookies (priv streams resolve correctly).
    constructor(private readonly getSession: () => Session | null) {}

    /** set by main: called whenever bandcamp answers HTTP 429 (drives the user-facing notice). */
    on429?: () => void;
    private notify429(status: number): void {
        if (status === 429) { try { this.on429?.(); } catch { /* notifier failed */ } }
    }

    // cache full tracklists by `${type}:${tralbumId}` and track -> album map by track id. both expire after cache ttl ms.
    private readonly tralbumCache = new Map<string, { tracks: PlayerTrack[]; at: number }>();
    private readonly albumOfTrack = new Map<string, { albumId: string; bandId: string; at: number }>();
    // release year by `${type}:${id}` (bandcamp's collection api omits release dates, so we read them from the tralbum endpoint on demand)
    private readonly yearCache = new Map<string, number>();

    // pull the release *year* out of a tralbum payload (string date or unix ts)
    private extractYear(data: any): number {
        if (!data || typeof data !== 'object') return 0;
        const cur = data.current || {};
        const raw = data.release_date ?? cur.release_date ?? data.publish_date ?? cur.publish_date;
        if (raw == null || raw === '') return 0;
        let d: Date | null = null;
        if (typeof raw === 'number') d = new Date(raw > 1e12 ? raw : raw * 1000);
        else { const t = Date.parse(String(raw)); if (!isNaN(t)) d = new Date(t); }
        const y = d ? d.getFullYear() : Number(String(raw).match(/\b(19|20)\d{2}\b/)?.[0] || 0);
        return y > 1900 && y < 3000 ? y : 0;
    }

    /** release year for a (type,id), fetched (and cached) from the tralbum endpoint. 0 if unknown. */
    async fetchReleaseYear(q: TralbumQuery): Promise<number> {
        const id = toId(q.tralbumId);
        if (!id) return 0;
        const key = `${q.tralbumType}:${id}`;
        if (this.yearCache.has(key)) return this.yearCache.get(key) as number;
        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        for (const type of types) {
            const data = await this.fetchRaw(type, id, q.bandId);
            if (!data) continue;
            const y = this.extractYear(data);
            this.yearCache.set(`${type}:${id}`, y);
            if (y) return y;
        }
        return this.yearCache.get(key) || 0;
    }

    /**
     * release details for one collection/feed item: genre tags, tracklist
     * (title+duration), release year & about text. drives the collection's search
     * index / list view and the feed's expanded cards. status-aware so the bulk
     * index builder can back off on 429 instead of silently losing items.
     */
    async fetchSearchIndex(q: TralbumQuery, interactive = false): Promise<
        { ok: true; tags: string[]; tracks: { title: string; duration: number }[]; year: number; about: string }
        | { ok: false; retryable: boolean }
    > {
        const id = toId(q.tralbumId);
        if (!id) return { ok: false, retryable: false };
        if (interactive) this.noteInteractive();
        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        let sawData = false;
        for (const type of types) {
            for (const url of this.attemptUrls(type, id, q.bandId)) {
                let { data, status } = await this.fetchRawFromStatus(url);
                // a user's click retries through a 429 (the crawler yields to us);
                // the bulk crawler instead returns retryable & backs off itself
                if (status === 429 && interactive) {
                    for (let attempt = 0; attempt < 3 && status === 429; attempt++) {
                        await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
                        ({ data, status } = await this.fetchRawFromStatus(url));
                    }
                }
                if (status === 429) return { ok: false, retryable: true };
                if (!data) continue;
                sawData = true;
                const tags = (Array.isArray(data.tags) ? data.tags : [])
                    .map((t: any) => String((t && (t.name || t.norm_name)) || '').trim())
                    .filter(Boolean);
                const rows: any[] = Array.isArray(data.trackinfo) ? data.trackinfo : Array.isArray(data.tracks) ? data.tracks : [];
                if (!tags.length && !rows.length) continue; // thin payload; try the next endpoint
                const year = this.extractYear(data);
                if (year) this.yearCache.set(`${q.tralbumType}:${id}`, year);
                return {
                    ok: true,
                    tags,
                    tracks: rows.map((t: any) => ({
                        title: String((t && t.title) || '').trim(),
                        duration: Math.max(0, Math.floor(Number(t && t.duration) || 0)),
                    })).filter((t) => t.title),
                    year,
                    about: String(data.about || (data.current && data.current.about) || '').trim(),
                };
            }
        }
        // real payloads but no tags/tracks anywhere: cache the emptiness (not retryable)
        if (sawData) return { ok: true, tags: [], tracks: [], year: 0, about: '' };
        return { ok: false, retryable: false };
    }

    /** seed the year cache (e.g. from a persisted store) so we don't refetch across sessions. */
    primeYear(type: TralbumType, id: string, year: number): void {
        if (id && year) this.yearCache.set(`${type}:${toId(id)}`, year);
    }
    getReleaseYear(type: TralbumType, id: string): number {
        return this.yearCache.get(`${type}:${toId(id)}`) || 0;
    }

    private cacheGet(key: string): PlayerTrack[] | null {
        const entry = this.tralbumCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at > CACHE_TTL_MS) {
            this.tralbumCache.delete(key);
            return null;
        }
        return entry.tracks;
    }

    private attemptUrls(type: TralbumType, tralbumId: string, bandId?: string): string[] {
        const mobile = new URL('https://bandcamp.com/api/mobile/24/tralbum_details');
        const info = new URL('https://bandcamp.com/api/tralbum/2/info');
        for (const u of [mobile, info]) {
            if (bandId) u.searchParams.set('band_id', bandId);
            u.searchParams.set('tralbum_id', tralbumId);
            u.searchParams.set('tralbum_type', type);
        }
        // web (info) endpoint first: its `artist` is the release's own artist (e.g. a
        // side-project on a label's page), whereas mobile's tralbum_artist is the band
        // — using mobile first showed the band name instead of the release artist.
        return [info.toString(), mobile.toString()];
    }

    /** GET one endpoint & return {data,status} so bulk callers can react to 429s. */
    private async fetchRawFromStatus(url: string): Promise<{ data: any | null; status: number }> {
        const session = this.getSession();
        if (!session) return { data: null, status: 0 };
        try {
            const res = await session.fetch(url, { credentials: 'include' } as any);
            if (!res.ok) { this.notify429(res.status); return { data: null, status: res.status }; }
            const data: any = await res.json();
            if (!data || typeof data !== 'object') return { data: null, status: res.status };
            // bandcamp returns 200 with {error:true,error_message:...} for bad/retired
            // endpoints (tralbum/2/info now answers "bad function"). treating that as
            // data poisoned every fallback: track→album lookups died, so collection
            // track items played with the page/band artist instead of the release's.
            if (data.error) return { data: null, status: res.status };
            return { data, status: res.status };
        } catch {
            return { data: null, status: 0 };
        }
    }

    // user-initiated fetches note themselves here; the background index crawler
    // yields while this is fresh so interactive actions (opening a tracklist,
    // paging the feed) never lose the 429 budget to the crawl.
    private lastInteractiveAt = 0;
    noteInteractive(): void { this.lastInteractiveAt = Date.now(); }
    interactiveIdleMs(): number { return Date.now() - this.lastInteractiveAt; }

    /**
     * GET one endpoint & return its json object (or null). used by the
     * user-initiated paths, so it marks interactive activity & retries 429s
     * with a short backoff instead of failing the user's click.
     */
    private async fetchRawFrom(url: string): Promise<any | null> {
        this.noteInteractive();
        for (let attempt = 0; attempt < 3; attempt++) {
            const { data, status } = await this.fetchRawFromStatus(url);
            if (data) return data;
            if (status !== 429) return null;
            await new Promise((res) => setTimeout(res, 800 * Math.pow(2, attempt)));
        }
        return null;
    }

    /** fetch raw tralbum payload for single (type, id) used to read parent album id of track before fetching full album. */
    private async fetchRaw(type: TralbumType, tralbumId: string, bandId?: string): Promise<any | null> {
        if (!tralbumId) return null;
        for (const url of this.attemptUrls(type, tralbumId, bandId)) {
            const data = await this.fetchRawFrom(url);
            if (data) return data;
        }
        return null;
    }

    /** fetch & norm full tracklist for release (cached). */
    async fetchTralbum(q: TralbumQuery): Promise<PlayerTrack[]> {
        if (!q.tralbumId) return [];
        const primaryKey = `${q.tralbumType}:${q.tralbumId}`;
        const cached = this.cacheGet(primaryKey);
        if (cached) return cached;

        const types: TralbumType[] = q.tralbumType === 't' ? ['t', 'a'] : ['a', 't'];
        for (const type of types) {
            // try EACH endpoint (web then mobile) and use the first that yields
            // tracks. going through fetchRaw returned the first *object* the web
            // endpoint gave — if that was a trackless/error payload, the mobile
            // endpoint was never tried and the tracklist came back empty.
            for (const url of this.attemptUrls(type, q.tralbumId, q.bandId)) {
                const data = await this.fetchRawFrom(url);
                if (!data) continue;
                const tracks = this.normalize(data, { ...q, tralbumType: type });
                if (!tracks.length) continue;
                const at = Date.now();
                this.tralbumCache.set(primaryKey, { tracks, at });
                // also key by album id actually returned so track id lookup and later album id lookup share 1 cache entry.
                const realId = toId((data && (data.id ?? data.tralbum_id)) || q.tralbumId);
                if (realId) this.tralbumCache.set(`${type}:${realId}`, { tracks, at });
                // cache the release year while we have the payload
                const yr = this.extractYear(data);
                this.yearCache.set(primaryKey, yr);
                if (realId) this.yearCache.set(`${type}:${realId}`, yr);
                return tracks;
            }
        }
        return [];
    }

    /** resolve single missing stream url for queued track. */
    async resolveStream(q: TralbumQuery): Promise<PlayerTrack | null> {
        const tracks = await this.fetchTralbum(q);
        if (!tracks.length) return null;
        if (q.trackId) {
            const match = tracks.find((t) => t.id === toId(q.trackId));
            if (match) return match;
        }
        return tracks[0];
    }

    /**
     * build full album q from just track id. this is what makes collection, feed, discover and fan collection playlist surfaces play clicked release in full none of them expose tracklist in page so we look track up, find parent album, and fetch whole album.
     */
    async resolveQueueForTrack(
        trackId: string,
        bandId?: string
    ): Promise<{ tracks: PlayerTrack[]; activeIndex: number }> {
        const tId = toId(trackId);
        if (!tId) return { tracks: [], activeIndex: 0 };

        // reuse known track -> album map so retrap of same track skips discovery fetch entirely.
        const mapped = this.albumOfTrack.get(tId);
        if (mapped && Date.now() - mapped.at <= CACHE_TTL_MS) {
            const tracks = await this.fetchTralbum({
                tralbumId: mapped.albumId,
                tralbumType: 'a',
                bandId: mapped.bandId || bandId,
            });
            if (tracks.length) {
                const idx = tracks.findIndex((t) => t.id === tId);
                return { tracks, activeIndex: idx === -1 ? 0 : idx };
            }
        }

        const trackData = await this.fetchRaw('t', tId, bandId);
        const albumId = toId(trackData?.album_id ?? trackData?.current?.album_id ?? trackData?.album?.id);
        const resolvedBand = toId(
            trackData?.band_id ?? trackData?.current?.band_id ?? trackData?.selling_band_id ?? bandId
        );

        if (albumId) {
            this.albumOfTrack.set(tId, { albumId, bandId: resolvedBand, at: Date.now() });
            const tracks = await this.fetchTralbum({ tralbumId: albumId, tralbumType: 'a', bandId: resolvedBand });
            if (tracks.length) {
                const idx = tracks.findIndex((t) => t.id === tId);
                return { tracks, activeIndex: idx === -1 ? 0 : idx };
            }
        }

        // standalone track (no album or album fetch failed): q it alone but w/ proper metadata + real stream url.
        const single = this.normalize(trackData, { tralbumId: tId, tralbumType: 't', bandId: resolvedBand });
        return { tracks: single, activeIndex: 0 };
    }

    /**
     * resolve the tracklist for a bandcamp release/track *page url* (used by
     * add-to-queue on links & release pages). reads the page's embedded TralbumData
     * blob (data-tralbum on modern pages) so we get real stream urls without knowing
     * the tralbum id up front.
     */
    async fetchTracksFromUrl(pageUrl: string): Promise<PlayerTrack[]> {
        const session = this.getSession();
        if (!session || !pageUrl) return [];
        let html = '';
        try {
            const r = await session.fetch(pageUrl, { credentials: 'include' } as any);
            if (!r.ok) return [];
            html = await r.text();
        } catch {
            return [];
        }
        let blob: any = null;
        const m = html.match(/data-tralbum="([^"]+)"/);
        if (m) {
            try { blob = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')); } catch { /* try next */ }
        }
        if (!blob) {
            const m2 = html.match(/data-tralbum='([^']+)'/);
            if (m2) { try { blob = JSON.parse(m2[1]); } catch { /* give up */ } }
        }
        if (!blob) return [];
        const type: TralbumType = (blob.item_type === 'track' || blob.tralbum_type === 't') ? 't' : 'a';
        return this.normalize(blob, {
            tralbumId: toId(blob.id ?? blob.tralbum_id),
            tralbumType: type,
            bandId: toId(blob.band_id ?? blob.selling_band_id),
        });
    }

    /** resolve a bandcamp page url for a track/release that shipped without one (e.g. homepage playlist rows) so the player's title/artist links work. */
    async resolvePageUrl(q: { trackId?: string; bandId?: string; tralbumId?: string; tralbumType?: TralbumType }): Promise<string> {
        const bandId = q.bandId;
        const tId = toId(q.trackId);
        if (tId) {
            const d = await this.fetchRaw('t', tId, bandId);
            const u = (d?.url || d?.bandcamp_url || d?.current?.bandcamp_url || '').toString();
            if (u) return u;
        }
        const alb = toId(q.tralbumId);
        if (alb) {
            const type: TralbumType = q.tralbumType === 't' ? 't' : 'a';
            const d = await this.fetchRaw(type, alb, bandId);
            const u = (d?.url || d?.bandcamp_url || d?.current?.bandcamp_url || '').toString();
            if (u) return u;
        }
        return '';
    }

    private normalize(data: any, q: TralbumQuery): PlayerTrack[] {
        if (!data || typeof data !== 'object') return [];

        const current = data.current || {};
        const bandId = toId(data.band_id ?? data.selling_band_id ?? q.bandId);
        const tralbumId = toId(data.id ?? data.tralbum_id ?? q.tralbumId);
        const tralbumType: TralbumType =
            (data.item_type || data.tralbum_type || q.tralbumType) === 't' ? 't' : 'a';

        // prefer the release's own artist (current.artist / artist) over the band /
        // tralbum_artist so a side-project or various-artists release shows its real
        // artist, not the page/label name. tralbum_artist/band.name are fallbacks for
        // the mobile endpoint shape.
        const artist = (
            current.artist || data.artist || data.tralbum_artist ||
            data.band_name || (data.band && data.band.name) || 'Bandcamp'
        ).toString().trim();
        const album = (data.album_title || current.title || data.title || '').toString().trim();
        const artId = toId(data.art_id ?? current.art_id);
        const art = artId ? `https://f4.bcbits.com/img/a${artId}_10.jpg` : '';
        const pageUrl = (data.url || current.bandcamp_url || data.bandcamp_url || '').toString();

        const rawTracks: any[] = Array.isArray(data.trackinfo)
            ? data.trackinfo
            : Array.isArray(data.tracks)
            ? data.tracks
            : [];

        const tracks: PlayerTrack[] = rawTracks
            .map((t: any) => {
                const src = pickStream(t.file || t.streaming_url || t.mp3_url);
                const id = toId(t.track_id ?? t.id);
                return {
                    id,
                    title: (t.title || current.title || 'Unknown Track').toString().trim(),
                    artist: (t.artist || t.band_name || artist).toString().trim(),
                    album,
                    art,
                    src,
                    duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                    url: pageUrl,
                    bandId,
                    tralbumId,
                    tralbumType,
                } as PlayerTrack;
            })
            .filter((t) => t.src);

        return tracks;
    }

    // fan collection (for custom sortable collection view)

    /** norm 1 fancollection item (same shape as page item cache). */
    private normalizeCollectionItem(it: any, redownloadUrls: Record<string, string>): CollectionItem {
        const type: TralbumType = (it.item_type === 'track' || it.tralbum_type === 't') ? 't' : 'a';
        const artId = toId(it.item_art_id ?? it.art_id);
        const added = Date.parse(it.purchased || it.added || it.date_added || '') || 0;
        // release year: bandcamp's collection api usually omits it, so this is often 0
        // and gets filled in later by fetchReleaseYear (see collection:enrich-years).
        // deliberately NOT falling back to the added date — that made "sort by year"
        // behave like "sort by date added".
        const rel = it.release_date || it.releaseDate || '';
        const year = Number(String(rel).match(/\b(19|20)\d{2}\b/)?.[0]) || 0;
        // redownload key is sale_item_type + sale_item_id, e.g. c173525240
        const saleKey = (it.sale_item_type || '') + toId(it.sale_item_id);
        return {
            itemId: toId(it.item_id ?? it.tralbum_id),
            tralbumId: toId(it.tralbum_id ?? it.album_id ?? it.item_id),
            tralbumType: type,
            title: (it.item_title || it.album_title || it.title || '').toString().trim(),
            artist: (it.band_name || it.artist || '').toString().trim(),
            art: artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : '',
            url: (it.item_url || '').toString(),
            bandId: toId(it.band_id ?? it.selling_band_id),
            addedAt: added,
            year,
            downloadUrl: (redownloadUrls[saleKey] || '').toString(),
        };
    }

    /**
     * fetch fan entire collection via fancollection api (page only embeds first ~20). resolves fan id + total count from cred collection summary endpoint then pages thru collection items.
     *
     * prev impl broke on any transient !ok (esp http 429) mid paginate, truncating collection to whatever it had (hence 580 / 1265 of 2780). now: big page size (fewer reqs = faster & less likely throttled) + per page retry w/ backoff so a single hiccup can't cut the run short. onprogress reports running count to view.
     */
    /**
     * stopAtKeys: keys ("<type><id>") already known to the caller. the collection
     * api pages newest-first, so hitting a known item means everything after it is
     * already cached — stop there. this is what makes Reload/startup an
     * incremental "check for new purchases" instead of a full re-scan.
     */
    async fetchCollection(
        maxItems = 20000,
        onProgress?: (added: CollectionItem[], soFar: number, total: number) => void,
        stopAtKeys?: Set<string>
    ): Promise<CollectionItem[]> {
        const session = this.getSession();
        if (!session) return [];

        let fanId = '';
        let total = 0;
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', {
                credentials: 'include',
            } as any);
            if (r.ok) {
                const d: any = await r.json();
                fanId = toId(d?.fan_id ?? d?.collection_summary?.fan_id);
                // summary lists every owned tralbum keyed by <type><id>; its size is the real count to page toward
                const lookup = d?.collection_summary?.tralbum_lookup;
                if (lookup && typeof lookup === 'object') total = Object.keys(lookup).length;
            }
        } catch {
            // fall thru
        }
        if (!fanId) return [];

        // pull one page w/ retry: only give up on a page after several failed attempts (backoff) so throttling can't silently truncate the collection
        const COUNT = 500;
        const fetchPage = async (token: string): Promise<any | null> => {
            for (let attempt = 0; attempt < 6; attempt++) {
                try {
                    const r = await session.fetch('https://bandcamp.com/api/fancollection/1/collection_items', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ fan_id: Number(fanId), older_than_token: token, count: COUNT }),
                        credentials: 'include',
                    } as any);
                    if (r.ok) return await r.json();
                    this.notify429(r.status);
                    // 429 / 5xx: back off & retry rather than abandoning the whole collection
                    if (r.status !== 429 && r.status < 500) return null;
                } catch {
                    // network blip: retry
                }
                await new Promise((res) => setTimeout(res, 400 * Math.pow(2, attempt)));
            }
            return null;
        };

        const out: CollectionItem[] = [];
        const seen = new Set<string>();
        let token = `${Math.floor(Date.now() / 1000)}::a::`;
        const seenTokens = new Set<string>();
        for (let page = 0; page < 200 && out.length < maxItems; page++) {
            const data = await fetchPage(token);
            if (!data) break;
            const items: any[] = Array.isArray(data?.items) ? data.items : [];
            if (!items.length) break;
            // maps sale key -> download page url for owned items
            const redl: Record<string, string> = (data?.redownload_urls && typeof data.redownload_urls === 'object') ? data.redownload_urls : {};
            const added: CollectionItem[] = [];
            let hitKnown = false;
            for (const it of items) {
                const c = this.normalizeCollectionItem(it, redl);
                const key = c.tralbumType + c.tralbumId;
                if (!c.tralbumId || seen.has(key)) continue;
                if (stopAtKeys && stopAtKeys.has(key)) { hitKnown = true; break; }
                seen.add(key);
                out.push(c);
                added.push(c);
            }
            if (hitKnown) {
                if (onProgress && added.length) onProgress(added, out.length, out.length);
                return out;
            }
            // hand each page to the caller as it arrives so the view can render
            // progressively instead of blocking on the whole (multi-request) fetch
            if (onProgress) onProgress(added, out.length, Math.max(total, out.length));
            const next = data?.last_token || '';
            // stop on no more, empty token, or a token that didn't advance (guards against a stuck cursor looping forever)
            if (!data?.more_available || !next || seenTokens.has(next)) break;
            seenTokens.add(next);
            token = next;
        }
        return out;
    }

    /** fetch a small binary (album cover) for the on-disk release cache. */
    async fetchBinary(url: string): Promise<Buffer | null> {
        const session = this.getSession();
        if (!session || !url || !url.startsWith('https://')) return null;
        try {
            const r = await session.fetch(url, { credentials: 'include' } as any);
            if (!r.ok) return null;
            return Buffer.from(await r.arrayBuffer());
        } catch {
            return null;
        }
    }

    // --- fan feed (custom feed view) -----------------------------------------

    private cachedFanId = '';

    /** resolve (and cache) the logged-in fan's id from the collection summary. */
    private async getFanId(): Promise<string> {
        if (this.cachedFanId) return this.cachedFanId;
        const session = this.getSession();
        if (!session) return '';
        try {
            const r = await session.fetch('https://bandcamp.com/api/fan/2/collection_summary', {
                credentials: 'include',
            } as any);
            if (r.ok) {
                const d: any = await r.json();
                this.cachedFanId = toId(d?.fan_id ?? d?.collection_summary?.fan_id);
            }
        } catch { /* stay '' */ }
        return this.cachedFanId;
    }

    /** normalize one feed story entry (fields vary between story types & api versions). */
    private normalizeStory(s: any): FeedStory | null {
        if (!s || typeof s !== 'object') return null;
        const tralbumId = toId(s.item_id ?? s.tralbum_id ?? s.album_id);
        if (!tralbumId) return null;
        const typeRaw = String(s.item_type ?? s.tralbum_type ?? 'a');
        const artId = toId(s.item_art_id ?? s.art_id);
        const date = Number(s.story_date_ts ?? 0) ||
            Math.floor(Date.parse(String(s.story_date || s.new_release_date || '')) / 1000) || 0;
        return {
            type: String(s.story_type || '').trim() || 'nr',
            date: date > 0 ? date : 0,
            title: String(s.item_title ?? s.album_title ?? s.title ?? '').trim(),
            artist: String(s.band_name ?? s.artist ?? '').trim(),
            art: artId ? `https://f4.bcbits.com/img/a${artId}_9.jpg` : '',
            url: String(s.item_url ?? s.tralbum_url ?? '').trim(),
            tralbumId,
            tralbumType: (typeRaw === 't' || typeRaw === 'track') ? 't' : 'a',
            bandId: toId(s.band_id ?? s.selling_band_id),
            trackId: toId(s.featured_track ?? s.featured_track_id ?? s.track_id),
            via: String(s.fan_name ?? '').trim(),
        };
    }

    /**
     * one page of the fan feed (stories from artists & fans you follow) via the
     * same endpoint bandcamp's own "older stories" button posts to. olderThan is
     * the unix ts to page back from (0/omitted = newest).
     */
    async fetchFeed(olderThan = 0): Promise<{ ok: boolean; stories: FeedStory[]; oldest: number; error?: string }> {
        const session = this.getSession();
        if (!session) return { ok: false, stories: [], oldest: 0, error: 'no session' };
        const fanId = await this.getFanId();
        if (!fanId) return { ok: false, stories: [], oldest: 0, error: 'not logged in' };
        this.noteInteractive(); // feed paging is user-driven: crawler yields to it
        let data: any = null;
        try {
            const body = new URLSearchParams({
                fan_id: fanId,
                older_than: String(olderThan > 0 ? olderThan : Math.floor(Date.now() / 1000) + 3600),
            }).toString();
            for (let attempt = 0; ; attempt++) {
                const r = await session.fetch('https://bandcamp.com/fan_dash_feed_updates', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body,
                    credentials: 'include',
                } as any);
                if (r.ok) { data = await r.json(); break; }
                this.notify429(r.status);
                // throttled: retry a few times with backoff before giving up
                if (r.status !== 429 || attempt >= 3) return { ok: false, stories: [], oldest: 0, error: 'http ' + r.status };
                await new Promise((res) => setTimeout(res, 1000 * Math.pow(2, attempt)));
            }
        } catch (e: any) {
            return { ok: false, stories: [], oldest: 0, error: e?.message || 'feed fetch failed' };
        }
        // entries live under .stories on the web endpoint; be lenient about shape
        const root = (data && typeof data === 'object' && (data.stories || data)) || {};
        const rawEntries: any[] = Array.isArray(root.entries) ? root.entries
            : Array.isArray(root.stories) ? root.stories
            : Array.isArray(data?.entries) ? data.entries : [];
        const stories: FeedStory[] = [];
        let oldest = 0;
        for (const s of rawEntries) {
            const n = this.normalizeStory(s);
            if (!n) continue;
            if (n.date && (!oldest || n.date < oldest)) oldest = n.date;
            stories.push(n);
        }
        const rootOldest = Number(root.oldest_story_date) || 0;
        if (rootOldest && (!oldest || rootOldest < oldest)) oldest = rootOldest;
        return { ok: true, stories, oldest };
    }

    // --- downloads (purchased items) ----------------------------------------

    // fetch a download page & pull its per-format popplers urls. downloadPageUrl
    // is the redownload_url from the collection (bandcamp.com/download?...).
    async fetchDownloadFormats(downloadPageUrl: string): Promise<DownloadFormat[]> {
        const session = this.getSession();
        if (!session || !downloadPageUrl) return [];
        let html = '';
        try {
            const r = await session.fetch(downloadPageUrl, { credentials: 'include' } as any);
            if (!r.ok) return [];
            html = await r.text();
        } catch {
            return [];
        }
        // the page carries a #pagedata data-blob with digital_items[].downloads
        const m = html.match(/id="pagedata"[^>]*data-blob="([^"]*)"/);
        if (!m) return [];
        let blob: any;
        try {
            blob = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'));
        } catch {
            return [];
        }
        const item = Array.isArray(blob?.digital_items) ? blob.digital_items[0] : null;
        const downloads = item?.downloads || {};
        const out: DownloadFormat[] = [];
        for (const enc of Object.keys(downloads)) {
            const dl = downloads[enc];
            if (dl && dl.url) out.push({ encoding: enc, label: (dl.description || enc).toString(), url: dl.url.toString() });
        }
        return out;
    }

    // some formats aren't encoded yet; the download url has a sibling statdownload
    // endpoint that reports ready + the final file url. poll it, then fall back to
    // the raw url (bandcamp also streams the zip directly once prepared).
    async prepareDownload(formatUrl: string): Promise<string> {
        const session = this.getSession();
        if (!session || !formatUrl) return formatUrl;
        const statUrl = formatUrl.replace('/download/', '/statdownload/') + '&.vrs=1&.rand=' + Math.floor(Math.random() * 1e9);
        for (let i = 0; i < 45; i++) {
            try {
                const r = await session.fetch(statUrl, { credentials: 'include' } as any);
                const text = await r.text();
                const jm = text.match(/\{[\s\S]*\}/); // strip any jsonp wrapper
                if (jm) {
                    const j = JSON.parse(jm[0]);
                    if (j.result === 'ok' && (j.download_url || j.url)) return (j.download_url || j.url).toString();
                    if (j.result === 'err') return formatUrl;
                }
            } catch {
                // keep polling
            }
            await new Promise((res) => setTimeout(res, 2000));
        }
        return formatUrl;
    }
}
