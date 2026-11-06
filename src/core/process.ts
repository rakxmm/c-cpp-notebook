import { spawn } from 'node:child_process';

export type StopReason = 'timeout' | 'cancelled' | 'output-limit';

export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  stopReason?: StopReason;
  spawnError?: Error;
}

export interface ProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputChars?: number;
}

const KILL_GRACE_MS = 2000;

/** Kills the whole tree: a cancelled `cmake --build` must not leave compilers running. */
function killTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on(
        'error',
        () => undefined,
      );
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // The process has already exited.
  }
}

export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  const empty = { code: null, signal: null, stdout: '', stderr: '' };
  if (options.signal.aborted) {
    return Promise.resolve({ ...empty, stopReason: 'cancelled' });
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let stopReason: StopReason | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (result: Omit<ProcessResult, 'stdout' | 'stderr' | 'stopReason'>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      options.signal.removeEventListener('abort', onAbort);
      resolve({ ...result, stdout, stderr, stopReason });
    };

    const stop = (reason: StopReason) => {
      if (stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      if (child.pid !== undefined) {
        killTree(child.pid);
      }
      // A surviving grandchild could hold the pipes open and delay 'close' forever.
      graceTimer = setTimeout(() => finish({ code: null, signal: null }), KILL_GRACE_MS);
    };

    const onAbort = () => stop('cancelled');
    options.signal.addEventListener('abort', onAbort);

    if (options.timeoutMs) {
      timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    }

    const checkLimit = () => {
      if (options.maxOutputChars && stdout.length + stderr.length > options.maxOutputChars) {
        stop('output-limit');
      }
    };
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
      checkLimit();
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
      checkLimit();
    });

    child.on('error', (spawnError) => finish({ code: null, signal: null, spawnError }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}
