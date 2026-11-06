# C/C++ Notebook

Notebooks for C and C++ in VS Code, stored as `.ccnb` files. Each notebook is either C or C++.

## Requirements

- VS Code 1.90 or newer
- `gcc`/`g++` or `clang`/`clang++`
- For the CMake build mode: CMake and either Ninja or Make

## Installation

The extension is not on the Marketplace, so searching for it in the Extensions view finds nothing until it is installed. Install it from a `.vsix` package instead.

Build the package from this repository:

```bash
npm ci
```

```bash
npm run package
```

Then install the resulting file:

```bash
code --install-extension c-cpp-notebook-0.1.0.vsix
```

You can also use **Extensions > ... > Install from VSIX...** in VS Code.

After that, the extension is listed in the Extensions view under `@installed C/C++ Notebook`. If a `.ccnb` file opens as plain text right after installing, close it and open it again from the Explorer.

## Usage

- Create one with **File > New File > C/C++ Notebook**, or open any `.ccnb` file.
- The toolbar shows the language (`C` / `C++`) and the build mode (`Direct` / `CMake`). Click to change them; the choice is saved in the file.

## How cells run

Running a cell compiles every code cell up to it into one program and runs that program from the start. Only the requested cells show output.

- A cell is the body of `main()`, so variables carry over to later cells.
- `#include` lines move to the top of the file automatically.
- Start a cell with `//%global` to place it outside `main()`, for functions, types and anything that must come before the includes, such as `#define _GNU_SOURCE`.
- Errors refer to code cells as `cell_N:line:column`, counting code cells only.
- The program runs in the notebook's folder. Local headers and relative file paths resolve from there.

Because everything runs again from the first cell, side effects repeat and time-dependent values change between runs. Outputs are not saved. Standard input is empty, so `scanf` and `cin` get end of file straight away.

## Build modes

**Direct** calls `gcc`/`g++` or `clang`/`clang++`. Compilers are searched for on `PATH`, then in the usual MSYS2 and LLVM folders on Windows.

**CMake** needs CMake and either Ninja or Make. If the workspace root has a `CMakeLists.txt`, the notebook is built on top of it, so its library targets can be used:

1. Switch the build mode to `CMake`.
2. Click the library icon in the toolbar (under `...` in a narrow window) and enter the targets to link, e.g. `mylib`.
3. Use `#include <mylib.h>` in a cell.

The project is added with `add_subdirectory`, so it should use `CMAKE_CURRENT_SOURCE_DIR` rather than `CMAKE_SOURCE_DIR`. Build files are kept in VS Code's extension storage, not in your project. **C/C++ Notebook: Clean Build Files** removes them.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ccNotebook.c.compiler`, `ccNotebook.cpp.compiler` | automatic | Compiler name or path |
| `ccNotebook.c.compileArgs` | `-std=c17` | C compiler flags |
| `ccNotebook.cpp.compileArgs` | `-std=c++20` | C++ compiler flags |
| `ccNotebook.c.linkArgs` | `-lm` | C linker flags |
| `ccNotebook.cpp.linkArgs` | none | C++ linker flags |
| `ccNotebook.cmake.path` | automatic | CMake name or path |
| `ccNotebook.timeoutSeconds` | `30` | Time limit for the program; `0` turns it off |
| `ccNotebook.defaultLanguage` | `cpp` | Language of an empty `.ccnb` file |

MSVC is not supported. The extension is disabled in untrusted workspaces because cells run as normal programs, without a sandbox.

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run test:integration
```

```bash
npm run package
```
