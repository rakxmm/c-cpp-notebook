import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { assemble, runtimeSource } from './assemble';
import {
  failedBuild,
  processOutput,
  writeIfChanged,
  type BuildContext,
  type BuildResult,
  type RunRequest,
} from './build';
import { buildWithCMake } from './cmake';
import { diagnosticCell, parseProgramResult, warningsByCell } from './output';
import { runProcess } from './process';
import { resolveCompiler, withToolDir } from './tools';

export interface CellReport {
  stdout: string;
  stderr: string;
  error?: string;
  /** undefined means that the cell did not run. */
  success: boolean | undefined;
}

const MAX_OUTPUT_CHARS = 10_000_000;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** All build files of one notebook. */
export function notebookStorageDir(storageDir: string, notebookId: string): string {
  return path.join(storageDir, sha(notebookId));
}

/**
 * Each configuration gets its own directory. Switching language or compiler therefore can
 * never reuse objects or a CMake cache created for a different one.
 */
export function buildDirectory(request: RunRequest, compiler: string): string {
  const tools = request.tools[request.language];
  const config = JSON.stringify([
    request.language,
    request.build,
    compiler,
    tools.compileArgs,
    tools.linkArgs,
    request.links,
    request.workingDir,
  ]);
  return path.join(notebookStorageDir(request.storageDir, request.notebookId), sha(config));
}

async function buildDirect(context: BuildContext): Promise<BuildResult> {
  const { request, compiler, dir, env } = context;
  const tools = request.tools[request.language];
  const extension = request.language === 'cpp' ? 'cpp' : 'c';
  const source = path.join(dir, `notebook.${extension}`);
  const runtimeSourceFile = path.join(dir, `ccnb_runtime.${extension}`);
  const runtimeObject = path.join(dir, 'ccnb_runtime.o');
  const executable = path.join(dir, process.platform === 'win32' ? 'notebook.exe' : 'notebook');
  const options = { cwd: dir, env, signal: request.signal };

  await writeIfChanged(source, context.source);
  await writeIfChanged(runtimeSourceFile, context.runtime);

  // The runtime pulls in <iostream>, which is slow to compile and never changes.
  const hasRuntime = await fs.access(runtimeObject).then(
    () => true,
    () => false,
  );
  if (!hasRuntime) {
    const temporary = `${runtimeObject}.${randomBytes(4).toString('hex')}.tmp`;
    const compiled = await runProcess(
      compiler,
      ['-c', runtimeSourceFile, ...tools.compileArgs, '-o', temporary],
      options,
    );
    if (compiled.code !== 0) {
      return failedBuild(compiled, executable);
    }
    await fs.rename(temporary, runtimeObject);
  }

  const compiled = await runProcess(
    compiler,
    [
      source,
      runtimeObject,
      ...tools.compileArgs,
      `-I${request.workingDir}`,
      '-o',
      executable,
      ...request.links.map((link) => `-l${link}`),
      ...tools.linkArgs,
    ],
    options,
  );
  if (compiled.code !== 0) {
    return failedBuild(compiled, executable);
  }
  return { ok: true, output: processOutput(compiled), executable, cancelled: false };
}

/** Compiles the cells, runs the program and reports the result for each requested cell. */
export async function runNotebook(request: RunRequest): Promise<Map<number, CellReport>> {
  const baseEnv = request.env ?? process.env;
  const tools = request.tools[request.language];
  const compiler = resolveCompiler(request.language, tools.compiler, baseEnv);
  const env = withToolDir(baseEnv, path.dirname(compiler));
  const { source, globalCells } = assemble(request.language, request.cells);

  const dir = buildDirectory(request, compiler);
  await fs.mkdir(dir, { recursive: true });
  const context: BuildContext = {
    request,
    compiler,
    source,
    runtime: runtimeSource(request.language),
    dir,
    env,
  };
  const build = request.build === 'cmake' ? await buildWithCMake(context) : await buildDirect(context);

  const reports = new Map<number, CellReport>();
  if (!build.ok) {
    const target = diagnosticCell(build.output, request.requested);
    for (const cell of request.requested) {
      reports.set(cell, { stdout: '', stderr: '', success: false });
    }
    reports.set(target, {
      stdout: '',
      stderr: build.cancelled ? '' : build.output,
      error: build.cancelled ? 'Cancelled.' : undefined,
      success: false,
    });
    return reports;
  }

  const nonce = randomBytes(8).toString('hex');
  const result = await runProcess(build.executable, [], {
    cwd: request.workingDir,
    env: { ...env, CCNB_MARKER: nonce },
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    maxOutputChars: MAX_OUTPUT_CHARS,
  });
  const outcome = parseProgramResult(result, nonce, request.timeoutMs);
  const warnings = warningsByCell(build.output);
  const lastReached = outcome.reached.at(-1);

  for (const cell of request.requested) {
    const warning = warnings.get(cell) ?? '';
    if (globalCells.has(cell)) {
      reports.set(cell, { stdout: '', stderr: warning, success: true });
      continue;
    }
    const output = outcome.outputs.get(cell);
    if (output) {
      const failed = outcome.failure !== undefined && cell === lastReached;
      reports.set(cell, {
        stdout: output.stdout,
        stderr: warning + output.stderr,
        error: failed ? outcome.failure : undefined,
        success: !failed,
      });
      continue;
    }
    let note: string;
    if (lastReached === undefined) {
      note = outcome.failure ?? 'The program ended before this cell.';
    } else if (outcome.failure) {
      note = `Not run: cell_${lastReached} failed. ${outcome.failure}`;
    } else {
      note = `Not run: the program ended in cell_${lastReached}.`;
    }
    reports.set(cell, { stdout: '', stderr: warning, error: note, success: undefined });
  }
  return reports;
}
