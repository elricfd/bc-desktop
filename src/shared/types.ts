// shared data model passed between main proc, content view & player view

export type TralbumType = 'a' | 't';

export type RepeatMode = 'off' | 'all' | 'one';

/** single playable entry in player queue. */
export interface PlayerTrack {
    id: string;
    title: string;
    artist: string;
    album: string;
    art: string;
    src: string;
    duration: number;
    url: string;
    albumUrl?: string;

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
    addedAt: number;
    year: number;
    downloadUrl: string;
    wish?: boolean;
    local?: boolean;
}

/** one format offered on a download page. */
export interface DownloadFormat {
    encoding: string;
    label: string;
    url: string;
}

/** one story in the custom feed view (new releases / activity from artists & fans you follow). */
export interface FeedStory {
    /** bandcamp story type: 'nr' new release, 'df' fan collected, others pass through. */
    type: string;
    date: number;
    title: string;
    artist: string;
    art: string;
    url: string;
    tralbumId: string;
    tralbumType: TralbumType;
    bandId: string;
    trackId: string;
    via: string;
}
