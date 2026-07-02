"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Queue = void 0;
// a playback queue w repeat + shuffle. tracks is the natural order; order is
// play order (an index permutation) so shuffle never mutates the displayed list
class Queue {
    tracks = [];
    context = 'single';
    repeat = 'off';
    shuffle = false;
    order = [];
    pos = 0;
    load(tracks, activeIndex, context) {
        this.tracks = tracks;
        this.context = context;
        this.rebuildOrder(Math.max(0, Math.min(activeIndex, tracks.length - 1)));
    }
    // append tracks to the end of the queue without disturbing what's playing.
    // returns true if the queue was empty before (caller should start playback).
    append(newTracks) {
        const wasEmpty = this.tracks.length === 0;
        const start = this.tracks.length;
        this.tracks.push(...newTracks);
        const added = newTracks.map((_, i) => start + i);
        if (this.shuffle) {
            for (let i = added.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [added[i], added[j]] = [added[j], added[i]];
            }
        }
        this.order.push(...added);
        if (wasEmpty)
            this.pos = 0;
        return wasEmpty;
    }
    rebuildOrder(currentTrackIndex) {
        const natural = this.tracks.map((_, i) => i);
        if (!this.shuffle) {
            this.order = natural;
            this.pos = currentTrackIndex;
            return;
        }
        // keep current track first, shuffle rest
        const rest = natural.filter((i) => i !== currentTrackIndex);
        for (let i = rest.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [rest[i], rest[j]] = [rest[j], rest[i]];
        }
        this.order = currentTrackIndex >= 0 ? [currentTrackIndex, ...rest] : rest;
        this.pos = 0;
    }
    current() {
        const idx = this.order[this.pos];
        return this.tracks[idx] ?? null;
    }
    currentTrackIndex() {
        return this.order[this.pos] ?? -1;
    }
    setRepeat(mode) {
        this.repeat = mode;
    }
    setShuffle(on) {
        if (on === this.shuffle)
            return;
        this.shuffle = on;
        this.rebuildOrder(this.currentTrackIndex());
    }
    // manual next: always advances, wrapping when repeat=all
    next() {
        if (!this.tracks.length)
            return null;
        if (this.pos + 1 < this.order.length) {
            this.pos += 1;
        }
        else if (this.repeat === 'all') {
            this.pos = 0;
        }
        else {
            return null;
        }
        return this.current();
    }
    // auto advance on track end: respects repeat=one (caller replays)
    advanceOnEnd() {
        if (this.repeat === 'one')
            return this.current();
        return this.next();
    }
    prev() {
        if (!this.tracks.length)
            return null;
        if (this.pos - 1 >= 0) {
            this.pos -= 1;
        }
        else if (this.repeat === 'all') {
            this.pos = this.order.length - 1;
        }
        else {
            this.pos = 0;
        }
        return this.current();
    }
    jumpTo(trackIndex) {
        const p = this.order.indexOf(trackIndex);
        if (p === -1)
            return null;
        this.pos = p;
        return this.current();
    }
}
exports.Queue = Queue;
