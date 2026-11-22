/**
 * The wire contract between the plugin (inside CardMirror) and the
 * CardMirror PDF companion app. The plugin reaches the companion only
 * through `api.flowPost(COMPANION_APP_ID, route, body)`, which CardMirror
 * brokers over the cardmirror-bridge handshake, so this file is the
 * whole interface. The companion imports it too.
 *
 * `flowPost` gives up after a few seconds, while the companion's work
 * waits on file dialogs. So `/export` and `/import` only START a job and
 * answer at once with its id; the plugin then polls `/status`.
 *
 * Every body carries `v` (the protocol version). The companion answers a
 * newer `v` it doesn't know with `{ ok: false, error: 'unsupported-version' }`.
 */
import type { PluginDocSnapshot } from '@cardmirror/plugin-api';

/** The companion's id in the cardmirror-bridge directory. */
export const COMPANION_APP_ID = 'cardmirror-pdf';
export const PROTOCOL_VERSION = 1;

export type PageSize = 'Letter' | 'A4';

/** POST /export */
export interface ExportRequest {
  v: number;
  /** The document's title, for the default file name and PDF metadata. */
  title: string;
  /** `doc.read(…, { formatting: true })`; formatting may be missing on old builds. */
  snapshot: PluginDocSnapshot;
  pageSize: PageSize;
  /** Embed the snapshot as `cardmirror-doc.json` (a Hybrid PDF). */
  hybrid: boolean;
}

/** POST /import */
export interface ImportRequest {
  v: number;
  /** `insert`: into the open document `target`. `new`: write a .cmir and open it. */
  mode: 'insert' | 'new';
  /** The document's session uid (`PluginDocSnapshot.docUid`); `insert` only. */
  target?: string;
}

/** POST /status */
export interface StatusRequest {
  v: number;
  job: string;
}

export type StartResponse =
  | { ok: true; job: string }
  | { ok: false; error: 'busy' | 'bad-request' | 'unsupported-version' };

/** `choosing`: a file dialog is open. `working`: rendering or reading.
 *  The rest are final. */
export type JobState = 'choosing' | 'working' | 'done' | 'cancelled' | 'failed';

export const FINAL_STATES: readonly JobState[] = ['done', 'cancelled', 'failed'];

export type StatusResponse =
  | {
      ok: true;
      state: JobState;
      /** A sentence for the user (set on `done` and `failed`). */
      message?: string;
      /** The file written, when there is one. */
      path?: string;
    }
  | { ok: false; error: 'no-such-job' | 'bad-request' | 'unsupported-version' };
