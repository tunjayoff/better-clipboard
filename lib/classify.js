// Decides what kind of text was copied. Kept free of GI imports so it can be
// unit-tested with plain gjs.

const URL_RE = /^(https?:\/\/|mailto:)[^\s]+$/i;

const SHELL_START_RE = new RegExp(
    '^(\\$ |sudo |git |cd |ls |npm |npx |pnpm |yarn |bun |deno |node |docker |podman |kubectl |' +
    'cargo |rustc |go |pip3? |python3? |paru |yay |pacman |flatpak |systemctl |journalctl |' +
    'curl |wget |ssh |scp |rsync |cp |mv |rm |mkdir |chmod |chown |echo |export |source |' +
    'gsettings |gnome-extensions |make |cmake |meson |ninja |gcc |clang |tar |grep |find |sed |awk )');

const CODE_LINE_RE = /^\s*(import |export |from \S+ import |const |let |var |function |class |def |fn |pub |#include|#!\/|package |func |return |if \(|for \(|while \(|<\/?[a-z][\w-]*[\s>])/;

/**
 * @param {string} text
 * @returns {'link' | 'code' | 'text'}
 */
export function classifyText(text) {
    const trimmed = text.trim();
    if (!trimmed.includes('\n') && URL_RE.test(trimmed))
        return 'link';

    const lines = trimmed.split('\n');

    if (lines.length === 1)
        return SHELL_START_RE.test(trimmed) ? 'code' : 'text';

    if (/^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed))
        return 'code';

    let score = 0;
    for (const line of lines) {
        if (/^( {2,}|\t)\S/.test(line))
            score += 1;
        if (/[;{}]\s*$/.test(line))
            score += 1;
        if (CODE_LINE_RE.test(line) || SHELL_START_RE.test(line.trim()))
            score += 2;
    }
    return score >= Math.max(2, lines.length * 0.6) ? 'code' : 'text';
}

/** A one-line label for the list. */
export function firstLine(text, max = 160) {
    const line = text.trim().split('\n').find(l => l.trim().length > 0) ?? '';
    const clean = line.replace(/\s+/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

export function domainOf(url) {
    const m = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
    if (m)
        return m[1].replace(/^www\./, '');
    return url.replace(/^mailto:/i, '');
}
