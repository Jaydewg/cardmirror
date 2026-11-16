/**
 * Default right-click menu for editor text: Cut / Copy / Paste.
 *
 * Registered AFTER the image, link, and spellcheck context-menu
 * plugins, so it only sees right-clicks none of them claimed — it is
 * the editor's fallback menu, giving right-click a purpose everywhere
 * in the document. (Before this, a right-click on plain text did
 * nothing visible, which trained users to right-click repeatedly —
 * the exact posture behind the 2026-08-14 paintbrush incident.)
 *
 * Cut/Copy serialize through `view.serializeForClipboard`, so
 * transformCopied hooks and the schema's clipboard representation
 * apply exactly as a keyboard copy would, then write through the
 * shared clipboard-write ladder (main-process first; honest failure
 * toast — no silent failures). Cut only deletes AFTER the clipboard
 * write reports success, so a busy clipboard can never eat text.
 * Paste prefers the main-process html+text read on desktop (no
 * permission UI, rich flavor preserved); the web edition asks the
 * async clipboard API and, if the browser blocks it, tells the user
 * the keyboard shortcut instead of failing silently.
 *
 * Rendering is the shared context-menu builder; granted plugins'
 * `ui.contextMenu` items follow after a separator.
 */

import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { showToast } from './toast.js';
import { writeClipboardHtml, CLIPBOARD_BUSY_MESSAGE } from './clipboard-write.js';
import { cutInPlaceApplies, markCutInPlace } from './cut-in-place.js';
import { getElectronHost } from './host/index.js';
import { showContextMenu, type MenuEntry } from './context-menu-builder.js';
import { pluginMenuEntries, type PluginMenuTarget } from './plugin-caps/menu.js';
import { governingHeading } from './plugin-extract.js';
import { getSpeechDocResolver } from './speech-doc-registry.js';
import { formatKeyForDisplay } from './ribbon-commands.js';
import { isRightClickContextMenu } from './context-menu-gate.js';

export const textContextMenuPlugin: Plugin = new Plugin({
  props: {
    handleDOMEvents: {
      contextmenu(view, event) {
        // Image, link, and misspelling right-clicks were claimed by
        // their plugins (registered earlier); everything reaching
        // here gets the fallback menu — unless it is not a right-click
        // (Ctrl+click on macOS), which opens nothing and shows no
        // browser menu either.
        event.preventDefault();
        if (!isRightClickContextMenu(event)) return true;
        showTextContextMenu(event.clientX, event.clientY, view);
        return true;
      },
    },
  },
});

function showTextContextMenu(x: number, y: number, view: EditorView): void {
  const sel = view.state.selection;
  const entries: MenuEntry[] = [
    {
      kind: 'item',
      label: 'Cut',
      hint: formatKeyForDisplay('Mod-X'),
      disabled: sel.empty || !view.editable,
      action: () => void cutSelection(view),
    },
    {
      kind: 'item',
      label: 'Copy',
      hint: formatKeyForDisplay('Mod-C'),
      disabled: sel.empty,
      action: () => void copySelection(view),
    },
    {
      kind: 'item',
      label: 'Paste',
      hint: formatKeyForDisplay('Mod-V'),
      disabled: !view.editable,
      action: () => void pasteFromClipboard(view),
    },
    ...pluginMenuEntries(() => textMenuTarget(view)),
  ];
  showContextMenu(x, y, entries);
}

/** What a plugin menu item is told about this right-click. */
function textMenuTarget(view: EditorView): PluginMenuTarget {
  const { doc, selection } = view.state;
  const heading = governingHeading(doc, selection.from);
  return {
    surface: 'text',
    docUid: getSpeechDocResolver().uidForView(view),
    headingId: heading?.id ?? null,
    headingType: (heading?.type as PluginMenuTarget['headingType']) ?? null,
    selectionText: selection.empty ? '' : doc.textBetween(selection.from, selection.to, '\n'),
  };
}

/** Serialize the live selection exactly as a keyboard copy would and
 *  push it through the shared write ladder. Returns whether the
 *  clipboard actually took it (cut's delete is gated on this). */
async function copySelection(view: EditorView): Promise<boolean> {
  const sel = view.state.selection;
  if (sel.empty) return false;
  const { dom, text } = view.serializeForClipboard(sel.content());
  const ok = await writeClipboardHtml(dom.innerHTML, text);
  if (!ok) showToast(CLIPBOARD_BUSY_MESSAGE);
  view.focus();
  return ok;
}

async function cutSelection(view: EditorView): Promise<void> {
  // Whole units in a shared document are cut in place (cut-in-place.ts).
  const units = cutInPlaceApplies(view);
  if (units) {
    await markCutInPlace(view, units);
    view.focus();
    return;
  }
  if (!(await copySelection(view))) return; // failed copy must not delete
  if (view.state.selection.empty) return;
  view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
  view.focus();
}

async function pasteFromClipboard(view: EditorView): Promise<void> {
  const deliver = (html: string, text: string): void => {
    view.focus();
    if (html) view.pasteHTML(html);
    else if (text) view.pasteText(text);
    // Both empty: clipboard has nothing pasteable — do nothing,
    // matching the keyboard shortcut's behavior.
  };

  const host = getElectronHost();
  if (host) {
    const rich = await host.clipboardReadHtml().catch(() => null);
    if (rich) {
      deliver(rich.html, rich.text);
      return;
    }
    // Older shell without the html read — text-only paste.
    const text = await host.clipboardReadText().catch(() => '');
    deliver('', text);
    return;
  }

  // Web edition: the async clipboard API, which the browser may gate
  // behind a permission prompt or refuse outright.
  try {
    if (navigator.clipboard?.read) {
      const clip = await navigator.clipboard.read();
      for (const item of clip) {
        if (item.types.includes('text/html')) {
          deliver(await (await item.getType('text/html')).text(), '');
          return;
        }
      }
      for (const item of clip) {
        if (item.types.includes('text/plain')) {
          deliver('', await (await item.getType('text/plain')).text());
          return;
        }
      }
      return; // nothing pasteable
    }
    if (navigator.clipboard?.readText) {
      deliver('', await navigator.clipboard.readText());
      return;
    }
    throw new Error('no async clipboard');
  } catch {
    showToast(
      `The browser blocked clipboard access — press ${formatKeyForDisplay('Mod-V')} to paste.`,
    );
  }
}
