/** Bundle entry: hand the definition to CardMirror's plugin registry.
 *  The plugin imports nothing from the app but types (erased at build),
 *  so this bundle carries no CardMirror code. */
import { createLiveSessionLinkPlugin } from './plugin.js';

window.__registerCardMirrorPlugin?.(createLiveSessionLinkPlugin());
