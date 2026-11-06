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

async function eventually(check: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function hoverContents(hovers: vscode.Hover[] | undefined): string {
  return (hovers ?? [])
    .flatMap((hover) => hover.contents)
    .map((content) => (typeof content === 'string' ? content : content.value))
    .join('\n');
}

function hoverAt(cell: vscode.NotebookCell, position: vscode.Position) {
  return vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', cell.document.uri, position);
}

/** Uses a stand-in for a C/C++ tool, which serves real files and never notebook cells. */
async function intelliSense(): Promise<void> {
  const workspace = process.env.CCNB_TEST_WORKSPACE as string;
  const file = path.join(workspace, 'intellisense.ccnb');
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      language: 'c',
      cells: [
        { kind: 'code', source: ['#include <stdio.h>', 'int shared = 1;'] },
        { kind: 'markdown', source: ['# Heading'] },
        { kind: 'code', source: ['//%global', 'static int helper(void) { return 2; }'] },
        { kind: 'code', source: ['printf("%d", shared);'] },
      ],
    }),
  );

  let hidden: vscode.TextDocument | undefined;
  const selector: vscode.DocumentSelector = [
    { scheme: 'file', language: 'c' },
    { scheme: 'file', language: 'cpp' },
  ];
  const standIn = [
    vscode.languages.registerHoverProvider(selector, {
      provideHover(document, position) {
        hidden = document;
        return new vscode.Hover(
          new vscode.MarkdownString(`${document.lineAt(position.line).text}@${position.character}`),
          document.getWordRangeAtPosition(position),
        );
      },
    }),
    vscode.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(document, position) {
          const item = new vscode.CompletionItem(`line:${document.lineAt(position.line).text}`);
          item.range = new vscode.Range(position.line, 0, position.line, position.character);
          return [item];
        },
      },
      '.',
    ),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(document) {
        const start = document.positionAt(document.getText().indexOf('int shared'));
        // Real tools can spell the path differently from the document, e.g. a long form on Windows.
        const respelled = document.uri.with({ path: document.uri.path.toUpperCase() });
        return new vscode.Location(respelled, new vscode.Range(start, start.translate(0, 10)));
      },
    }),
    vscode.languages.registerSignatureHelpProvider(
      selector,
      {
        provideSignatureHelp(document, position) {
          const help = new vscode.SignatureHelp();
          help.signatures = [new vscode.SignatureInformation(document.lineAt(position.line).text)];
          return help;
        },
      },
      '(',
    ),
  ];
  const standInErrors = vscode.languages.createDiagnosticCollection('stand-in');

  try {
    // Opened as from the UI: an API reference would keep the notebook open for minutes after closing.
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), 'ccnb');
    const notebook = vscode.window.activeNotebookEditor?.notebook as vscode.NotebookDocument;
    assert.equal(notebook.uri.fsPath, vscode.Uri.file(file).fsPath);
    const [first, , global, last] = notebook.getCells();

    // Columns and the requested word map back into the cell.
    const hovers = await hoverAt(last, new vscode.Position(0, 15));
    assert.equal(hoverContents(hovers), 'printf("%d", shared);@15');
    assert.deepEqual(hovers[0].range, new vscode.Range(0, 13, 0, 19));

    assert.ok(hidden);
    const program = hidden;
    assert.equal(program.languageId, 'c');
    assert.equal(program.uri.scheme, 'file');
    assert.ok(
      !vscode.window.visibleTextEditors.some((editor) => editor.document.uri.toString() === program.uri.toString()),
      'no editor shows the hidden file',
    );

    // Hoisted and file-scope lines answer too.
    assert.equal(hoverContents(await hoverAt(first, new vscode.Position(0, 2))), '#include <stdio.h>@2');
    assert.equal(
      hoverContents(await hoverAt(global, new vscode.Position(1, 12))),
      'static int helper(void) { return 2; }@12',
    );

    // An unsaved edit in a cell reaches the tool before the request does.
    await setSource(notebook, 3, 'shared++;\nshared.');
    assert.equal(hoverContents(await hoverAt(last, new vscode.Position(0, 1))), 'shared++;@1');

    const position = new vscode.Position(1, 7);
    const list = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      last.document.uri,
      position,
      '.',
    );
    const item = list.items.find((candidate) => String(candidate.label).startsWith('line:'));
    assert.equal(item?.label, 'line:shared.');
    assert.deepEqual(item?.range, new vscode.Range(1, 0, 1, 7));

    const definitions = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      'vscode.executeDefinitionProvider',
      last.document.uri,
      position,
    );
    const definition = definitions[0];
    const definitionUri = 'targetUri' in definition ? definition.targetUri : definition.uri;
    const definitionRange = 'targetUri' in definition ? definition.targetRange : definition.range;
    assert.equal(definitionUri.toString(), first.document.uri.toString(), 'goes to the cell, not the hidden file');
    assert.deepEqual(definitionRange, new vscode.Range(1, 0, 1, 10));

    const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>(
      'vscode.executeSignatureHelpProvider',
      last.document.uri,
      new vscode.Position(0, 1),
      '(',
    );
    assert.equal(signature.signatures[0].label, 'shared++;');

    // Errors of the program show up on the cell that caused them, including generated lines.
    const lines = program.getText().split(/\r?\n/);
    const errorLine = lines.indexOf('shared++;');
    const hintLine = lines.indexOf('shared.');
    standInErrors.set(program.uri, [
      new vscode.Diagnostic(new vscode.Range(errorLine, 0, errorLine, 6), 'in the last cell'),
      new vscode.Diagnostic(
        new vscode.Range(hintLine, 0, hintLine, 6),
        'a hint',
        vscode.DiagnosticSeverity.Hint,
      ),
      new vscode.Diagnostic(new vscode.Range(lines.indexOf('return 0;'), 0, lines.indexOf('return 0;'), 6), 'unbalanced'),
    ]);
    await eventually(() => vscode.languages.getDiagnostics(last.document.uri).length === 2, 'errors reach the cell');
    const errors = vscode.languages.getDiagnostics(last.document.uri);
    assert.deepEqual(errors[0].range, new vscode.Range(0, 0, 0, 6));
    assert.equal(errors[0].message, 'in the last cell');
    assert.equal(errors[1].message, 'unbalanced');
    assert.equal(errors[1].range.start.line, 1, 'the closest cell line before the generated one');

    standInErrors.set(program.uri, []);
    await eventually(() => vscode.languages.getDiagnostics(last.document.uri).length === 0, 'fixed errors go away');

    // VS Code opens a tab for a file that stays unsaved too long, so typing must not delay the save.
    for (let i = 0; i < 12; i++) {
      await setSource(notebook, 3, `shared++;\nshared.\n// ${i}`);
      await hoverAt(last, new vscode.Position(0, 1));
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await eventually(() => !program.isDirty, 'the hidden file gets saved');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const tabUris = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .map((tab) => (tab.input as { uri?: vscode.Uri } | undefined)?.uri?.toString());
    assert.ok(!tabUris.includes(program.uri.toString()), 'no tab opens for the hidden file');

    // Tools choose their mode by file extension.
    await vscode.commands.executeCommand('ccNotebook.selectLanguage', 'cpp');
    assert.equal(hoverContents(await hoverAt(notebook.cellAt(3), new vscode.Position(0, 1))), 'shared++;@1');
    const cppProgram = hidden as vscode.TextDocument;
    assert.equal(cppProgram.languageId, 'cpp');
    assert.equal(program.getText().split(/\r?\n/).filter(Boolean).length, 1, 'the old file holds only its header');

    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await eventually(
      () => cppProgram.getText().split(/\r?\n/).filter(Boolean).length === 1,
      'closing the notebook blanks its hidden file',
    );
    await eventually(() => !cppProgram.isDirty, 'and leaves it saved');
  } finally {
    standIn.forEach((provider) => provider.dispose());
    standInErrors.dispose();
  }
}

export async function run(): Promise<void> {
  const tests: [string, () => Promise<void>][] = [
    ['IntelliSense in cells', intelliSense],
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
