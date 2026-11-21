/**
 * Plugin updates — one set of consent rules for both paths:
 *
 *  - The Plugins tab's "Check for updates" button (user-initiated:
 *    confirm, then ask about new permissions if any).
 *  - The background pass (`runPluginAutoUpdates`): about once a day per
 *    plugin, for plugins whose Auto-update switch is on. An update that
 *    asks for nothing new installs silently and takes effect next
 *    launch; one that asks for new permissions is NOT installed — it
 *    leaves a status-bar notice whose button opens the consent dialog.
 *
 * Main does the downloading (`pluginCheckUpdate`, `pluginInstallInspect`
 * stage the release in memory; nothing touches disk until
 * `pluginInstallCommit`). Main's installer re-checks the curated
 * allowlist on every inspect, so a repo dropped from the relay's list
 * stops updating too.
 */
import { getElectronHost } from './host/index.js';
import { isLiteBuild } from './lite.js';
import { permissionConsentDialog } from './plugin-permission-dialog.js';
import { getPluginPermissionPrefs } from './plugin-permission-requests.js';
import {
  ANY_HOST,
  consentedHosts,
  hostAllowed,
  sanitizeNetworkHosts,
  sanitizePermissionList,
  splitKnown,
} from './plugin-permissions.js';
import { setPluginConsent } from './plugin-registry.js';
import {
  isPluginAutoUpdate,
  pluginLastUpdateCheck,
  setPluginLastUpdateCheck,
} from './plugins-store.js';
import { settings } from './settings.js';
import { clearNotice, postNotice } from './status-notices.js';
import { showToast } from './toast.js';

/** The installed-plugin fields the update flow reads. */
export interface UpdatablePlugin {
  id: string;
  name: string;
  version: string;
  repo?: string;
  incompatible?: string;
  permissions?: string[];
  grantedPermissions?: string[];
  /** The hosts consented to with `net.fetch`. */
  grantedNetworkHosts?: string[];
}

interface StagedManifest {
  id: string;
  name: string;
  version: string;
  author?: string;
  permissions?: string[];
  permissionReasons?: Record<string, string>;
  networkHosts?: string[];
}

/** A release staged main-side, plus what its permissions mean for this
 *  user. `pending` must end in commit or discard. */
export interface StagedUpdate {
  pending: string;
  plugin: StagedManifest;
  ownerRepo: string;
  /** Granted now and still requested: carried over without asking. */
  kept: string[];
  /** Requested for the first time by this version: asked, ticked. */
  added: string[];
  /** Requested before, turned off by the user, and still askable
   *  (ask-again on, not blocked): listed unticked. */
  turnedOff: string[];
  /** New ids this build doesn't know: shown, never granted. */
  unknownNew: string[];
  /** The `net.fetch` hosts this version asks for (sanitized). */
  newHosts: string[];
  /** The hosts the installed version was granted. */
  priorHosts: string[];
}

export type UpdateOutcome =
  | { kind: 'updated'; version: string; granted: string[] }
  | { kind: 'declined' }
  | { kind: 'error'; error: string };

type Host = NonNullable<ReturnType<typeof getElectronHost>>;

/** Stage the latest release of `p.repo` and work out its permission
 *  diff against the current install. */
export async function stagePluginUpdate(
  host: Host,
  p: UpdatablePlugin,
): Promise<{ ok: true; staged: StagedUpdate } | { ok: false; error: string }> {
  const ins = (await host.pluginInstallInspect(p.repo ?? '')) as
    | {
        ok: true;
        pending: string;
        plugin: StagedManifest;
        ownerRepo: string;
        installedGranted?: string[];
        installedGrantedNetworkHosts?: string[];
      }
    | { ok: false; error: string }
    | undefined;
  if (!ins?.ok) return { ok: false, error: ins && 'error' in ins ? ins.error : 'unavailable' };
  const requested = sanitizePermissionList(ins.plugin?.permissions);
  const prior = sanitizePermissionList(ins.installedGranted ?? p.grantedPermissions);
  const priorHosts = sanitizeNetworkHosts(ins.installedGrantedNetworkHosts ?? p.grantedNetworkHosts);
  const newHosts = sanitizeNetworkHosts(ins.plugin?.networkHosts);
  // An update that adds hosts re-asks `net.fetch` (ticked, with the new
  // list): its old consent covered only the old sites. Counting it as
  // `added` also keeps the background pass from installing it silently.
  // Covered = the old grant already allowed it; "*" is covered only by
  // "*" (widening specific sites to any site is growth).
  const hostsGrew =
    prior.includes('net.fetch') &&
    newHosts.some((h) => (h === ANY_HOST ? !priorHosts.includes(ANY_HOST) : !hostAllowed(priorHosts, h)));
  const kept = prior.filter((x) => requested.includes(x) && !(hostsGrew && x === 'net.fetch'));
  const { known, unknown } = splitKnown(requested);
  // A permission the installed version already requested but isn't
  // granted was turned off by the user: re-asking it ticked would undo
  // that with one click, so it's listed UNticked, and only when the user
  // lets this plugin ask again and hasn't blocked it.
  const priorRequested = sanitizePermissionList(p.permissions);
  const prefs = getPluginPermissionPrefs(p.id);
  const added = known.filter(
    (x) => (!prior.includes(x) && !priorRequested.includes(x)) || (hostsGrew && x === 'net.fetch'),
  );
  const turnedOff = prefs.askAgain
    ? known.filter((x) => !prior.includes(x) && priorRequested.includes(x) && !prefs.blocked.includes(x))
    : [];
  const unknownNew = unknown.filter((x) => !prior.includes(x) && !priorRequested.includes(x));
  return {
    ok: true,
    staged: {
      pending: ins.pending,
      plugin: ins.plugin,
      ownerRepo: ins.ownerRepo,
      kept,
      added,
      turnedOff,
      unknownNew,
      newHosts,
      priorHosts,
    },
  };
}

/** Commit a staged update with the given grant and record the consent.
 *  `askedNetFetch`: `net.fetch` was in the consent dialog, so the hosts
 *  it showed are what was agreed to; otherwise the prior hosts carry over
 *  (∩ what this version asks for). */
async function commitStaged(
  host: Host,
  p: UpdatablePlugin,
  staged: StagedUpdate,
  granted: string[],
  askedNetFetch = false,
): Promise<UpdateOutcome> {
  const grantedHosts = consentedHosts(granted, staged.newHosts, {
    asked: askedNetFetch,
    priorHosts: staged.priorHosts,
  });
  const r = (await host.pluginInstallCommit(staged.pending, granted, grantedHosts)) as
    | { ok: true }
    | { ok: false; error: string }
    | undefined;
  if (!r?.ok) return { kind: 'error', error: r && 'error' in r ? r.error : 'unavailable' };
  setPluginConsent(p.id, granted, grantedHosts);
  return { kind: 'updated', version: staged.plugin.version, granted };
}

/**
 * Finish a staged update the user asked for. New permissions (and,
 * unticked, ones they turned off) get the consent dialog; declining
 * discards the staged release and leaves the installed version as is.
 * With nothing to ask, it commits what's already granted.
 */
export async function completeStagedUpdate(
  host: Host,
  p: UpdatablePlugin,
  staged: StagedUpdate,
): Promise<UpdateOutcome> {
  const asked = [...staged.added, ...staged.turnedOff];
  let granted = staged.kept;
  if (asked.length > 0) {
    const chosen = await permissionConsentDialog({
      mode: 'update',
      name: staged.plugin.name,
      version: staged.plugin.version,
      author: staged.plugin.author,
      ownerRepo: staged.ownerRepo,
      known: asked,
      unknown: staged.unknownNew,
      reasons: staged.plugin.permissionReasons,
      unchecked: staged.turnedOff,
      networkHosts: staged.newHosts,
    });
    if (!chosen) {
      await host.pluginInstallDiscard(staged.pending);
      return { kind: 'declined' };
    }
    // Only what stayed (or was) ticked; the rest stays off.
    granted = [...staged.kept, ...chosen.filter((x) => asked.includes(x))];
  }
  return commitStaged(host, p, staged, granted, asked.includes('net.fetch'));
}

// ── Background auto-update ────────────────────────────────────────────

/** Minimum time between background checks of one plugin. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let running = false;

/** The notice key for a plugin whose update waits on consent. */
const consentNoticeKey = (id: string): string => `plugin-update-consent:${id}`;

/**
 * One background pass over the installed plugins. Each plugin is
 * checked at most once per `AUTO_UPDATE_INTERVAL_MS` (failed checks
 * count, so an offline machine doesn't retry on every pass). Never
 * throws; failures only reach the console.
 */
export async function runPluginAutoUpdates(now: () => number = Date.now): Promise<void> {
  if (running) return;
  if (!settings.get('pluginsEnabled') || isLiteBuild()) return;
  const host = getElectronHost();
  if (!host?.pluginList) return;
  running = true;
  try {
    const installed = ((await host.pluginList()) as UpdatablePlugin[]) ?? [];
    const updated: string[] = [];
    for (const p of installed) {
      if (!p.repo || p.incompatible || !isPluginAutoUpdate(p.id)) continue;
      if (now() - pluginLastUpdateCheck(p.id) < AUTO_UPDATE_INTERVAL_MS) continue;
      setPluginLastUpdateCheck(p.id, now());
      try {
        const res = (await host.pluginCheckUpdate(p.id, p.repo)) as
          | { ok: true; latest: string; hasUpdate: boolean }
          | { ok: false; error: string }
          | undefined;
        if (!res?.ok) {
          console.warn(`[plugins] update check for ${p.id} failed:`, res && 'error' in res ? res.error : 'unavailable');
          continue;
        }
        if (!res.hasUpdate) continue;
        const st = await stagePluginUpdate(host, p);
        if (!st.ok) {
          console.warn(`[plugins] could not fetch the ${p.id} update:`, st.error);
          continue;
        }
        if (st.staged.added.length === 0) {
          // Nothing new to consent to: what's granted stays granted, a
          // permission the user turned off stays off (the shield turns
          // it back on), and ids this build doesn't know are never
          // granted.
          const out = await commitStaged(host, p, st.staged, st.staged.kept);
          if (out.kind === 'updated') {
            updated.push(`${p.name} v${out.version}`);
            clearNotice(consentNoticeKey(p.id));
          }
          else if (out.kind === 'error') console.warn(`[plugins] ${p.id} update failed:`, out.error);
          continue;
        }
        // New permissions need the user — don't install, ask.
        await host.pluginInstallDiscard(st.staged.pending);
        postNotice({
          severity: 'info',
          key: consentNoticeKey(p.id),
          title: 'Plugin update',
          body: `${p.name} v${st.staged.plugin.version} is available. It asks for new permissions, so it wasn’t installed automatically.`,
          actions: [{ label: 'Review update', run: () => void reviewUpdate(p) }],
        });
      } catch (err) {
        console.warn(`[plugins] auto-update of ${p.id} failed:`, err);
      }
    }
    if (updated.length > 0) {
      postNotice({
        severity: 'info',
        key: 'plugin-auto-updated',
        title: 'Plugins updated',
        body: `Updated ${updated.join(', ')}. Restart CardMirror to use the new version.`,
      });
    }
  } catch (err) {
    console.warn('[plugins] auto-update pass failed:', err);
  } finally {
    running = false;
  }
}

/** Drop a plugin's waiting-on-consent notice (it was updated, or
 *  uninstalled, some other way). */
export function clearPluginUpdateNotice(id: string): void {
  clearNotice(consentNoticeKey(id));
}

/** The notice's "Review update" button. Re-reads the install (it may
 *  have been updated or removed since the notice) and the latest
 *  release (it may have moved on), then runs the consent flow. */
async function reviewUpdate(noticed: UpdatablePlugin): Promise<void> {
  const host = getElectronHost();
  if (!host) return;
  const fail = (error: string): void =>
    postNotice({
      severity: 'warning',
      key: consentNoticeKey(noticed.id),
      title: 'Plugin update',
      body: `${noticed.name} couldn’t be updated: ${error}`,
    });
  try {
    const installed = ((await host.pluginList()) as UpdatablePlugin[]) ?? [];
    const p = installed.find((x) => x.id === noticed.id);
    if (!p?.repo) return;
    const res = (await host.pluginCheckUpdate(p.id, p.repo)) as
      | { ok: true; hasUpdate: boolean }
      | { ok: false; error: string }
      | undefined;
    if (!res?.ok) return fail(res && 'error' in res ? res.error : 'unavailable');
    if (!res.hasUpdate) {
      showToast(`${p.name} is up to date.`);
      return;
    }
    const st = await stagePluginUpdate(host, p);
    if (!st.ok) return fail(st.error);
    const out = await completeStagedUpdate(host, p, st.staged);
    if (out.kind === 'updated') {
      postNotice({
        severity: 'info',
        key: 'plugin-auto-updated',
        title: 'Plugins updated',
        body: `Updated ${p.name} v${out.version}. Restart CardMirror to use the new version.`,
      });
    } else if (out.kind === 'error') fail(out.error);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

/** Delay after boot before the first pass — keeps the network off the
 *  startup path. */
const FIRST_PASS_DELAY_MS = 30_000;
/** How often a long-running app re-runs the pass (each plugin is still
 *  checked at most once per `AUTO_UPDATE_INTERVAL_MS`). */
const PASS_EVERY_MS = 6 * 60 * 60 * 1000;
let scheduled = false;

/** Called once plugins have booted: first pass shortly after startup,
 *  then periodically so an app left open for days still updates. */
export function schedulePluginAutoUpdates(): void {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    void runPluginAutoUpdates();
    setInterval(() => void runPluginAutoUpdates(), PASS_EVERY_MS);
  }, FIRST_PASS_DELAY_MS);
}

/** Test hook. */
export function __resetPluginAutoUpdateForTests(): void {
  running = false;
  scheduled = false;
}
