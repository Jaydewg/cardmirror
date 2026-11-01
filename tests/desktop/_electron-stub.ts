// Stub the 'electron' module surface the fast-paste-bridge uses,
// so vitest can run desktop-module tests without a real Electron
// install in the project root.

export const sentToRenderer: Array<{ channel: string; payload: any }> = [];
export const ipcListeners = new Map<string, Array<(evt: unknown, ack: any) => void>>();

interface MockWinOpts {
  url?: string;
  sendThrows?: boolean;
  destroyed?: boolean;
  minimized?: boolean;
}

export interface MockWin {
  id: number;
  webContents: { send: (channel: string, payload: any) => void; getURL: () => string };
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  restore: () => void;
  show: () => void;
  focus: () => void;
  __restored: boolean;
  __shown: boolean;
  __focused: boolean;
}

let nextWinId = 1;

export function makeMockWindow(opts: MockWinOpts = {}): MockWin {
  const win: MockWin = {
    id: nextWinId++,
    webContents: {
      send: (channel: string, payload: any) => {
        if (opts.sendThrows) throw new Error('render process gone');
        sentToRenderer.push({ channel, payload });
      },
      getURL: () => opts.url ?? 'http://localhost/index.html',
    },
    isDestroyed: () => opts.destroyed ?? false,
    isMinimized: () => opts.minimized ?? false,
    restore: () => { win.__restored = true; },
    show: () => { win.__shown = true; },
    focus: () => { win.__focused = true; },
    __restored: false,
    __shown: false,
    __focused: false,
  };
  return win;
}

const makeWin = makeMockWindow;

let mockFocusedWindow: MockWin | null = makeWin();
let mockAllWindows: MockWin[] = [mockFocusedWindow];

export function setMockFocusedWindow(win: MockWin | null): void {
  mockFocusedWindow = win;
  mockAllWindows = win ? [win] : [];
}

export function setMockAllWindows(wins: MockWin[]): void {
  mockAllWindows = wins;
}

export function resetElectronStub(userDataPath: string): void {
  sentToRenderer.length = 0;
  ipcListeners.clear();
  ipcHandlers.clear();
  const win = makeWin();
  setMockFocusedWindow(win);
  (app as any).__userData = userDataPath;
}

const appEventListeners = new Map<string, Array<(evt: unknown, ...args: any[]) => void>>();

export const app = {
  __userData: '/tmp',
  getPath: (name: string) => {
    if (name === 'userData') return (app as any).__userData as string;
    return (app as any).__userData as string;
  },
  getVersion: () => 'TEST-1.2.3',
  on: (event: string, listener: (evt: unknown, ...args: any[]) => void) => {
    const arr = appEventListeners.get(event) ?? [];
    arr.push(listener);
    appEventListeners.set(event, arr);
  },
};

/** Fire an app-level event (e.g. 'browser-window-focus') into every
 *  registered listener, the way Electron's app emitter would. */
export function emitAppEvent(event: string, ...args: any[]): void {
  for (const l of appEventListeners.get(event) ?? []) l(null, ...args);
}

export const BrowserWindow = {
  getFocusedWindow: () => mockFocusedWindow,
  getAllWindows: () => mockAllWindows,
};

/** `ipcMain.handle` registrations, for tests that invoke a main-process
 *  handler directly (`ipcHandlers.get(channel)!(evt, payload)`). */
export const ipcHandlers = new Map<string, (evt: unknown, ...args: any[]) => any>();

export const powerMonitor = {
  on: (_event: string, _listener: (...args: any[]) => void) => {},
};

export const ipcMain = {
  handle: (channel: string, handler: (evt: unknown, ...args: any[]) => any) => {
    ipcHandlers.set(channel, handler);
  },
  on: (channel: string, listener: (evt: unknown, ack: any) => void) => {
    const arr = ipcListeners.get(channel) ?? [];
    arr.push(listener);
    ipcListeners.set(channel, arr);
  },
  removeListener: (channel: string, listener: (evt: unknown, ack: any) => void) => {
    const arr = ipcListeners.get(channel);
    if (!arr) return;
    const idx = arr.indexOf(listener);
    if (idx >= 0) arr.splice(idx, 1);
  },
};
