import { describe, expect, it } from 'vitest';
import { DoomscrollerStateMachine } from '../src/core/state-machine';
import { TargetRotator } from '../src/core/targets';
import { AGENT_FINISHED, AGENT_STARTED } from '../src/core/types';
import {
  ManualScheduler,
  MockRecorder,
  MockSound,
  MockWindowController,
  agentWindow,
  browserWindow,
  testConfig,
} from './helpers';

function create(overrides: Parameters<typeof testConfig>[0] = {}) {
  const scheduler = new ManualScheduler();
  const windows = new MockWindowController();
  const sound = new MockSound();
  const stats = new MockRecorder();
  const config = testConfig(overrides);
  const machine = new DoomscrollerStateMachine({
    config,
    windows,
    sound,
    stats,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    targets: new TargetRotator(config.targets),
    scheduler,
    now: () => scheduler.now,
  });
  return { scheduler, windows, sound, stats, config, machine };
}

describe('DoomscrollerStateMachine', () => {
  it('waits for the delay before minimizing and opening a target', async () => {
    const { scheduler, windows, machine } = create({ delaySeconds: 10 });

    await machine.handle(AGENT_STARTED);
    expect(machine.state).toBe('working');
    expect(windows.calls).toEqual([]);

    scheduler.advance(9_999);
    await machine.whenIdle();
    expect(windows.calls).toEqual([]);

    scheduler.advance(1);
    await machine.whenIdle();
    expect(windows.minimized).toEqual([agentWindow.id]);
    expect(windows.opened).toEqual(['https://www.instagram.com/']);
    expect(machine.currentTarget).toBe('https://www.instagram.com/');
  });

  it('cancels the delay when the agent finishes first', async () => {
    const { scheduler, windows, sound, stats, machine } = create({ delaySeconds: 10 });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(5_000);
    await machine.handle(AGENT_FINISHED);

    expect(machine.state).toBe('done');
    expect(windows.calls).toEqual([]);
    expect(sound.plays).toBe(0);
    expect(stats.records).toHaveLength(1);
    expect(stats.records[0].doomscrollMs).toBe(0);
    expect(stats.records[0].end).toBe('finished');
    expect(scheduler.pending).toBe(0);

    scheduler.advance(20_000);
    await machine.whenIdle();
    expect(windows.calls).toEqual([]);
  });

  it('minimizes the browser and restores the agent on finish', async () => {
    const { scheduler, windows, sound, stats, machine } = create({ delaySeconds: 10 });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(10_000);
    await machine.whenIdle();

    scheduler.advance(5_000);
    await machine.handle(AGENT_FINISHED);

    expect(windows.minimized).toEqual([agentWindow.id, browserWindow.id]);
    expect(windows.focused).toEqual([agentWindow.id]);
    expect(sound.plays).toBe(1);
    expect(stats.records).toHaveLength(1);
    expect(stats.records[0].durationMs).toBe(15_000);
    expect(stats.records[0].doomscrollMs).toBe(5_000);
    expect(stats.records[0].target).toBe('https://www.instagram.com/');
    expect(machine.state).toBe('done');
  });

  it('rotates through targets across sessions', async () => {
    const { windows, machine, scheduler } = create({ delaySeconds: 0 });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(1);
    await machine.whenIdle();
    await machine.handle(AGENT_FINISHED);

    await machine.handle(AGENT_STARTED);
    await machine.whenIdle();
    await machine.handle(AGENT_FINISHED);

    expect(windows.opened).toEqual([
      'https://www.instagram.com/',
      'https://x.com/',
    ]);
  });

  it('force return restores focus and records the hotkey reason', async () => {
    const { windows, sound, stats, machine, scheduler } = create({ delaySeconds: 0 });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(2_000);
    await machine.forceReturn('hotkey');

    expect(windows.minimized).toEqual([agentWindow.id, browserWindow.id]);
    expect(windows.focused).toEqual([agentWindow.id]);
    expect(sound.plays).toBe(1);
    expect(stats.records[0].end).toBe('hotkey');
    expect(machine.state).toBe('done');
  });

  it('enforces the max doomscroll cap', async () => {
    const { machine, stats, scheduler, windows } = create({
      delaySeconds: 0,
      maxDoomscrollSeconds: 30,
    });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(30_000);
    await machine.whenIdle();

    expect(machine.state).toBe('done');
    expect(stats.records[0].end).toBe('cap');
    expect(stats.records[0].doomscrollMs).toBe(30_000);
    expect(windows.focused).toEqual([agentWindow.id]);
  });

  it('ignores duplicate starts and stray finishes', async () => {
    const { windows, machine, scheduler, stats } = create({ delaySeconds: 5 });

    await machine.handle(AGENT_FINISHED);
    expect(machine.state).toBe('idle');
    expect(stats.records).toHaveLength(0);

    await machine.handle(AGENT_STARTED);
    await machine.handle(AGENT_STARTED);
    scheduler.advance(5_000);
    await machine.whenIdle();

    expect(windows.opened).toHaveLength(1);
  });

  it('does not crash when window operations fail', async () => {
    const { windows, machine, stats, sound } = create({
      delaySeconds: 0,
      browser: 'edge',
    });
    windows.failMinimize = true;
    windows.failFocus = true;
    windows.failOpen = true;

    await machine.handle(AGENT_STARTED);
    await machine.whenIdle();
    expect(machine.state).toBe('working');

    await machine.handle(AGENT_FINISHED);
    expect(machine.state).toBe('done');
    expect(stats.records).toHaveLength(1);
    expect(sound.plays).toBe(0);
  });

  it('survives a failing foreground lookup and empty target list', async () => {
    const { windows, machine, stats } = create({
      delaySeconds: 0,
      targets: [],
    });
    windows.failForeground = true;

    await machine.handle(AGENT_STARTED);
    await machine.whenIdle();
    await machine.handle(AGENT_FINISHED);

    expect(machine.state).toBe('done');
    expect(stats.records).toHaveLength(1);
  });

  it('swallows a failing sound player and stats recorder', async () => {
    const { machine, scheduler, sound, stats } = create({ delaySeconds: 0 });
    sound.throwOnPlay = true;
    stats.throwOnRecord = true;

    await machine.handle(AGENT_STARTED);
    scheduler.advance(1_000);
    await machine.handle(AGENT_FINISHED);

    expect(machine.state).toBe('done');
  });

  it('allows a new session after finishing', async () => {
    const { machine, windows, scheduler } = create({ delaySeconds: 0 });

    await machine.handle(AGENT_STARTED);
    scheduler.advance(100);
    await machine.handle(AGENT_FINISHED);
    await machine.handle(AGENT_STARTED);
    await machine.whenIdle();

    expect(machine.state).toBe('working');
    expect(windows.opened).toHaveLength(2);
  });
});
