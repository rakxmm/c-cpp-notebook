import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Language } from './core/assemble';
import type { RunRequest } from './core/build';
import {
  normalizeSettings,
  parseNotebook,
  serializeNotebook,
  type BuildSystem,
  type NotebookSettings,
  type StoredNotebook,
} from './core/format';
import { notebookStorageDir, runNotebook } from './core/runner';
import { ToolError } from './core/tools';

const VIEW_TYPE = 'ccnb';

const LANGUAGE_LABELS: Record<Language, string> = { c: 'C', cpp: 'C++' };

const STARTER_CELLS: Record<Language, string> = {
  c: '#include <stdio.h>\n\nprintf("Hello from C\\n");',
  cpp: '#include <iostream>\n\nstd::cout << "Hello from C++\\n";',
};

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('ccNotebook');
}

function defaultLanguage(): Language {
  return configuration().get<string>('defaultLanguage') === 'c' ? 'c' : 'cpp';
}

function settingsOf(notebook: vscode.NotebookDocument): NotebookSettings {
  return normalizeSettings(notebook.metadata, defaultLanguage());
}

function toNotebookData(stored: StoredNotebook): vscode.NotebookData {
  const cells = stored.cells.map((cell) =>
    cell.kind === 'markdown'
      ? new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, cell.source, 'markdown')
      : new vscode.NotebookCellData(vscode.NotebookCellKind.Code, cell.source, stored.language),
  );
  const data = new vscode.NotebookData(cells);
  data.metadata = { language: stored.language, build: stored.build, links: stored.links };
  return data;
}

const serializer: vscode.NotebookSerializer = {
  deserializeNotebook(content) {
    return toNotebookData(parseNotebook(new TextDecoder().decode(content), defaultLanguage()));
  },
  serializeNotebook(data) {
    const text = serializeNotebook({
      ...normalizeSettings(data.metadata, defaultLanguage()),
      cells: data.cells.map((cell) => ({
        kind: cell.kind === vscode.NotebookCellKind.Markup ? 'markdown' : 'code',
        source: cell.value,
      })),
    });
    return new TextEncoder().encode(text);
  },
};

/** A notebook has one language, while VS Code tracks a language per cell. */
async function syncCellLanguages(notebook: vscode.NotebookDocument): Promise<void> {
  const { language } = settingsOf(notebook);
  for (const cell of notebook.getCells()) {
    if (cell.kind === vscode.NotebookCellKind.Code && cell.document.languageId !== language) {
      await vscode.languages.setTextDocumentLanguage(cell.document, language);
    }
  }
}

async function updateSettings(
  notebook: vscode.NotebookDocument,
  changes: Partial<NotebookSettings>,
): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.set(notebook.uri, [
    vscode.NotebookEdit.updateNotebookMetadata({ ...notebook.metadata, ...changes }),
  ]);
  await vscode.workspace.applyEdit(edit);
  await syncCellLanguages(notebook);
  updateContextKeys();
}

function updateContextKeys(): void {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  const settings = notebook?.notebookType === VIEW_TYPE ? settingsOf(notebook) : undefined;
  void vscode.commands.executeCommand('setContext', 'ccNotebook.language', settings?.language);
  void vscode.commands.executeCommand('setContext', 'ccNotebook.build', settings?.build);
}

function activeNotebook(): vscode.NotebookDocument | undefined {
  const notebook = vscode.window.activeNotebookEditor?.notebook;
  return notebook?.notebookType === VIEW_TYPE ? notebook : undefined;
}

function textOutput(item: vscode.NotebookCellOutputItem): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([item]);
}

class NotebookKernel implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  // A program runs from the first cell, so runs of the same notebook must not overlap.
  private readonly queues = new Map<string, Promise<void>>();
  private executionOrder = 0;

  constructor(private readonly storageDir: string) {
    this.controller = vscode.notebooks.createNotebookController(
      'ccnb-compiler',
      VIEW_TYPE,
      'C/C++ Compiler',
    );
    this.controller.supportedLanguages = ['c', 'cpp'];
    this.controller.supportsExecutionOrder = true;
    this.controller.executeHandler = (cells, notebook) => this.enqueue(cells, notebook);
  }

  dispose(): void {
    this.controller.dispose();
  }

  private enqueue(cells: vscode.NotebookCell[], notebook: vscode.NotebookDocument): Promise<void> {
    const key = notebook.uri.toString();
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.execute(cells, notebook));
    this.queues.set(key, next);
    return next;
  }

  private async execute(
    cells: vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    const requestedCells = cells
      .filter((cell) => cell.kind === vscode.NotebookCellKind.Code)
      .sort((a, b) => a.index - b.index);
    if (requestedCells.length === 0) {
      return;
    }
    await syncCellLanguages(notebook);

    const abort = new AbortController();
    const executions = requestedCells.map((cell) => {
      const execution = this.controller.createNotebookCellExecution(cell);
      execution.executionOrder = ++this.executionOrder;
      execution.token.onCancellationRequested(() => abort.abort());
      execution.start(Date.now());
      return execution;
    });
    await Promise.all(executions.map((execution) => execution.clearOutput()));

    const codeCells = notebook.getCells().filter((cell) => cell.kind === vscode.NotebookCellKind.Code);
    const numberOf = (cell: vscode.NotebookCell) => codeCells.indexOf(cell) + 1;
    const lastIndex = requestedCells[requestedCells.length - 1].index;

    try {
      const reports = await runNotebook(
        this.createRequest(
          notebook,
          codeCells
            .filter((cell) => cell.index <= lastIndex)
            .map((cell) => ({ number: numberOf(cell), source: cell.document.getText() })),
          requestedCells.map(numberOf),
          abort.signal,
        ),
      );
      for (let i = 0; i < requestedCells.length; i++) {
        const report = reports.get(numberOf(requestedCells[i]));
        const outputs: vscode.NotebookCellOutput[] = [];
        if (report?.stdout) {
          outputs.push(textOutput(vscode.NotebookCellOutputItem.stdout(report.stdout)));
        }
        if (report?.stderr) {
          outputs.push(textOutput(vscode.NotebookCellOutputItem.stderr(report.stderr)));
        }
        if (report?.error) {
          outputs.push(textOutput(vscode.NotebookCellOutputItem.stderr(`${report.error}\n`)));
        }
        await executions[i].replaceOutput(outputs);
        executions[i].end(report?.success, Date.now());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await executions[0].replaceOutput([
        textOutput(vscode.NotebookCellOutputItem.stderr(`${message}\n`)),
      ]);
      for (const execution of executions) {
        execution.end(false, Date.now());
      }
      if (error instanceof ToolError) {
        void this.offerToolFix(error, notebook);
      }
    }
  }

  private createRequest(
    notebook: vscode.NotebookDocument,
    cells: RunRequest['cells'],
    requested: number[],
    signal: AbortSignal,
  ): RunRequest {
    const settings = settingsOf(notebook);
    const config = configuration();
    const toolsFor = (language: Language) => ({
      compiler: config.get<string>(`${language}.compiler`) ?? '',
      compileArgs: config.get<string[]>(`${language}.compileArgs`) ?? [],
      linkArgs: config.get<string[]>(`${language}.linkArgs`) ?? [],
    });

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(notebook.uri)?.uri.fsPath;
    const anyFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const workingDir =
      notebook.uri.scheme === 'file'
        ? path.dirname(notebook.uri.fsPath)
        : (anyFolder ?? os.homedir());
    const timeoutSeconds = config.get<number>('timeoutSeconds') ?? 0;

    return {
      ...settings,
      cells,
      requested,
      tools: { c: toolsFor('c'), cpp: toolsFor('cpp') },
      cmakePath: config.get<string>('cmake.path') ?? '',
      notebookId: notebook.uri.toString(),
      storageDir: this.storageDir,
      workingDir,
      projectRoot: workspaceFolder ?? workingDir,
      timeoutMs: timeoutSeconds > 0 ? timeoutSeconds * 1000 : undefined,
      signal,
    };
  }

  private async offerToolFix(error: ToolError, notebook: vscode.NotebookDocument): Promise<void> {
    if (error.tool === 'compiler') {
      const action = await vscode.window.showErrorMessage(error.message, 'Open Settings');
      if (action) {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'ccNotebook');
      }
      return;
    }
    const action = await vscode.window.showErrorMessage(error.message, 'Use Direct Build');
    if (action) {
      await updateSettings(notebook, { build: 'direct' });
    }
  }
}

/** Commands take an explicit value when called programmatically; toolbar clicks pass objects. */
async function selectLanguage(value?: unknown): Promise<void> {
  const notebook = activeNotebook();
  if (!notebook) {
    return;
  }
  let language: Language | undefined = value === 'c' || value === 'cpp' ? value : undefined;
  if (!language) {
    const current = settingsOf(notebook).language;
    const picked = await vscode.window.showQuickPick(
      (['c', 'cpp'] as const).map((id) => ({
        id,
        label: LANGUAGE_LABELS[id],
        description: id === current ? 'current' : undefined,
      })),
      { title: 'Notebook language' },
    );
    language = picked?.id;
  }
  if (language) {
    await updateSettings(notebook, { language });
  }
}

async function selectBuild(value?: unknown): Promise<void> {
  const notebook = activeNotebook();
  if (!notebook) {
    return;
  }
  let build: BuildSystem | undefined = value === 'direct' || value === 'cmake' ? value : undefined;
  if (!build) {
    const current = settingsOf(notebook).build;
    const options: { id: BuildSystem; label: string; detail: string }[] = [
      { id: 'direct', label: 'Direct', detail: 'Call the compiler directly. Fast and needs no CMake.' },
      {
        id: 'cmake',
        label: 'CMake',
        detail: "Build with CMake and use the libraries from the workspace's CMakeLists.txt.",
      },
    ];
    const picked = await vscode.window.showQuickPick(
      options.map((option) => ({
        ...option,
        description: option.id === current ? 'current' : undefined,
      })),
      { title: 'Notebook build mode' },
    );
    build = picked?.id;
  }
  if (build) {
    await updateSettings(notebook, { build });
  }
}

async function configureLinks(value?: unknown): Promise<void> {
  const notebook = activeNotebook();
  if (!notebook) {
    return;
  }
  let links: string[] | undefined = Array.isArray(value) ? value : undefined;
  if (!links) {
    const input = await vscode.window.showInputBox({
      title: 'Linked libraries',
      prompt: 'Comma-separated system libraries or targets from the CMake project, e.g. mylib, pthread',
      value: settingsOf(notebook).links.join(', '),
    });
    if (input === undefined) {
      return;
    }
    links = input
      .split(',')
      .map((link) => link.trim())
      .filter(Boolean);
  }
  await updateSettings(notebook, { links });
}

async function newNotebook(value?: unknown): Promise<void> {
  let language: Language | undefined = value === 'c' || value === 'cpp' ? value : undefined;
  if (!language) {
    const picked = await vscode.window.showQuickPick(
      (['cpp', 'c'] as const).map((id) => ({ id, label: LANGUAGE_LABELS[id] })),
      { title: 'New notebook language' },
    );
    language = picked?.id;
  }
  if (!language) {
    return;
  }
  const data = toNotebookData({
    language,
    build: 'direct',
    links: [],
    cells: [{ kind: 'code', source: STARTER_CELLS[language] }],
  });
  const document = await vscode.workspace.openNotebookDocument(VIEW_TYPE, data);
  await vscode.window.showNotebookDocument(document);
}

export function activate(context: vscode.ExtensionContext): void {
  const storageDir = path.join(context.globalStorageUri.fsPath, 'builds');

  const cleanBuild = async () => {
    const notebook = activeNotebook();
    if (notebook) {
      await fs.rm(notebookStorageDir(storageDir, notebook.uri.toString()), {
        recursive: true,
        force: true,
      });
      void vscode.window.showInformationMessage('Build files of this notebook were removed.');
    }
  };

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(VIEW_TYPE, serializer, { transientOutputs: true }),
    new NotebookKernel(storageDir),
    vscode.commands.registerCommand('ccNotebook.new', newNotebook),
    vscode.commands.registerCommand('ccNotebook.selectLanguage', selectLanguage),
    vscode.commands.registerCommand('ccNotebook.selectBuild', selectBuild),
    vscode.commands.registerCommand('ccNotebook.configureLinks', configureLinks),
    vscode.commands.registerCommand('ccNotebook.cleanBuild', cleanBuild),
    vscode.commands.registerCommand('ccNotebook.toolbar.languageC', () => selectLanguage()),
    vscode.commands.registerCommand('ccNotebook.toolbar.languageCpp', () => selectLanguage()),
    vscode.commands.registerCommand('ccNotebook.toolbar.buildDirect', () => selectBuild()),
    vscode.commands.registerCommand('ccNotebook.toolbar.buildCMake', () => selectBuild()),
    vscode.window.onDidChangeActiveNotebookEditor(updateContextKeys),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.notebookType !== VIEW_TYPE) {
        return;
      }
      if (event.metadata) {
        updateContextKeys();
      }
      // New cells inherit a language from VS Code, which may not match the notebook.
      if (event.contentChanges.some((change) => change.addedCells.length > 0)) {
        void syncCellLanguages(event.notebook);
      }
    }),
  );
  updateContextKeys();
}

export function deactivate(): void {}
