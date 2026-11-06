import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleForAnalysis, lineEdit, nearestOrigin } from '../../core/analysis';

function lineOf(source: string, text: string): number {
  return source.split('\n').indexOf(text);
}

test('the analysis program has no line directives or run markers', () => {
  const { source } = assembleForAnalysis([{ number: 1, source: '#include <stdio.h>\nputs("x");' }]);
  assert.doesNotMatch(source, /#line|ccnb_mark/);
  assert.ok(lineOf(source, '#include <stdio.h>') < lineOf(source, 'int main(void) {'));
  assert.ok(lineOf(source, 'puts("x");') > lineOf(source, 'int main(void) {'));
});

test('every cell line maps to its program line and back', () => {
  const cells = [
    { number: 1, source: 'int a = 1;\n#include <stdio.h>\n\nint b = 2;' },
    { number: 2, source: '//%global\nint helper(void) { return 1; }' },
    { number: 3, source: '#ifdef X\n#include <x.h>\n#endif\nb++;' },
  ];
  const { source, origins, programLines } = assembleForAnalysis(cells);
  const programText = source.split('\n');
  for (const cell of cells) {
    const lines = cell.source.split('\n');
    lines.forEach((text, line) => {
      const programLine = programLines.get(cell.number)?.[line];
      assert.notEqual(programLine, undefined, `cell ${cell.number} line ${line} has a place`);
      assert.equal(programText[programLine as number], text);
      assert.deepEqual(origins[programLine as number], { cell: cell.number, line });
    });
  }
});

test('code in cells keeps its columns', () => {
  const { source } = assembleForAnalysis([{ number: 1, source: '    int indented = 1;' }]);
  assert.ok(source.split('\n').includes('    int indented = 1;'));
});

test('generated lines belong to no cell', () => {
  const { source, origins } = assembleForAnalysis([{ number: 1, source: 'int a;' }]);
  for (const text of ['int main(void) {', 'return 0;', '}']) {
    assert.equal(origins[lineOf(source, text)], undefined);
  }
});

test('a line ending of a cell does not change the program', () => {
  const crlf = assembleForAnalysis([{ number: 1, source: 'int a;\r\nint b;' }]);
  const lf = assembleForAnalysis([{ number: 1, source: 'int a;\nint b;' }]);
  assert.equal(crlf.source, lf.source);
});

test('a generated line is attributed to the closest cell line before it', () => {
  const { source, origins } = assembleForAnalysis([{ number: 1, source: 'if (1) {\nint a;' }]);
  assert.deepEqual(nearestOrigin(origins, lineOf(source, 'return 0;')), { cell: 1, line: 1 });
  assert.equal(nearestOrigin(origins, 0), undefined);
  assert.deepEqual(nearestOrigin(origins, 10_000), { cell: 1, line: 1 });
});

function applyLineEdit(current: string, wanted: string): string {
  const edit = lineEdit(current, wanted);
  if (!edit) {
    return current;
  }
  const lines = current.split('\n');
  const before = lines.slice(0, edit.startLine).map((line) => `${line}\n`).join('');
  const after = lines.slice(edit.endLine).join('\n');
  return before + edit.text + after;
}

test('a line edit changes only the lines that differ', () => {
  assert.equal(lineEdit('a\nb\n', 'a\nb\n'), undefined);
  assert.deepEqual(lineEdit('a\nb\nc\n', 'a\nX\nc\n'), { startLine: 1, endLine: 2, text: 'X\n' });
  assert.deepEqual(lineEdit('a\nc\n', 'a\nb\nc\n'), { startLine: 1, endLine: 1, text: 'b\n' });
  assert.deepEqual(lineEdit('a\nb\nc\n', 'a\nc\n'), { startLine: 1, endLine: 2, text: '' });
});

test('a line edit ignores line endings of the current text', () => {
  assert.equal(lineEdit('a\r\nb\r\n', 'a\nb\n'), undefined);
});

test('a line edit always produces the wanted text', () => {
  const samples = ['', '\n', 'a\n', 'a\nb\n', 'a\na\na\n', 'b\na\nb\n', 'a\nb\nc\nd\n', 'x\n\n\ny\n'];
  for (const current of samples) {
    for (const wanted of samples.filter(Boolean)) {
      assert.equal(applyLineEdit(current, wanted), wanted, `${JSON.stringify(current)} -> ${JSON.stringify(wanted)}`);
    }
  }
});

test('text without a final line break is replaced as a whole', () => {
  assert.deepEqual(lineEdit('a\nb', 'a\nb\n'), { startLine: 0, endLine: 2, text: 'a\nb\n' });
});
