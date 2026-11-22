/**
 * The cardmirror-bridge handshake (PLUGINS.md section 4), from the flow
 * app's side: announce ourselves, find CardMirror, and talk to it.
 *
 * We write `cardmirror-pdf.json` (identity, kept) and
 * `cardmirror-pdf.session.json` (port/token/pid, deleted on quit), and
 * read `cardmirror.session.json` to reach CardMirror's HTTP routes.
 */
import { promises as fs, unlinkSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { COMPANION_APP_ID } from '../../src/protocol.js';

export const BRIDGE_SCHEMA = 1;
export const TOKEN_HEADER = 'x-bridge-token';
const MAX_HANDSHAKE_BYTES = 64 * 1024;

/** Same rules as CardMirror's `bridgeDirPath`. `appData` is Electron's
 *  `app.getPath('appData')` (used off Linux). */
export function bridgeDirPath(appData: string, env = process.env, platform = process.platform): string {
  if (env['CARDMIRROR_BRIDGE_DIR']) return env['CARDMIRROR_BRIDGE_DIR'];
  if (platform === 'linux') {
    const base = env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local', 'share');
    return path.join(base, 'cardmirror-bridge');
  }
  return path.join(appData, 'cardmirror-bridge');
}

async function writeAtomic0600(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function announce(dir: string, info: { appVersion: string; port: number; token: string }): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  await writeAtomic0600(path.join(dir, `${COMPANION_APP_ID}.json`), {
    schema: BRIDGE_SCHEMA,
    app: 'CardMirror PDF',
    appVersion: info.appVersion,
    kind: 'flow',
  });
  await writeAtomic0600(path.join(dir, `${COMPANION_APP_ID}.session.json`), {
    port: info.port,
    token: info.token,
    pid: process.pid,
  });
}

/** Quit: remove only the session file (the identity file stays, so the
 *  app stays listed in CardMirror while closed). Sync, for exit handlers. */
export function retractSync(dir: string): void {
  try {
    unlinkSync(path.join(dir, `${COMPANION_APP_ID}.session.json`));
  } catch {
    // already gone
  }
}

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

function pidAlive(pid: number): boolean {
  if (!pid) return true; // unknown: let the request decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** CardMirror's live endpoint, or null when it isn't running. */
export async function findCardmirror(dir: string): Promise<Endpoint | null> {
  const file = path.join(dir, 'cardmirror.session.json');
  try {
    if ((await fs.stat(file)).size > MAX_HANDSHAKE_BYTES) return null;
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
    const port = raw['port'];
    const token = raw['token'];
    const pid = typeof raw['pid'] === 'number' ? raw['pid'] : 0;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) return null;
    if (typeof token !== 'string' || !token) return null;
    if (!pidAlive(pid)) return null;
    return { port: port as number, token, pid };
  } catch {
    return null;
  }
}

/** One identified request to CardMirror (`X-App-Id: cardmirror-pdf`). No
 *  Origin/Referer: CardMirror rejects requests that carry them. */
export async function cardmirrorRequest(
  ep: Endpoint,
  method: 'GET' | 'POST',
  route: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${ep.port}${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Token': ep.token,
        'X-App-Id': COMPANION_APP_ID,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body: json && typeof json === 'object' ? json : {} };
  } finally {
    clearTimeout(timer);
  }
}
