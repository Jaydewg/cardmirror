/** The default relay endpoint for BROWSER hosts. This fork ships with
 *  NO default relay (store-release decision 2026-11-26): users point
 *  card sharing / co-editing at a relay via Custom relay URL. Kept as a
 *  module (and the LITE alias to relay-endpoint-lite) so the shape
 *  matches upstream for merges. */
export const WEB_DEFAULT_RELAY_URL = '';
