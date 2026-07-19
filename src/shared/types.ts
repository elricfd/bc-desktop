// shared data model passed between main proc, content view & player view. kept dep free so req from any context.

export type TralbumType = 'a' | 't';

export type RepeatMode = 'off' | 'all' | 'one';

/** single playable entry in player queue. */
export interface PlayerTrack {
    /** bandcamp track id. */
    id: string;
    title: string;
    artist: string;
    album: string;
    /** artwork url (sized for display). */
    art: string;
    /** direct stream url. empty string means it must resolve lazily. */
    src: string;
    /** track len in secs, 0 when unknown. */
    duration: number;
    /** canonical bandcamp page url for release/track. */
    url: string;
    /** album page url when it differs from url (e.g. playlist track whose url points at standalone track page). title click prefers this. */
    albumUrl?: string;

    // resolver handle lets main proc fetch stream url on demand.
    bandId: string;
    tralbumId: string;
    tralbumType: TralbumType;
}

/** where queue came from drives default repeat/advance behavior. */
export type QueueContext = 'release' | 'collection' | 'wishlist' | 'feed' | 'playlist' | 'single';

/** payload sent from content view to player when stream is trapped. */
export interface StreamPayload {
    queue: PlayerTrack[];
    activeIndex: number;
    context: QueueContext;
    format: 'raw' | 'hls';
}

/** req to resolve missing stream url for queued track. */
export interface ResolveStreamRequest {
    token: string;
    bandId: string;
    tralbumId: string;
    tralbumType: TralbumType;
    trackId: string;
    url: string;
}

/** resp carrying resolved stream url (& refined metadata). */
export interface ResolveStreamResponse {
    token: string;
    ok: boolean;
    src: string;
    duration: number;
    title?: string;
    artist?: string;
    art?: string;
    error?: string;
}

/** now playing snapshot player emits so main proc can drive discord rich presence & last.fm scrobbling. */
export interface NowPlaying {
    id: string;
    title: string;
    artist: string;
    album: string;
    art: string;
    url: string;
    duration: number;
    position: number;
    isPlaying: boolean;
}

/** 1 release in fan collection for custom sortable collection view. */
export interface CollectionItem {
    itemId: string;
    tralbumId: string;
    tralbumType: TralbumType;
    title: string;
    artist: string;
    art: string;
    url: string;
    bandId: string;
    /** epoch ms item was added (purchase date); 0 when unknown. */
    addedAt: number;
    /** release year; 0 when collection payload doesn't carry it. */
    year: number;
    /** bandcamp download page url for owned items; '' when not downloadable. */
    downloadUrl: string;
    /** true for wishlist items (not owned; shown alongside the collection). */
    wish?: boolean;
    /** true for pseudo-releases built from local audio files (tralbumId 'local:…'). */
    local?: boolean;
}

/** one format offered on a download page. */
export interface DownloadFormat {
    /** bandcamp encoding name, e.g. flac, mp3-320, mp3-v0, alac, wav, aiff-lossless, vorbis, aac-hi. */
    encoding: string;
    /** human label, e.g. FLAC, MP3 320. */
    label: string;
    /** the popplers download url for this format. */
    url: string;
}

/** one story in the custom feed view (new releases / activity from artists & fans you follow). */
export interface FeedStory {
    /** bandcamp story type: 'nr' new release, 'df' fan collected, others pass through. */
    type: string;
    /** epoch seconds of the story. */
    date: number;
    title: string;
    artist: string;
    art: string;
    url: string;
    tralbumId: string;
    tralbumType: TralbumType;
    bandId: string;
    /** featured track id when the story carries one. */
    trackId: string;
    /** collector's name for 'df' stories ("collected by …"); '' otherwise. */
    via: string;
}
