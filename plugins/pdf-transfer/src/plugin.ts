/**
 * PDF Export & Import. Two commands, both carried out by the CardMirror
 * PDF companion app (see ../companion), which this plugin drives over
 * `flowPost`:
 *
 *   - Export to PDF: reads the focused document with its formatting
 *     (`doc.read`) and hands it to the companion, which asks where to
 *     save, prints it with Chromium, and (as a Hybrid PDF, when the
 *     setting is on) embeds the document for exact re-import.
 *   - Import PDF: asks where the PDF should go (the focused document or a
 *     new one), then the companion asks for the file, rebuilds cards from
 *     it, and inserts them through CardMirror's /insert route, or writes a
 *     .cmir and opens it.
 *
 * The plugin never touches files itself: it only uses the plugin API.
 */
import type { CardMirrorPluginApi, PluginDefinition } from '@cardmirror/plugin-api';
import {
  COMPANION_APP_ID,
  FINAL_STATES,
  PROTOCOL_VERSION,
  type ExportRequest,
  type ImportRequest,
  type PageSize,
  type StartResponse,
  type StatusResponse,
} from './protocol.js';

export const PLUGIN_ID = 'pdf-transfer';
export const PLUGIN_NAME = 'PDF Export & Import';
/** Must equal `permissions` in cardmirror-plugin.json (a test checks). */
export const PLUGIN_PERMISSIONS = ['doc.read', 'ui.dialogs'];

export const SETTING_HYBRID = 'hybrid';
export const SETTING_PAGE_SIZE = 'pageSize';

/** How often to ask the companion how a job is going, and for how long. */
export const POLL_MS = 750;
export const POLL_LIMIT_MS = 60 * 60 * 1000;

const COMPANION_NAME = 'CardMirror PDF';

/** Test seam: the plugin's clock. */
export interface PluginTiming {
  sleep(ms: number): Promise<void>;
  now(): number;
}
const realTiming: PluginTiming = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/** Whether the companion is installed and running; tells the user when not. */
async function companionReady(api: CardMirrorPluginApi): Promise<boolean> {
  const apps = await api.flowApps();
  const app = apps.find((a) => a.id === COMPANION_APP_ID);
  if (!app) {
    api.showToast(`${PLUGIN_NAME} needs the ${COMPANION_NAME} app. Install it and start it, then try again.`);
    return false;
  }
  if (!app.running) {
    api.showToast(`Start the ${COMPANION_NAME} app, then try again.`);
    return false;
  }
  return true;
}

function explainTransport(api: CardMirrorPluginApi, error: string): void {
  if (error === 'unsupported') api.showToast(`${PLUGIN_NAME} works in the CardMirror desktop app only.`);
  else if (error === 'no-such-app' || error === 'app-not-running')
    api.showToast(`Start the ${COMPANION_NAME} app, then try again.`);
  else api.showToast(`${COMPANION_NAME} didn't answer (${error}). Try again.`);
}

/** Start a job with one POST; null (after telling the user) on failure. */
async function startJob(
  api: CardMirrorPluginApi,
  route: '/export' | '/import',
  body: ExportRequest | ImportRequest,
): Promise<string | null> {
  const r = await api.flowPost(COMPANION_APP_ID, route, body);
  if (!r.ok) {
    explainTransport(api, r.error);
    return null;
  }
  const res = r.body as StartResponse | null;
  if (res && res.ok === true && typeof res.job === 'string') return res.job;
  const error = res && res.ok === false ? res.error : 'bad-response';
  if (error === 'busy') api.showToast(`${COMPANION_NAME} is still busy with another file.`);
  else if (error === 'unsupported-version')
    api.showToast(`${COMPANION_NAME} is older than this plugin. Update it, then try again.`);
  else api.showToast(`${COMPANION_NAME} couldn't start (${error}).`);
  return null;
}

/** Poll a job to its end and tell the user how it went. */
export async function followJob(
  api: CardMirrorPluginApi,
  job: string,
  timing: PluginTiming = realTiming,
): Promise<StatusResponse> {
  const start = timing.now();
  for (;;) {
    const r = await api.flowPost(COMPANION_APP_ID, '/status', { v: PROTOCOL_VERSION, job });
    if (!r.ok) {
      explainTransport(api, r.error);
      return { ok: false, error: 'no-such-job' };
    }
    const s = r.body as StatusResponse | null;
    if (!s || s.ok !== true) {
      api.showToast(`${COMPANION_NAME} lost track of the job. Try again.`);
      return s ?? { ok: false, error: 'bad-request' };
    }
    if (FINAL_STATES.includes(s.state)) {
      if (s.state !== 'cancelled' && s.message) api.showToast(s.message);
      return s;
    }
    if (timing.now() - start > POLL_LIMIT_MS) {
      api.showToast(`Stopped waiting for ${COMPANION_NAME}.`);
      return s;
    }
    await timing.sleep(POLL_MS);
  }
}

function pageSize(api: CardMirrorPluginApi): PageSize {
  return api.settings.get(SETTING_PAGE_SIZE) === 'A4' ? 'A4' : 'Letter';
}

function needsReadPermission(api: CardMirrorPluginApi): void {
  const status = api.permissions?.status('doc.read');
  api.showToast(
    status === 'denied'
      ? `${PLUGIN_NAME} needs “Read your open documents”. Allow it in Settings → Plugins.`
      : `${PLUGIN_NAME} needs a newer CardMirror.`,
  );
}

export async function exportPdf(api: CardMirrorPluginApi, timing?: PluginTiming): Promise<void> {
  if (!api.doc?.read) return needsReadPermission(api);
  const snapshot = api.doc.read(undefined, { formatting: true });
  if (!snapshot) {
    api.showToast('Open a document to export it.');
    return;
  }
  if (snapshot.outline.length === 0 && snapshot.cards.length === 0) {
    api.showToast('This document has no headings or cards to export.');
    return;
  }
  if (snapshot.cards.length > 0 && snapshot.cards[0]!.formatting === undefined) {
    // An older CardMirror: export anyway, as plain text.
    api.showToast('This CardMirror is too old to export highlighting. Exporting plain text.');
  }
  if (!(await companionReady(api))) return;
  const job = await startJob(api, '/export', {
    v: PROTOCOL_VERSION,
    title: snapshot.title,
    snapshot,
    pageSize: pageSize(api),
    hybrid: api.settings.get(SETTING_HYBRID) === true,
  });
  if (job) await followJob(api, job, timing);
}

/** Where an import goes: the focused doc (`insert`), a new doc, or nowhere. */
async function chooseDestination(
  api: CardMirrorPluginApi,
): Promise<{ mode: 'insert'; target: string } | { mode: 'new' } | null> {
  const snapshot = api.doc?.read?.() ?? null;
  if (!snapshot) return { mode: 'new' };
  if (!api.ui) {
    // No dialogs: the safe choice never touches an open document.
    return { mode: 'new' };
  }
  const hasContent = snapshot.outline.length > 0 || snapshot.cards.length > 0;
  const newDoc = {
    value: 'new',
    label: 'New document',
    description: 'Saved as a .cmir next to the PDF, then opened.',
  };
  const insert = {
    value: 'insert',
    label: hasContent ? `Add to “${snapshot.title}”` : `Into “${snapshot.title}”`,
    description: hasContent ? 'It already has content: the cards go in at the cursor.' : 'This document is empty.',
  };
  const choice = await api.ui.choose({
    message: 'Where should the PDF go?',
    // The safe choice comes first when the open document has content.
    choices: hasContent ? [newDoc, insert] : [insert, newDoc],
  });
  if (choice === 'new') return { mode: 'new' };
  if (choice === 'insert') return { mode: 'insert', target: snapshot.docUid };
  return null;
}

export async function importPdf(api: CardMirrorPluginApi, timing?: PluginTiming): Promise<void> {
  if (!(await companionReady(api))) return;
  const dest = await chooseDestination(api);
  if (!dest) return;
  const job = await startJob(api, '/import', { v: PROTOCOL_VERSION, ...dest });
  if (job) await followJob(api, job, timing);
}

export function createPlugin(): PluginDefinition {
  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    permissions: [...PLUGIN_PERMISSIONS],
    permissionReasons: {
      'doc.read': 'To read the document, with its highlighting, when you export it to PDF.',
      'ui.dialogs': 'To ask whether an imported PDF goes into this document or a new one.',
    },
    settings: [
      {
        key: SETTING_HYBRID,
        label: 'Hybrid PDF',
        type: 'boolean',
        default: false,
        description:
          'Embed the document in exported PDFs, so importing them back is exact. Anyone with the PDF can extract it.',
      },
      {
        key: SETTING_PAGE_SIZE,
        label: 'Page size',
        type: 'select',
        default: 'Letter',
        options: ['Letter', 'A4'],
      },
    ],
    commands: [
      {
        id: `${PLUGIN_ID}.export`,
        label: 'Export to PDF',
        keywords: ['pdf', 'print', 'save', 'export'],
        run: (api) => exportPdf(api),
      },
      {
        id: `${PLUGIN_ID}.import`,
        label: 'Import PDF',
        keywords: ['pdf', 'open', 'import'],
        run: (api) => importPdf(api),
      },
    ],
  };
}
