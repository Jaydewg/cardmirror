/**
 * Per-plugin data carried in a `.cmir` envelope (`"plugins"` field).
 *
 *   "plugins": {
 *     "<pluginId>": { "name": "Display Name", "data": <JSON>, "summary": "notice" }
 *   }
 *
 * Written by plugins holding the `files.data` permission (through the
 * editor's save hooks), and KEPT across every save — including saves on
 * machines where that plugin isn't installed — so a file passed around
 * never silently loses another plugin's data. Old CardMirror builds
 * ignore the field (and drop it if they re-save).
 *
 * `summary` is a short human-readable notice (never secrets). Core also
 * writes the summaries into the gzip header comment, where generic tools
 * (`exiftool`, `7z l -slt`) can see them without unpacking the file.
 *
 * DOM-free: node tooling imports the native module.
 */

export interface PluginFileEntry {
  /** The plugin's display name, for "data from X, which isn't
   *  installed" notices on machines without it. */
  name: string;
  /** The plugin's own JSON payload. */
  data: unknown;
  /** Optional ASCII notice, shown in metadata readers. */
  summary?: string;
}

export type PluginFileBag = Record<string, PluginFileEntry>;

/** Plugin ids — same shape the registry enforces. */
export const PLUGIN_DATA_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Serialized JSON budget per plugin entry. */
export const PLUGIN_DATA_MAX_BYTES = 64 * 1024;
export const PLUGIN_DATA_MAX_ENTRIES = 32;
export const PLUGIN_NAME_MAX = 100;
export const PLUGIN_SUMMARY_MAX = 200;

/** Printable ASCII only (gzip header comments are Latin-1, NUL-ended),
 *  whitespace collapsed, capped. Empty → undefined. */
export function sanitizeSummary(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const ascii = raw
    .replace(/[^\x20-\x7e]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PLUGIN_SUMMARY_MAX);
  return ascii || undefined;
}

/** Validate one entry; null when it must be dropped. */
export function sanitizePluginEntry(raw: unknown): PluginFileEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['name'] !== 'string' || !r['name'].trim()) return null;
  if (!('data' in r) || r['data'] === undefined) return null;
  let json: string;
  try {
    json = JSON.stringify(r['data']);
  } catch {
    return null; // cycles, BigInt…
  }
  if (json === undefined || json.length > PLUGIN_DATA_MAX_BYTES) return null;
  const entry: PluginFileEntry = {
    name: r['name'].trim().slice(0, PLUGIN_NAME_MAX),
    // Round-trip: the stored value is plain JSON, detached from the
    // caller's live objects.
    data: JSON.parse(json) as unknown,
  };
  const summary = sanitizeSummary(r['summary']);
  if (summary) entry.summary = summary;
  return entry;
}

/** Validate a whole bag (from a file or from save hooks). Bad ids and
 *  bad entries are dropped individually; never throws. */
export function sanitizePluginBag(raw: unknown): PluginFileBag {
  const out: PluginFileBag = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  let n = 0;
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= PLUGIN_DATA_MAX_ENTRIES) break;
    if (!PLUGIN_DATA_ID_RE.test(id)) continue;
    const entry = sanitizePluginEntry(value);
    if (!entry) continue;
    out[id] = entry;
    n++;
  }
  return out;
}

/** The gzip header comment for a bag: its summaries, or undefined when
 *  no entry has one. */
export function gzipCommentForBag(bag: PluginFileBag | undefined): string | undefined {
  if (!bag) return undefined;
  const parts = Object.keys(bag)
    .sort()
    .map((id) => bag[id]!.summary)
    .filter((s): s is string => !!s);
  return parts.length > 0 ? `CardMirror: ${parts.join(' | ')}` : undefined;
}
