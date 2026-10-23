import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AgentEvent, CoreState } from './types';
import { cliEntryPath } from '../util/paths';

export type IpcRequest =
  | { type: 'event'; event: AgentEvent }
  | { type: 'status' }
  | { type: 'shutdown' };

export interface IpcResponse {
  ok: boolean;
  state?: CoreState;
  target?: string | null;
  error?: string;
}

const HOST = '127.0.0.1';

export function sendIpcRequest(
  port: number,
  request: IpcRequest,
  timeoutMs = 1000,
): Promise<IpcResponse | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buffer = '';
    let socket: net.Socket;

    const finish = (response: IpcResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(response);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      socket = net.createConnection({ host: HOST, port });
    } catch {
      resolve(null);
      return;
    }

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {
        finish(null);
      }
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const parsed = JSON.parse(buffer.slice(0, newline)) as IpcResponse;
        finish(parsed && typeof parsed === 'object' ? parsed : null);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}

export interface IpcServerHandle {
  close(): Promise<void>;
}

export function createIpcServer(
  port: number,
  handler: (request: IpcRequest) => IpcResponse,
): Promise<IpcServerHandle> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let buffer = '';
      let handled = false;

      const respond = (response: IpcResponse): void => {
        if (handled) return;
        handled = true;
        try {
          socket.end(`${JSON.stringify(response)}\n`);
        } catch {
          // ignore
        }
      };

      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.length > 65536) {
          respond({ ok: false, error: 'request too large' });
          return;
        }
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(buffer.slice(0, newline)) as IpcRequest;
          respond(handler(parsed));
        } catch {
          respond({ ok: false, error: 'invalid request' });
        }
      });
      socket.on('error', () => {});
    });

    server.once('error', (error) => reject(error));
    server.listen({ host: HOST, port }, () => {
      resolve({
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

export function spawnNodeDetached(args: string[]): void {
  try {
    const entry = cliEntryPath();
    const child = spawn(process.execPath, [entry, ...args], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: path.dirname(entry),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Never let daemon spawning break the caller.
  }
}

export function spawnDaemonDetached(): void {
  spawnNodeDetached(['daemon', '--hidden']);
}

export function spawnDispatchDetached(event: AgentEvent): void {
  spawnNodeDetached(['__dispatch', event]);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function isDaemonRunning(port: number, timeoutMs = 250): Promise<boolean> {
  const response = await sendIpcRequest(port, { type: 'status' }, timeoutMs);
  return Boolean(response?.ok);
}

export async function ensureDaemon(port: number, timeoutMs = 5000): Promise<boolean> {
  if (await isDaemonRunning(port, 250)) return true;

  spawnDaemonDetached();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(120);
    if (await isDaemonRunning(port, 200)) return true;
  }
  return false;
}

/**
 * Hook-safe dispatch: try the daemon briefly, then hand the event to a
 * detached helper and return immediately. The hook process never waits for
 * the daemon to become ready. The helper's ensureDaemon starts the daemon if
 * needed, so this function must not spawn one too: two spawns race and the
 * loser fails to bind the port (EADDRINUSE).
 */
export async function dispatchFast(event: AgentEvent, port: number): Promise<boolean> {
  try {
    const response = await sendIpcRequest(port, { type: 'event', event }, 180);
    if (response?.ok) return true;
  } catch {
    // fall through
  }

  spawnDispatchDetached(event);
  return false;
}

/** Used by the detached helper: wait for the daemon, then deliver exactly once. */
export async function dispatchWithDaemon(
  event: AgentEvent,
  port: number,
  timeoutMs = 8000,
): Promise<boolean> {
  const ready = await ensureDaemon(port, timeoutMs);
  if (!ready) return false;
  const response = await sendIpcRequest(port, { type: 'event', event }, 1500);
  return Boolean(response?.ok);
}

export class EventClient {
  private ready: Promise<boolean>;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly port: number) {
    // Prewarm so the first Enter in a wrapped agent isn't delayed by daemon
    // startup. ensureDaemon is a no-op when another daemon is already running.
    this.ready = ensureDaemon(port, 6000);
  }

  emit(event: AgentEvent): void {
    this.pending = this.pending
      .then(async () => {
        const ready = await this.ready;
        if (!ready) return;
        const response = await sendIpcRequest(this.port, { type: 'event', event }, 1500);
        if (!response?.ok) {
          this.ready = ensureDaemon(this.port, 6000);
        }
      })
      .catch(() => {
        this.ready = ensureDaemon(this.port, 6000);
      });
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
