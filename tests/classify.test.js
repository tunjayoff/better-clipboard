// Run with: gjs -m tests/classify.test.js
import {classifyText, domainOf, firstLine} from '../lib/classify.js';
import {formatCountdown, relativeTime} from '../lib/format.js';

let failed = 0;
function eq(actual, expected, name) {
    if (actual !== expected) {
        failed++;
        print(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

eq(classifyText('https://extensions.gnome.org/about/'), 'link', 'url');
eq(classifyText('mailto:someone@example.org'), 'link', 'mailto');
eq(classifyText('see https://example.org for more'), 'text', 'url inside sentence');
eq(classifyText('git rebase -i HEAD~3'), 'code', 'shell command');
eq(classifyText('docker compose up -d --build'), 'code', 'docker command');
eq(classifyText('Merhaba, toplantı Perşembe 14:00’te.'), 'text', 'sentence');
eq(classifyText('{\n  "uuid": "x",\n  "name": "y"\n}'), 'code', 'json');
eq(classifyText('const a = 1;\nconst b = 2;\nexport default a + b;'), 'code', 'js');
eq(classifyText('First line of a note.\nSecond line of the note.\nThird.'), 'text', 'multi-line prose');
eq(classifyText('def main():\n    print("hi")\n    return 0'), 'code', 'python');

eq(firstLine('\n\n  hello   world \nsecond'), 'hello world', 'first line');
eq(domainOf('https://www.gnome.org/foo'), 'gnome.org', 'domain');

const now = Date.UTC(2026, 9, 22, 12, 0, 0);
eq(relativeTime(now - 10 * 1000, now), 'just now', 'just now');
eq(relativeTime(now - 4 * 60 * 1000, now), '4 min ago', 'minutes');
eq(relativeTime(now - 3 * 3600 * 1000, now), '3 h ago', 'hours');
eq(formatCountdown(899), '14:59', 'countdown');
eq(formatCountdown(3725), '1:02:05', 'countdown hours');

print(failed === 0 ? 'All tests passed' : `${failed} test(s) failed`);
if (failed > 0)
    imports.system.exit(1);
