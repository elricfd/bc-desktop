import * as crypto from 'crypto';
import fetch from 'cross-fetch';
import type Store from 'electron-store';
import type { NowPlaying } from '../shared/types';

// minimal last.fm scrobbler. uses desktop auth flow:
//   1. auth.getToken           -> req token
//   2. user authorizes token   -> https://www.last.fm/api/auth/?api_key=..&token=..
//   3. auth.getSession         -> long lived session key (stored)
// then track.updatenowplaying / track.scrobble are signed w/ secret.

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';

interface LastfmConfig {
    apiKey: string;
    apiSecret: string;
    sessionKey: string;
    username: string;
    enabled: boolean;
}

export class LastfmService {
    private pendingToken = '';
    private lastNowPlaying = '';
    private scrobbled = false;

    constructor(private readonly store: Store) {}

    private cfg(): LastfmConfig {
        const raw = (this.store.get('lastfm') as Partial<LastfmConfig>) || {};
        return {
            apiKey: raw.apiKey || '',
            apiSecret: raw.apiSecret || '',
            sessionKey: raw.sessionKey || '',
            username: raw.username || '',
            enabled: raw.enabled !== false,
        };
    }

    isReady(): boolean {
        const c = this.cfg();
        return Boolean(c.enabled && c.apiKey && c.apiSecret && c.sessionKey);
    }

    /**
     * md5 signature over alphabetically sorted params + shared secret.
     * NOTE: md5 here is MANDATED by the Last.fm API auth spec (the api_sig must be
     * md5(sorted params + secret)) — it's a protocol requirement, not a security
     * hash of sensitive data, so the CodeQL "weak crypto" alert is a false positive
     * for this call and can be dismissed. https://www.last.fm/api/authspec
     */
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

    // auth

    /** step 1+2: get req token & url user must authorize. */
    async beginAuth(): Promise<{ authUrl: string } | { error: string }> {
        const c = this.cfg();
        if (!c.apiKey || !c.apiSecret) return { error: 'Missing Last.fm API key/secret' };
        try {
            const data = await this.call({ method: 'auth.getToken', api_key: c.apiKey }, 'GET');
            if (!data.token) return { error: data.message || 'Could not get token' };
            this.pendingToken = data.token;
            return { authUrl: `https://www.last.fm/api/auth/?api_key=${c.apiKey}&token=${data.token}` };
        } catch (e: any) {
            return { error: e?.message || 'Auth request failed' };
        }
    }

    /**
     * poll step 3 until the user finishes authorizing in their browser (last.fm's
     * desktop flow has no redirect back, so we watch auth.getSession which errors
     * until the token is approved, then returns the session). removes the need for
     * a manual "i've authorized" click.
     */
    async pollForSession(
        attempts = 60,
        intervalMs = 2500
    ): Promise<{ username: string } | { error: string }> {
        const token = this.pendingToken;
        for (let i = 0; i < attempts; i++) {
            // stop if a newer auth attempt replaced (or cleared) this token
            if (this.pendingToken !== token) return { error: 'cancelled' };
            const res = await this.completeAuth();
            if ('username' in res) return res;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return { error: 'timed out waiting for authorization' };
    }

    /** step 3: exchange authorized token for session key. */
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

    // scrobbling

    /** called whenever now playing track changes. */
    async updateNowPlaying(track: NowPlaying): Promise<void> {
        if (!this.isReady() || !track.isPlaying || !track.title || !track.artist) return;
        const key = track.id + '|' + track.title;
        if (key === this.lastNowPlaying) return;
        this.lastNowPlaying = key;
        this.scrobbled = false;

        const c = this.cfg();
        try {
            await this.call(
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
        } catch {
            // non fatal
        }
    }

    /** called on progress; submits scrobble once play threshold is met. */
    async maybeScrobble(track: NowPlaying): Promise<void> {
        if (!this.isReady() || this.scrobbled || !track.title || !track.artist) return;
        // last.fm rule: half track or 4 mins whichever comes first.
        const threshold = track.duration > 30 ? Math.min(track.duration / 2, 240) : 0;
        if (!threshold || track.position < threshold) return;
        this.scrobbled = true;

        const c = this.cfg();
        const startedAt = Math.floor(Date.now() / 1000 - track.position);
        try {
            await this.call(
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
        } catch {
            // allow retry on next tick
            this.scrobbled = false; 
        }
    }
}
