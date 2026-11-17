/**
 * Just-in-time permission requests (`api.permissions.request`): when a
 * plugin may prompt, and the user's standing answers.
 *
 * WHEN. A prompt needs a recent trigger for THAT plugin: the user acted
 * on it (ran one of its commands, clicked its menu item or a notice
 * button, used its panel) or a permission-gated event reached it (a
 * file it can read opened, the focused document changed). Each trigger
 * opens a short window; a request outside every window resolves
 * `denied` without a prompt, so a plugin can't prompt from a timer.
 * High-frequency events (typing, selection, saves) never open a window.
 * One prompt at a time, app-wide.
 *
 * ANSWERS. "Not now" to a prompt an EVENT triggered keeps event-
 * triggered prompts for that permission quiet until CardMirror restarts
 * (opening ten files can't mean ten prompts); a prompt the user's own
 * action triggered may still appear. "Don't ask again" blocks the
 * permission until the user unblocks it in Settings → Plugins (the
 * shield). The per-plugin "ask again" switch (default on) turns off
 * every request prompt and update re-ask for permissions the user turned
 * off.
 *
 * Prefs live in localStorage (per machine, shared by this app's
 * windows). They're consent bookkeeping, not a sandbox: plugins run in
 * the renderer's main world (see plugin-permissions.ts).
 */

/** How long a trigger lets the plugin prompt. */
export const REQUEST_WINDOW_MS = 10_000;

export type ActivationKind = 'user' | 'event';

interface Activation {
  at: number;
  kind: ActivationKind;
}

const activations = new Map<string, Activation>();
/** `pluginId|permission` answered "Not now" to an event-triggered prompt. */
const quietForEvents = new Set<string>();
let promptOpen = false;

/** A trigger reached `pluginId`. A user action always wins over an event
 *  inside the same window (it's the stronger signal). */
export function notePluginActivation(pluginId: string, kind: ActivationKind, now = Date.now()): void {
  const prev = activations.get(pluginId);
  const keepUser = kind === 'event' && prev?.kind === 'user' && now - prev.at <= REQUEST_WINDOW_MS;
  activations.set(pluginId, { at: now, kind: keepUser ? 'user' : kind });
}

/** Why a request may or may not prompt right now. */
export type PromptGate = { ok: true; kind: ActivationKind } | { ok: false };

export function promptGate(pluginId: string, permission: string, now = Date.now()): PromptGate {
  if (promptOpen) return { ok: false };
  const a = activations.get(pluginId);
  if (!a || now - a.at > REQUEST_WINDOW_MS) return { ok: false };
  if (a.kind === 'event' && quietForEvents.has(`${pluginId}|${permission}`)) return { ok: false };
  return { ok: true, kind: a.kind };
}

/** Hold the single prompt slot while `show` runs. */
export async function withPromptSlot<T>(show: () => Promise<T>): Promise<T> {
  promptOpen = true;
  try {
    return await show();
  } finally {
    promptOpen = false;
  }
}

/** "Not now" to an event-triggered prompt. */
export function quietEventPrompts(pluginId: string, permission: string): void {
  quietForEvents.add(`${pluginId}|${permission}`);
}

// ── Standing prefs ────────────────────────────────────────────────────

const PREFS_KEY = 'cm-plugin-permission-prefs';

export interface PluginPermissionPrefs {
  /** May the plugin ask again for permissions the user turned off
   *  (request prompts, and update re-asks)? Default true. */
  askAgain: boolean;
  /** Permissions answered "Don't ask again", sorted. */
  blocked: string[];
}

type StoredPrefs = Record<string, { askAgain?: boolean; blocked?: string[] }>;

function readAll(): StoredPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as StoredPrefs) : {};
  } catch {
    return {};
  }
}

function writeAll(all: StoredPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* quota / storage off — the prefs just don't persist */
  }
}

export function getPluginPermissionPrefs(pluginId: string): PluginPermissionPrefs {
  const e = readAll()[pluginId];
  const blocked = Array.isArray(e?.blocked) ? e.blocked.filter((x): x is string => typeof x === 'string') : [];
  return { askAgain: e?.askAgain !== false, blocked: [...new Set(blocked)].sort() };
}

export function setPluginPermissionPrefs(pluginId: string, prefs: PluginPermissionPrefs): void {
  const all = readAll();
  const blocked = [...new Set(prefs.blocked)].sort();
  if (prefs.askAgain && blocked.length === 0) delete all[pluginId];
  else all[pluginId] = { askAgain: prefs.askAgain, blocked };
  writeAll(all);
}

export function blockPluginPermission(pluginId: string, permission: string): void {
  const prefs = getPluginPermissionPrefs(pluginId);
  setPluginPermissionPrefs(pluginId, { ...prefs, blocked: [...prefs.blocked, permission] });
}

/** Uninstall: forget the plugin's answers (a reinstall starts fresh). */
export function forgetPluginPermissionPrefs(pluginId: string): void {
  const all = readAll();
  if (!(pluginId in all)) return;
  delete all[pluginId];
  writeAll(all);
  for (const k of [...quietForEvents]) if (k.startsWith(`${pluginId}|`)) quietForEvents.delete(k);
  activations.delete(pluginId);
}

export function resetPluginPermissionRequestsForTests(): void {
  activations.clear();
  quietForEvents.clear();
  promptOpen = false;
  try {
    localStorage.removeItem(PREFS_KEY);
  } catch {
    /* no storage */
  }
}
