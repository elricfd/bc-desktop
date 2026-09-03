// js injected when a stream is trapped: runs in page context
export function buildExtractorScript(trappedUrl: string, format: 'raw' | 'hls'): string {
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

        try { document.querySelectorAll('audio').forEach(function (a) { try { a.pause(); } catch (e) {} }); } catch (e) {}

        function toId(v) { if (v == null) return ''; var m = String(v).match(/\\d+/); return m ? m[0] : ''; }
        // strip a leading track number from a title
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

        // cached same-origin tralbum fetch
        async function apiFetch(url) {
            try {
                var r = await fetch(url, { credentials: 'include' }); if (!r.ok) return null;
                var j = await r.json();
                return (j && typeof j === 'object' && !j.error) ? j : null;
            }
            catch (e) { return null; }
        }
        async function fetchTralbum(type, id, bandId) {
            id = toId(id); if (!id) return null;
            var ck = type + ':' + id;
            var c = CACHE.tralbum[ck];
            if (c && Date.now() - c.at < TTL) return c.data;
            var base = (bandId ? 'band_id=' + bandId + '&' : '') + 'tralbum_type=' + type + '&tralbum_id=' + id;
            var urls = [
                'https://bandcamp.com/api/tralbum/2/info?' + base,
                'https://bandcamp.com/api/mobile/24/tralbum_details?' + base
            ];
            for (var i = 0; i < urls.length; i++) {
                var d = await apiFetch(urls[i]);
                if (d && (d.trackinfo || d.tracks)) { CACHE.tralbum[ck] = { data: d, at: Date.now() }; return d; }
                if (d && !CACHE.tralbum[ck]) CACHE.tralbum[ck] = { data: d, at: Date.now() };
            }
            return CACHE.tralbum[ck] ? CACHE.tralbum[ck].data : null;
        }

        // resolve full album queue for track id given opt hints
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

        // resolve just the trapped track (no album expansion) for homepage carousel players
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

        // discover/genre pages: resolve from the captured discover api
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

        // the homepage tags each player widget with tracklistkey
        function activePlayerKey() {
            var e = document.querySelector('[tracklistkey][aria-label="Pause"], [aria-label="Pause"][tracklistkey]');
            return e ? (e.getAttribute('tracklistkey') || '') : '';
        }

        // 1. release / track page
        function fromTralbumData() {
            var td = window.TralbumData;
            if (!td || !td.trackinfo) {
                var el = document.querySelector('[data-tralbum]');
                if (el) { try { td = JSON.parse(el.getAttribute('data-tralbum')); } catch (e) { td = null; } }
            }
            if (!td || !td.trackinfo || !td.trackinfo.length) return null;
            var q = normaliseApi(td);
            if (!q.length) return null;
            var tid = trappedTrackId();
            if (tid && !q.some(function (t) { return t.id === tid; })) return null;
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

                    if (isWish || arr.length <= 1) {
                        var full = await resolveByTrack(tid, bandId, type === 'a' ? tralbumId : '');
                        if (full.length) {
                            var fi = full.findIndex(function (t) { return t.id === tid; });
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
                    var active = type === 'a' ? 0 : (function () { var i = queue.findIndex(function (t) { return t.id === tid; }); return i === -1 ? 0 : i; })();
                    if (queue[active] && !queue[active].src) queue[active].src = targetUrl;
                    return { queue: queue, activeIndex: active, context: isWish ? 'wishlist' : 'collection', format: format };
                }
            }
            return null;
        }

        // 2b. playlist page
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
            if (tid) {
                var idx = queue.findIndex(function (t) { return t.id === tid; });
                if (idx === -1) return null;
                active = idx;
            }
            if (queue[active] && !queue[active].src) queue[active].src = targetUrl;
            return { queue: queue, activeIndex: active, context: 'playlist', format: format };
        }

        // 3. feed track_list
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

        // homepage playlists render their entire tracklist inline as .track-meta rows (stream urls + metadata)
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

        // dom album hint from story/grid <li> release identity
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

        // collection mini-player hint: it exposes the loaded album via data-collect-item
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

        // single TRACK item in the grid: resolve through the tralbum api (parent album carries the right artist + art)
        async function fromCollectionItem(tid) {
            if (!tid) return null;
            var li = document.querySelector('.collection-item-container[data-trackid="' + tid + '"]');
            if (!li || li.getAttribute('data-itemtype') !== 'track') return null;
            var bandId = toId(li.getAttribute('data-bandid'));

            var q = await resolveByTrack(tid, bandId, '');
            if (q.length) {
                var idx = q.findIndex(function (t) { return t.id === tid; });
                if (q[idx === -1 ? 0 : idx] && !q[idx === -1 ? 0 : idx].src) q[idx === -1 ? 0 : idx].src = targetUrl;
                return { queue: q, activeIndex: idx === -1 ? 0 : idx, context: 'collection', format: format };
            }

            var img = li.querySelector('img.collection-item-art, img');
            var art = img ? (img.getAttribute('src') || '').replace(/_\\d+\\.jpg([?#].*)?$/, '_10.jpg') : '';
            var artistEl = li.querySelector('.collection-item-artist');
            var artist = artistEl ? (artistEl.textContent || '').replace(/^\\s*by\\s+/i, '').trim() : '';
            var linkEl = li.querySelector('a.item-link[href]');
            return {
                queue: [{
                    id: tid,
                    title: stripNo(li.getAttribute('data-title') || 'Unknown Track'),
                    artist: artist || 'Bandcamp',
                    album: '',
                    art: art,
                    src: targetUrl,
                    duration: 0,
                    url: linkEl ? linkEl.getAttribute('href') : '',
                    bandId: bandId,
                    tralbumId: tid,
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

        var tid = trappedTrackId();

        var release = fromTralbumData();
        if (release) return release;

        var playlist = fromPlaylistPage(tid);
        if (playlist) return playlist;

        var coll = await fromCollectionData(tid);
        if (coll) return coll;

        var feed = fromFeed(tid);
        if (feed) return feed;

        var trackMeta = fromTrackMeta(tid);
        if (trackMeta) return trackMeta;

        if (tid && activePlayerKey()) {
            var single = await resolveSingle(tid);
            if (single.length) return { queue: single, activeIndex: 0, context: 'single', format: format };
        }

        var discover = await fromDiscoverCapture(tid);
        if (discover) return discover;

        var ciTrack = await fromCollectionItem(tid);
        if (ciTrack) return ciTrack;

        var hint = domHint(tid);
        var cHint = (hint && hint.albumId) ? null : collectionPlayerHint();
        if (tid) {
            var bandHint = (hint && hint.bandId) || (cHint && cHint.bandId);
            var albHint = ((hint && hint.type === 'a') ? hint.albumId : '') || ((cHint && cHint.type === 'a') ? cHint.albumId : '');
            var q = await resolveByTrack(tid, bandHint, albHint);
            if (q.length) {
                var idx = q.findIndex(function (t) { return t.id === tid; });
                var itemType = (hint && hint.type) || (cHint && cHint.type) || 'a';
                var isColl = !!cHint;
                var active = itemType === 't' ? (idx === -1 ? 0 : idx) : (isColl ? 0 : (idx === -1 ? 0 : idx));
                return { queue: q, activeIndex: active, context: isColl ? 'collection' : 'release', format: format };
            }
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

        if (tid) {
            var single = await resolveSingle(tid);
            if (single.length) return { queue: single, activeIndex: 0, context: 'single', format: format };
        }

        return fromDom(tid);
    })();
    `;
}
