/**
 * Live Session Link — a .cmir can carry its live co-editing link.
 *
 * Embedding (opt-in, per session): the "Embed live link in this file"
 * command (or the "sessions I host" setting) makes every working-copy
 * save of the session's doc write the session's EDIT share code into
 * the file's plugin data. Anyone who gets that file can join and edit
 * while the session lives, so the command asks first.
 *
 * Opening: a file carrying a link gets a quiet status-bar notice (never
 * a modal) offering Join, but only after a liveness probe says the
 * session hasn't ended. Dismissing it means "keep local"; the link stays
 * in the file. The same file + session is offered once per app run, so
 * reloads and crash recovery stay quiet.
 *
 * Servers: the link is a SESSION ADDRESS (`code@server`), so it reads
 * the same on federated and non-federated builds. A session on a server
 * this build can't reach is reported as such (never as "ended"), and the
 * link stays. On a CardMirror from before session addresses, the plugin
 * falls back to the plain code and never concludes "ended" (it can't
 * tell which server answered).
 *
 * Everything runs through the permission-gated plugin API; each missing
 * permission degrades one feature and the commands say why.
 */
import type {
  CardMirrorPluginApi,
  PluginDefinition,
  PluginDocContext,
  PluginProbeResult,
  PluginSaveResult,
  PluginSessionInfo,
} from '@cardmirror/plugin-api';
import {
  addressParts,
  linkKey,
  makeLinkData,
  parseLinkData,
  serverHost,
  sessionKey,
  type LinkData,
} from './link-data.js';

export const PLUGIN_ID = 'live-session-link';
export const PLUGIN_NAME = 'Live Session Link';
export const PLUGIN_PERMISSIONS = [
  'collab.join',
  'collab.probe',
  'collab.read',
  'collab.server',
  'collab.shareCode',
  'files.data',
  'ui.dialogs',
  'ui.notices',
];

/** Gzip-header / metadata notice. Never the code. */
export const LINK_SUMMARY = 'Contains a live co-editing link (Live Session Link plugin)';
export const LIST_CAP = 200;
/** Only the first notice in a burst this long flashes a toast. */
export const TOAST_BURST_MS = 10_000;
export const AUTO_EMBED_SETTING = 'autoEmbedHosted';

type ListKey = 'embedSessions' | 'optOutSessions' | 'endedSessions' | 'quietDocs';

const PERMISSION_LABELS: Record<string, string> = {
  'collab.join': 'Join co-editing sessions',
  'collab.probe': 'Check if a session is still live',
  'collab.read': 'See your live co-editing sessions',
  'collab.server': 'See which co-editing server you use',
  'collab.shareCode': 'Read your session share codes',
  'files.data': 'Store its own data in your documents',
  'ui.dialogs': 'Show dialogs',
  'ui.notices': 'Post notices in the status bar',
};

// ── Per-machine lists in api.storage ─────────────────────────────────

function readList(api: CardMirrorPluginApi, key: ListKey): string[] {
  const v = api.storage.get(key);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function inList(api: CardMirrorPluginApi, key: ListKey, value: string): boolean {
  return readList(api, key).includes(value);
}

/** Add (moving to newest); oldest entries fall off past LIST_CAP. */
function addToList(api: CardMirrorPluginApi, key: ListKey, value: string): void {
  const list = readList(api, key).filter((x) => x !== value);
  list.push(value);
  api.storage.set(key, list.slice(-LIST_CAP));
}

function removeFromList(api: CardMirrorPluginApi, key: ListKey, value: string): void {
  const list = readList(api, key);
  if (list.includes(value)) api.storage.set(key, list.filter((x) => x !== value));
}

/** A user-facing reason a permission-backed feature is missing. */
export function missingPermissionMessage(api: CardMirrorPluginApi, permission: string): string {
  const label = PERMISSION_LABELS[permission] ?? permission;
  const status = api.permissions?.status(permission);
  if (status === 'denied') {
    return `${PLUGIN_NAME} needs “${label}” for this. Allow it in Settings → Plugins.`;
  }
  if (status === 'unsupported' || status === undefined) {
    return `${PLUGIN_NAME} needs “${label}”, which this version of CardMirror doesn’t support. Update CardMirror to use it.`;
  }
  return `${PLUGIN_NAME} can’t do that right now (“${label}” is unavailable).`;
}

/** Does this CardMirror speak session addresses? A build knows
 *  `collab.server` exactly when it does (granted or not); older builds
 *  report it `unsupported`. */
export function hostSpeaksAddresses(api: CardMirrorPluginApi): boolean {
  const status = api.permissions?.status('collab.server');
  return status !== undefined && status !== 'unsupported';
}

/** What to hand probe / join: the address, or on an older build the
 *  plain code it can decode. */
function targetFor(api: CardMirrorPluginApi, link: LinkData): string {
  return hostSpeaksAddresses(api) ? link.address : addressParts(link.address)?.plainCode ?? link.address;
}

type LinkStatus = PluginProbeResult;

/** Liveness of a link's session. An older build checks only its own
 *  server, so its "ended" may mean "not on this server": unknown. */
async function probeLink(api: CardMirrorPluginApi, link: LinkData): Promise<LinkStatus> {
  const probe = api.collab?.probe;
  if (!probe) return 'unknown';
  const result = await probe(targetFor(api, link)).catch((): LinkStatus => 'unknown');
  if (result === 'ended' && !hostSpeaksAddresses(api)) return 'unknown';
  return result === 'live' || result === 'ended' || result === 'unreachable' ? result : 'unknown';
}

/** "on relay.b.example, which your co-editing server (relay.a.example)
 *  can't reach". Worded for every build: without federation no other
 *  server is reachable; with it, only servers linked to yours are. */
async function serverMismatchText(api: CardMirrorPluginApi, link: LinkData): Promise<string> {
  const here = await api.collab?.server?.().catch(() => null);
  const there = serverHost(link.server);
  return here
    ? `on ${there}, which your co-editing server (${here.host}) can’t reach`
    : `on ${there}, a co-editing server yours can’t reach`;
}

/** " It's on relay.b.example; its host may need to let you in." when
 *  the link's session is on another server this build reaches (a
 *  cross-server join asks the session's host first); else "". Decided
 *  from `reach`, never from what kind of build this is. */
async function otherServerNote(api: CardMirrorPluginApi, link: LinkData): Promise<string> {
  const collab = api.collab;
  if (!collab?.reach || !collab.server) return '';
  const here = await collab.server().catch(() => null);
  if (!here || here.url === link.server) return '';
  const reach = await collab.reach(link.server).catch(() => 'unknown');
  return reach === 'federated' ? ` It’s on ${serverHost(link.server)}; its host may need to let you in.` : '';
}

/** Who a saved copy's link lets in, by the session's `crossServer`
 *  state. A value this plugin doesn't know reads as `off` (the API's
 *  rule: never assume other servers can join). */
function embedScopeText(info: PluginSessionInfo): string {
  const host = info.server ? serverHost(info.server) : null;
  if (info.crossServer === 'federated') {
    return host
      ? ` People on servers linked to ${host} can join too, once the session’s host lets them in.`
      : ' People on linked servers can join too, once the session’s host lets them in.';
  }
  return host ? ` Only people on ${host} can join.` : '';
}

/** The address of a doc's live session, if this build can name it. */
function liveAddress(api: CardMirrorPluginApi, docUid?: string) {
  return addressParts(api.collab?.shareAddress?.(docUid) ?? null);
}

export function createLiveSessionLinkPlugin(): PluginDefinition {
  /** The newest api (re-minted on every grant change); notice buttons
   *  clicked later must act with the CURRENT grant, not the one they
   *  were posted with. */
  let liveApi: CardMirrorPluginApi | null = null;
  /** `docId|roomId` offered this app run — reload / recovery re-fires
   *  the open hook under a new doc uid; this keeps them quiet. */
  const offered = new Set<string>();
  let lastToastAt = Number.NEGATIVE_INFINITY;

  // ── Save ───────────────────────────────────────────────────────────

  function onSave(api: CardMirrorPluginApi, ctx: PluginDocContext): PluginSaveResult {
    const collab = api.collab;
    const info = collab?.current?.(ctx.docUid) ?? null;
    const stored = parseLinkData(api.files?.get(ctx.docUid));
    if (info && info.role !== 'spectator') {
      const live = liveAddress(api, ctx.docUid);
      // Name the session: its address, else (address unreadable) the
      // stored link when it is this room — enough to honor an opt-out.
      const key = live
        ? sessionKey(live.roomId, live.server)
        : stored && stored.roomId === info.roomId
          ? linkKey(stored)
          : null;
      if (!key) return undefined;
      if (inList(api, 'optOutSessions', key)) return null;
      const wanted =
        inList(api, 'embedSessions', key) || (info.role === 'host' && api.settings.get(AUTO_EMBED_SETTING) === true);
      // No address readable (permission revoked, older build): keep what
      // the file has rather than silently stripping a chosen link.
      if (!wanted || !live) return undefined;
      const at = stored && stored.address === live.address ? stored.embeddedAt : Date.now();
      const data = makeLinkData(live.address, info.title ?? ctx.title, at);
      return data ? { data, summary: LINK_SUMMARY } : undefined;
    }
    if (info) return undefined; // spectator seat: never touch the link
    // No live session here: the file is a local copy. Keep its link —
    // unless that session is known to have ended or the user opted out.
    if (!stored) return undefined;
    const key = linkKey(stored);
    if (inList(api, 'endedSessions', key) || inList(api, 'optOutSessions', key)) return null;
    return undefined;
  }

  // ── Join ───────────────────────────────────────────────────────────

  async function joinFromLink(link: LinkData, intoDoc: string | null): Promise<void> {
    const api = liveApi;
    if (!api) return;
    const join = api.collab?.join;
    if (!join) {
      api.showToast(missingPermissionMessage(api, 'collab.join'));
      return;
    }
    const outcome = await join(targetFor(api, link), intoDoc ? { intoDoc } : undefined);
    const current = liveApi ?? api;
    if (outcome === 'joined') {
      // The live copy keeps carrying the link when saved.
      addToList(current, 'embedSessions', linkKey(link));
    } else if (outcome === 'ended') {
      if (hostSpeaksAddresses(current)) {
        addToList(current, 'endedSessions', linkKey(link));
        current.showToast('That session has ended; the link will be removed the next time you save.');
      } else {
        current.showToast('Couldn’t join: that session has ended or is on a different co-editing server.');
      }
    } else if (outcome === 'unreachable') {
      current.showToast(`Can’t join: that session is ${await serverMismatchText(current, link)}. The link stays in the file.`);
    } else if (outcome === 'declined') {
      current.showToast('The session’s host declined your request to join. The link stays in the file.');
    }
    // Other outcomes: CardMirror already explained them.
  }

  // ── Open ───────────────────────────────────────────────────────────

  /** Only the first notice in a burst flashes a toast. */
  function toastNow(): boolean {
    const now = Date.now();
    const toast = now - lastToastAt >= TOAST_BURST_MS;
    if (toast) lastToastAt = now;
    return toast;
  }

  function quietAction(ctx: PluginDocContext) {
    return {
      label: 'Don’t ask for this file',
      run: () => {
        const a = liveApi;
        if (a && ctx.docId) addToList(a, 'quietDocs', ctx.docId);
      },
    };
  }

  async function onOpen(raw: unknown, ctx: PluginDocContext): Promise<void> {
    const api = liveApi;
    if (!api) return;
    const link = parseLinkData(raw);
    if (!link) return;
    const key = linkKey(link);
    const collab = api.collab;
    if (collab?.current?.(ctx.docUid)) return; // already live here
    if (ctx.docId && inList(api, 'quietDocs', ctx.docId)) return;
    if (inList(api, 'endedSessions', key)) return;
    const offerKey = `${ctx.docId ?? ctx.docUid}|${key}`;
    if (offered.has(offerKey)) return;
    offered.add(offerKey);
    // This machine held the session for this very file: CardMirror's own
    // Rejoin / Leave prompt covers it.
    if (ctx.docId && collab?.localRecord) {
      const rec = await collab.localRecord(link.roomId).catch(() => null);
      if (rec && rec.docId === ctx.docId) return;
    }
    const status = await probeLink(api, link);
    const current = liveApi ?? api;
    const sessionName = link.title ? `“${link.title}”` : 'a live co-editing session';
    if (status === 'ended') {
      addToList(current, 'endedSessions', key);
      current.notices?.post({
        key,
        title: `Session ended: “${ctx.title}”`,
        body: `The live session linked in “${ctx.title}” has ended. The link will be removed the next time you save.`,
        toast: false,
      });
      return;
    }
    if (status === 'unreachable') {
      // Not ended — just not reachable from here. Say where it is; the
      // link stays in the file for someone (or some build) that can.
      const where = await serverMismatchText(current, link);
      const body =
        `This file links to ${sessionName} ${where}. To join, use a co-editing server that can reach it, ` +
        `then run “${PLUGIN_NAME}: Join live session from this file”. The link stays in the file.`;
      if (!current.notices) {
        current.showToast(body);
        return;
      }
      current.notices.post({
        key,
        title: `Live session on another server: “${ctx.title}”`,
        body,
        toast: toastNow(),
        actions: [quietAction(ctx)],
      });
      return;
    }
    if (!current.collab?.join) return; // nothing to offer
    const elsewhere = await otherServerNote(current, link);
    if (!current.notices) {
      current.showToast(
        `“${ctx.title}” links to a live session. Run “${PLUGIN_NAME}: Join live session from this file” to join.` +
          elsewhere,
      );
      return;
    }
    current.notices.post({
      key,
      title: `Live session in “${ctx.title}”`,
      body:
        `This file links to ${sessionName}. Join replaces this view with the live copy; ` +
        'saving then writes the live copy back to this file. Dismiss to keep working locally.' +
        elsewhere +
        (status === 'unknown' ? ' (Couldn’t check whether it’s still live.)' : ''),
      toast: toastNow(),
      actions: [{ label: 'Join', run: () => void joinFromLink(link, ctx.docUid) }, quietAction(ctx)],
    });
  }

  // ── Commands ───────────────────────────────────────────────────────

  /** The focused doc's live session, or a toast saying why not. */
  function focusedSession(api: CardMirrorPluginApi): PluginSessionInfo | null {
    if (!api.collab?.current) {
      api.showToast(missingPermissionMessage(api, 'collab.read'));
      return null;
    }
    const info = api.collab.current();
    if (!info) api.showToast('This document isn’t in a live co-editing session.');
    return info;
  }

  async function embedCommand(api: CardMirrorPluginApi): Promise<void> {
    if (!api.files) {
      api.showToast(missingPermissionMessage(api, 'files.data'));
      return;
    }
    const info = focusedSession(api);
    if (!info) return;
    if (info.role === 'spectator') {
      api.showToast('You’re watching this session. Only participants can embed its edit link.');
      return;
    }
    if (!api.collab?.shareAddress) {
      api.showToast(
        api.collab?.shareCode
          ? `${PLUGIN_NAME} needs a newer CardMirror to embed links (one that names each session’s server).`
          : missingPermissionMessage(api, 'collab.shareCode'),
      );
      return;
    }
    const live = liveAddress(api);
    if (!live) {
      api.showToast('Couldn’t read this session’s share code.');
      return;
    }
    if (!api.ui) {
      api.showToast(missingPermissionMessage(api, 'ui.dialogs'));
      return;
    }
    const ok = await api.ui.confirm(
      'Anyone who gets a saved copy of this file can join and edit this session, until it ends.' + embedScopeText(info),
      { okLabel: 'Embed link' },
    );
    if (!ok) return;
    const key = sessionKey(live.roomId, live.server);
    removeFromList(api, 'optOutSessions', key);
    addToList(api, 'embedSessions', key);
    api.showToast('Added — save to write the link into the file.');
  }

  function stopCommand(api: CardMirrorPluginApi): void {
    const live = api.collab?.current?.() ? liveAddress(api) : null;
    const stored = parseLinkData(api.files?.get());
    const key = live ? sessionKey(live.roomId, live.server) : stored ? linkKey(stored) : null;
    if (!key) {
      api.showToast('This document has no live session link.');
      return;
    }
    removeFromList(api, 'embedSessions', key);
    addToList(api, 'optOutSessions', key);
    api.showToast('Removed — the link leaves the file the next time you save.');
  }

  async function joinCommand(api: CardMirrorPluginApi): Promise<void> {
    if (!api.files) {
      api.showToast(missingPermissionMessage(api, 'files.data'));
      return;
    }
    const doc = api.files.focusedDoc();
    const link = doc ? parseLinkData(api.files.get(doc.docUid)) : null;
    if (!doc || !link) {
      api.showToast('This document has no live session link.');
      return;
    }
    if (api.collab?.current?.(doc.docUid)) {
      api.showToast('This document is already in its live session.');
      return;
    }
    if (!api.collab?.join) {
      api.showToast(missingPermissionMessage(api, 'collab.join'));
      return;
    }
    // Running the command IS the confirmation; just don't knock on a
    // door known to be closed.
    const status = await probeLink(api, link);
    if (status === 'ended') {
      addToList(api, 'endedSessions', linkKey(link));
      api.showToast('That session has ended; the link will be removed the next time you save.');
      return;
    }
    if (status === 'unreachable') {
      api.showToast(`Can’t join: that session is ${await serverMismatchText(api, link)}. The link stays in the file.`);
      return;
    }
    removeFromList(api, 'endedSessions', linkKey(link));
    liveApi = api;
    await joinFromLink(link, doc.docUid);
  }

  return {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    apiVersion: 1,
    permissions: [...PLUGIN_PERMISSIONS],
    settings: [
      {
        key: AUTO_EMBED_SETTING,
        label: 'Always embed the link for sessions I host',
        type: 'boolean',
        default: false,
        description:
          'Every saved copy of a session you host then carries its edit link: anyone who gets the file can join and edit while the session lives.',
      },
    ],
    commands: [
      {
        id: `${PLUGIN_ID}.embed`,
        label: `${PLUGIN_NAME}: Embed live link in this file`,
        keywords: ['share code', 'session link', 'embed', 'co-editing'],
        run: embedCommand,
      },
      {
        id: `${PLUGIN_ID}.stop`,
        label: `${PLUGIN_NAME}: Stop embedding live link`,
        keywords: ['share code', 'session link', 'remove', 'co-editing'],
        run: stopCommand,
      },
      {
        id: `${PLUGIN_ID}.join`,
        label: `${PLUGIN_NAME}: Join live session from this file`,
        keywords: ['share code', 'session link', 'join', 'co-editing'],
        run: joinCommand,
      },
    ],
    activate(api) {
      liveApi = api;
      const files = api.files;
      if (!files) return undefined;
      const offSave = files.onSave((ctx) => onSave(liveApi ?? api, ctx));
      const offOpen = files.onOpen((data, ctx) => onOpen(data, ctx));
      return () => {
        offSave();
        offOpen();
      };
    },
  };
}
