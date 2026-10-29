/**
 * File-index service — utilityProcess entry.
 *
 * A thin message shim over file-index-core.ts: main forks this once and
 * forwards one MessagePort per renderer window; each renderer then
 * talks to the service DIRECTLY (query in, ranked rows out) with the
 * browser process out of the loop entirely. See the core's header for
 * the why.
 *
 * Protocol (renderer → service over the forwarded port):
 *   { id, op: 'configure' | 'refresh' | 'query' | 'browse' | 'locateCurrentFile' | 'entriesForPaths', args }
 * → { id, ok: true, result } | { id, ok: false, error }
 * Push (service → every port): { push: 'changed', root } when a scan /
 * revalidation lands a fresh listing (renderer re-queries).
 *
 * The data dir arrives via CM_INDEX_DATA_DIR — utilityProcess has no
 * `app`, so main passes userData at fork. Bundled standalone by esbuild
 * (build:service) because the core imports src/editor/file-search.ts,
 * which the desktop tsc build can't reach.
 */

import { createFileIndexCore } from './file-index-core.js';

/** The slice of Electron's MessagePortMain / parentPort surface the
 *  shim touches (no electron types in a bundled utility process). */
interface PortLike {
  on(event: 'message', handler: (e: { data: unknown; ports: PortLike[] }) => void): void;
  on(event: 'close', handler: () => void): void;
  start?(): void;
  postMessage(message: unknown): void;
}

const dataDir = process.env['CM_INDEX_DATA_DIR'];
if (!dataDir) {
  console.error('[file-index] CM_INDEX_DATA_DIR missing — exiting');
  process.exit(1);
}

const ports = new Set<PortLike>();

const core = createFileIndexCore({
  dataDir,
  onChanged: (root) => {
    for (const port of ports) {
      try {
        port.postMessage({ push: 'changed', root });
      } catch {
        /* port gone — pruned on 'close' */
      }
    }
  },
});

interface Request {
  id: number;
  op: 'configure' | 'refresh' | 'query' | 'browse' | 'locateCurrentFile' | 'entriesForPaths';
  args: unknown;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.op) {
    case 'configure':
      return core.configure((req.args as { roots: string[] }).roots);
    case 'refresh':
      return core.refresh((req.args as { roots: string[] }).roots);
    case 'query':
      return core.query(req.args as Parameters<typeof core.query>[0]);
    case 'browse':
      return core.browse(req.args as Parameters<typeof core.browse>[0]);
    case 'locateCurrentFile':
      return core.locateCurrentFile(req.args as Parameters<typeof core.locateCurrentFile>[0]);
    case 'entriesForPaths':
      return core.entriesForPaths(req.args as Parameters<typeof core.entriesForPaths>[0]);
    default:
      throw new Error(`unknown op ${(req as { op?: string }).op}`);
  }
}

function wirePort(port: PortLike): void {
  ports.add(port);
  port.on('message', (e) => {
    const req = e.data as Request | null;
    if (!req || typeof req.id !== 'number' || typeof req.op !== 'string') return;
    void handle(req)
      .then((result) => port.postMessage({ id: req.id, ok: true, result }))
      .catch((err) =>
        port.postMessage({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  });
  port.on('close', () => ports.delete(port));
  port.start?.();
}

// utilityProcess: main sends { type: 'port' } with one transferred
// MessagePortMain per renderer.
const parentPort = (process as unknown as { parentPort: PortLike }).parentPort;
parentPort.on('message', (e) => {
  const msg = e.data as { type?: string } | null;
  if (msg?.type === 'port' && e.ports[0]) wirePort(e.ports[0]);
});
