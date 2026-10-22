import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const MAX_BYTES = 128 * 1024;
const CHUNK = 16 * 1024;

const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' '};

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
        if (code[0] === '#') {
            const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) ? String.fromCodePoint(n) : match;
        }
        return ENTITIES[code.toLowerCase()] ?? match;
    });
}

/** Reads just enough of an HTML page to find its <title>. */
export class LinkTitleFetcher {
    constructor() {
        this._session = new Soup.Session({
            timeout: 8,
            user_agent: 'Mozilla/5.0 (X11; Linux x86_64) BetterClipboard/1',
        });
        this._cancellable = new Gio.Cancellable();
    }

    async fetch(url) {
        if (!/^https?:\/\//i.test(url))
            return null;

        let message;
        try {
            message = Soup.Message.new('GET', url);
        } catch {
            return null;
        }
        if (!message)
            return null;

        const stream = await new Promise((resolve, reject) => {
            this._session.send_async(message, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                try {
                    resolve(s.send_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        try {
            const type = message.get_response_headers().get_content_type()[0] ?? '';
            if (message.get_status() !== Soup.Status.OK || !type.includes('html'))
                return null;

            // GJS's TextDecoder can't stream, so keep the raw chunks and decode
            // the whole prefix each time.
            const decoder = new TextDecoder('utf-8');
            const chunks = [];
            let html = '';
            for (let read = 0; read < MAX_BYTES; read += CHUNK) {
                // eslint-disable-next-line no-await-in-loop
                const bytes = await new Promise((resolve, reject) => {
                    stream.read_bytes_async(CHUNK, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                        try {
                            resolve(s.read_bytes_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    });
                });
                if (bytes.get_size() === 0)
                    break;
                chunks.push(new Uint8Array(bytes.toArray()));
                const all = new Uint8Array(chunks.reduce((n, ch) => n + ch.length, 0));
                chunks.reduce((offset, ch) => {
                    all.set(ch, offset);
                    return offset + ch.length;
                }, 0);
                html = decoder.decode(all);
                if (/<\/title>/i.test(html))
                    break;
            }

            const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
            if (!match)
                return null;
            const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
            return title.length > 0 ? title.slice(0, 200) : null;
        } finally {
            stream.close_async(GLib.PRIORITY_LOW, null, null);
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
    }
}
