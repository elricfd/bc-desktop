// minimal ID3v2.3 tag builder for stream downloads: Title / Artist / Album
// Artist / Album / Track number / Year / Lyrics / embedded cover. the tag is
// simply prepended to the mp3 bytes (players skip the tag to the first frame).

export interface Id3Tag {
    title: string;
    artist: string;
    albumArtist: string;
    album: string;
    trackNum: number;
    trackTotal?: number;
    year?: number;
    lyrics?: string;
    /** jpeg/png bytes for the embedded cover. */
    art?: Buffer;
    artMime?: string;
}

// utf-16le with BOM (text encoding 0x01), the safest for arbitrary unicode
function utf16(s: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
}
const UTF16_NULL = Buffer.from([0x00, 0x00]);

// v2.3 frame: 4-char id, 32-bit BE size (NOT synchsafe in 2.3), 2 flag bytes
function frame(id: string, body: Buffer): Buffer {
    const h = Buffer.alloc(10);
    h.write(id, 0, 'latin1');
    h.writeUInt32BE(body.length, 4);
    return Buffer.concat([h, body]);
}

function textFrame(id: string, value: string): Buffer {
    return frame(id, Buffer.concat([Buffer.from([0x01]), utf16(value)]));
}

// unsynchronised lyrics: enc, 3-char language, descriptor (utf16 + null), text
function lyricsFrame(lyrics: string): Buffer {
    return frame('USLT', Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from('eng', 'latin1'),
        utf16(''), UTF16_NULL,
        utf16(lyrics),
    ]));
}

// attached picture: enc, mime (latin1 + null), type 0x03 = front cover,
// description (utf16 + null), image bytes
function apicFrame(art: Buffer, mime: string): Buffer {
    return frame('APIC', Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from(mime, 'latin1'), Buffer.from([0x00]),
        Buffer.from([0x03]),
        utf16(''), UTF16_NULL,
        art,
    ]));
}

// the TAG HEADER size is synchsafe (7 bits per byte), unlike frame sizes
function synchsafe(n: number): Buffer {
    return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

export function buildId3v23(tag: Id3Tag): Buffer {
    const frames: Buffer[] = [];
    if (tag.title) frames.push(textFrame('TIT2', tag.title));
    if (tag.artist) frames.push(textFrame('TPE1', tag.artist));
    if (tag.albumArtist) frames.push(textFrame('TPE2', tag.albumArtist));
    if (tag.album) frames.push(textFrame('TALB', tag.album));
    if (tag.trackNum > 0) frames.push(textFrame('TRCK', tag.trackTotal ? `${tag.trackNum}/${tag.trackTotal}` : String(tag.trackNum)));
    if (tag.year) frames.push(textFrame('TYER', String(tag.year)));
    if (tag.lyrics) frames.push(lyricsFrame(tag.lyrics));
    if (tag.art && tag.art.length && tag.art.length < 8 * 1024 * 1024) {
        frames.push(apicFrame(tag.art, tag.artMime || 'image/jpeg'));
    }
    const body = Buffer.concat(frames);
    const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([0x03, 0x00, 0x00]), synchsafe(body.length)]);
    return Buffer.concat([header, body]);
}
