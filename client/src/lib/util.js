import { localDate, addDays } from '@shared/dates.js';

/** Random v4 UUID; crypto.randomUUID needs HTTPS, getRandomValues does not. */
export function uuid() {
  try {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    // fall through
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const time = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** "6:40 pm", "Yesterday 6:40 pm", "Mon 16 Nov 6:40 pm" */
export function whenLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const day = localDate(d);
  const today = localDate();
  if (day === today) return time(d);
  if (day === addDays(today, -1)) return `Yesterday ${time(d)}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time(d)}`;
}

export function dayLabel(dateStr) {
  const today = localDate();
  if (dateStr === today) return 'Today';
  if (dateStr === addDays(today, -1)) return 'Yesterday';
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

export const pts = (n) => `${n} ${Math.abs(n) === 1 ? 'pt' : 'pts'}`;

export function joinNames(names) {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
