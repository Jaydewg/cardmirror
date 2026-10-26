/**
 * Speech History modal: the saved dynamic-speech sessions (last 5 days),
 * delete one or all, and apply their average to Reader 1's WPM.
 */

import { settings } from '../settings.js';
import { setIcon } from '../icons';
import { pushOverlay, popOverlay } from '../overlay-stack.js';
import { installModalKeys, armDialogFocus, captureFocusForDialog } from '../text-prompt.js';
import { isBackdropClick } from '../backdrop-click.js';
import { showConfirm } from '../confirm-dialog.js';
import { formatNumber } from '../word-count.js';
import { currentBlend, isSpeechArmed, lastSpeechSummary } from './session.js';
import { speechSourceLines } from './display.js';
import {
  clearSpeechSessions,
  listSpeechSessions,
  removeSpeechSession,
  subscribeSpeechSessions,
  type SpeechSession,
} from './history-store.js';

function clock(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Word-weighted mean WPM of the sessions, rounded. */
export function averageWpm(sessions: readonly SpeechSession[]): number | null {
  let w = 0, sum = 0;
  for (const s of sessions) {
    w += s.words;
    sum += s.words * s.wpm;
  }
  return w > 0 ? Math.round(sum / w) : null;
}

/** "Where the WPM comes from": the live session's blend while one runs,
 *  otherwise what the next speech would start from. */
function renderSources(): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'pmd-ds-sources';
  const live = lastSpeechSummary();
  const inSpeech = live.active && isSpeechArmed();
  const rates = inSpeech ? live : currentBlend();
  const head = document.createElement('p');
  head.className = 'pmd-wc-scope';
  head.textContent =
    rates.wpm === null
      ? 'No WPM to go on yet: set a reader WPM in Settings.'
      : inSpeech
        ? `Live WPM right now: ${Math.round(rates.wpm)}, a blend of:`
        : `The next dynamic speech starts at ${Math.round(rates.wpm)} WPM, a blend of:`;
  wrap.appendChild(head);
  const list = document.createElement('ul');
  for (const line of speechSourceLines(rates, { inSpeech })) {
    const li = document.createElement('li');
    li.textContent = line;
    list.appendChild(li);
  }
  wrap.appendChild(list);
  const note = document.createElement('p');
  note.className = 'pmd-settings-row-desc';
  note.textContent =
    'Saved speeches count from the last 3 hours; if you haven\u2019t spoken in 8 hours, from around this time yesterday; otherwise from the morning of your last day with speeches. Your own measured rate takes over as the speech goes on.';
  wrap.appendChild(note);
  return wrap;
}

class SpeechHistoryModal {
  private overlay: HTMLDivElement;
  private dialog: HTMLDivElement;
  private overlayToken: symbol | null = null;
  private removeKeys: (() => void) | null = null;
  private restoreFocus: (() => void) | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor() {
    this.overlay = document.createElement('div');
    this.overlay.className = 'pmd-settings-overlay';
    this.overlay.style.display = 'none';
    this.dialog = document.createElement('div');
    this.dialog.className = 'pmd-settings-dialog pmd-ds-history';
    this.overlay.appendChild(this.dialog);
    this.overlay.addEventListener('click', (e) => {
      if (isBackdropClick(e, this.overlay)) this.close();
    });
    document.body.appendChild(this.overlay);
  }

  open(): void {
    this.render();
    this.overlay.style.display = '';
    this.unsubscribe ??= subscribeSpeechSessions(() => this.render());
    if (this.overlayToken === null) {
      const token = pushOverlay();
      this.overlayToken = token;
      this.restoreFocus = captureFocusForDialog();
      this.removeKeys = installModalKeys(this.dialog, token, (e) => {
        if (e.key === 'Escape') {
          this.close();
          return true;
        }
        return false;
      });
    }
    armDialogFocus(this.dialog, 'dialog', 'Speech History');
  }

  close(): void {
    this.overlay.style.display = 'none';
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.overlayToken !== null) {
      popOverlay(this.overlayToken);
      this.overlayToken = null;
    }
    this.removeKeys?.();
    this.removeKeys = null;
    this.restoreFocus?.();
    this.restoreFocus = null;
  }

  private render(): void {
    this.dialog.innerHTML = '';
    const header = document.createElement('header');
    header.className = 'pmd-settings-header';
    const title = document.createElement('h2');
    title.textContent = 'Speech History';
    header.appendChild(title);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pmd-settings-close';
    setIcon(closeBtn, 'close');
    closeBtn.addEventListener('click', () => this.close());
    header.appendChild(closeBtn);
    this.dialog.appendChild(header);

    const body = document.createElement('div');
    body.className = 'pmd-settings-list';
    this.dialog.appendChild(body);

    body.appendChild(renderSources());

    const sessions = listSpeechSessions();
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'pmd-settings-empty';
      empty.textContent =
        'No dynamic speeches in the last 5 days. Start the speech timer and press Space as you read to record one.';
      body.appendChild(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'pmd-wc-table';
    const trh = document.createElement('tr');
    for (const h of ['When', 'Document', 'Words', 'Time', 'WPM', '']) {
      const th = document.createElement('th');
      th.textContent = h;
      trh.appendChild(th);
    }
    const thead = document.createElement('thead');
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    for (const s of sessions) {
      const tr = document.createElement('tr');
      const cells = [
        new Date(s.endedAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
        s.docName ?? 'Untitled',
        formatNumber(Math.round(s.words)),
        clock(s.elapsedMs),
        String(Math.round(s.wpm)),
      ];
      cells.forEach((text, i) => {
        const td = document.createElement('td');
        td.textContent = text;
        if (i >= 2) td.className = 'pmd-wc-numeric';
        tr.appendChild(td);
      });
      const tdDel = document.createElement('td');
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pmd-ds-history-delete';
      del.textContent = 'Delete';
      del.addEventListener('click', () => removeSpeechSession(s.id));
      tdDel.appendChild(del);
      tr.appendChild(tdDel);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    body.appendChild(table);

    const actions = document.createElement('div');
    actions.className = 'pmd-ds-history-actions';
    const avg = averageWpm(sessions);
    const reader = settings.get('readers')[0];
    if (avg !== null && reader) {
      const apply = document.createElement('button');
      apply.type = 'button';
      apply.textContent = `Apply average (${avg} WPM) to ${reader.name}`;
      apply.addEventListener('click', () => {
        void showConfirm({
          title: 'Apply average WPM',
          message: `Set ${reader.name}'s WPM from ${reader.wpm} to ${avg}?`,
          confirmLabel: 'Apply',
        }).then((ok) => {
          if (!ok) return;
          const readers = settings.get('readers');
          const r0 = readers[0];
          if (!r0) return;
          // Rates were measured at r0's tag/body ratio; keep it.
          const tagWpm = r0.tagWpm != null && r0.wpm > 0 ? Math.round((r0.tagWpm * avg) / r0.wpm) : undefined;
          settings.set('readers', [{ ...r0, wpm: avg, ...(tagWpm !== undefined ? { tagWpm } : {}) }, ...readers.slice(1)]);
          this.render();
        });
      });
      actions.appendChild(apply);
    }
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = 'Delete all';
    clear.addEventListener('click', () => {
      void showConfirm({
        title: 'Delete speech history',
        message: `Delete all ${sessions.length} saved ${sessions.length === 1 ? 'speech' : 'speeches'}?`,
        confirmLabel: 'Delete all',
        danger: true,
      }).then((ok) => {
        if (ok) clearSpeechSessions();
      });
    });
    actions.appendChild(clear);
    body.appendChild(actions);
  }
}

let singleton: SpeechHistoryModal | null = null;

export function openSpeechHistory(): void {
  singleton ??= new SpeechHistoryModal();
  singleton.open();
}
