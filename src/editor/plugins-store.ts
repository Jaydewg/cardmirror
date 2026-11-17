/**
 * Per-plugin enabled flags — localStorage blob, pins-store style.
 * Install state (which plugins exist) lives on disk with main; this
 * store only remembers which ones the user switched on, which ones
 * auto-update (default on), and when each was last checked.
 */
import { settings } from './settings.js';

const STORAGE_KEY = 'pmd-plugins';

interface PluginsBlob {
  enabled: Record<string, boolean>;
  /** Per-plugin auto-update switch. Absent = on (the default). */
  autoUpdate: Record<string, boolean>;
  /** Epoch ms of the last background update check, per plugin. */
  lastUpdateCheck: Record<string, number>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function read(): PluginsBlob {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PluginsBlob>;
      if (parsed && typeof parsed === 'object' && isRecord(parsed.enabled)) {
        // Blobs written before auto-update existed have only `enabled`.
        return {
          enabled: parsed.enabled,
          autoUpdate: isRecord(parsed.autoUpdate) ? parsed.autoUpdate : {},
          lastUpdateCheck: isRecord(parsed.lastUpdateCheck) ? parsed.lastUpdateCheck : {},
        };
      }
    }
  } catch {
    /* fall through */
  }
  return { enabled: {}, autoUpdate: {}, lastUpdateCheck: {} };
}

function write(blob: PluginsBlob): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
  } catch {
    /* quota — non-fatal */
  }
}

export function isPluginEnabled(id: string): boolean {
  return read().enabled[id] === true;
}

export function setPluginEnabled(id: string, on: boolean): void {
  const blob = read();
  blob.enabled[id] = on;
  write(blob);
}

/** Whether background update checks may install this plugin's updates.
 *  On unless the user switched it off. */
export function isPluginAutoUpdate(id: string): boolean {
  return read().autoUpdate[id] !== false;
}

export function setPluginAutoUpdate(id: string, on: boolean): void {
  const blob = read();
  if (on) delete blob.autoUpdate[id];
  else blob.autoUpdate[id] = false;
  write(blob);
}

/** Epoch ms of the last background update check, or 0 for never. */
export function pluginLastUpdateCheck(id: string): number {
  const t = read().lastUpdateCheck[id];
  return typeof t === 'number' && Number.isFinite(t) ? t : 0;
}

export function setPluginLastUpdateCheck(id: string, at: number): void {
  const blob = read();
  blob.lastUpdateCheck[id] = at;
  write(blob);
}

/** Uninstall: forget the auto-update switch and check time, so a
 *  reinstall starts from the defaults. */
export function forgetPluginUpdateState(id: string): void {
  const blob = read();
  delete blob.autoUpdate[id];
  delete blob.lastUpdateCheck[id];
  write(blob);
}

/** Boot-time reconciliation against what is ACTUALLY installed on disk:
 *  drops enabled flags, `plugin:<id>` storage bags, and dot-namespaced
 *  key overrides for plugins whose install directory no longer exists
 *  (deleted outside the app, or an uninstall that predates this
 *  cleanup). Directory-absent is the one unambiguous signal — a plugin
 *  that merely FAILED TO LOAD is still installed, and pruning on that
 *  would wipe a user's keybindings over a transient error. Command ids
 *  are enforced to start with `<pluginId>.` at registration, and no
 *  static ribbon id contains a dot, so the prefix test is exact. */
export function reconcilePluginState(installedIds: ReadonlySet<string>): void {
  const blob = read();
  let changed = false;
  for (const map of [blob.enabled, blob.autoUpdate, blob.lastUpdateCheck]) {
    for (const id of Object.keys(map)) {
      if (!installedIds.has(id)) {
        delete map[id];
        changed = true;
      }
    }
  }
  if (changed) write(blob);
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('plugin:') && !installedIds.has(key.slice('plugin:'.length))) {
        stale.push(key);
      }
    }
    for (const key of stale) localStorage.removeItem(key);
  } catch {
    /* storage unavailable — nothing to prune */
  }
  const overrides = settings.get('ribbonKeyOverrides');
  const kept: Partial<Record<string, string | string[]>> = {};
  let dropped = 0;
  for (const [cmdId, key] of Object.entries(overrides)) {
    const dot = cmdId.indexOf('.');
    if (dot > 0 && !installedIds.has(cmdId.slice(0, dot))) {
      dropped++;
      continue;
    }
    if (key !== undefined) kept[cmdId] = key;
  }
  if (dropped > 0) settings.set('ribbonKeyOverrides', kept);
  // Custom ribbon buttons bound to a gone plugin's commands unconfigure the
  // same way (dot-prefix test — setting commands use `toggle:`/`cycle:`, no
  // dot, and static ribbon ids are dot-free).
  const customButtons = settings.get('ribbonCustomButtons');
  const keptButtons = customButtons.filter((b) => {
    const dot = b.command.indexOf('.');
    return dot <= 0 || installedIds.has(b.command.slice(0, dot));
  });
  if (keptButtons.length !== customButtons.length) {
    settings.set('ribbonCustomButtons', keptButtons);
  }
}
