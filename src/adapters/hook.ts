import { dispatchFast } from '../core/ipc';
import { AgentEvent } from '../core/types';

/**
 * Hook entry point. Runs in an agent-spawned process, so every failure is
 * swallowed and the caller is never blocked.
 */
export async function emitHookEvent(event: AgentEvent, port: number): Promise<void> {
  try {
    await dispatchFast(event, port);
  } catch {
    // Intentionally silent: hooks must never break the agent.
  }
}
