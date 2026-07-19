// minimal local audio metadata reader for the local-files library.
// modeled on quodlibet/mutagen's approach: every format is normalized into ONE
// flat schema (title/artist/album/albumartist/year/tracknum/genre/duration/art)
// with graceful degradation — a broken or missing tag never throws, it just
// yields fewer fields, and the importer falls back to the filename (quodlibet
// does exactly this for WAV, whose metadata story is hopeless).
// read-only by design: we never rewrite the user's files, so there is zero
// corruption risk.
import * as fs from 'fs';
import * as path from 'path';

export interface LocalTags {
    title: string;
    artist: string;
    album: string;
    albumArtist: string;
    year: number;
    trackNum: number;
    genre: string[];
    /** seconds; 0 when the container doesn't say (player learns it on play) */
    duration: number;
    /** embedded front cover when present */
    art: Buffer | null;
}

const empty = (): LocalTags => ({ title: '', artist: '', album: '', albumArtist: '', year: 0, trackNum: 0, genre: [], duration: 0, art: null });

// ---------------------------------------------------------------------------
// id3v2 (mp3, and embedded in wav/aiff chunks). "ID3 is absolutely the worst
// thing ever" — quodlibet/formats/_id3.py. we read the handful of frames that
// map onto our schema (their IDS table): TIT2 TPE1 TALB TPE2 TRCK TCON APIC,
// plus TDRC (v2.4) / TYER (v2.3) for the year and the 3-char v2.2 variants.
// ---------------------------------------------------------------------------

const V22_IDS: Record<string, string> = { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', TP2: 'TPE2', TRK: 'TRCK', TYE: 'TYER', TCO: 'TCON', PIC: 'APIC' };

function synchsafe(b: Buffer, off: number): number {
    return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f);
}

// reverse the unsynchronization scheme: 0xFF 0x00 -> 0xFF
function deUnsync(b: Buffer): Buffer {
    const out = Buffer.alloc(b.length);
    let j = 0;
    for (let i = 0; i < b.length; i++) {
        out[j++] = b[i];
        if (b[i] === 0xff && b[i + 1] === 0x00) i++;
    }
    return out.subarray(0, j);
}

function decodeText(enc: number, b: Buffer): string {
    try {
        if (enc === 1) { // utf-16 with BOM (LE assumed when absent)
            if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return swap16(b.subarray(2)).toString('utf16le');
            if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
            return b.toString('utf16le');
        }
        if (enc === 2) return swap16(b).toString('utf16le'); // utf-16be, no BOM
        if (enc === 3) return b.toString('utf8');
        return b.toString('latin1');
    } catch { return ''; }
}
function swap16(b: Buffer): Buffer {
    const out = Buffer.from(b);
    for (let i = 0; i + 1 < out.length; i += 2) { const t = out[i]; out[i] = out[i + 1]; out[i + 1] = t; }
    return out;
}

// multi-value text frames are null-separated; mutagen keeps a list, we join
const splitVals = (s: string): string[] => s.split('\0').map((x) => x.trim()).filter(Boolean);
const textOf = (enc: number, b: Buffer): string => splitVals(decodeText(enc, b)).join(', ');

// find the null terminator for the frame's encoding (utf-16 uses a double null)
function zEnd(b: Buffer, start: number, enc: number): number {
    if (enc === 1 || enc === 2) {
        for (let i = start; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i + 2;
        return b.length;
    }
    const i = b.indexOf(0, start);
    return i === -1 ? b.length : i + 1;
}

interface Id3Result { tags: LocalTags; tagSize: number }

export function parseId3v2(buf: Buffer): Id3Result | null {
    if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return null;
    const major = buf[3];
    if (major < 2 || major > 4) return null;
    const flags = buf[5];
    const size = synchsafe(buf, 6);
    const tagSize = 10 + size + ((flags & 0x10) ? 10 : 0); // + footer (v2.4)
    let body = buf.subarray(10, Math.min(10 + size, buf.length));
    if ((flags & 0x80) && major < 4) body = deUnsync(body); // whole-tag unsync (v2.4 is per-frame)

    const t = empty();
    let pictures: { type: number; data: Buffer }[] = [];
    let pos = 0;
    // extended header: v2.3 size excludes its own 4 bytes, v2.4 includes them
    if (flags & 0x40) {
        if (major === 4) pos += Math.max(6, synchsafe(body, 0));
        else pos += 4 + body.readUInt32BE(0);
    }
    const idLen = major === 2 ? 3 : 4;
    const headLen = major === 2 ? 6 : 10;
    const text: Record<string, string> = {};
    while (pos + headLen <= body.length) {
        const rawId = body.toString('latin1', pos, pos + idLen);
        if (!/^[A-Z0-9]+$/.test(rawId)) break; // padding / garbage
        let fsize: number;
        let fflags = 0;
        if (major === 2) fsize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
        else if (major === 3) { fsize = body.readUInt32BE(pos + 4); fflags = body.readUInt16BE(pos + 8); }
        else {
            fsize = synchsafe(body, pos + 4);
            // some v2.4 writers (itunes) use plain sizes; a plain size that fits
            // where the synchsafe one doesn't wins (mutagen has the same heuristic)
            const plain = body.readUInt32BE(pos + 4);
            if (plain !== fsize && pos + 10 + fsize < body.length) {
                const nextOk = (o: number) => o + 10 > body.length || /^[A-Z0-9]{4}/.test(body.toString('latin1', o, o + 4)) || body[o] === 0;
                if (!nextOk(pos + 10 + fsize) && nextOk(pos + 10 + plain)) fsize = plain;
            }
            fflags = body.readUInt16BE(pos + 8);
        }
        if (fsize <= 0 || pos + headLen + fsize > body.length) break;
        let data = body.subarray(pos + headLen, pos + headLen + fsize);
        pos += headLen + fsize;
        const id = major === 2 ? (V22_IDS[rawId] || rawId) : rawId;
        if (major === 4) {
            if (fflags & 0x02) data = deUnsync(data); // per-frame unsync
            if (fflags & 0x01) data = data.subarray(4); // data length indicator
        }
        if (fflags & 0x0c && major === 3) continue; // v2.3 compressed/encrypted
        if (id === 'APIC' && data.length > 4) {
            try {
                const enc = data[0];
                let p: number;
                let picType: number;
                if (rawId === 'PIC') { // v2.2: 3-char image format, not a mime string
                    picType = data[4];
                    p = zEnd(data, 5, enc);
                } else {
                    const mimeEnd = data.indexOf(0, 1);
                    if (mimeEnd === -1) continue;
                    picType = data[mimeEnd + 1];
                    p = zEnd(data, mimeEnd + 2, enc);
                }
                const img = data.subarray(p);
                if (img.length > 32) pictures.push({ type: picType, data: Buffer.from(img) });
            } catch { /* skip malformed picture */ }
            continue;
        }
        if (id[0] === 'T' && id !== 'TXXX' && data.length > 1 && !(id in text)) {
            text[id] = textOf(data[0], data.subarray(1));
        }
    }
    t.title = text.TIT2 || '';
    t.artist = text.TPE1 || '';
    t.album = text.TALB || '';
    t.albumArtist = text.TPE2 || ''; // quodlibet maps TPE2->performer; in the wild it's album artist
    const date = text.TDRC || text.TYER || text.TORY || '';
    const ym = date.match(/\d{4}/);
    t.year = ym ? Number(ym[0]) : 0;
    t.trackNum = parseInt(text.TRCK || '', 10) || 0;
    // TCON: strip legacy "(nn)" genre references, keep the text
    t.genre = splitVals((text.TCON || '').replace(/\(\d+\)/g, '\0')).filter((g) => !/^\d+$/.test(g));
    // front cover (type 3) preferred, else the first picture
    const front = pictures.find((p) => p.type === 3) || pictures[0];
    t.art = front ? front.data : null;
    return { tags: t, tagSize };
}

function parseId3v1(fd: number, fileSize: number, t: LocalTags): void {
    if (fileSize < 128) return;
    const b = Buffer.alloc(128);
    fs.readSync(fd, b, 0, 128, fileSize - 128);
    if (b.toString('latin1', 0, 3) !== 'TAG') return;
    const str = (s: number, e: number) => b.toString('latin1', s, e).replace(/\0.*$/s, '').trim();
    t.title = t.title || str(3, 33);
    t.artist = t.artist || str(33, 63);
    t.album = t.album || str(63, 93);
    t.year = t.year || Number(str(93, 97).match(/\d{4}/)?.[0] || 0);
    if (!t.trackNum && b[125] === 0 && b[126] > 0) t.trackNum = b[126]; // id3v1.1
}

// ---------------------------------------------------------------------------
// mp3 duration: Xing/Info/VBRI header when present (VBR), else a CBR estimate
// from the first frame's bitrate — the same ladder mutagen's MPEGInfo climbs.
// ---------------------------------------------------------------------------

const BITRATES_V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLERATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Duration(fd: number, fileSize: number, offset: number): number {
    const len = Math.min(fileSize - offset, 256 * 1024);
    if (len <= 4) return 0;
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, offset);
    for (let i = 0; i + 4 < b.length; i++) {
        if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
        const ver = (b[i + 1] >> 3) & 3; // 3=mpeg1, 2=mpeg2, 0=mpeg2.5
        const layer = (b[i + 1] >> 1) & 3; // 1 = layer III
        const brIdx = b[i + 2] >> 4;
        const srIdx = (b[i + 2] >> 2) & 3;
        if (ver === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
        const rate = SAMPLERATES[ver]?.[srIdx];
        const kbps = (ver === 3 ? BITRATES_V1L3 : BITRATES_V2L3)[brIdx];
        if (!rate || !kbps) continue;
        const spf = ver === 3 ? 1152 : 576;
        const mono = ((b[i + 3] >> 6) & 3) === 3;
        const side = ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
        const at = i + 4 + side;
        const magic = b.toString('latin1', at, at + 4);
        if (magic === 'Xing' || magic === 'Info') {
            const flags = b.readUInt32BE(at + 4);
            if (flags & 1) return Math.round((b.readUInt32BE(at + 8) * spf) / rate);
        }
        if (b.toString('latin1', i + 4 + 32, i + 4 + 36) === 'VBRI') {
            return Math.round((b.readUInt32BE(i + 4 + 32 + 14) * spf) / rate);
        }
        return Math.round(((fileSize - offset - i) * 8) / (kbps * 1000)); // CBR estimate
    }
    return 0;
}

// ---------------------------------------------------------------------------
// flac: STREAMINFO gives an exact duration, VORBIS_COMMENT the tags, PICTURE
// the cover. vorbis comments double for ogg/opus below (quodlibet/xiph.py).
// ---------------------------------------------------------------------------

function applyVorbisComment(c: Record<string, string[]>, t: LocalTags): void {
    const first = (k: string) => (c[k] && c[k][0]) || '';
    t.title = t.title || first('title');
    t.artist = t.artist || (c.artist || []).join(', ');
    t.album = t.album || first('album');
    t.albumArtist = t.albumArtist || first('albumartist') || first('album artist');
    t.year = t.year || Number((first('date') || first('year')).match(/\d{4}/)?.[0] || 0);
    t.trackNum = t.trackNum || parseInt(first('tracknumber'), 10) || 0;
    if (!t.genre.length && c.genre) t.genre = c.genre.filter(Boolean);
}

// KEY=value pairs, length-prefixed; shared by flac blocks and ogg comment packets
function parseVorbisComments(b: Buffer, pos: number): { c: Record<string, string[]>; pics: Buffer[] } {
    const c: Record<string, string[]> = {};
    const pics: Buffer[] = [];
    try {
        const vendorLen = b.readUInt32LE(pos);
        pos += 4 + vendorLen;
        const count = b.readUInt32LE(pos);
        pos += 4;
        for (let i = 0; i < count && pos + 4 <= b.length; i++) {
            const len = b.readUInt32LE(pos);
            pos += 4;
            if (len > 32 * 1024 * 1024 || pos + len > b.length) break; // truncated / spans pages
            const s = b.toString('utf8', pos, pos + len);
            pos += len;
            const eq = s.indexOf('=');
            if (eq <= 0) continue;
            const key = s.slice(0, eq).toLowerCase();
            const val = s.slice(eq + 1);
            if (key === 'metadata_block_picture') {
                try { pics.push(Buffer.from(val, 'base64')); } catch { /* bad b64 */ }
                continue;
            }
            (c[key] = c[key] || []).push(val.trim());
        }
    } catch { /* keep what we got */ }
    return { c, pics };
}

// FLAC PICTURE block layout (also inside ogg's METADATA_BLOCK_PICTURE)
function parseFlacPicture(b: Buffer): { type: number; data: Buffer } | null {
    try {
        const type = b.readUInt32BE(0);
        const mimeLen = b.readUInt32BE(4);
        let p = 8 + mimeLen;
        const descLen = b.readUInt32BE(p);
        p += 4 + descLen + 16; // + width/height/depth/colors
        const dataLen = b.readUInt32BE(p);
        p += 4;
        if (p + dataLen > b.length) return null;
        return { type, data: Buffer.from(b.subarray(p, p + dataLen)) };
    } catch { return null; }
}

function readFlac(fd: number, fileSize: number): LocalTags | null {
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    let off = 0;
    if (head.toString('latin1') === 'ID3') { // flac with a bolted-on id3 (rare, real)
        const hb = Buffer.alloc(10);
        fs.readSync(fd, hb, 0, 10, 0);
        off = 10 + synchsafe(hb, 6);
        fs.readSync(fd, head, 0, 4, off);
    }
    if (head.toString('latin1') !== 'fLaC') return null;
    const t = empty();
    const pics: { type: number; data: Buffer }[] = [];
    let pos = off + 4;
    for (let guard = 0; guard < 64; guard++) {
        const bh = Buffer.alloc(4);
        if (fs.readSync(fd, bh, 0, 4, pos) < 4) break;
        const last = bh[0] & 0x80;
        const type = bh[0] & 0x7f;
        const size = (bh[1] << 16) | (bh[2] << 8) | bh[3];
        pos += 4;
        if (size > 0 && size < 64 * 1024 * 1024) {
            if (type === 0 && size >= 18) { // STREAMINFO
                const si = Buffer.alloc(18);
                fs.readSync(fd, si, 0, 18, pos);
                const rate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
                const totalHi = si[13] & 0x0f;
                const total = totalHi * 4294967296 + si.readUInt32BE(14);
                if (rate > 0 && total > 0) t.duration = Math.round(total / rate);
            } else if (type === 4) { // VORBIS_COMMENT
                const vb = Buffer.alloc(size);
                fs.readSync(fd, vb, 0, size, pos);
                const { c } = parseVorbisComments(vb, 0);
                applyVorbisComment(c, t);
            } else if (type === 6 && size < 16 * 1024 * 1024) { // PICTURE
                const pb = Buffer.alloc(size);
                fs.readSync(fd, pb, 0, size, pos);
                const pic = parseFlacPicture(pb);
                if (pic) pics.push(pic);
            }
        }
        pos += size;
        if (last) break;
    }
    const front = pics.find((p) => p.type === 3) || pics[0];
    t.art = front ? front.data : null;
    return t;
}

// ---------------------------------------------------------------------------
// wav: duration from fmt/data chunk math (what quodlibet's wave-module read
// boils down to), tags from the RIFF LIST/INFO chunk and an embedded id3
// chunk when some tagger left one. INFO ids per the RIFF spec.
// ---------------------------------------------------------------------------

const RIFF_INFO: Record<string, keyof Pick<LocalTags, 'title' | 'artist' | 'album'>> = { INAM: 'title', IART: 'artist', IPRD: 'album' };

function readWav(fd: number, fileSize: number): LocalTags | null {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') return null;
    const t = empty();
    let byteRate = 0;
    let pos = 12;
    while (pos + 8 <= fileSize) {
        const ch = Buffer.alloc(8);
        if (fs.readSync(fd, ch, 0, 8, pos) < 8) break;
        const id = ch.toString('latin1', 0, 4);
        const size = ch.readUInt32LE(4);
        if (size < 0 || size > fileSize) break;
        if (id === 'fmt ' && size >= 16) {
            const fb = Buffer.alloc(16);
            fs.readSync(fd, fb, 0, 16, pos + 8);
            byteRate = fb.readUInt32LE(8);
        } else if (id === 'data') {
            if (byteRate > 0) t.duration = Math.round(size / byteRate);
        } else if (id === 'LIST' && size >= 4 && size < 8 * 1024 * 1024) {
            const lb = Buffer.alloc(size);
            fs.readSync(fd, lb, 0, size, pos + 8);
            if (lb.toString('latin1', 0, 4) === 'INFO') {
                let p = 4;
                while (p + 8 <= lb.length) {
                    const iid = lb.toString('latin1', p, p + 4);
                    const isz = lb.readUInt32LE(p + 4);
                    if (isz < 0 || p + 8 + isz > lb.length) break;
                    const val = lb.toString('utf8', p + 8, p + 8 + isz).replace(/\0.*$/s, '').trim();
                    const key = RIFF_INFO[iid];
                    if (key && val) t[key] = t[key] || val;
                    else if (iid === 'ICRD' && val) t.year = t.year || Number(val.match(/\d{4}/)?.[0] || 0);
                    else if (iid === 'IGNR' && val) t.genre.length || (t.genre = [val]);
                    else if (iid === 'ITRK' && val) t.trackNum = t.trackNum || parseInt(val, 10) || 0;
                    p += 8 + isz + (isz & 1);
                }
            }
        } else if ((id === 'id3 ' || id === 'ID3 ') && size > 10 && size < 32 * 1024 * 1024) {
            const ib = Buffer.alloc(size);
            fs.readSync(fd, ib, 0, size, pos + 8);
            const r = parseId3v2(ib);
            if (r) mergeMissing(t, r.tags);
        }
        pos += 8 + size + (size & 1);
    }
    return t;
}

// aiff: big-endian chunks; COMM carries frames + an 80-bit float sample rate,
// tags live in an 'ID3 ' chunk (this is what mutagen's aiff module reads too)
function readAiff(fd: number, fileSize: number): LocalTags | null {
    const head = Buffer.alloc(12);
    fs.readSync(fd, head, 0, 12, 0);
    if (head.toString('latin1', 0, 4) !== 'FORM') return null;
    const form = head.toString('latin1', 8, 12);
    if (form !== 'AIFF' && form !== 'AIFC') return null;
    const t = empty();
    let pos = 12;
    while (pos + 8 <= fileSize) {
        const ch = Buffer.alloc(8);
        if (fs.readSync(fd, ch, 0, 8, pos) < 8) break;
        const id = ch.toString('latin1', 0, 4);
        const size = ch.readUInt32BE(4);
        if (size < 0 || size > fileSize) break;
        if (id === 'COMM' && size >= 18) {
            const cb = Buffer.alloc(18);
            fs.readSync(fd, cb, 0, 18, pos + 8);
            const frames = cb.readUInt32BE(2);
            // 80-bit extended float sample rate
            const exp = (((cb[8] & 0x7f) << 8) | cb[9]) - 16383;
            const mant = cb.readUInt32BE(10);
            const rate = mant * Math.pow(2, exp - 31);
            if (rate > 0 && frames > 0) t.duration = Math.round(frames / rate);
        } else if (id === 'ID3 ' && size > 10 && size < 32 * 1024 * 1024) {
            const ib = Buffer.alloc(size);
            fs.readSync(fd, ib, 0, size, pos + 8);
            const r = parseId3v2(ib);
            if (r) mergeMissing(t, r.tags);
        }
        pos += 8 + size + (size & 1);
    }
    return t;
}

// ---------------------------------------------------------------------------
// ogg vorbis / opus: comments from the header packets near the start; duration
// from the last page's granule position (samples) — scan the tail for "OggS".
// ---------------------------------------------------------------------------

function readOgg(fd: number, fileSize: number): LocalTags | null {
    const headLen = Math.min(fileSize, 192 * 1024);
    const hb = Buffer.alloc(headLen);
    fs.readSync(fd, hb, 0, headLen, 0);
    if (hb.toString('latin1', 0, 4) !== 'OggS') return null;
    const t = empty();
    let granuleRate = 0;
    const opusAt = hb.indexOf('OpusHead');
    const vorbAt = hb.indexOf('\x01vorbis');
    if (opusAt !== -1) granuleRate = 48000; // opus granules are always 48kHz
    else if (vorbAt !== -1 && vorbAt + 16 <= hb.length) granuleRate = hb.readUInt32LE(vorbAt + 12);
    // comment packet: OpusTags / \x03vorbis marker, comments follow immediately
    const opusTags = hb.indexOf('OpusTags');
    const vorbTags = hb.indexOf('\x03vorbis');
    const cAt = opusTags !== -1 ? opusTags + 8 : vorbTags !== -1 ? vorbTags + 7 : -1;
    if (cAt !== -1) {
        const { c, pics } = parseVorbisComments(hb, cAt);
        applyVorbisComment(c, t);
        for (const raw of pics) {
            const pic = parseFlacPicture(raw);
            if (pic && (pic.type === 3 || !t.art)) t.art = pic.data;
        }
    }
    if (granuleRate > 0) {
        const tailLen = Math.min(fileSize, 96 * 1024);
        const tb = Buffer.alloc(tailLen);
        fs.readSync(fd, tb, 0, tailLen, fileSize - tailLen);
        let at = -1;
        for (let i = tb.length - 27; i >= 0; i--) {
            if (tb[i] === 0x4f && tb.toString('latin1', i, i + 4) === 'OggS') { at = i; break; }
        }
        if (at !== -1) {
            const granule = tb.readUInt32LE(at + 6) + tb.readUInt32LE(at + 10) * 4294967296;
            if (granule > 0) t.duration = Math.round(granule / granuleRate);
        }
    }
    return t;
}

// ---------------------------------------------------------------------------
// m4a/mp4: atom tree — moov.mvhd for duration, moov.udta.meta.ilst for tags
// (©nam/©ART/©alb/aART/©day/©gen/trkn/covr), like mutagen's mp4 module.
// ---------------------------------------------------------------------------

function readM4a(fd: number, fileSize: number): LocalTags | null {
    const probe = Buffer.alloc(12);
    fs.readSync(fd, probe, 0, 12, 0);
    if (probe.toString('latin1', 4, 8) !== 'ftyp') return null;
    const t = empty();
    // moov is usually small (metadata only); cap the read defensively
    const findAtom = (start: number, end: number, name: string): { at: number; size: number } | null => {
        let pos = start;
        while (pos + 8 <= end) {
            const ab = Buffer.alloc(8);
            if (fs.readSync(fd, ab, 0, 8, pos) < 8) return null;
            let size = ab.readUInt32BE(0);
            if (size === 1) { // 64-bit size
                const xb = Buffer.alloc(8);
                fs.readSync(fd, xb, 0, 8, pos + 8);
                size = xb.readUInt32BE(0) * 4294967296 + xb.readUInt32BE(4);
            }
            if (size < 8) return null;
            if (ab.toString('latin1', 4, 8) === name) return { at: pos, size };
            pos += size;
        }
        return null;
    };
    const moov = findAtom(0, fileSize, 'moov');
    if (!moov) return t;
    const moovEnd = moov.at + moov.size;
    const mb = Buffer.alloc(Math.min(moov.size, 24 * 1024 * 1024));
    fs.readSync(fd, mb, 0, mb.length, moov.at);
    const scan = (start: number, end: number, name: string): { at: number; size: number } | null => {
        let pos = start;
        while (pos + 8 <= end && pos + 8 <= mb.length) {
            let size = mb.readUInt32BE(pos);
            let head = 8;
            if (size === 1) { size = mb.readUInt32BE(pos + 8) * 4294967296 + mb.readUInt32BE(pos + 12); head = 16; }
            if (size < 8) return null;
            if (mb.toString('latin1', pos + 4, pos + 8) === name) return { at: pos + head, size: size - head };
            pos += size;
        }
        return null;
    };
    const mvhd = scan(8, mb.length, 'mvhd');
    if (mvhd) {
        const v = mb[mvhd.at];
        if (v === 1) {
            const ts = mb.readUInt32BE(mvhd.at + 20);
            const dur = mb.readUInt32BE(mvhd.at + 24) * 4294967296 + mb.readUInt32BE(mvhd.at + 28);
            if (ts > 0) t.duration = Math.round(dur / ts);
        } else {
            const ts = mb.readUInt32BE(mvhd.at + 12);
            const dur = mb.readUInt32BE(mvhd.at + 16);
            if (ts > 0) t.duration = Math.round(dur / ts);
        }
    }
    const udta = scan(8, mb.length, 'udta');
    if (!udta) return t;
    const meta = scan(udta.at, udta.at + udta.size, 'meta');
    if (!meta) return t;
    const ilst = scan(meta.at + 4, meta.at + meta.size, 'ilst'); // meta has 4 bytes version/flags
    if (!ilst) return t;
    let pos = ilst.at;
    const end = Math.min(ilst.at + ilst.size, mb.length);
    const M4A_KEYS: Record<string, 'title' | 'artist' | 'album' | 'albumArtist'> = { '©nam': 'title', '©ART': 'artist', '©alb': 'album', aART: 'albumArtist' };
    while (pos + 8 <= end) {
        const size = mb.readUInt32BE(pos);
        if (size < 8) break;
        const name = mb.toString('latin1', pos + 4, pos + 8);
        // child 'data' atom: 8 header + 4 type + 4 locale, then the payload
        const dataAt = pos + 16;
        const dataLen = mb.readUInt32BE(pos + 8) - 16;
        if (dataAt + 8 <= end && mb.toString('latin1', pos + 12, pos + 16) === 'data' && dataLen > 0 && dataAt + 8 + dataLen <= mb.length) {
            const payload = mb.subarray(dataAt + 8, dataAt + 8 + dataLen);
            const key = M4A_KEYS[name];
            if (key) t[key] = t[key] || payload.toString('utf8').trim();
            else if (name === '©day') t.year = t.year || Number(payload.toString('utf8').match(/\d{4}/)?.[0] || 0);
            else if (name === '©gen') { const g = payload.toString('utf8').trim(); if (g && !t.genre.length) t.genre = [g]; }
            else if (name === 'trkn' && payload.length >= 4) t.trackNum = t.trackNum || payload.readUInt16BE(2);
            else if (name === 'covr' && payload.length > 32 && !t.art) t.art = Buffer.from(payload);
        }
        pos += size;
    }
    return t;
}

function mergeMissing(into: LocalTags, from: LocalTags): void {
    if (!into.title) into.title = from.title;
    if (!into.artist) into.artist = from.artist;
    if (!into.album) into.album = from.album;
    if (!into.albumArtist) into.albumArtist = from.albumArtist;
    if (!into.year) into.year = from.year;
    if (!into.trackNum) into.trackNum = from.trackNum;
    if (!into.genre.length) into.genre = from.genre;
    if (!into.duration) into.duration = from.duration;
    if (!into.art) into.art = from.art;
}

export const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.ogg', '.opus', '.m4a', '.aiff', '.aif'];

/**
 * read tags + duration + embedded art from a local audio file. never throws;
 * missing/broken metadata falls back to a filename parse ("Artist - Title",
 * quodlibet-style title-from-filename as the last resort).
 */
export function readLocalTags(file: string): LocalTags {
    let t = empty();
    let fd = -1;
    try {
        fd = fs.openSync(file, 'r');
        const fileSize = fs.fstatSync(fd).size;
        const ext = path.extname(file).toLowerCase();
        const head = Buffer.alloc(12);
        fs.readSync(fd, head, 0, 12, 0);
        const magic4 = head.toString('latin1', 0, 4);

        if (magic4 === 'fLaC' || (ext === '.flac' && magic4 !== 'ID3')) {
            t = readFlac(fd, fileSize) || t;
        } else if (magic4 === 'RIFF') {
            t = readWav(fd, fileSize) || t;
        } else if (magic4 === 'FORM') {
            t = readAiff(fd, fileSize) || t;
        } else if (magic4 === 'OggS') {
            t = readOgg(fd, fileSize) || t;
        } else if (head.toString('latin1', 4, 8) === 'ftyp') {
            t = readM4a(fd, fileSize) || t;
        } else {
            // mp3 (or flac-with-id3): id3v2 header, then sniff what follows it
            let offset = 0;
            if (magic4.startsWith('ID3')) {
                const hb = Buffer.alloc(10);
                fs.readSync(fd, hb, 0, 10, 0);
                const tagLen = 10 + synchsafe(hb, 6);
                const tagBuf = Buffer.alloc(Math.min(tagLen, 48 * 1024 * 1024));
                fs.readSync(fd, tagBuf, 0, tagBuf.length, 0);
                const r = parseId3v2(tagBuf);
                if (r) { mergeMissing(t, r.tags); offset = r.tagSize; }
                const after = Buffer.alloc(4);
                fs.readSync(fd, after, 0, 4, offset);
                if (after.toString('latin1') === 'fLaC') {
                    const ft = readFlac(fd, fileSize);
                    if (ft) mergeMissing(t, ft);
                    offset = -1; // not an mp3
                }
            }
            if (offset >= 0) {
                if (!t.duration) t.duration = mp3Duration(fd, fileSize, offset);
                parseId3v1(fd, fileSize, t);
            }
        }
    } catch { /* unreadable: fall through to filename fallback */ }
    finally { if (fd !== -1) { try { fs.closeSync(fd); } catch { /* closed */ } } }

    if (!t.title) {
        const base = path.basename(file, path.extname(file)).replace(/_/g, ' ').trim();
        // "01 Artist - Title" / "Artist - Title" filename conventions
        const m = base.match(/^(?:\d{1,3}[\s.\-_]+)?(.+?)\s+-\s+(.+)$/);
        if (m && !t.artist) { t.artist = m[1].trim(); t.title = m[2].trim(); }
        else t.title = base || 'untitled';
    }
    return t;
}
