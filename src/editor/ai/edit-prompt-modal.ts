/**
 * Modal editor for one AI cite-creator prompt preset.
 *
 * The prompt is long enough that the inline settings text input
 * doesn't fit. This dialog opens on demand with a name field and a
 * full-size textarea — pre-populated with the preset being edited, or,
 * for a new preset, with the prompt currently in use (the built-in
 * default when none is). Save writes the preset (cite-prompt-presets.ts)
 * and makes it the active one; "Restore default" refills the textarea
 * with the built-in prompt.
 */

import { settings } from '../settings.js';
import { DEFAULT_AI_CITE_PROMPT } from './cite-creator.js';
import {
  MAX_CITE_PROMPT_PRESETS,
  activateCitePromptPreset,
  activeCitePromptIndex,
  citePromptPresets,
  defaultCitePromptPresetName,
  saveCitePromptPreset,
} from './cite-prompt-presets.js';
import { setIcon } from '../icons';
import { pushOverlay, popOverlay, isTopOverlay } from '../overlay-stack.js';
import { isBackdropClick } from '../backdrop-click.js';
import { showToast } from '../toast.js';

export interface CitePromptEditorOptions {
  /** Preset to edit; null adds a new one. Omitted: the active preset,
   *  or a new one when the built-in default is in use. */
  preset?: number | null;
}

export function openCitePromptEditor(opts: CitePromptEditorOptions = {}): void {
  if (document.querySelector('.pmd-prompt-overlay')) return;
  const presets = citePromptPresets();
  const index =
    opts.preset === undefined
      ? activeCitePromptIndex() >= 0
        ? activeCitePromptIndex()
        : null
      : opts.preset;
  const editing = index != null ? presets[index] : undefined;
  if (index == null && presets.length >= MAX_CITE_PROMPT_PRESETS) {
    showToast(`You already have ${MAX_CITE_PROMPT_PRESETS} cite-prompt presets — delete one to add another.`);
    return;
  }
  const overlayToken = pushOverlay();

  const overlay = document.createElement('div');
  overlay.className = 'pmd-prompt-overlay';
  overlay.addEventListener('click', (e) => {
    if (isBackdropClick(e, overlay)) close();
  });

  const dialog = document.createElement('div');
  dialog.className = 'pmd-prompt-dialog';
  overlay.appendChild(dialog);

  const header = document.createElement('header');
  header.className = 'pmd-prompt-header';
  const title = document.createElement('h2');
  title.textContent = editing ? `AI cite-creator prompt: ${editing.name}` : 'New AI cite-creator prompt preset';
  header.appendChild(title);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    popOverlay(overlayToken);
  };
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'pmd-prompt-close';
  setIcon(closeBtn, 'close');
  closeBtn.title = 'Close';
  closeBtn.addEventListener('click', close);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  const note = document.createElement('p');
  note.className = 'pmd-prompt-note';
  note.textContent =
    'This system prompt is sent to the AI before your selected citation text. ' +
    'Use `{DATE}` anywhere you want today\'s date substituted in (M-D-YYYY). ' +
    'The reply must use the delimited [[CITE]] … [[TOKENS]] … [[END]] block format at the bottom of the prompt — the editor splits on those exact markers to insert the cite and apply the F8 cite mark to each token, so leave that part intact unless you know what you\'re doing.';
  dialog.appendChild(note);

  const nameLabel = document.createElement('label');
  nameLabel.className = 'pmd-prompt-name-label';
  nameLabel.textContent = 'Preset name';
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'pmd-prompt-name';
  nameInput.maxLength = 60;
  nameInput.placeholder = defaultCitePromptPresetName(index ?? presets.length);
  nameInput.value = editing?.name ?? '';
  nameLabel.appendChild(nameInput);
  dialog.appendChild(nameLabel);

  const textarea = document.createElement('textarea');
  textarea.className = 'pmd-prompt-textarea';
  textarea.spellcheck = false;
  // A new preset starts from what's in use now, so "tweak the current
  // prompt into a second one" is the zero-effort path.
  textarea.value = editing ? editing.prompt : settings.get('aiCitePrompt') || DEFAULT_AI_CITE_PROMPT;
  textarea.rows = 24;
  dialog.appendChild(textarea);

  const footer = document.createElement('footer');
  footer.className = 'pmd-prompt-footer';

  const resetBtn = document.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'pmd-prompt-btn';
  resetBtn.textContent = 'Restore default';
  resetBtn.addEventListener('click', () => {
    textarea.value = DEFAULT_AI_CITE_PROMPT;
  });
  footer.appendChild(resetBtn);

  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  footer.appendChild(spacer);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'pmd-prompt-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', close);
  footer.appendChild(cancelBtn);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'pmd-prompt-btn pmd-prompt-btn-primary';
  saveBtn.textContent = editing ? 'Save' : 'Save and use';
  saveBtn.addEventListener('click', () => {
    const at = saveCitePromptPreset(index, nameInput.value, textarea.value);
    if (at == null) {
      showToast('Could not save the preset.');
      return;
    }
    activateCitePromptPreset(at);
    close();
  });
  footer.appendChild(saveBtn);

  dialog.appendChild(footer);
  document.body.appendChild(overlay);

  const onKey = (e: KeyboardEvent): void => {
    // Only the topmost overlay reacts, so Escape from here doesn't also
    // close the Settings modal underneath.
    if (e.key === 'Escape' && isTopOverlay(overlayToken)) close();
  };
  document.addEventListener('keydown', onKey);

  requestAnimationFrame(() => (editing ? textarea : nameInput).focus());
}
