import { loadConfig } from './config';
import { Logger, logCaught } from './logger';
import { SessionLogger } from './stats';
import { TargetRotator } from './targets';
import { DoomscrollerConfig } from './types';
import { DoomscrollerStateMachine } from './state-machine';
import { WindowsSoundPlayer } from './sound';
import { createIpcServer, IpcRequest, IpcResponse, IpcServerHandle } from './ipc';
import { HotkeyAdapter } from '../adapters/hotkey';
import { IdeActivityAdapter } from '../adapters/ide-activity';
import { PowerShellCpuProbeFactory } from '../windows/cpu-probe';
import { GlobalKeyListener, parseHotkey } from '../windows/key-listener';
import { Win32WindowController } from '../windows/win32';

export interface DaemonHandle {
  machine: DoomscrollerStateMachine;
  close(): Promise<void>;
}

export async function startDaemon(config: DoomscrollerConfig, logger: Logger): Promise<DaemonHandle> {
  const windows = new Win32WindowController(config.browser, logger);
  const sound = new WindowsSoundPlayer(config.sound, logger);
  const targets = new TargetRotator(config.targets);
  let currentConfig = config;
  const machine = new DoomscrollerStateMachine({
    config: currentConfig,
    windows,
    logger,
    stats: new SessionLogger(currentConfig.sessionLogPath),
    sound,
    targets,
  });

  // Re-read the config file at the start of each session so edits take effect
  // without restarting the daemon. On a missing or invalid file the previous
  // values are kept. Port, hotkey and log paths still require a restart.
  const refreshConfig = (): void => {
    try {
      const loaded = loadConfig();
      if (!loaded.exists || loaded.error) return;
      const next: DoomscrollerConfig = {
        ...currentConfig,
        delaySeconds: loaded.config.delaySeconds,
        maxDoomscrollSeconds: loaded.config.maxDoomscrollSeconds,
        targets: loaded.config.targets,
        browser: loaded.config.browser,
        sound: loaded.config.sound,
      };
      currentConfig = next;
      machine.updateConfig(next);
      targets.setTargets(next.targets);
      windows.setBrowser(next.browser);
      sound.setEnabled(next.sound);
      logger.info(
        `config reloaded (delay=${next.delaySeconds}s, cap=${next.maxDoomscrollSeconds}s, targets=${next.targets.length}, browser=${next.browser}, sound=${next.sound})`,
      );
    } catch (error) {
      logCaught(logger, 'could not reload config; keeping previous values', error);
    }
  };

  const hotkeySpec = parseHotkey(config.hotkey);
  const hasIdeAgents = config.registeredAgents.some((agent) => agent.adapter === 'ide-activity');
  const keyListener = new GlobalKeyListener(logger, hotkeySpec?.key ?? 'D');

  const hotkeyAdapter = new HotkeyAdapter({
    listener: keyListener,
    machine,
    hotkey: hotkeySpec,
    logger,
  });
  const ideAdapter = new IdeActivityAdapter({
    config,
    machine,
    logger,
    keySource: keyListener,
    cpuProbes: new PowerShellCpuProbeFactory(logger),
  });

  let server: IpcServerHandle | null = null;
  let closeDaemon: (() => Promise<void>) | null = null;
  const handler = (request: IpcRequest): IpcResponse => {
    if (!request || typeof request !== 'object') {
      return { ok: false, error: 'invalid request' };
    }
    if (request.type === 'status') {
      return { ok: true, state: machine.state, target: machine.currentTarget };
    }
    if (request.type === 'shutdown') {
      logger.info('shutdown requested over IPC');
      setTimeout(() => {
        void closeDaemon?.();
      }, 100);
      return { ok: true, state: machine.state };
    }
    if (request.type === 'event' && (request.event === 'agent:started' || request.event === 'agent:finished')) {
      if (request.event === 'agent:started') refreshConfig();
      void machine.handle(request.event);
      return { ok: true, state: machine.state, target: machine.currentTarget };
    }
    return { ok: false, error: 'unknown request' };
  };

  try {
    server = await createIpcServer(config.port, handler);
  } catch (error) {
    throw new Error(
      `could not listen on 127.0.0.1:${config.port} (is another daemon running?): ${String(error)}`,
    );
  }

  if (hotkeySpec || hasIdeAgents) {
    keyListener.start();
  } else {
    logger.info('no hotkey and no IDE agents configured; key listener not started');
  }
  hotkeyAdapter.start();
  ideAdapter.start();

  logger.info(
    `daemon listening on 127.0.0.1:${config.port} (hotkey=${config.hotkey ?? 'disabled'}, targets=${config.targets.length}, agents=${config.registeredAgents.length})`,
  );

  let closed = false;
  closeDaemon = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (machine.isWorking) {
      try {
        await machine.forceReturn('hotkey');
      } catch (error) {
        logCaught(logger, 'could not restore focus while stopping', error);
      }
    }
    try {
      ideAdapter.stop();
    } catch (error) {
      logCaught(logger, 'could not stop ide adapter', error);
    }
    try {
      hotkeyAdapter.stop();
    } catch (error) {
      logCaught(logger, 'could not stop hotkey adapter', error);
    }
    try {
      keyListener.stop();
    } catch (error) {
      logCaught(logger, 'could not stop key listener', error);
    }
    machine.dispose();
    try {
      await server?.close();
    } catch (error) {
      logCaught(logger, 'could not close IPC server', error);
    }
    logger.info('daemon stopped');
  };

  return {
    machine,
    close: () => closeDaemon!(),
  };
}
