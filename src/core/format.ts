import type { Language } from './assemble';

export type BuildSystem = 'direct' | 'cmake';

export interface NotebookSettings {
  language: Language;
  build: BuildSystem;
  links: string[];
}

export interface StoredCell {
  kind: 'code' | 'markdown';
  source: string;
}

export interface StoredNotebook extends NotebookSettings {
  cells: StoredCell[];
}

export function normalizeSettings(
  value: Record<string, unknown> | undefined,
  defaultLanguage: Language,
): NotebookSettings {
  const language = value?.language === 'c' || value?.language === 'cpp' ? value.language : defaultLanguage;
  const build = value?.build === 'cmake' ? 'cmake' : 'direct';
  const links = Array.isArray(value?.links)
    ? value.links.filter((link): link is string => typeof link === 'string')
    : [];
  return { language, build, links };
}

export function parseNotebook(text: string, defaultLanguage: Language): StoredNotebook {
  if (text.trim() === '') {
    return { language: defaultLanguage, build: 'direct', links: [], cells: [] };
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  if (raw.language !== 'c' && raw.language !== 'cpp') {
    throw new Error(`Unknown notebook language: ${String(raw.language)}. Expected "c" or "cpp".`);
  }
  if (raw.build !== undefined && raw.build !== 'direct' && raw.build !== 'cmake') {
    throw new Error(`Unknown build mode: ${String(raw.build)}. Expected "direct" or "cmake".`);
  }
  const rawCells = Array.isArray(raw.cells) ? (raw.cells as Record<string, unknown>[]) : [];
  const cells = rawCells.map(
    (cell): StoredCell => ({
      kind: cell.kind === 'markdown' ? 'markdown' : 'code',
      source: Array.isArray(cell.source) ? cell.source.join('\n') : String(cell.source ?? ''),
    }),
  );
  return { ...normalizeSettings(raw, defaultLanguage), cells };
}

/** Sources are stored as line arrays so that notebook diffs stay readable. */
export function serializeNotebook(notebook: StoredNotebook): string {
  const content = {
    version: 1,
    language: notebook.language,
    build: notebook.build,
    links: notebook.links,
    cells: notebook.cells.map((cell) => ({
      kind: cell.kind,
      source: cell.source.split(/\r?\n/),
    })),
  };
  return `${JSON.stringify(content, null, 2)}\n`;
}
