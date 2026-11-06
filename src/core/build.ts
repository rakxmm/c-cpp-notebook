import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CodeCell, Language } from './assemble';
import type { BuildSystem } from './format';
import type { ProcessResult } from './process';

export interface LanguageTools {
  compiler: string;
  compileArgs: string[];
  linkArgs: string[];
}

export interface RunRequest {
  language: Language;
  build: BuildSystem;
  links: string[];
  /** Every code cell up to and including the last requested one, in notebook order. */
  cells: CodeCell[];
  /** Cells whose output should be shown. */
  requested: number[];
  tools: Record<Language, LanguageTools>;
  cmakePath: string;
  /** Identifies the notebook across runs, e.g. its URI. */
  notebookId: string;
  storageDir: string;
  /** Working directory of the program; local headers are also resolved from here. */
  workingDir: string;
  /** Root of the surrounding project; used by CMake when it has a CMakeLists.txt. */
  projectRoot?: string;
  timeoutMs?: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface BuildResult {
  ok: boolean;
  output: string;
  executable: string;
  cancelled: boolean;
}

export interface BuildContext {
  request: RunRequest;
  compiler: string;
  source: string;
  runtime: string;
  dir: string;
  env: NodeJS.ProcessEnv;
}

/** Leaves untouched files alone so that incremental builds do not recompile them. */
export async function writeIfChanged(file: string, content: string): Promise<void> {
  const current = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (current !== content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

export function processOutput(result: ProcessResult): string {
  if (result.spawnError) {
    return result.spawnError.message;
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n');
}

export function failedBuild(result: ProcessResult, executable: string): BuildResult {
  return {
    ok: false,
    output: processOutput(result),
    executable,
    cancelled: result.stopReason === 'cancelled',
  };
}
