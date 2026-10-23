import { TargetProvider } from './types';

/** Cycles through the configured targets, one per doomscroll session. */
export class TargetRotator implements TargetProvider {
  private index = 0;

  constructor(private targets: readonly string[]) {}

  setTargets(targets: readonly string[]): void {
    this.targets = targets;
    this.index = 0;
  }

  next(): string | null {
    if (this.targets.length === 0) return null;
    const target = this.targets[this.index % this.targets.length];
    this.index = (this.index + 1) % this.targets.length;
    return target;
  }

  get position(): number {
    return this.index;
  }
}
