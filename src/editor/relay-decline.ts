/**
 * The ONE fix-path sentence for every relay credential-decline
 * surface (mailbox sends, the push stream, session start/join,
 * mid-session rejection). The toast audit found five independently
 * authored ~25-word phrasings of the same 401 — copy edits now
 * happen here once. This fork ships with no default relay, so the
 * one fix is configuring one (a missing URL and a wrong token both
 * land here).
 */
export const RELAY_FIX_PATH =
  'In Settings → Collaboration, set up a relay (Custom relay URL and token).';
