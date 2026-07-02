import type { PlayerTrack, RepeatMode, QueueContext } from '../shared/types';

// a playback queue w repeat + shuffle. tracks is the natural order; order is
// play order (an index permutation) so shuffle never mutates the displayed list
export class Queue {
    tracks: PlayerTrack[] = [];
    context: QueueContext = 'single';
    repeat: RepeatMode = 'off';
    shuffle = false;

    private order: number[] = [];
    private pos = 0;

    load(tracks: PlayerTrack[], activeIndex: number, context: QueueContext): void {
        this.tracks = tracks;
        this.context = context;
        this.rebuildOrder(Math.max(0, Math.min(activeIndex, tracks.length - 1)));
    }

    // append tracks to the end of the queue without disturbing what's playing.
    // returns true if the queue was empty before (caller should start playback).
    append(newTracks: PlayerTrack[]): boolean {
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
        if (wasEmpty) this.pos = 0;
        return wasEmpty;
    }

    private rebuildOrder(currentTrackIndex: number): void {
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

    current(): PlayerTrack | null {
        const idx = this.order[this.pos];
        return this.tracks[idx] ?? null;
    }

    currentTrackIndex(): number {
        return this.order[this.pos] ?? -1;
    }

    setRepeat(mode: RepeatMode): void {
        this.repeat = mode;
    }

    setShuffle(on: boolean): void {
        if (on === this.shuffle) return;
        this.shuffle = on;
        this.rebuildOrder(this.currentTrackIndex());
    }

    // manual next: always advances, wrapping when repeat=all
    next(): PlayerTrack | null {
        if (!this.tracks.length) return null;
        if (this.pos + 1 < this.order.length) {
            this.pos += 1;
        } else if (this.repeat === 'all') {
            this.pos = 0;
        } else {
            return null;
        }
        return this.current();
    }

    // auto advance on track end: respects repeat=one (caller replays)
    advanceOnEnd(): PlayerTrack | null {
        if (this.repeat === 'one') return this.current();
        return this.next();
    }

    prev(): PlayerTrack | null {
        if (!this.tracks.length) return null;
        if (this.pos - 1 >= 0) {
            this.pos -= 1;
        } else if (this.repeat === 'all') {
            this.pos = this.order.length - 1;
        } else {
            this.pos = 0;
        }
        return this.current();
    }

    jumpTo(trackIndex: number): PlayerTrack | null {
        const p = this.order.indexOf(trackIndex);
        if (p === -1) return null;
        this.pos = p;
        return this.current();
    }
}
