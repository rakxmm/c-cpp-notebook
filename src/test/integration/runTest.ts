import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Runs the suite in an isolated VS Code instance; nothing is installed into the user's one. */
function vscodeExecutable(): string {
  if (process.env.CCNB_VSCODE) {
    return process.env.CCNB_VSCODE;
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Microsoft VS Code', 'Code.exe');
  }
  return 'code';
}

function main(): void {
  const extensionRoot = path.resolve(__dirname, '../../..');
  const sandbox = mkdtempSync(path.join(os.tmpdir(), 'ccnb-integration-'));
  const workspace = path.join(sandbox, 'workspace');
  cpSync(path.join(extensionRoot, 'test-fixtures', 'cmake-project'), workspace, { recursive: true });
  writeFileSync(
    path.join(workspace, 'demo.ccnb'),
    JSON.stringify({
      version: 1,
      language: 'cpp',
      cells: [
        { kind: 'code', source: ['#include <iostream>', 'int x = 40;', 'std::cout << "first";'] },
        { kind: 'markdown', source: ['# Heading'] },
        { kind: 'code', source: ['x += 2;', 'std::cout << x;'] },
      ],
    }),
  );

  const env: NodeJS.ProcessEnv = { ...process.env, CCNB_TEST_WORKSPACE: workspace };
  // Inherited from a parent Electron or VS Code process, these would break the new instance.
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith('VSCODE_')) {
      delete env[key];
    }
  }

  const child = spawn(
    vscodeExecutable(),
    [
      workspace,
      '--new-window',
      '--disable-extensions',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      `--user-data-dir=${path.join(sandbox, 'user-data')}`,
      `--extensions-dir=${path.join(sandbox, 'extensions')}`,
      `--extensionDevelopmentPath=${extensionRoot}`,
      `--extensionTestsPath=${path.join(__dirname, 'suite.js')}`,
    ],
    { env, stdio: 'inherit' },
  );
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('close', (code) => {
    console.log(`VS Code test run finished with code ${code}`);
    process.exitCode = code ?? 1;
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });
}

main();
