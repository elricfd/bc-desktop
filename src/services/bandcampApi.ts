import type { Session } from 'electron';
import type { PlayerTrack, TralbumType, CollectionItem, DownloadFormat } from '../shared/types';

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

    // cache full tracklists by `${type}:${tralbumId}` and track -> album map by track id. both expire after cache ttl ms.
    private readonly tralbumCache = new Map<string, { tracks: PlayerTrack[]; at: number }>();
    private readonly albumOfTrack = new Map<string, { albumId: string; bandId: string; at: number }>();

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
        return [mobile.toString(), info.toString()];
    }

    /** fetch raw tralbum payload for single (type, id) used to read parent album id of track before fetching full album. */
    private async fetchRaw(type: TralbumType, tralbumId: string, bandId?: string): Promise<any | null> {
        const session = this.getSession();
        if (!session || !tralbumId) return null;
        for (const url of this.attemptUrls(type, tralbumId, bandId)) {
            try {
                const res = await session.fetch(url, { credentials: 'include' } as any);
                if (!res.ok) continue;
                const data: any = await res.json();
                if (data && typeof data === 'object') return data;
            } catch {
                // try next endpoint
            }
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
            const data = await this.fetchRaw(type, q.tralbumId, q.bandId);
            const tracks = this.normalize(data, { ...q, tralbumType: type });
            if (tracks.length) {
                const at = Date.now();
                this.tralbumCache.set(primaryKey, { tracks, at });
                // also key by album id actually returned so track id lookup and later album id lookup share 1 cache entry.
                const realId = toId((data && (data.id ?? data.tralbum_id)) || q.tralbumId);
                if (realId) this.tralbumCache.set(`${type}:${realId}`, { tracks, at });
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

        // the mobile tralbum endpoint (tried first) names the artist tralbum_artist /
        // band.name, not artist/band_name — cover all of them or the collection view's
        // player shows a blank artist
        const artist = (
            data.tralbum_artist || data.artist || current.artist ||
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
        const rel = it.release_date || it.releaseDate || '';
        let year = Number(String(rel).match(/\d{4}/)?.[0]) || 0;
        if (!year && added) year = new Date(added).getFullYear();
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
    async fetchCollection(
        maxItems = 20000,
        onProgress?: (added: CollectionItem[], soFar: number, total: number) => void
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
            for (const it of items) {
                const c = this.normalizeCollectionItem(it, redl);
                const key = c.tralbumType + c.tralbumId;
                if (!c.tralbumId || seen.has(key)) continue;
                seen.add(key);
                out.push(c);
                added.push(c);
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
