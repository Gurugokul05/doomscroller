import fs from 'node:fs';
import path from 'node:path';
import { SessionRecord, SessionRecorder } from './types';

export class SessionLogger implements SessionRecorder {
  constructor(private readonly filePath: string) {}

  record(record: SessionRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // Never let session logging interfere with the agent.
    }
  }
}

export function readSessions(filePath: string): SessionRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return [];
  }

  const records: SessionRecord[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<SessionRecord>;
      if (
        parsed &&
        parsed.type === 'session' &&
        typeof parsed.startedAt === 'string' &&
        typeof parsed.finishedAt === 'string' &&
        typeof parsed.durationMs === 'number' &&
        typeof parsed.doomscrollMs === 'number' &&
        (parsed.end === 'finished' || parsed.end === 'hotkey' || parsed.end === 'cap')
      ) {
        records.push({
          type: 'session',
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          durationMs: parsed.durationMs,
          doomscrollMs: parsed.doomscrollMs,
          target: typeof parsed.target === 'string' ? parsed.target : null,
          end: parsed.end,
        });
      }
    } catch {
      // Ignore corrupt lines.
    }
  }
  return records;
}

export interface DayStats {
  date: string;
  sessions: number;
  doomscrollMs: number;
  durationMs: number;
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function aggregateByDay(
  records: readonly SessionRecord[],
  options: { days?: number | null; now?: Date } = {},
): DayStats[] {
  const now = options.now ?? new Date();
  const days = options.days === undefined ? 14 : options.days;
  let cutoff: number | null = null;
  if (days !== null) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    start.setDate(start.getDate() - Math.max(0, days - 1));
    cutoff = start.getTime();
  }

  const map = new Map<string, DayStats>();
  for (const record of records) {
    const finished = new Date(record.finishedAt);
    if (Number.isNaN(finished.getTime())) continue;
    if (cutoff !== null && finished.getTime() < cutoff) continue;
    const key = localDateKey(finished);
    const current = map.get(key) ?? { date: key, sessions: 0, doomscrollMs: 0, durationMs: 0 };
    current.sessions += 1;
    current.doomscrollMs += Math.max(0, record.doomscrollMs);
    current.durationMs += Math.max(0, record.durationMs);
    map.set(key, current);
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
