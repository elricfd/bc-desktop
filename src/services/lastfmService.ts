import * as crypto from 'crypto';
import fetch from 'cross-fetch';
import type Store from 'electron-store';
import type { NowPlaying } from '../shared/types';

// minimal last.fm scrobbler (desktop auth flow)

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

interface LastfmConfig {
    apiKey: string;
    apiSecret: string;
    sessionKey: string;
    username: string;
    enabled: boolean;
    minScrobbleLen: number;
}

/** half duration or 4 min, whichever first; null when too short to ever scrobble. */
export function scrobbleThreshold(duration: number, minLen: number): number | null {
    if (duration <= minLen) return null;
    return Math.min(duration / 2, 240);
}

export class LastfmService {
    private pendingToken = '';
    private lastNowPlaying = '';
    private scrobbled = false;
    /** last observed playback position; detects loop restarts (repeat-one) */
    private lastPos = 0;
    /** failed scrobbles retry no sooner than this (avoids a per-tick retry flood). */
    private nextRetryAt = 0;

    constructor(private readonly store: Store) {}

    private cfg(): LastfmConfig {
        const raw = (this.store.get('lastfm') as Partial<LastfmConfig>) || {};
        const m = Number(raw.minScrobbleLen);
        return {
            apiKey: raw.apiKey || '',
            apiSecret: raw.apiSecret || '',
            sessionKey: raw.sessionKey || '',
            username: raw.username || '',
            enabled: raw.enabled !== false,
            minScrobbleLen:
                raw.minScrobbleLen === undefined ||
                raw.minScrobbleLen === null ||
                !Number.isFinite(m)
                    ? 30
                    : Math.max(0, Math.min(30, Math.round(m))),
        };
    }

    isReady(): boolean {
        const c = this.cfg();
        return Boolean(c.enabled && c.apiKey && c.apiSecret && c.sessionKey);
    }

    /** outcome of the most recent api submission (settings shows this). */
    private lastResult: { ok: boolean; detail: string; at: number } | null = null;
    private noteResult(kind: string, data: any, err?: any): void {
        if (err) {
            this.lastResult = { ok: false, detail: kind + ' failed: ' + (err?.message || 'network error'), at: Date.now() };
        } else if (data && data.error) {
            let detail = kind + ' rejected by last.fm (' + data.error + '): ' + (data.message || '');
            if (Number(data.error) === 26) {
                detail += ' - this key was suspended by last.fm; create a NEW api key at https://www.last.fm/api/account/create and save the new key + secret here.';
            }
            this.lastResult = { ok: false, detail, at: Date.now() };
        } else {
            this.lastResult = { ok: true, detail: kind + ' ok', at: Date.now() };
        }
    }

    status(): { ready: boolean; reason: string; last: { ok: boolean; detail: string; at: number } | null } {
        const c = this.cfg();
        const reason = !c.enabled ? 'scrobbling is disabled'
            : !c.apiKey ? 'no api key saved'
            : !c.apiSecret ? 'no shared secret saved'
            : !c.sessionKey ? 'account not connected (authorize below)'
            : '';
        return { ready: !reason, reason, last: this.lastResult };
    }

    // md5 is mandated by the last.fm api_sig spec
    private sign(params: Record<string, string>, secret: string): string {
        const sigBase = Object.keys(params)
            .sort()
            .map((k) => k + params[k])
            .join('');
        // eslint-disable-next-line -- md5 required by Last.fm api_sig spec
        return crypto.createHash('md5').update(sigBase + secret, 'utf8').digest('hex');
    }

    private async call(params: Record<string, string>, method: 'GET' | 'POST'): Promise<any> {
        const { apiSecret } = this.cfg();
        const signed = { ...params, api_sig: this.sign(params, apiSecret), format: 'json' };
        const body = new URLSearchParams(signed).toString();
        const url = method === 'GET' ? `${API_ROOT}?${body}` : API_ROOT;
        const res = await fetch(url, {
            method,
            headers:
                method === 'POST'
                    ? { 'Content-Type': 'application/x-www-form-urlencoded' }
                    : undefined,
            body: method === 'POST' ? body : undefined,
        });
        return res.json();
    }


    async beginAuth(): Promise<{ authUrl: string } | { error: string }> {
        const c = this.cfg();
        if (!c.apiKey || !c.apiSecret) return { error: 'Missing Last.fm API key/secret' };
        try {
            const data = await this.call({ method: 'auth.getToken', api_key: c.apiKey }, 'GET');
            if (!data.token) {
                if (Number(data.error) === 26) {
                    return { error: 'this api key was suspended by last.fm - create a new key at https://www.last.fm/api/account/create and save the new key + secret here, then connect again' };
                }
                return { error: data.message || 'Could not get token' };
            }
            this.pendingToken = data.token;
            return { authUrl: `https://www.last.fm/api/auth/?api_key=${c.apiKey}&token=${data.token}` };
        } catch (e: any) {
            return { error: e?.message || 'Auth request failed' };
        }
    }

    async pollForSession(
        attempts = 60,
        intervalMs = 2500
    ): Promise<{ username: string } | { error: string }> {
        const token = this.pendingToken;
        for (let i = 0; i < attempts; i++) {
            if (this.pendingToken !== token) return { error: 'cancelled' };
            const res = await this.completeAuth();
            if ('username' in res) return res;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return { error: 'timed out waiting for authorization' };
    }

    async completeAuth(): Promise<{ username: string } | { error: string }> {
        const c = this.cfg();
        if (!this.pendingToken) return { error: 'No pending authorization' };
        try {
            const data = await this.call(
                { method: 'auth.getSession', api_key: c.apiKey, token: this.pendingToken },
                'GET'
            );
            const session = data.session;
            if (!session?.key) return { error: data.message || 'Authorization not confirmed yet' };
            this.store.set('lastfm', { ...c, sessionKey: session.key, username: session.name });
            this.pendingToken = '';
            return { username: session.name };
        } catch (e: any) {
            return { error: e?.message || 'Session exchange failed' };
        }
    }


    /** called whenever now playing track changes. */
    async updateNowPlaying(track: NowPlaying): Promise<void> {
        if (!this.isReady() || !track.isPlaying || !track.title || !track.artist) return;
        const key = track.id + '|' + track.title;
        if (key === this.lastNowPlaying) return;
        this.lastNowPlaying = key;
        this.scrobbled = false;
        this.lastPos = 0;
        this.nextRetryAt = 0;

        const c = this.cfg();
        try {
            const res = await this.call(
                {
                    method: 'track.updateNowPlaying',
                    artist: track.artist,
                    track: track.title,
                    album: track.album || '',
                    duration: track.duration ? String(Math.round(track.duration)) : '',
                    api_key: c.apiKey,
                    sk: c.sessionKey,
                },
                'POST'
            );
            this.noteResult('now playing', res);
        } catch (err) {
            this.noteResult('now playing', null, err);
        }
    }

    /** called on progress; submits scrobble once play threshold is met. */
    async maybeScrobble(track: NowPlaying): Promise<void> {
        if (!this.isReady() || !track.title || !track.artist) return;
        if (this.scrobbled && track.position < 5 && this.lastPos > track.position + 10) {
            this.scrobbled = false;
            this.lastNowPlaying = '';
        }
        this.lastPos = track.position;
        if (this.scrobbled) return;
        if (Date.now() < this.nextRetryAt) return;
        const minLen = this.cfg().minScrobbleLen;
        const threshold = scrobbleThreshold(track.duration, minLen);
        if (threshold === null || track.position < threshold) return;
        this.scrobbled = true;

        const c = this.cfg();
        const startedAt = Math.floor(Date.now() / 1000 - track.position);
        try {
            const res = await this.call(
                {
                    method: 'track.scrobble',
                    artist: track.artist,
                    track: track.title,
                    album: track.album || '',
                    duration: track.duration ? String(Math.round(track.duration)) : '',
                    timestamp: String(startedAt),
                    api_key: c.apiKey,
                    sk: c.sessionKey,
                },
                'POST'
            );
            this.noteResult('scrobble', res);
        } catch (err) {
            this.noteResult('scrobble', null, err);
            this.scrobbled = false;
            this.nextRetryAt = Date.now() + 30000;
        }
    }
}
