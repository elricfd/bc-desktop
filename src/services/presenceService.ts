import { Client } from '@xhayper/discord-rpc';
import type Store from 'electron-store';
import type { NowPlaying } from '../shared/types';

// discord rich presence driven by player
export class PresenceService {
    private client!: Client;
    private isConnected = false;
    private connecting = false;
    private lastKey = '';
    private readonly debug = process.argv.includes('--dev');
    private clientId: string;

    constructor(private readonly store?: Store) {
        this.clientId = this.storedClientId();
        this.log('init clientId=' + this.clientId);
        this.connect();
        setInterval(() => { if (!this.isConnected) this.connect(); }, 20_000);
    }

    private log(msg: string): void {
        if (this.debug) console.log('[bcrpc:discord] ' + msg);
    }

    // real baked in bandcamp app id so presence works out of box (no per user setup)
    private storedClientId(): string {
        const id = (this.store?.get('discordClientId') as string) || '';
        return id.trim() || '1521825571611607140';
    }

    // re read id & reconnect called when settings change it
    reconnect(): void {
        this.log('reconnect requested');
        this.isConnected = false;
        this.connecting = false;
        this.lastKey = '';
        try { (this.client as any)?.destroy?.(); } catch { /* no live client */ }
        this.connect();
    }

    async connect(): Promise<void> {
        if (this.isConnected || this.connecting) return;
        this.connecting = true;
        this.clientId = this.storedClientId();
        try {
            this.client = new Client({ clientId: this.clientId });
            this.client.on('error', (err: any) => this.log('client error: ' + (err && (err.message || err))));
            this.client.on('ready', () => { this.isConnected = true; this.log('ready (user=' + (this.client.user?.username || '?') + ')'); });
            this.client.on('disconnected', () => { this.isConnected = false; this.log('disconnected'); });
            this.log('connecting… (clientId=' + this.clientId + ')');
            await this.client.login();
            this.isConnected = true;
            this.log('connected');
        } catch (err: any) {
            this.isConnected = false;
            this.log('connect failed: ' + (err && (err.message || err)) + ' (is discord running? is the app id valid?)');
        } finally {
            this.connecting = false;
        }
    }

    private enabled(): boolean {
        return this.store ? this.store.get('discordEnabled', true) !== false : true;
    }

    options(): { showWhenPaused: boolean } {
        return {
            showWhenPaused: this.store ? this.store.get('discordShowWhenPaused', false) === true : false,
        };
    }

    private lastTrack: NowPlaying | null = null;
    nowPlaying(): NowPlaying | null { return this.lastTrack; }

    /** re-send the current activity (called when settings toggles change). */
    refresh(): void {
        this.lastKey = '';
        if (this.lastTrack) void this.update(this.lastTrack);
    }

    async update(track: NowPlaying): Promise<void> {
        this.lastTrack = track;
        if (!this.isConnected) return;
        const o = this.options();

        if (!this.enabled() || !track.title || (!track.isPlaying && !o.showWhenPaused)) {
            this.lastKey = '';
            await this.client.user?.clearActivity().catch(() => {});
            return;
        }

        const key = `${track.id}|${track.title}|${track.isPlaying}|${JSON.stringify(o)}`;
        if (key === this.lastKey) return;
        this.lastKey = key;

        const now = Date.now();
        const start = now - Math.floor((track.position || 0) * 1000);
        const end = track.duration > 0 ? start + Math.floor(track.duration * 1000) : undefined;

        const activity: any = {
            name: (track.artist || 'Bandcamp').slice(0, 128),               
            type: 2,
            details: (track.title || 'Bandcamp').slice(0, 128),
            state: (track.artist || 'Bandcamp').slice(0, 128),
            largeImageKey: track.art || 'bandcamp_icon',
            largeImageText: (track.album || track.title || 'Bandcamp').slice(0, 128),
            instance: false,
            startTimestamp: start,
        };
        if (end) activity.endTimestamp = end;

        try {
            await this.client.user?.setActivity(activity);
            this.log('setActivity ok: ' + activity.details + ' - ' + activity.state);
        } catch (err: any) {
            this.log('setActivity failed, retrying text-only: ' + (err && (err.message || err)));
            try {
                await this.client.user?.setActivity({
                    name: activity.name, type: 2, instance: false,
                    details: activity.details, state: activity.state,
                    startTimestamp: activity.startTimestamp, endTimestamp: activity.endTimestamp,
                    buttons: activity.buttons,
                });
                this.log('setActivity ok (text-only)');
            } catch (err2: any) {
                this.lastKey = '';
                this.log('setActivity failed (text-only too): ' + (err2 && (err2.message || err2)));
            }
        }
    }
}
