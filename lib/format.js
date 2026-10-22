const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function relativeTime(ms, now = Date.now()) {
    const diff = Math.max(0, now - ms);
    if (diff < 45 * 1000)
        return 'just now';
    if (diff < HOUR)
        return `${Math.max(1, Math.round(diff / MINUTE))} min ago`;
    if (diff < DAY)
        return `${Math.round(diff / HOUR)} h ago`;

    const then = new Date(ms);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    if (then >= new Date(today.getTime() - DAY))
        return 'yesterday';
    if (diff < 7 * DAY)
        return `${Math.ceil(diff / DAY)} days ago`;
    return `${MONTHS[then.getMonth()]} ${then.getDate()}`;
}

export function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatCountdown(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const pad = n => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}
