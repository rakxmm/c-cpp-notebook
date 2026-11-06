import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  ANALYSIS_HEADER,
  assembleForAnalysis,
  lineEdit,
  nearestOrigin,
  type AnalysisProgram,
} from './core/analysis';
import type { Language } from './core/assemble';
import { notebookStorageDir } from './core/runner';

const SYNC_DELAY_MS = 300;
const CELL_SCHEME = 'vscode-notebook-cell';
const COMPLETION_TRIGGERS = ['.', '>', ':', '#', '<', '"', '/'];
const SIGNATURE_TRIGGERS = ['(', ','];

interface Snapshot {
  document: vscode.TextDocument;
  program: AnalysisProgram;
  cells: vscode.NotebookCell[];
}

function sameUri(a: vscode.Uri, b: vscode.Uri): boolean {
  return a.toString() === b.toString();
}

/**
 * Tools can answer with another spelling of a path, such as its long form on Windows. The
 * hidden file's folder is unique to its notebook, so the end of the path is enough to tell.
 */
function isSameHiddenFile(uri: vscode.Uri, hidden: vscode.Uri): boolean {
  const pathEnd = (value: vscode.Uri) => value.path.split('/').slice(-2).join('/').toLowerCase();
  return uri.scheme === hidden.scheme && pathEnd(uri) === pathEnd(hidden);
}

/** VS Code then saves the file itself, opens no tab for it and runs no formatter on it. */
function autoSavesSoon(uri: vscode.Uri): boolean {
  const files = vscode.workspace.getConfiguration('files', uri);
  return files.get('autoSave') === 'afterDelay' && (files.get<number>('autoSaveDelay') ?? 1000) <= 1000;
}

async function applyLineEdit(document: vscode.TextDocument, wanted: string): Promise<boolean> {
  const edit = lineEdit(document.getText(), wanted);
  if (!edit) {
    return false;
  }
  const change = new vscode.WorkspaceEdit();
  change.replace(
    document.uri,
    document.validateRange(new vscode.Range(edit.startLine, 0, edit.endLine, 0)),
    edit.text,
  );
  await vscode.workspace.applyEdit(change);
  return true;
}

/**
 * C/C++ tools serve real files only, so they never see a notebook cell. Each notebook
 * therefore keeps its whole program in a file that no editor shows, and requests from a
 * cell are forwarded to that file. The file also gives a cell what it lacks on its own:
 * the includes and variables of the other cells.
 *
 * The file changes through document edits because only those reach the tools before the
 * forwarded request does. They leave the document unsaved, and every 800 ms VS Code opens
 * a background tab for files in that state, so each edit is followed by a save at once
 * and a tab that opens anyway gets closed. A save can run formatters on the file, which
 * the next sync undoes.
 */
class HiddenProgram {
  private queue: Promise<unknown> = Promise.resolve();
  private snapshot: Snapshot | undefined;
  private syncTimer: NodeJS.Timeout | undefined;
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('ccnb-intellisense');

  constructor(
    private readonly notebook: vscode.NotebookDocument,
    private readonly storageDir: string,
    private readonly languageOf: (notebook: vscode.NotebookDocument) => Language,
  ) {}

  sync(): Promise<Snapshot> {
    return this.enqueue(() => this.syncNow());
  }

  scheduleSync(): void {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(() => void this.sync().catch(console.error), SYNC_DELAY_MS);
  }

  onDiagnosticsChanged(uris: readonly vscode.Uri[]): void {
    const snapshot = this.snapshot;
    // Tools drop the errors of a file VS Code closed for being unused. The cells did not change.
    if (snapshot && !snapshot.document.isClosed && uris.some((uri) => sameUri(uri, snapshot.document.uri))) {
      this.publishDiagnostics(snapshot);
    }
  }

  /** The notebook was closed: blanks the file so that its errors leave the Problems panel. */
  close(): void {
    this.dispose();
    const document = this.snapshot?.document;
    if (document && !document.isClosed) {
      void this.enqueue(() => this.retire(document)).catch(console.error);
    }
  }

  dispose(): void {
    clearTimeout(this.syncTimer);
    this.diagnostics.dispose();
  }

  /** Closes a tab of the hidden file. It runs in the queue so that no edit makes the file unsaved first. */
  closeTabIfHidden(tab: vscode.Tab): void {
    const input = tab.input;
    const document = this.snapshot?.document;
    if (document && input instanceof vscode.TabInputText && sameUri(input.uri, document.uri)) {
      void this.enqueue(async () => {
        await this.saveNow();
        await vscode.window.tabGroups.close(tab, true);
      }).catch(console.error);
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async syncNow(): Promise<Snapshot> {
    const cells = this.notebook.getCells().filter((cell) => cell.kind === vscode.NotebookCellKind.Code);
    const program = assembleForAnalysis(
      cells.map((cell, index) => ({ number: index + 1, source: cell.document.getText() })),
    );
    const document = await this.openDocument(program.source);
    this.snapshot = { document, program, cells };
    if ((await applyLineEdit(document, program.source)) && !autoSavesSoon(document.uri)) {
      // A separate task, so that the caller's request leaves first: a formatter run by the
      // save then changes the file only after the tool has that request.
      setTimeout(() => void this.enqueue(() => this.saveNow()).catch(console.error), 0);
    }
    return this.snapshot;
  }

  private async openDocument(source: string): Promise<vscode.TextDocument> {
    const extension = this.languageOf(this.notebook) === 'cpp' ? 'cpp' : 'c';
    const file = path.join(
      notebookStorageDir(this.storageDir, this.notebook.uri.toString()),
      `${path.basename(this.notebook.uri.path)}.${extension}`,
    );
    const uri = vscode.Uri.file(file);
    const current = this.snapshot?.document;
    if (current && !current.isClosed) {
      if (sameUri(current.uri, uri)) {
        return current;
      }
      await this.retire(current);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source);
    return vscode.workspace.openTextDocument(uri);
  }

  private async retire(document: vscode.TextDocument): Promise<void> {
    await applyLineEdit(document, `${ANALYSIS_HEADER}\n`);
    await document.save();
  }

  private async saveNow(): Promise<void> {
    const document = this.snapshot?.document;
    if (document && !document.isClosed && document.isDirty) {
      await document.save();
    }
  }

  private publishDiagnostics(snapshot: Snapshot): void {
    const byCell = new Map<string, { uri: vscode.Uri; items: vscode.Diagnostic[] }>();
    for (const diagnostic of vscode.languages.getDiagnostics(snapshot.document.uri)) {
      // Spell checkers and the like report on cells themselves, and they use the lower severities.
      if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) {
        continue;
      }
      const target = diagnosticTarget(snapshot, diagnostic.range);
      if (!target) {
        continue;
      }
      const mapped = new vscode.Diagnostic(target.range, diagnostic.message, diagnostic.severity);
      mapped.code = diagnostic.code;
      mapped.source = diagnostic.source;
      mapped.tags = diagnostic.tags;
      const key = target.uri.toString();
      const entry = byCell.get(key) ?? { uri: target.uri, items: [] };
      entry.items.push(mapped);
      byCell.set(key, entry);
    }
    this.diagnostics.clear();
    for (const { uri, items } of byCell.values()) {
      this.diagnostics.set(uri, items);
    }
  }
}

function toCell(snapshot: Snapshot, range: vscode.Range): { uri: vscode.Uri; range: vscode.Range } | undefined {
  const start = snapshot.program.origins[range.start.line];
  if (!start) {
    return undefined;
  }
  const end = snapshot.program.origins[range.end.line];
  // A range can run past the cell, whose next program line may belong to another one.
  const endPosition =
    end?.cell === start.cell
      ? new vscode.Position(end.line, range.end.character)
      : new vscode.Position(start.line, Number.MAX_SAFE_INTEGER);
  return {
    uri: snapshot.cells[start.cell - 1].document.uri,
    range: new vscode.Range(new vscode.Position(start.line, range.start.character), endPosition),
  };
}

function diagnosticTarget(
  snapshot: Snapshot,
  range: vscode.Range,
): { uri: vscode.Uri; range: vscode.Range } | undefined {
  const exact = toCell(snapshot, range);
  if (exact) {
    return exact;
  }
  const nearest = nearestOrigin(snapshot.program.origins, range.start.line);
  return nearest
    ? {
        uri: snapshot.cells[nearest.cell - 1].document.uri,
        range: new vscode.Range(nearest.line, 0, nearest.line, Number.MAX_SAFE_INTEGER),
      }
    : undefined;
}

function toCellLink(
  snapshot: Snapshot,
  result: vscode.Location | vscode.LocationLink,
): vscode.LocationLink | undefined {
  const uri = 'targetUri' in result ? result.targetUri : result.uri;
  const range = 'targetUri' in result ? result.targetRange : result.range;
  const selection = 'targetUri' in result ? result.targetSelectionRange : undefined;
  if (!isSameHiddenFile(uri, snapshot.document.uri)) {
    return { targetUri: uri, targetRange: range, targetSelectionRange: selection };
  }
  const target = toCell(snapshot, range);
  return target
    ? {
        targetUri: target.uri,
        targetRange: target.range,
        targetSelectionRange: selection && toCell(snapshot, selection)?.range,
      }
    : undefined;
}

export function registerNotebookIntelliSense(
  viewType: string,
  storageDir: string,
  languageOf: (notebook: vscode.NotebookDocument) => Language,
): vscode.Disposable {
  const programs = new Map<string, HiddenProgram>();

  const programOf = (notebook: vscode.NotebookDocument): HiddenProgram => {
    const key = notebook.uri.toString();
    let program = programs.get(key);
    if (!program) {
      program = new HiddenProgram(notebook, storageDir, languageOf);
      programs.set(key, program);
    }
    return program;
  };

  const notebookOf = (document: vscode.TextDocument): vscode.NotebookDocument | undefined =>
    document.uri.scheme === CELL_SCHEME
      ? vscode.workspace.notebookDocuments.find(
          (notebook) =>
            notebook.notebookType === viewType &&
            notebook.getCells().some((cell) => sameUri(cell.document.uri, document.uri)),
        )
      : undefined;

  /** Brings the hidden file up to date and finds the position of a cell's text in it. */
  const locate = async (document: vscode.TextDocument, position: vscode.Position) => {
    const notebook = notebookOf(document);
    if (!notebook) {
      return undefined;
    }
    const snapshot = await programOf(notebook).sync();
    const number = snapshot.cells.findIndex((cell) => sameUri(cell.document.uri, document.uri)) + 1;
    const line = snapshot.program.programLines.get(number)?.[position.line];
    return line === undefined
      ? undefined
      : { snapshot, position: new vscode.Position(line, position.character) };
  };

  const selector: vscode.DocumentSelector = [
    { notebookType: viewType, language: 'c' },
    { notebookType: viewType, language: 'cpp' },
  ];

  const completionProvider: vscode.CompletionItemProvider = {
    async provideCompletionItems(document, position, _token, context) {
      const target = await locate(document, position);
      if (!target) {
        return undefined;
      }
      const list = await vscode.commands.executeCommand<vscode.CompletionList | undefined>(
        'vscode.executeCompletionItemProvider',
        target.snapshot.document.uri,
        target.position,
        context.triggerCharacter,
      );
      if (!list) {
        return undefined;
      }
      // Completions replace text on the cursor's line, whose columns match the cell's.
      const onCursorLine = (range: vscode.Range) =>
        new vscode.Range(position.line, range.start.character, position.line, range.end.character);
      for (const item of list.items) {
        // Results carry this deprecated copy of the range, and it takes precedence over `range`.
        item.textEdit = undefined;
        if (item.range instanceof vscode.Range) {
          item.range = onCursorLine(item.range);
        } else if (item.range) {
          item.range = {
            inserting: onCursorLine(item.range.inserting),
            replacing: onCursorLine(item.range.replacing),
          };
        }
        item.additionalTextEdits = item.additionalTextEdits?.flatMap((edit) => {
          const mapped = toCell(target.snapshot, edit.range);
          return mapped && sameUri(mapped.uri, document.uri)
            ? [new vscode.TextEdit(mapped.range, edit.newText)]
            : [];
        });
      }
      return new vscode.CompletionList(list.items, list.isIncomplete);
    },
  };

  const hoverProvider: vscode.HoverProvider = {
    async provideHover(document, position) {
      const target = await locate(document, position);
      if (!target) {
        return undefined;
      }
      const hovers = await vscode.commands.executeCommand<vscode.Hover[] | undefined>(
        'vscode.executeHoverProvider',
        target.snapshot.document.uri,
        target.position,
      );
      if (!hovers?.length) {
        return undefined;
      }
      const range = hovers.find((hover) => hover.range)?.range;
      return new vscode.Hover(
        hovers.flatMap((hover) => hover.contents),
        range && toCell(target.snapshot, range)?.range,
      );
    },
  };

  const definitionProvider: vscode.DefinitionProvider = {
    async provideDefinition(document, position) {
      const target = await locate(document, position);
      if (!target) {
        return undefined;
      }
      const results = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[] | undefined>(
        'vscode.executeDefinitionProvider',
        target.snapshot.document.uri,
        target.position,
      );
      return (results ?? []).flatMap((result) => toCellLink(target.snapshot, result) ?? []);
    },
  };

  const signatureProvider: vscode.SignatureHelpProvider = {
    async provideSignatureHelp(document, position, _token, context) {
      const target = await locate(document, position);
      return target
        ? vscode.commands.executeCommand<vscode.SignatureHelp | undefined>(
            'vscode.executeSignatureHelpProvider',
            target.snapshot.document.uri,
            target.position,
            context.triggerCharacter,
          )
        : undefined;
    },
  };

  for (const notebook of vscode.workspace.notebookDocuments) {
    if (notebook.notebookType === viewType) {
      programOf(notebook).scheduleSync();
    }
  }

  return vscode.Disposable.from(
    vscode.languages.registerCompletionItemProvider(selector, completionProvider, ...COMPLETION_TRIGGERS),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerSignatureHelpProvider(selector, signatureProvider, ...SIGNATURE_TRIGGERS),
    vscode.languages.onDidChangeDiagnostics((event) => {
      for (const program of programs.values()) {
        program.onDiagnosticsChanged(event.uris);
      }
    }),
    vscode.workspace.onDidOpenNotebookDocument((notebook) => {
      if (notebook.notebookType === viewType) {
        programOf(notebook).scheduleSync();
      }
    }),
    vscode.workspace.onDidCloseNotebookDocument((notebook) => {
      const key = notebook.uri.toString();
      programs.get(key)?.close();
      programs.delete(key);
    }),
    vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.notebookType === viewType && (event.metadata || event.contentChanges.length > 0)) {
        programOf(event.notebook).scheduleSync();
      }
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const notebook = notebookOf(event.document);
      if (notebook) {
        programOf(notebook).scheduleSync();
      }
    }),
    vscode.window.tabGroups.onDidChangeTabs((event) => {
      // A tab that a user opens is active; the ones VS Code opens for unsaved files are not.
      for (const tab of event.opened.filter((opened) => !opened.isActive)) {
        for (const program of programs.values()) {
          program.closeTabIfHidden(tab);
        }
      }
    }),
    {
      dispose() {
        for (const program of programs.values()) {
          program.dispose();
        }
        programs.clear();
      },
    },
  );
}
