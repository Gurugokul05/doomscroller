import { WindowHandle, WindowMatch } from '../core/types';

export interface WindowController {
  getForegroundWindow(): Promise<WindowHandle | null>;
  minimizeWindow(handle: WindowHandle): Promise<void>;
  restoreAndFocusWindow(handle: WindowHandle): Promise<boolean>;
  openInNewBrowserWindow(url: string): Promise<WindowHandle | null>;
  findWindows(match: WindowMatch): Promise<WindowHandle[]>;
}
