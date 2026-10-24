/**
 * Remembers which media a Niimbot roll is, keyed by the barcode on its
 * RFID tag.
 *
 * Older heads (D110) answer the RFID query with barcode + counters but
 * no dimensions, and the paper-info query that newer models use to
 * report width/height comes back invalid. So the first print on a roll
 * teaches us its size (the media the user printed with), and every
 * later connection with the same roll type detects it.
 *
 * Per-browser convenience only: storage failures fall back to "not
 * remembered", never to an error.
 */
const STORAGE_KEY = 'burnmark.niimbot.roll-media';

function readAll(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function recallRollMedia(barcode: string): string | undefined {
  return readAll()[barcode];
}

export function rememberRollMedia(barcode: string, mediaId: string): void {
  try {
    const all = readAll();
    if (all[barcode] === mediaId) return;
    all[barcode] = mediaId;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Private mode / blocked storage — detection just won't persist.
  }
}
