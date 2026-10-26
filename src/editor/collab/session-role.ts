/**
 * A peer's role in a collaboration session.
 *
 *   host        — started the room; ends it for everyone; compacts.
 *   participant — joined with a share code; edits.
 *   spectator   — joined with a VIEW code (2026-10-24): sees every edit
 *                 live, posts nothing. Enforced twice: the relay refuses
 *                 the view pass on every write, and the client's session
 *                 plugin rejects local document changes before they are
 *                 ever queued. Not a secrecy boundary (spectators hold the
 *                 room key) — a way to share a live doc without the chaos
 *                 of co-editing.
 *
 * Kept in its own zero-dependency module so the always-loaded shells and
 * the lazy collab module agree on the union without importing each other.
 */
export type SessionRole = 'host' | 'participant' | 'spectator';

/** Roles that may write to the room. */
export function roleCanEdit(role: SessionRole): boolean {
  return role !== 'spectator';
}
