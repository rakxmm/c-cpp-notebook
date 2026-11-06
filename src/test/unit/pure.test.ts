import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assemble } from '../../core/assemble';
import { generateWrapper } from '../../core/cmake';
import { parseNotebook, serializeNotebook } from '../../core/format';
import { diagnosticCell, warningsByCell } from '../../core/output';

test('includes move to file scope and keep their line numbers', () => {
  const { source } = assemble('c', [
    { number: 1, source: 'int a = 1;\n#include <stdio.h>\nint b = 2;' },
  ]);
  const beforeMain = source.slice(0, source.indexOf('int main'));
  const inMain = source.slice(source.indexOf('int main'));
  assert.match(beforeMain, /#line 2 "cell_1"\n#include <stdio\.h>/);
  assert.doesNotMatch(inMain, /#include/);
  assert.match(inMain, /#line 1 "cell_1"\nint a = 1;\n\nint b = 2;/);
});

test('a conditional block containing an include moves as a whole', () => {
  const { source } = assemble('c', [
    { number: 1, source: '#ifdef _WIN32\n#include <windows.h>\n#endif\nint a = 1;' },
  ]);
  const beforeMain = source.slice(0, source.indexOf('int main'));
  assert.match(beforeMain, /#ifdef _WIN32\n#include <windows\.h>\n#endif/);
});

test('a conditional block without an include stays in main', () => {
  const { source } = assemble('c', [{ number: 1, source: '#ifdef X\nint a = 1;\n#endif' }]);
  assert.ok(source.indexOf('#ifdef X') > source.indexOf('int main'));
});

test('global cells stay at file scope in their original order', () => {
  const { source, globalCells } = assemble('cpp', [
    { number: 1, source: '//%global\n#define _GNU_SOURCE\n#include <stdio.h>' },
    { number: 2, source: 'puts("x");' },
    { number: 3, source: '  // %global  \nint helper() { return 1; }' },
  ]);
  assert.deepEqual([...globalCells], [1, 3]);
  const main = source.indexOf('int main');
  assert.ok(source.indexOf('#define _GNU_SOURCE') < source.indexOf('#include <stdio.h>'));
  assert.ok(source.indexOf('#include <stdio.h>') < main);
  assert.ok(source.indexOf('int helper()') < main);
  assert.ok(source.indexOf('puts("x")') > main);
});

test('the notebook format round-trips', () => {
  const notebook = {
    language: 'c' as const,
    build: 'cmake' as const,
    links: ['mylib'],
    cells: [
      { kind: 'code' as const, source: 'int a;\nint b;' },
      { kind: 'markdown' as const, source: '# Title' },
    ],
  };
  assert.deepEqual(parseNotebook(serializeNotebook(notebook), 'cpp'), notebook);
});

test('an empty file uses the default language', () => {
  assert.equal(parseNotebook('', 'c').language, 'c');
  assert.equal(parseNotebook('  \n', 'cpp').language, 'cpp');
});

test('an unknown language or build mode is rejected rather than silently changed', () => {
  assert.throws(() => parseNotebook('{"language":"rust"}', 'cpp'), /Unknown notebook language/);
  assert.throws(() => parseNotebook('{"language":"c","build":"make"}', 'cpp'), /Unknown build mode/);
  assert.throws(() => parseNotebook('{broken', 'cpp'), SyntaxError);
});

test('build errors go to the first requested cell they mention', () => {
  const output = "notebook.cpp: In function 'int main()':\ncell_1:1:1: error: a\ncell_3:2:5: error: b\n";
  assert.equal(diagnosticCell(output, [3, 4]), 3);
  assert.equal(diagnosticCell(output, [4]), 4);
  assert.equal(diagnosticCell('cell_12(3): error', [12]), 12);
});

test('warnings are grouped by cell', () => {
  const warnings = warningsByCell(
    'cell_2:1:5: warning: unused\ncell_2:3:1: warning: other\n[1/2] Building\ncell_4:2:2: warning: x\n',
  );
  assert.deepEqual([...warnings.keys()], [2, 4]);
  assert.match(warnings.get(2) ?? '', /unused[\s\S]*other/);
});

test('the wrapper quotes values so they cannot break out of CMake arguments', () => {
  const wrapper = generateWrapper({
    language: 'c',
    sources: ['notebook.c'],
    includeDir: 'C:\\my dir\\$x',
    compileArgs: ['-std=c17'],
    linkItems: ['evil")\nmessage("pwned'],
  });
  assert.match(wrapper, /"C:\/my dir\/\\\$x"/);
  assert.match(wrapper, /"evil\\"\)\nmessage\(\\"pwned"/);
  assert.match(wrapper, /LANGUAGES C\)/);
  assert.doesNotMatch(wrapper, /add_subdirectory/);
});
