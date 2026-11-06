import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const STDOUT = 'application/vnd.code.notebook.stdout';
const STDERR = 'application/vnd.code.notebook.stderr';

function outputText(cell: vscode.NotebookCell, mime: string): string {
  return cell.outputs
    .flatMap((output) => output.items)
    .filter((item) => item.mime === mime)
    .map((item) => new TextDecoder().decode(item.data))
    .join('');
}

async function open(file: vscode.Uri): Promise<vscode.NotebookDocument> {
  const notebook = await vscode.workspace.openNotebookDocument(file);
  await vscode.window.showNotebookDocument(notebook);
  return notebook;
}

/** Runs cells through the same command as the UI's run button and waits for the result. */
async function runCells(notebook: vscode.NotebookDocument, start: number, end: number): Promise<void> {
  const before = Date.now();
  await vscode.commands.executeCommand('notebook.cell.execute', {
    ranges: [{ start, end }],
    document: notebook.uri,
  });
  const deadline = Date.now() + 120_000;
  const isDone = () =>
    notebook
      .getCells()
      .slice(start, end)
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .every((cell) => (cell.executionSummary?.timing?.endTime ?? 0) >= before);
  while (!isDone()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for cells to finish.');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function setSource(notebook: vscode.NotebookDocument, index: number, source: string): Promise<void> {
  const document = notebook.cellAt(index).document;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), source);
  assert.ok(await vscode.workspace.applyEdit(edit));
}

async function fileFormat(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const file = path.join(workspace, 'demo.ccnb');
  const notebook = await open(vscode.Uri.file(file));
  assert.equal(notebook.notebookType, 'ccnb');
  assert.equal(notebook.metadata.language, 'cpp');
  assert.equal(notebook.cellAt(0).document.languageId, 'cpp');
  assert.equal(notebook.cellAt(1).kind, vscode.NotebookCellKind.Markup);

  // The kernel is selected automatically; a user does not have to pick one.
  await runCells(notebook, 0, 3);
  assert.equal(outputText(notebook.cellAt(0), STDOUT), 'first');
  assert.equal(outputText(notebook.cellAt(2), STDOUT), '42');
  assert.equal(notebook.cellAt(2).executionSummary?.success, true);

  // Running a single later cell still sees state from the earlier ones.
  await runCells(notebook, 2, 3);
  assert.equal(outputText(notebook.cellAt(2), STDOUT), '42');
}

async function languageSwitch(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const file = path.join(workspace, 'demo.ccnb');
  const notebook = await open(vscode.Uri.file(file));

  await setSource(notebook, 0, '#include <stdio.h>\nint class = 7;\nprintf("%d", class);');
  await setSource(notebook, 2, 'printf("[%d]", class + 1);');

  await runCells(notebook, 0, 3);
  assert.equal(notebook.cellAt(0).executionSummary?.success, false, 'class is a keyword in C++');
  assert.match(outputText(notebook.cellAt(0), STDERR), /cell_1:2:/);

  await vscode.commands.executeCommand('ccNotebook.selectLanguage', 'c');
  assert.equal(notebook.metadata.language, 'c');
  assert.equal(notebook.cellAt(0).document.languageId, 'c');
  assert.equal(notebook.cellAt(1).kind, vscode.NotebookCellKind.Markup);

  await runCells(notebook, 0, 3);
  assert.equal(outputText(notebook.cellAt(0), STDOUT), '7');
  assert.equal(outputText(notebook.cellAt(2), STDOUT), '[8]');

  // The choice must survive saving and reopening.
  assert.ok(await notebook.save());
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.language, 'c');
  assert.equal(saved.cells[1].kind, 'markdown');
  assert.equal('outputs' in saved.cells[0], false);
}

async function newCellsFollowLanguage(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const notebook = await open(vscode.Uri.file(path.join(workspace, 'demo.ccnb')));
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.insertCells(notebook.cellCount, [
      new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'printf("new");', 'cpp'),
    ]),
  ]);
  assert.ok(await vscode.workspace.applyEdit(edit));
  const last = notebook.cellCount - 1;
  await runCells(notebook, last, last + 1);
  assert.equal(notebook.cellAt(last).document.languageId, 'c');
  assert.equal(outputText(notebook.cellAt(last), STDOUT), 'new');
  await vscode.commands.executeCommand('workbench.action.files.revert');
}

async function newNotebookCommand(): Promise<void> {
  for (const [language, expected] of [
    ['c', 'Hello from C'],
    ['cpp', 'Hello from C++'],
  ] as const) {
    await vscode.commands.executeCommand('ccNotebook.new', language);
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    assert.ok(notebook);
    assert.equal(notebook.metadata.language, language);
    assert.equal(notebook.cellAt(0).document.languageId, language);
    await runCells(notebook, 0, 1);
    assert.match(outputText(notebook.cellAt(0), STDOUT), new RegExp(`^${expected.replace(/\+/g, '\\+')}\\r?\\n$`));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  }
}

async function cmakeMode(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const file = path.join(workspace, 'cmake.ccnb');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      language: 'c',
      cells: [{ kind: 'code', source: ['#include <stdio.h>', '#include <mylib.h>', 'printf("%d", mylib_answer());'] }],
    }),
  );
  const notebook = await open(vscode.Uri.file(file));

  await runCells(notebook, 0, 1);
  assert.equal(notebook.cellAt(0).executionSummary?.success, false, 'mylib is unknown to the direct build');

  await vscode.commands.executeCommand('ccNotebook.selectBuild', 'cmake');
  await vscode.commands.executeCommand('ccNotebook.configureLinks', ['mylib']);
  assert.equal(notebook.metadata.build, 'cmake');
  assert.deepEqual(notebook.metadata.links, ['mylib']);

  await runCells(notebook, 0, 1);
  assert.equal(outputText(notebook.cellAt(0), STDERR), '');
  assert.equal(outputText(notebook.cellAt(0), STDOUT), '42');

  assert.ok(await notebook.save());
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.build, 'cmake');
  assert.deepEqual(saved.links, ['mylib']);

  await vscode.commands.executeCommand('ccNotebook.cleanBuild');
  await runCells(notebook, 0, 1);
  assert.equal(outputText(notebook.cellAt(0), STDOUT), '42', 'rebuilds after cleaning');
}

async function interrupt(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const file = path.join(workspace, 'loop.ccnb');
  writeFileSync(
    file,
    JSON.stringify({ version: 1, language: 'c', cells: [{ kind: 'code', source: ['for (;;) {}'] }] }),
  );
  const notebook = await open(vscode.Uri.file(file));
  const started = Date.now();
  const run = runCells(notebook, 0, 1);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await vscode.commands.executeCommand('notebook.cell.cancelExecution', {
    ranges: [{ start: 0, end: 1 }],
    document: notebook.uri,
  });
  await run;
  assert.ok(Date.now() - started < 25_000, 'stopped before the 30 s time limit');
  assert.match(outputText(notebook.cellAt(0), STDERR), /Cancelled/);
}

export async function run(): Promise<void> {
  const tests: [string, () => Promise<void>][] = [
    ['opening and running a file', fileFormat],
    ['switching language', languageSwitch],
    ['new cells follow the notebook language', newCellsFollowLanguage],
    ['new notebook command', newNotebookCommand],
    ['CMake mode', cmakeMode],
    ['interrupting a cell', interrupt],
  ];
  const failures: string[] = [];
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`ok - ${name}`);
    } catch (error) {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(`not ok - ${name}\n${text}`);
      failures.push(name);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Failed: ${failures.join(', ')}`);
  }
}
