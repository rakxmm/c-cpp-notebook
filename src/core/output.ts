import { END_OF_MAIN } from './assemble';
import type { ProcessResult } from './process';

export interface CellOutput {
  stdout: string;
  stderr: string;
}

interface ParsedStream {
  /** Text per cell; output printed before main() or after it belongs to the nearest cell. */
  segments: Map<number, string>;
  reached: number[];
  completed: boolean;
}

function parseStream(text: string, nonce: string): ParsedStream {
  const parts = text.split(new RegExp(`\\x1eCCNB:${nonce}:(-?\\d+)\\x1e`));
  const segments = new Map<number, string>();
  const reached: number[] = [];
  let completed = false;

  // split() alternates plain text and captured cell numbers.
  let pending = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const cell = Number(parts[i]);
    const chunk = parts[i + 1];
    if (cell === END_OF_MAIN) {
      completed = true;
      const last = reached.at(-1);
      if (last !== undefined) {
        segments.set(last, (segments.get(last) ?? '') + chunk);
      }
      continue;
    }
    reached.push(cell);
    segments.set(cell, pending + chunk);
    pending = '';
  }
  return { segments, reached, completed };
}

export interface ProgramOutcome {
  outputs: Map<number, CellOutput>;
  reached: number[];
  completed: boolean;
  /** Set when the program did not end cleanly. */
  failure?: string;
}

const WINDOWS_EXIT_CODES: Record<number, string> = {
  0xc0000005: 'access violation',
  0xc00000fd: 'stack overflow',
  0xc0000094: 'integer division by zero',
  0xc000001d: 'illegal instruction',
};

function describeFailure(result: ProcessResult, timeoutMs?: number): string | undefined {
  if (result.spawnError) {
    return `Could not start the program: ${result.spawnError.message}`;
  }
  switch (result.stopReason) {
    case 'timeout':
      return `Stopped after the ${(timeoutMs ?? 0) / 1000} s time limit (setting ccNotebook.timeoutSeconds).`;
    case 'cancelled':
      return 'Cancelled.';
    case 'output-limit':
      return 'Stopped because the program printed too much output.';
  }
  if (result.signal) {
    return `The program was terminated by signal ${result.signal}.`;
  }
  if (result.code === null || result.code === 0) {
    return undefined;
  }
  const known = WINDOWS_EXIT_CODES[result.code];
  if (known) {
    return `The program crashed: ${known} (0x${result.code.toString(16).toUpperCase()}).`;
  }
  return `The program exited with code ${result.code}.`;
}

export function parseProgramResult(
  result: ProcessResult,
  nonce: string,
  timeoutMs?: number,
): ProgramOutcome {
  const out = parseStream(result.stdout, nonce);
  const err = parseStream(result.stderr, nonce);
  // The stdout marker is written first, so stdout is never behind stderr.
  const reached = out.reached.length >= err.reached.length ? out.reached : err.reached;

  const outputs = new Map<number, CellOutput>();
  for (const cell of reached) {
    outputs.set(cell, {
      stdout: out.segments.get(cell) ?? '',
      stderr: err.segments.get(cell) ?? '',
    });
  }
  return {
    outputs,
    reached,
    completed: out.completed,
    failure: describeFailure(result, timeoutMs),
  };
}

const DIAGNOSTIC_CELL = /\bcell_(\d+)[:(]/g;
const WARNING_LINE = /^cell_(\d+):\d+(?::\d+)?: warning:/;

/** Picks the cell that should display build errors: the first requested one they mention. */
export function diagnosticCell(output: string, requested: number[]): number {
  for (const match of output.matchAll(DIAGNOSTIC_CELL)) {
    const cell = Number(match[1]);
    if (requested.includes(cell)) {
      return cell;
    }
  }
  return requested[0];
}

export function warningsByCell(output: string): Map<number, string> {
  const warnings = new Map<number, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = WARNING_LINE.exec(line);
    if (match) {
      const cell = Number(match[1]);
      warnings.set(cell, `${warnings.get(cell) ?? ''}${line}\n`);
    }
  }
  return warnings;
}
