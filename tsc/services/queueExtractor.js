"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildExtractorScript = buildExtractorScript;
// produces js injected into content view when audio stream is
// trapped. it runs in page own context (bandcamp.com origin) so it can read
// page embedded data & when needed fetch full tracklist from
// bandcamp api w/ fan cookies exactly how bandcamp player ext
// resolves metadata. resolving in page (rather than from main proc) is what
// makes discover/feed/homepage players work: api is same origin here.
//
// res order:
//   1. window.TralbumData            release/track pages (no fetch)
//   2. #PlaylistPage data-blob       fan playlist page (full tracks + streams)
//   3. #pagedata tracklists          collection / wishlist (full album no fetch)
//   4. #pagedata track_list          feed (whole feed is queue)
//   5. active carousel player        homepage playlist / radio single track
//   6. CACHE.discover (capture)      discover / genre pages no extra fetch
//   7. tralbum API by track id       below fold items dom album hint
//   8. #collection-player / DOM      last resort single track
//
// it resolves to streampayload ({ queue, activeIndex, context, format }).
function buildExtractorScript(trappedUrl, format) {
    const safeUrl = JSON.stringify(trappedUrl);
    const safeFormat = JSON.stringify(format);
    return `
    (async function () {
        var targetUrl = ${safeUrl};
        var format = ${safeFormat};
        var MAX_QUEUE = 500;
        var TTL = 15 * 60 * 1000;
        window.__bcrpc = window.__bcrpc || { tralbum: {}, trackAlbum: {}, discover: {} };
        if (!window.__bcrpc.discover) window.__bcrpc.discover = {};
        var CACHE = window.__bcrpc;

        // stop page own (muted) player instant we take over so it can't
        // keep auto advancing thru release & re trapping every track.
        try { document.querySelectorAll('audio').forEach(function (a) { try { a.pause(); } catch (e) {} }); } catch (e) {}

        function toId(v) { if (v == null) return ''; var m = String(v).match(/\\d+/); return m ? m[0] : ''; }
        // strip a leading track number from a title ("01 ", "1. ", "12 - ", "03) ")
        function stripNo(t) {
            var s = String(t == null ? '' : t);
            var r = s.replace(/^\\s*\\d{1,3}\\s*[-.\\)]\\s+/, '').replace(/^\\s*0\\d{1,2}\\s+/, '').trim();
            return r || s.trim();
        }
        function pickStream(file) {
            if (!file) return '';
            if (typeof file === 'string') return file;
            if (typeof file !== 'object') return '';
            if (file['mp3-128']) return file['mp3-128'];
            if (file['mp3-v0']) return file['mp3-v0'];
            if (file['mp3-320']) return file['mp3-320'];
            for (var k in file) { if (typeof file[k] === 'string' && file[k]) return file[k]; }
            return '';
        }
        function artFromId(id) { id = toId(id); return id ? 'https://f4.bcbits.com/img/a' + id + '_10.jpg' : ''; }
        function trappedTrackId() {
            try {
                var u = new URL(targetUrl, location.href);
                var q = toId(u.searchParams.get('track_id') || u.searchParams.get('id'));
                if (q) return q;
                var segs = u.pathname.split('/').filter(Boolean);
                for (var i = segs.length - 1; i >= 0; i--) { if (/^\\d{4,}$/.test(segs[i])) return segs[i]; }
                return '';
            } catch (e) { return ''; }
        }

        // normalise tralbum api payload (mobile or web shape)
        function normaliseApi(data) {
            if (!data || typeof data !== 'object') return [];
            var cur = data.current || {};
            var albumArtist = data.tralbum_artist || data.artist || cur.artist || data.band_name || '';
            var albumTitle = data.album_title || cur.title || data.title || '';
            var art = artFromId(data.art_id || cur.art_id || data.item_art_id);
            var url = (data.url || cur.bandcamp_url || '').toString();
            var bandId = toId(data.band_id || data.selling_band_id || (cur && cur.band_id));
            var tralbumId = toId(data.id || data.tralbum_id);
            var type = (data.item_type === 't' || data.tralbum_type === 't') ? 't' : 'a';
            var rows = (data.trackinfo && data.trackinfo.length) ? data.trackinfo : (data.tracks || []);
            var out = [];
            for (var i = 0; i < rows.length && out.length < MAX_QUEUE; i++) {
                var t = rows[i];
                var src = pickStream(t.file || t.streaming_url || t.mp3_url);
                if (!src) continue;
                out.push({
                    id: toId(t.track_id || t.id),
                    title: stripNo(t.title || albumTitle || 'Unknown Track'),
                    artist: (t.band_name || t.artist || albumArtist || 'Bandcamp').toString().trim(),
                    album: albumTitle.toString().trim(),
                    art: art,
                    src: src,
                    duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                    url: url,
                    bandId: bandId,
                    tralbumId: tralbumId,
                    tralbumType: type
                });
            }
            return out;
        }

        // same origin tralbum fetch (cookied) cached
        async function apiFetch(url) {
            try { var r = await fetch(url, { credentials: 'include' }); if (!r.ok) return null; return await r.json(); }
            catch (e) { return null; }
        }
        async function fetchTralbum(type, id, bandId) {
            id = toId(id); if (!id) return null;
            var ck = type + ':' + id;
            var c = CACHE.tralbum[ck];
            if (c && Date.now() - c.at < TTL) return c.data;
            var base = (bandId ? 'band_id=' + bandId + '&' : '') + 'tralbum_type=' + type + '&tralbum_id=' + id;
            // web endpoint is one site itself calls so it is most
            // reliable from this (desktop browser) context; mobile endpoint is
            // fallback that also carries album_id for track lookups.
            var urls = [
                'https://bandcamp.com/api/tralbum/2/info?' + base,
                'https://bandcamp.com/api/mobile/24/tralbum_details?' + base
            ];
            for (var i = 0; i < urls.length; i++) {
                var d = await apiFetch(urls[i]);
                if (d && (d.trackinfo || d.tracks)) { CACHE.tralbum[ck] = { data: d, at: Date.now() }; return d; }
                if (d && !CACHE.tralbum[ck]) CACHE.tralbum[ck] = { data: d, at: Date.now() }; // keep album id bearing track payloads
            }
            return CACHE.tralbum[ck] ? CACHE.tralbum[ck].data : null;
        }

        // resolve full album queue for track id given opt hints.
        async function resolveByTrack(tid, bandHint, albumHint) {
            var albumId = toId(albumHint), bandId = toId(bandHint), trackOnly = [];
            if (!albumId) {
                var cm = CACHE.trackAlbum[tid];
                if (cm && Date.now() - cm.at < TTL) { albumId = cm.albumId; bandId = cm.bandId || bandId; }
            }
            if (!albumId && tid) {
                var tr = await fetchTralbum('t', tid, bandId);
                if (tr) {
                    albumId = toId(tr.album_id || (tr.current && tr.current.album_id) || (tr.album && tr.album.id));
                    if (!bandId) bandId = toId(tr.band_id || tr.selling_band_id);
                    if (albumId) CACHE.trackAlbum[tid] = { albumId: albumId, bandId: bandId, at: Date.now() };
                    trackOnly = normaliseApi(tr);
                }
            }
            if (albumId) {
                var al = await fetchTralbum('a', albumId, bandId);
                var q = normaliseApi(al);
                if (q.length) return q;
            }
            return trackOnly;
        }

        // resolve just trapped track (no album expansion). used for
        // homepage carousel players (playlist / radio / aggregated) where
        // surrounding queue is curation not track album. track
        // endpoint sometimes returns thin row (title only) so when art or
        // artist is missing we backfill from parent album that is
        // "only song name shows" fix for homepage playlist players.
        async function resolveSingle(tid) {
            var tr = await fetchTralbum('t', tid, '');
            var q = normaliseApi(tr);
            var pick = null;
            for (var i = 0; i < q.length; i++) { if (q[i].id === tid) { pick = q[i]; break; } }
            if (!pick) pick = q.length ? q[0] : null;
            if (!pick) return [];
            if ((!pick.art || !pick.artist || pick.artist === 'Bandcamp') && tr) {
                var albumId = toId(tr.album_id || (tr.current && tr.current.album_id) || (tr.album && tr.album.id));
                if (albumId) {
                    var aq = normaliseApi(await fetchTralbum('a', albumId, pick.bandId));
                    var ref = null;
                    for (var j = 0; j < aq.length; j++) { if (aq[j].id === tid) { ref = aq[j]; break; } }
                    if (!ref) ref = aq[0];
                    if (ref) {
                        if (!pick.art) pick.art = ref.art;
                        if (!pick.artist || pick.artist === 'Bandcamp') pick.artist = ref.artist;
                        if (!pick.album) pick.album = ref.album;
                        if (!pick.url) pick.url = ref.url;
                        if (!pick.tralbumId) { pick.tralbumId = ref.tralbumId; pick.tralbumType = ref.tralbumType; }
                    }
                }
            }
            return [pick];
        }

        // discover / genre pages
        // discover app ("/discover/...") fetches grid from
        // /api/discover/1/discover_web; capture hook installed on page (see
        // main.ts) mirrors every result into cache.discover keyed by featured
        // track id. each entry carries release identity (band + tralbum id)
        // plus featured track own stream url & metadata. that lets us
        // resolve full album w/ single cached req & if that is
        // unavailable still play featured track w/ correct metadata & no
        // extra req replacing track -> album discovery fetch that was
        // main source of http 429 storm on genre pages.
        async function fromDiscoverCapture(tid) {
            if (!tid) return null;
            var d = CACHE.discover && CACHE.discover[tid];
            if (!d) return null;
            if (d.tralbumId) {
                var q = normaliseApi(await fetchTralbum('a', d.tralbumId, d.bandId));
                if (q.length) {
                    var idx = q.findIndex(function (t) { return t.id === tid; });
                    return { queue: q, activeIndex: idx === -1 ? 0 : idx, context: 'release', format: format };
                }
            }
            return {
                queue: [{
                    id: tid,
                    title: (d.title || 'Unknown Track').toString().trim(),
                    artist: (d.artist || 'Bandcamp').toString().trim(),
                    album: (d.album || '').toString().trim(),
                    art: d.art || '',
                    src: pickStream(d.streamUrl) || targetUrl,
                    duration: 0,
                    url: (d.url || location.href).toString(),
                    bandId: d.bandId || '',
                    tralbumId: d.tralbumId || '',
                    tralbumType: d.type === 't' ? 't' : 'a'
                }],
                activeIndex: 0, context: 'single', format: format
            };
        }

        // vue homepage tags each player widget w/ tracklistkey
        // ("playlist:123", "radio:9", "aggregated:album:..."); actively
        // playing one shows pause control. identify *player* not page.
        function activePlayerKey() {
            var e = document.querySelector('[tracklistkey][aria-label="Pause"], [aria-label="Pause"][tracklistkey]');
            return e ? (e.getAttribute('tracklistkey') || '') : '';
        }

        // 1. release / track page
        function fromTralbumData() {
            var td = window.TralbumData;
            if (!td || !td.trackinfo) {
                // newer ("trackpipe") release pages no longer expose
                // window.tralbumdata; same payload lives in data tralbum
                // attr instead.
                var el = document.querySelector('[data-tralbum]');
                if (el) { try { td = JSON.parse(el.getAttribute('data-tralbum')); } catch (e) { td = null; } }
            }
            if (!td || !td.trackinfo || !td.trackinfo.length) return null;
            var q = normaliseApi(td);
            if (!q.length) return null;
            var tid = trappedTrackId();
            if (tid && !q.some(function (t) { return t.id === tid; })) return null; // stale tralbumdata
            var active = 0;
            if (tid) { var i = q.findIndex(function (t) { return t.id === tid; }); if (i !== -1) active = i; }
            return { queue: q, activeIndex: active, context: 'release', format: format };
        }

        function readBlob(id) {
            var el = document.getElementById(id);
            if (!el || !el.dataset || !el.dataset.blob) return null;
            try { return JSON.parse(el.dataset.blob); } catch (e) { return null; }
        }

        // 2. collection / wishlist tracklists
        // owned sections (collection / hidden / gifts) embed the WHOLE album inline
        // so we play it with zero api calls. wishlist items aren't owned, so bandcamp
        // only embeds the item's featured (preview) track inline that's why wishlist
        // albums used to play just one song. for those we resolve the real release
        // from the tralbum api (same path below-fold items already take) so the whole
        // album queues & track items get real metadata.
        async function fromCollectionData(tid) {
            if (!tid) return null;
            var blob = readBlob('pagedata');
            if (!blob || !blob.tracklists) return null;
            var sections = ['collection', 'wishlist', 'gifts_given', 'hidden'];
            for (var s = 0; s < sections.length; s++) {
                var sec = blob.tracklists[sections[s]];
                if (!sec) continue;
                for (var key in sec) {
                    var arr = sec[key];
                    if (!arr || !arr.length) continue;
                    if (!arr.some(function (t) { return toId(t.id || t.track_id) === tid; })) continue;
                    var item = (blob.item_cache && blob.item_cache[sections[s]] && blob.item_cache[sections[s]][key]) || {};
                    var bandId = toId(item.band_id);
                    var tralbumId = toId(item.tralbum_id || item.album_id) || toId(key);
                    var type = (item.tralbum_type === 't' || item.item_type === 'track' || key.charAt(0) === 't') ? 't' : 'a';
                    var isWish = sections[s] === 'wishlist';

                    // not owned (or only a featured track embedded): pull the full release
                    if (isWish || arr.length <= 1) {
                        var full = await resolveByTrack(tid, bandId, type === 'a' ? tralbumId : '');
                        if (full.length) {
                            var fi = full.findIndex(function (t) { return t.id === tid; });
                            // albums play from the start; a wishlisted single track plays itself
                            var act = type === 'a' ? 0 : (fi === -1 ? 0 : fi);
                            return { queue: full, activeIndex: act, context: isWish ? 'wishlist' : 'collection', format: format };
                        }
                    }

                    var albumTitle = (item.item_title || '').toString();
                    var art = artFromId(item.item_art_id);
                    var url = (item.item_url || '').toString();
                    var bandName = (item.band_name || '').toString();
                    var queue = arr.map(function (t) {
                        return {
                            id: toId(t.id || t.track_id),
                            title: stripNo(t.title || 'Unknown Track'),
                            artist: (t.artist || bandName || 'Bandcamp').toString().trim(),
                            album: albumTitle,
                            art: art,
                            src: pickStream(t.file || t.streaming_url),
                            duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                            url: url,
                            bandId: bandId,
                            tralbumId: tralbumId,
                            tralbumType: type
                        };
                    });
                    // owned album: play from track 1 (the trapped track is the item's
                    // featured track, often not track 1); a track item plays itself
                    var active = type === 'a' ? 0 : (function () { var i = queue.findIndex(function (t) { return t.id === tid; }); return i === -1 ? 0 : i; })();
                    if (queue[active] && !queue[active].src) queue[active].src = targetUrl;
                    return { queue: queue, activeIndex: active, context: isWish ? 'wishlist' : 'collection', format: format };
                }
            }
            return null;
        }

        // 2b. playlist page (full tracks embedded inline)
        // fan playlist page (#playlistpage data blob) ships whole
        // tracklist in appdata.tracks each row carrying its own direct
        // streamurl plus title / artist / album / art / duration. that means
        // entire playlist is playable w/ zero api calls & crucially
        // real stream urls are right here so audio plays immediately instead of
        // failing way single track api fallback did.
        function fromPlaylistPage(tid) {
            var blob = readBlob('PlaylistPage');
            var data = blob && (blob.appData || blob);
            var rows = data && data.tracks;
            if (!rows || !rows.length) return null;
            var queue = [];
            for (var i = 0; i < rows.length && queue.length < MAX_QUEUE; i++) {
                var t = rows[i];
                var album = t.album || {};
                var id = toId(t.id || t.track_id);
                if (!id) continue;
                queue.push({
                    id: id,
                    title: stripNo(t.title || 'Unknown Track'),
                    artist: (t.artistName || t.band_name || t.artist || 'Bandcamp').toString().trim(),
                    album: (album.title || t.album_title || '').toString().trim(),
                    art: artFromId(t.artId || t.art_id),
                    src: pickStream(t.streamUrl || t.file || t.streaming_url),
                    duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                    url: (t.url || '').toString(),
                    albumUrl: (album.url || '').toString(),
                    bandId: toId(t.bandId || t.band_id),
                    tralbumId: toId(album.id || t.album_id),
                    tralbumType: 't'
                });
            }
            if (!queue.length) return null;
            var active = 0;
            if (tid) { var idx = queue.findIndex(function (t) { return t.id === tid; }); if (idx !== -1) active = idx; }
            if (queue[active] && !queue[active].src) queue[active].src = targetUrl;
            return { queue: queue, activeIndex: active, context: 'playlist', format: format };
        }

        // 3. feed: track_list is play queue
        // fan feed embeds every featured track (w/ stream url artist
        // album art) in #pagedata.track_list & plays thru them in order so
        // we queue whole feed & start at trapped track. zero reqs.
        function fromFeed(tid) {
            var blob = readBlob('pagedata');
            var list = blob && blob.track_list;
            if (!list || !list.length) return null;
            var seen = {};
            var queue = [];
            for (var i = 0; i < list.length; i++) {
                var t = list[i];
                var id = toId(t.track_id || t.id);
                var src = pickStream(t.streaming_url || t.file);
                if (!id || !src || seen[id]) continue;
                seen[id] = 1;
                queue.push({
                    id: id,
                    title: stripNo(t.title || 'Unknown Track'),
                    artist: (t.band_name || t.artist || 'Bandcamp').toString().trim(),
                    album: (t.album_title || '').toString().trim(),
                    art: artFromId(t.art_id),
                    src: src,
                    duration: Math.max(0, Math.floor(Number(t.duration) || 0)),
                    url: (t.track_url || '').toString(),
                    bandId: toId(t.band_id),
                    tralbumId: toId(t.album_id),
                    tralbumType: 'a'
                });
            }
            if (!queue.length) return null;
            var active = 0;
            if (tid) { var i2 = queue.findIndex(function (t) { return t.id === tid; }); if (i2 === -1) return null; active = i2; }
            return { queue: queue, activeIndex: active, context: 'feed', format: format };
        }

        // homepage / embedded player tracklists
        // homepage renders featured playlist *entire* tracklist inline as
        //   <div class="track-meta" id=<trackId> streamurl=… bandid=… duration=…>
        // rows (title / artist / album / art in child nodes) grouped inside
        // <ol class="track-list">. reading those gives full playlist queue w/
        // real metadata & direct stream urls no api no 429 which is what
        // homepage playlist players were missing (they only got thin single track).
        function metaToTrack(el) {
            function txt(sel) { var e = el.querySelector(sel); return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : ''; }
            var img = el.querySelector('.art img, img');
            var art = img ? (img.getAttribute('src') || '') : '';
            art = art.replace(/_\\d+\\.jpg([?#].*)?$/, '_10.jpg');
            return {
                id: toId(el.getAttribute('id')),
                title: stripNo(txt('.track-title .title-text') || txt('.track-title') || txt('.title-text') || 'Unknown Track'),
                artist: (txt('.artist-name').replace(/^by\\s+/i, '')) || 'Bandcamp',
                album: txt('.album-title').replace(/^from\\s+/i, ''),
                art: art,
                src: el.getAttribute('streamurl') || '',
                duration: Math.max(0, Math.floor(Number(el.getAttribute('duration')) || 0)),
                url: '',
                bandId: toId(el.getAttribute('bandid') || el.getAttribute('sellingbandid')),
                tralbumId: '',
                tralbumType: 't'
            };
        }
        function fromTrackMeta(tid) {
            if (!tid) return null;
            var target = document.querySelector('.track-meta[streamurl][id="' + tid + '"]');
            if (!target) return null;
            // whole tracklist (one <ol class="track-list">) is queue; fall
            // back to just this row when it isn't inside one (single card widgets).
            var scope = target.closest ? target.closest('.track-list') : null;
            var rows = scope ? scope.querySelectorAll('.track-meta[streamurl]') : [target];
            if (!rows.length) rows = [target];
            var seen = {}, queue = [];
            for (var i = 0; i < rows.length && queue.length < MAX_QUEUE; i++) {
                var t = metaToTrack(rows[i]);
                if (!t.id || !t.src || seen[t.id]) continue;
                seen[t.id] = 1;
                queue.push(t);
            }
            if (!queue.length) return null;
            var active = 0, idx = queue.findIndex(function (t) { return t.id === tid; });
            if (idx !== -1) active = idx;
            return { queue: queue, activeIndex: active, context: 'playlist', format: format };
        }

        // dom album hint (feed stories / collection grid items)
        // every story/grid <li> carries release identity (data tralbumid /
        // data bandid or richer data item json). trapped track on
        // initial click is item featured track so we can map it to its
        // album w/out discovery req covers below "view all" collection
        // items & feed stories loaded after embedded track_list.
        function domHint(tid) {
            if (!tid) return null;
            var el = document.querySelector('[data-trackid="' + tid + '"]');
            var li = el && (el.closest ? el.closest('.collection-item-container') : null);
            if (!li && el && el.classList && el.classList.contains('collection-item-container')) li = el;
            if (!li) return null;
            var albumId = '', bandId = '', type = 'a', url = '', artist = '', album = '', art = '', trackTitle = '';
            var ij = li.getAttribute('data-item-json');
            if (ij) {
                try {
                    var o = JSON.parse(ij);
                    albumId = toId(o.album_id || o.tralbum_id);
                    bandId = toId(o.band_id);
                    type = (o.tralbum_type === 't' || o.item_type === 't') ? 't' : 'a';
                    url = (o.item_url || o.band_url || '').toString();
                    artist = (o.band_name || '').toString();
                    album = (o.item_title || o.album_title || '').toString();
                    art = artFromId(o.item_art_id);
                    if (toId(o.featured_track) === tid) trackTitle = (o.featured_track_title || '').toString();
                } catch (e) {}
            }
            if (!albumId) {
                albumId = toId(li.getAttribute('data-tralbumid'));
                bandId = toId(li.getAttribute('data-bandid'));
                type = li.getAttribute('data-tralbumtype') === 't' ? 't' : 'a';
            }
            if (!albumId) return null;
            return { albumId: albumId, bandId: bandId, type: type, url: url, artist: artist, album: album, art: art, trackTitle: trackTitle };
        }

        // collection mini player album hint
        // on collection/wishlist page each row data trackid is item
        // featured track not one that starts playing (track 1) so domhint
        // misses for below fold items & we'd fall back to scraping
        // now playing display which shows featured track. mini player
        // though exposes album currently loaded via data collect item
        // ("a<albumId>"). resolve that album & seek to trapped track so
        // player shows/plays right song instead of featured one.
        function collectionPlayerHint() {
            var el = document.querySelector('#collection-player [data-collect-item]');
            if (!el) el = document.querySelector('.collection-item-container.active, .collection-item-container.track_play_hilite');
            if (!el) return null;
            var ci = el.getAttribute('data-collect-item') || '';
            var m = /^([at])(\\d+)$/.exec(ci);
            if (m) return { type: m[1], albumId: m[2], bandId: toId(el.getAttribute('data-collect-band')) };
            var alb = toId(el.getAttribute('data-tralbumid'));
            if (alb) return { type: el.getAttribute('data-tralbumtype') === 't' ? 't' : 'a', albumId: alb, bandId: toId(el.getAttribute('data-bandid')) };
            return null;
        }

        // collection / wishlist grid item built straight from its dom.
        // each <li.collection-item-container> carries full metadata in
        // data-playerdata (title / artist_name / art_id / duration / url + its
        // parent album). for a single TRACK item (e.g. a wishlisted track) this is
        // everything we need play it with the trapped stream & real metadata, no
        // api call, which is what the track/album api lookups were failing to do.
        function fromCollectionItem(tid) {
            if (!tid) return null;
            var li = document.querySelector('.collection-item-container[data-trackid="' + tid + '"]');
            if (!li || li.getAttribute('data-itemtype') !== 'track') return null;
            var pd = null;
            try { pd = JSON.parse(li.getAttribute('data-playerdata') || 'null'); } catch (e) { pd = null; }
            var alb = (pd && pd.album) || {};
            var title = stripNo((pd && pd.title) || li.getAttribute('data-title') || 'Unknown Track');
            var artist = ((pd && (pd.artist_name || pd.band_name)) || '').toString().trim() || 'Bandcamp';
            var art = artFromId((pd && pd.art_id) || alb.art_id);
            return {
                queue: [{
                    id: toId((pd && pd.id) || tid),
                    title: title,
                    artist: artist,
                    album: (alb.title || '').toString().trim(),
                    art: art,
                    src: targetUrl,
                    duration: Math.max(0, Math.floor(Number(pd && pd.duration) || 0)),
                    url: ((pd && pd.url) || '').toString(),
                    bandId: toId((pd && pd.band_id) || li.getAttribute('data-bandid')),
                    tralbumId: toId(alb.id || (pd && pd.id) || tid),
                    tralbumType: 't'
                }],
                activeIndex: 0, context: 'collection', format: format
            };
        }

        // 5. last resort single track
        function fromDom(tid) {
            var cp = document.querySelector('#collection-player');
            var title = '', artist = '', art = '', url = location.href, bandId = '', tralbumId = '', type = 'a';
            if (cp) {
                var collectEl = cp.querySelector('[data-collect-item]');
                if (collectEl) {
                    var m = /^([at])(\\d+)$/.exec(collectEl.getAttribute('data-collect-item') || '');
                    if (m) { type = m[1]; tralbumId = m[2]; }
                    bandId = toId(collectEl.getAttribute('data-collect-band'));
                }
                var tEl = cp.querySelector('.info-progress .title');
                var aEl = cp.querySelector('.now-playing .artist span');
                var artEl = cp.querySelector('.now-playing img');
                var uEl = cp.querySelector('.now-playing a[href]');
                if (tEl) title = tEl.textContent.trim();
                if (aEl) artist = aEl.textContent.trim();
                if (artEl) art = artEl.getAttribute('src') || '';
                if (uEl) url = uEl.getAttribute('href') || url;
            }
            if (!title) title = (document.querySelector('.trackTitle') || {}).textContent || document.title;
            return {
                queue: [{
                    id: tid || '0', title: (title || 'Unknown Track').toString().trim(),
                    artist: artist || 'Bandcamp', album: '', art: art, src: targetUrl,
                    duration: 0, url: url, bandId: bandId, tralbumId: tralbumId, tralbumType: type
                }],
                activeIndex: 0, context: 'single', format: format
            };
        }

        // orchestration
        var tid = trappedTrackId();

        var release = fromTralbumData();
        if (release) return release;

        // fan playlist page full tracklist + stream urls embedded inline.
        var playlist = fromPlaylistPage(tid);
        if (playlist) return playlist;

        var coll = await fromCollectionData(tid);
        if (coll) return coll;

        var feed = fromFeed(tid);
        if (feed) return feed;

        // homepage featured playlist: full tracklist is embedded in dom.
        var trackMeta = fromTrackMeta(tid);
        if (trackMeta) return trackMeta;

        // homepage carousel players (playlist / radio / curated): play exactly
        // trapped track w/ correct metadata expanding it to track album
        // would be wrong here since surrounding queue is curation. this is
        // checked before discover capture so curated carousel that happens to
        // share track id w/ loaded discover grid isn't expanded to its album.
        if (tid && activePlayerKey()) {
            var single = await resolveSingle(tid);
            if (single.length) return { queue: single, activeIndex: 0, context: 'single', format: format };
        }

        // discover / genre pages: resolve from captured discover_web grid.
        var discover = await fromDiscoverCapture(tid);
        if (discover) return discover;

        // single track item in the collection/wishlist grid: play it straight from
        // its dom metadata (data-playerdata) w/ the trapped stream.
        var ciTrack = fromCollectionItem(tid);
        if (ciTrack) return ciTrack;

        // discover / below fold collection / scrolled feed: resolve full
        // album thru api by trapped track id using dom album hint
        // where present to skip track -> album discovery req. on
        // collection page mini player names album directly which is more
        // reliable than per row featured track hint.
        var hint = domHint(tid);
        var cHint = (hint && hint.albumId) ? null : collectionPlayerHint();
        if (tid) {
            var bandHint = (hint && hint.bandId) || (cHint && cHint.bandId);
            // an album id hint only. domHint.albumId is the containing album (safe
            // even for track items), but the collection mini-player reports a single
            // track as "t<id>" whose id is NOT an album id feeding that to
            // resolveByTrack fetched the wrong thing & left tracks w/ no metadata.
            // for track items leave albHint empty so it does the track -> album lookup.
            var albHint = (hint && hint.albumId) || ((cHint && cHint.type === 'a') ? cHint.albumId : '');
            var q = await resolveByTrack(tid, bandHint, albHint);
            if (q.length) {
                var idx = q.findIndex(function (t) { return t.id === tid; });
                var itemType = (hint && hint.type) || (cHint && cHint.type) || 'a';
                var isColl = !!cHint;
                // an album item in your collection traps its FEATURED track (often not
                // track 1), but clicking it should play the album from the start. a
                // single track item plays that track. release pages honor the click.
                var active = itemType === 't' ? (idx === -1 ? 0 : idx) : (isColl ? 0 : (idx === -1 ? 0 : idx));
                return { queue: q, activeIndex: active, context: isColl ? 'collection' : 'release', format: format };
            }
            // album lookup failed but dom told us release: play trapped
            // track alone still w/ correct metadata.
            if (hint) {
                return {
                    queue: [{
                        id: tid,
                        title: (hint.trackTitle || hint.album || 'Unknown Track'),
                        artist: (hint.artist || 'Bandcamp'),
                        album: hint.album || '',
                        art: hint.art || '',
                        src: targetUrl,
                        duration: 0,
                        url: hint.url || location.href,
                        bandId: hint.bandId,
                        tralbumId: hint.albumId,
                        tralbumType: hint.type
                    }],
                    activeIndex: 0, context: 'single', format: format
                };
            }
        }

        // last resort before the metadata-less dom scrape: ask the track api
        // directly. this is what populates title/artist/art for a wishlisted single
        // track whose album expansion above came back empty.
        if (tid) {
            var single = await resolveSingle(tid);
            if (single.length) return { queue: single, activeIndex: 0, context: 'single', format: format };
        }

        return fromDom(tid);
    })();
    `;
}
