"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PresenceService = void 0;
const discord_rpc_1 = require("@xhayper/discord-rpc");
// discord rich presence driven by player. run w/ --dev to see
// [bcrpc:discord] lines client otherwise swallows transport errors.
class PresenceService {
    store;
    client;
    isConnected = false;
    connecting = false;
    lastKey = '';
    debug = process.argv.includes('--dev');
    clientId;
    constructor(store) {
        this.store = store;
        this.clientId = this.storedClientId();
        this.log('init clientId=' + this.clientId);
        this.connect();
        // discord may start after us or restart; keep retrying
        setInterval(() => { if (!this.isConnected)
            this.connect(); }, 20_000);
    }
    log(msg) {
        if (this.debug)
            console.log('[bcrpc:discord] ' + msg);
    }
    // real baked in bandcamp app id so presence works out of box (no per user
    // setup). user can still override it in settings via discordclientid.
    storedClientId() {
        const id = this.store?.get('discordClientId') || '';
        return id.trim() || '1521825571611607140';
    }
    // re read id & reconnect called when settings change it
    reconnect() {
        this.log('reconnect requested');
        this.isConnected = false;
        this.connecting = false;
        this.lastKey = '';
        try {
            this.client?.destroy?.();
        }
        catch { /* no live client */ }
        this.connect();
    }
    async connect() {
        if (this.isConnected || this.connecting)
            return;
        this.connecting = true;
        this.clientId = this.storedClientId();
        try {
            // fresh client per attempt transport can't be reused after fail
            this.client = new discord_rpc_1.Client({ clientId: this.clientId });
            this.client.on('error', (err) => this.log('client error: ' + (err && (err.message || err))));
            this.client.on('ready', () => { this.isConnected = true; this.log('ready (user=' + (this.client.user?.username || '?') + ')'); });
            this.client.on('disconnected', () => { this.isConnected = false; this.log('disconnected'); });
            this.log('connecting… (clientId=' + this.clientId + ')');
            await this.client.login();
            this.isConnected = true;
            this.log('connected');
        }
        catch (err) {
            this.isConnected = false;
            this.log('connect failed: ' + (err && (err.message || err)) + ' (is discord running? is the app id valid?)');
        }
        finally {
            this.connecting = false;
        }
    }
    enabled() {
        return this.store ? this.store.get('discordEnabled', true) !== false : true;
    }
    async update(track) {
        if (!this.isConnected)
            return;
        if (!this.enabled() || !track.isPlaying || !track.title) {
            this.lastKey = '';
            await this.client.user?.clearActivity().catch(() => { });
            return;
        }
        // don't re send same activity every progress tick
        const key = `${track.id}|${track.title}|${track.isPlaying}`;
        if (key === this.lastKey)
            return;
        this.lastKey = key;
        const now = Date.now();
        const start = now - Math.floor((track.position || 0) * 1000);
        const end = track.duration > 0 ? start + Math.floor(track.duration * 1000) : undefined;
        // name shows as the compact status line. use "artist - song" (no emoji).
        // note: discord always prefixes the type verb ("Listening to") and there's no
        // way to remove it via rpc.
        const nameLine = (track.artist ? `${track.artist} - ${track.title}` : track.title) || 'Bandcamp';
        const activity = {
            name: nameLine.slice(0, 128),
            type: 2, // listening
            details: track.title.slice(0, 128),
            state: (track.album || track.artist || 'Bandcamp').slice(0, 128),
            startTimestamp: start,
            largeImageKey: track.art || 'bandcamp_icon',
            largeImageText: (track.album || track.title).slice(0, 128),
            smallImageKey: 'bandcamp_icon',
            smallImageText: 'Bandcamp Desktop',
            instance: false,
        };
        if (end)
            activity.endTimestamp = end;
        // discord only supports clickable *buttons* (not clickable title/cover/artist),
        // so this button is the link to the release.
        if (track.url?.startsWith('https://')) {
            activity.buttons = [{ label: 'Listen on Bandcamp', url: track.url }];
        }
        try {
            await this.client.user?.setActivity(activity);
            this.log('setActivity ok: ' + activity.details + ' — ' + activity.state);
        }
        catch (err) {
            // discord may reject external image url; retry text only so
            // presence still shows then give up (failure shouldn't wedge next track)
            this.log('setActivity failed, retrying text-only: ' + (err && (err.message || err)));
            try {
                await this.client.user?.setActivity({
                    name: activity.name, type: 2, instance: false,
                    details: activity.details, state: activity.state,
                    startTimestamp: activity.startTimestamp, endTimestamp: activity.endTimestamp,
                    buttons: activity.buttons,
                });
                this.log('setActivity ok (text-only)');
            }
            catch (err2) {
                this.lastKey = '';
                this.log('setActivity failed (text-only too): ' + (err2 && (err2.message || err2)));
            }
        }
    }
}
exports.PresenceService = PresenceService;
