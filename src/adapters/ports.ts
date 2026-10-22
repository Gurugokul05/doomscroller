import { AgentEvent, CoreState } from '../core/types';
import { KeyEvent } from '../windows/key-listener';

export interface AgentControlPort {
  readonly state: CoreState;
  handle(event: AgentEvent): Promise<void>;
}

export interface ForceReturnPort extends AgentControlPort {
  forceReturn(reason: 'hotkey' | 'cap'): Promise<void>;
}

export interface KeySource {
  onKey(listener: (event: KeyEvent) => void): () => void;
}
