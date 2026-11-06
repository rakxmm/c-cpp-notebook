import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import type { Language } from './assemble';

export type ToolKind = 'compiler' | 'cmake' | 'generator';

export class ToolError extends Error {
  constructor(
    message: string,
    readonly tool: ToolKind,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

const COMPILER_NAMES: Record<Language, string[]> = {
  c: ['gcc', 'clang', 'cc'],
  cpp: ['g++', 'clang++', 'c++'],
};

// Toolchains on Windows are commonly installed without being added to PATH.
const WINDOWS_TOOL_DIRS = [
  'C:\\msys64\\ucrt64\\bin',
  'C:\\msys64\\clang64\\bin',
  'C:\\msys64\\mingw64\\bin',
  'C:\\Program Files\\LLVM\\bin',
  'C:\\Program Files\\CMake\\bin',
];

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
}

function searchDirs(env: NodeJS.ProcessEnv): string[] {
  const fromEnv = (env[pathKey(env)] ?? '').split(path.delimiter).filter(Boolean);
  return process.platform === 'win32' ? [...fromEnv, ...WINDOWS_TOOL_DIRS] : fromEnv;
}

function isFile(candidate: string): boolean {
  return existsSync(candidate) && statSync(candidate).isFile();
}

function findInDirs(name: string, dirs: string[]): string | undefined {
  const fileName = process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name;
  return dirs.map((dir) => path.join(dir, fileName)).find(isFile);
}

/** Resolves a configured name or path, falling back to the first default name that exists. */
function findTool(
  configured: string,
  defaults: string[],
  env: NodeJS.ProcessEnv,
  extraDirs: string[] = [],
): string | undefined {
  const dirs = [...extraDirs, ...searchDirs(env)];
  if (configured) {
    if (path.isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
      return findInDirs(path.basename(configured), [path.dirname(configured)]);
    }
    return findInDirs(configured, dirs);
  }
  for (const name of defaults) {
    const found = findInDirs(name, dirs);
    if (found) {
      return found;
    }
  }
  return undefined;
}

export function resolveCompiler(
  language: Language,
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const found = findTool(configured, COMPILER_NAMES[language], env);
  if (found) {
    return found;
  }
  const label = language === 'cpp' ? 'C++' : 'C';
  const hint = configured
    ? `"${configured}" was not found.`
    : `Install ${COMPILER_NAMES[language].slice(0, 2).join(' or ')}.`;
  throw new ToolError(
    `No ${label} compiler available. ${hint} You can set its path in the setting ccNotebook.${language}.compiler.`,
    'compiler',
  );
}

/** The sibling-language compiler is optional; only CMake projects may need it. */
export function findCompiler(
  language: Language,
  configured: string,
  env: NodeJS.ProcessEnv,
  preferDir: string,
): string | undefined {
  return findTool(configured, COMPILER_NAMES[language], env, [preferDir]);
}

export interface CMakeTools {
  cmake: string;
  generator: string;
  makeProgram: string;
}

const GENERATORS: { tool: string; generator: string }[] = [
  { tool: 'ninja', generator: 'Ninja' },
  { tool: 'mingw32-make', generator: 'MinGW Makefiles' },
  { tool: 'make', generator: 'Unix Makefiles' },
];

export function resolveCMake(
  configured: string,
  compilerDir: string,
  env: NodeJS.ProcessEnv = process.env,
): CMakeTools {
  const cmake = findTool(configured, ['cmake'], env, [compilerDir]);
  if (!cmake) {
    const hint = configured ? `"${configured}" was not found.` : 'Install CMake.';
    throw new ToolError(
      `CMake is not available. ${hint} You can set its path in the setting ccNotebook.cmake.path, or switch this notebook to the direct build.`,
      'cmake',
    );
  }
  // Prefer tools next to the compiler. Left to itself, CMake on Windows may pick Visual
  // Studio, which would ignore the selected compiler.
  const dirs = [compilerDir, path.dirname(cmake), ...searchDirs(env)];
  for (const { tool, generator } of GENERATORS) {
    const makeProgram = findInDirs(tool, dirs);
    if (makeProgram) {
      return { cmake, generator, makeProgram };
    }
  }
  throw new ToolError(
    'CMake needs Ninja or Make, but neither was found. Install one of them, or switch this notebook to the direct build.',
    'generator',
  );
}

/**
 * Puts the compiler's directory first on PATH. Compiled programs need its runtime DLLs
 * on Windows, and the compiler needs its own helpers even if it is not on PATH.
 */
export function withToolDir(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = pathKey(env);
  return { ...env, [key]: [dir, env[key]].filter(Boolean).join(path.delimiter) };
}
