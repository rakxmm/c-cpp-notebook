import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import type { Language } from '../../core/assemble';
import type { RunRequest } from '../../core/build';
import { buildDirectory, runNotebook } from '../../core/runner';
import { ToolError } from '../../core/tools';

const root = mkdtempSync(path.join(os.tmpdir(), 'ccnb-test-'));
after(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function freshDir(name = 'work'): string {
  const dir = path.join(root, `${counter++}`, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function request(
  language: Language,
  sources: string[],
  overrides: Partial<RunRequest> = {},
): RunRequest {
  const tools = {
    c: { compiler: '', compileArgs: ['-std=c17'], linkArgs: ['-lm'] },
    cpp: { compiler: '', compileArgs: ['-std=c++20'], linkArgs: [] },
  };
  const cells = sources.map((source, i) => ({ number: i + 1, source }));
  return {
    language,
    build: 'direct',
    links: [],
    cells,
    requested: cells.map((cell) => cell.number),
    tools,
    cmakePath: '',
    notebookId: `notebook-${counter++}`,
    storageDir: path.join(root, 'storage'),
    workingDir: freshDir(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('language selection', () => {
  test('a C notebook compiles as C', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nint class = 7;\nprintf("%d %d\\n", class, __STDC_VERSION__ > 0);']),
    );
    assert.equal(reports.get(1)?.success, true);
    assert.match(reports.get(1)?.stdout ?? '', /7 1/);
  });

  test('C++ code does not compile in a C notebook', async () => {
    const reports = await runNotebook(request('c', ['#include <iostream>\nstd::cout << 1;']));
    assert.equal(reports.get(1)?.success, false);
    assert.notEqual(reports.get(1)?.stderr, '');
  });

  test('a C++ notebook compiles as C++', async () => {
    const reports = await runNotebook(
      request('cpp', ['#include <iostream>\n#include <vector>\nstd::vector<int> v{1, 2};\nstd::cout << v.size() << "\\n";']),
    );
    assert.equal(reports.get(1)?.success, true);
    assert.match(reports.get(1)?.stdout ?? '', /^2\r?\n$/);
  });

  test('C-only code does not compile in a C++ notebook', async () => {
    const reports = await runNotebook(request('cpp', ['int class = 1;']));
    assert.equal(reports.get(1)?.success, false);
    assert.match(reports.get(1)?.stderr ?? '', /cell_1:1:/);
  });

  test('switching language or compiler never reuses a build directory', () => {
    const base = request('c', ['']);
    const directories = new Set([
      buildDirectory(base, 'gcc'),
      buildDirectory({ ...base, language: 'cpp' }, 'gcc'),
      buildDirectory(base, 'clang'),
      buildDirectory({ ...base, build: 'cmake' }, 'gcc'),
      buildDirectory({ ...base, links: ['m'] }, 'gcc'),
    ]);
    assert.equal(directories.size, 5);
  });

  test('the same notebook can switch between C and C++', async () => {
    const shared = { notebookId: 'switching', workingDir: freshDir() };
    const first = await runNotebook(request('c', ['#include <stdio.h>\nputs("c");'], shared));
    const second = await runNotebook(request('cpp', ['#include <iostream>\nstd::cout << "cpp";'], shared));
    const third = await runNotebook(request('c', ['#include <stdio.h>\nputs("c again");'], shared));
    assert.match(first.get(1)?.stdout ?? '', /^c\r?\n$/);
    assert.equal(second.get(1)?.stdout, 'cpp');
    assert.match(third.get(1)?.stdout ?? '', /^c again\r?\n$/);
  });
});

describe('cells', () => {
  test('variables are shared and output belongs to its own cell', async () => {
    const reports = await runNotebook(
      request('c', [
        '#include <stdio.h>\nint x = 20;\nprintf("first\\n");',
        'x += 22;\nfprintf(stderr, "to stderr\\n");',
        'printf("%d\\n", x);',
      ]),
    );
    assert.match(reports.get(1)?.stdout ?? '', /^first\r?\n$/);
    assert.equal(reports.get(2)?.stdout, '');
    assert.match(reports.get(2)?.stderr ?? '', /^to stderr\r?\n$/);
    assert.match(reports.get(3)?.stdout ?? '', /^42\r?\n$/);
  });

  test('only requested cells report, but earlier cells still run', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nint x = 5;\nputs("hidden");', 'printf("%d", x);'], {
        requested: [2],
      }),
    );
    assert.deepEqual([...reports.keys()], [2]);
    assert.equal(reports.get(2)?.stdout, '5');
  });

  test('global cells define functions and types usable by later cells', async () => {
    const reports = await runNotebook(
      request('cpp', [
        '//%global\n#include <iostream>\nstruct Point { int x; };\nint twice(int v) { return v * 2; }',
        'Point p{21};\nstd::cout << twice(p.x);',
      ]),
    );
    assert.equal(reports.get(1)?.success, true);
    assert.equal(reports.get(1)?.stdout, '');
    assert.equal(reports.get(2)?.stdout, '42');
  });

  test('a feature macro in a global cell comes before every system header', async () => {
    const reports = await runNotebook(
      request('c', [
        '//%global\n#define CCNB_FEATURE 1\n#include <stdio.h>',
        '#ifndef CCNB_FEATURE\n#error missing\n#endif\nputs("ok");',
      ]),
    );
    assert.equal(reports.get(2)?.success, true);
  });

  test('a missing include stays an error', async () => {
    const reports = await runNotebook(request('cpp', ['std::cout << 1;']));
    assert.equal(reports.get(1)?.success, false);
    assert.match(reports.get(1)?.stderr ?? '', /cell_1:1:/);
  });

  test('compile errors point at the correct cell and line', async () => {
    const reports = await runNotebook(
      request('c', ['int a = 1;', 'int b = 2;\n\nint c = missing;', 'int d = 4;']),
    );
    assert.match(reports.get(2)?.stderr ?? '', /cell_2:3:\d+: error/);
    assert.equal(reports.get(1)?.stderr, '');
    assert.equal(reports.get(2)?.success, false);
    assert.equal(reports.get(3)?.success, false);
  });

  test('a warning is shown only in the cell that causes it', async () => {
    const base = request('c', ['int a = 1;', 'unsigned u = 1; int b = u < -1;'], {
      tools: {
        c: { compiler: '', compileArgs: ['-std=c17', '-Wall', '-Wextra'], linkArgs: [] },
        cpp: { compiler: '', compileArgs: [], linkArgs: [] },
      },
    });
    const reports = await runNotebook(base);
    assert.equal(reports.get(2)?.success, true);
    assert.match(reports.get(2)?.stderr ?? '', /cell_2:1:\d+: warning/);
    assert.doesNotMatch(reports.get(1)?.stderr ?? '', /cell_2/);
  });

  test('sync_with_stdio(false) output stays in the right cell', async () => {
    const reports = await runNotebook(
      request('cpp', [
        '#include <iostream>\nstd::ios::sync_with_stdio(false);\nstd::cout << "one";',
        'std::cout << "two";',
      ]),
    );
    assert.equal(reports.get(1)?.stdout, 'one');
    assert.equal(reports.get(2)?.stdout, 'two');
  });

  test('printing the marker prefix cannot fake a cell boundary', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nprintf("\\036CCNB:0000:2\\036x");', 'puts("y");']),
    );
    assert.match(reports.get(1)?.stdout ?? '', /CCNB:0000:2/);
    assert.match(reports.get(2)?.stdout ?? '', /^y\r?\n$/);
  });

  test('UTF-8 output survives', async () => {
    const reports = await runNotebook(request('c', ['#include <stdio.h>\nputs("žltý kôň");']));
    assert.match(reports.get(1)?.stdout ?? '', /žltý kôň/);
  });
});

describe('program behaviour', () => {
  test('a crash is reported on the crashing cell and later cells do not run', async () => {
    const reports = await runNotebook(
      request('c', [
        '#include <stdio.h>\nputs("before");',
        'int *p = 0;\nvolatile int v = *p;\n(void)v;',
        'puts("after");',
      ]),
    );
    assert.equal(reports.get(1)?.success, true);
    assert.match(reports.get(1)?.stdout ?? '', /before/);
    assert.equal(reports.get(2)?.success, false);
    assert.match(reports.get(2)?.error ?? '', /crashed|signal/);
    assert.equal(reports.get(3)?.success, undefined);
    assert.match(reports.get(3)?.error ?? '', /Not run: cell_2 failed/);
  });

  test('a non-zero exit code fails the cell that returned it', async () => {
    const reports = await runNotebook(request('c', ['return 3;', 'int x = 1; (void)x;']));
    assert.equal(reports.get(1)?.success, false);
    assert.match(reports.get(1)?.error ?? '', /code 3/);
    assert.equal(reports.get(2)?.success, undefined);
  });

  test('an early return 0 leaves later cells not run without an error', async () => {
    const reports = await runNotebook(request('c', ['return 0;', 'int x = 1; (void)x;']));
    assert.equal(reports.get(1)?.success, true);
    assert.equal(reports.get(2)?.success, undefined);
    assert.match(reports.get(2)?.error ?? '', /ended in cell_1/);
  });

  test('stdin is at end of file, so reading it does not hang', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nint n = 0;\nprintf("%d", scanf("%d", &n) == EOF);']),
    );
    assert.equal(reports.get(1)?.stdout, '1');
  });

  test('the program runs in the working directory and finds local files', async () => {
    const workingDir = freshDir();
    writeFileSync(path.join(workingDir, 'data.txt'), '123');
    writeFileSync(path.join(workingDir, 'local.h'), '#define LOCAL 9\n');
    const reports = await runNotebook(
      request(
        'c',
        [
          '#include <stdio.h>\n#include "local.h"\nFILE *f = fopen("data.txt", "r");\nint n = 0;\nif (f) fscanf(f, "%d", &n);\nprintf("%d %d", n, LOCAL);',
        ],
        { workingDir },
      ),
    );
    assert.equal(reports.get(1)?.stdout, '123 9');
  });

  test('an infinite loop stops at the time limit', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nputs("start");\nfflush(stdout);', 'for (;;) {}'], {
        timeoutMs: 1000,
      }),
    );
    assert.match(reports.get(1)?.stdout ?? '', /start/);
    assert.equal(reports.get(2)?.success, false);
    assert.match(reports.get(2)?.error ?? '', /time limit/);
  });

  test('cancelling stops a running program', async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 3000);
    const reports = await runNotebook(request('c', ['for (;;) {}'], { signal: abort.signal }));
    assert.match(reports.get(1)?.error ?? '', /Cancelled/);
    assert.ok(Date.now() - started < 15000);
  });

  test('endless output stops at the output limit', async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nfor (;;) { puts("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); }'], {
        timeoutMs: 60000,
      }),
    );
    assert.match(reports.get(1)?.error ?? '', /too much output/);
  });

  test('paths with spaces and diacritics work', async () => {
    const workingDir = freshDir('môj notebook');
    writeFileSync(path.join(workingDir, 'local.h'), '#define LOCAL 5\n');
    const reports = await runNotebook(
      request('cpp', ['#include <iostream>\n#include "local.h"\nstd::cout << LOCAL;'], {
        workingDir,
        storageDir: path.join(freshDir('úložisko s medzerou')),
      }),
    );
    assert.equal(reports.get(1)?.stdout, '5');
  });

  test('a missing compiler raises a helpful ToolError', async () => {
    const base = request('c', ['']);
    base.tools.c.compiler = 'no-such-compiler';
    await assert.rejects(runNotebook(base), (error: Error) => {
      assert.ok(error instanceof ToolError);
      assert.equal(error.tool, 'compiler');
      assert.match(error.message, /ccNotebook\.c\.compiler/);
      return true;
    });
  });
});

describe('CMake', () => {
  const fixture = path.resolve(__dirname, '../../../test-fixtures/cmake-project');

  function project(): string {
    const dir = freshDir('cmake project');
    cpSync(fixture, dir, { recursive: true });
    return dir;
  }

  const MAX_BUILD_MS = 180_000;

  test('works without a project', { timeout: MAX_BUILD_MS }, async () => {
    const reports = await runNotebook(
      request('cpp', ['#include <iostream>\nint x = 1;\nstd::cout << x;', 'std::cout << x + 1;'], {
        build: 'cmake',
      }),
    );
    assert.equal(reports.get(1)?.stdout, '1');
    assert.equal(reports.get(2)?.stdout, '2');
  });

  test('a C notebook stays C under CMake', { timeout: MAX_BUILD_MS }, async () => {
    const reports = await runNotebook(
      request('c', ['#include <stdio.h>\nint class = 3;\nprintf("%d", class);'], { build: 'cmake' }),
    );
    assert.equal(reports.get(1)?.stdout, '3');
  });

  for (const language of ['c', 'cpp'] as const) {
    test(`links a library target of the project (${language})`, { timeout: MAX_BUILD_MS }, async () => {
      const projectRoot = project();
      const print = language === 'c' ? 'printf("%d", mylib_answer());' : 'std::cout << mylib_answer();';
      const include = language === 'c' ? '#include <stdio.h>' : '#include <iostream>';
      const reports = await runNotebook(
        request(language, [`${include}\n#include <mylib.h>\n${print}`], {
          build: 'cmake',
          links: ['mylib'],
          projectRoot,
          workingDir: projectRoot,
        }),
      );
      assert.equal(reports.get(1)?.stderr, '');
      assert.equal(reports.get(1)?.stdout, '42');
    });
  }

  test('rebuilds after the project changes and reconfigures after its CMakeLists changes', { timeout: MAX_BUILD_MS }, async () => {
    const projectRoot = project();
    const options: Partial<RunRequest> = {
      build: 'cmake',
      links: ['mylib'],
      projectRoot,
      workingDir: projectRoot,
      notebookId: 'project-changes',
    };
    const cells = ['#include <stdio.h>\n#include <mylib.h>\nprintf("%d", mylib_answer());'];
    assert.equal((await runNotebook(request('c', cells, options))).get(1)?.stdout, '42');

    const library = path.join(projectRoot, 'mylib.c');
    writeFileSync(library, readFileSync(library, 'utf8').replace('42', '43'));
    assert.equal((await runNotebook(request('c', cells, options))).get(1)?.stdout, '43');

    const lists = path.join(projectRoot, 'CMakeLists.txt');
    writeFileSync(
      lists,
      `${readFileSync(lists, 'utf8')}target_compile_definitions(mylib PRIVATE ANSWER=44)\n`,
    );
    writeFileSync(library, '#include "mylib.h"\nint mylib_answer(void) { return ANSWER; }\n');
    assert.equal((await runNotebook(request('c', cells, options))).get(1)?.stdout, '44');
  });

  test('compile errors keep the cell and line', { timeout: MAX_BUILD_MS }, async () => {
    const reports = await runNotebook(
      request('c', ['int a = 1;\n(void)a;', 'int b = missing;'], { build: 'cmake' }),
    );
    assert.equal(reports.get(2)?.success, false);
    assert.match(reports.get(2)?.stderr ?? '', /cell_2:1:\d+: error/);
  });

  test('an unknown library fails the build instead of running stale code', { timeout: MAX_BUILD_MS }, async () => {
    const reports = await runNotebook(
      request('c', ['int a = 1;\n(void)a;'], { build: 'cmake', links: ['no_such_library_xyz'] }),
    );
    assert.equal(reports.get(1)?.success, false);
    assert.match(reports.get(1)?.stderr ?? '', /no_such_library_xyz/);
  });

  test('a broken project reports the CMake error', { timeout: MAX_BUILD_MS }, async () => {
    const projectRoot = project();
    writeFileSync(path.join(projectRoot, 'CMakeLists.txt'), 'this_is_not_a_command()\n');
    const options: Partial<RunRequest> = {
      build: 'cmake',
      projectRoot,
      workingDir: projectRoot,
      notebookId: 'broken-project',
    };
    const first = await runNotebook(request('c', ['int a = 1;\n(void)a;'], options));
    assert.equal(first.get(1)?.success, false);
    assert.match(first.get(1)?.stderr ?? '', /this_is_not_a_command/);

    // Fixing the project must recover without manually cleaning the build directory.
    cpSync(path.join(fixture, 'CMakeLists.txt'), path.join(projectRoot, 'CMakeLists.txt'));
    const second = await runNotebook(request('c', ['int a = 1;\n(void)a;'], options));
    assert.equal(second.get(1)?.success, true);
  });

  test('a missing CMake raises a ToolError', async () => {
    await assert.rejects(
      runNotebook(request('c', [''], { build: 'cmake', cmakePath: 'no-such-cmake' })),
      (error: Error) => {
        assert.ok(error instanceof ToolError);
        assert.equal(error.tool, 'cmake');
        return true;
      },
    );
  });
});
