# GDB UI

GDB UI is a VS Code debugging extension for executable-first native debugging with GDB and LLDB.

It is designed for workflows where you want to point directly at an existing binary, debug assembly comfortably, inspect disassembly and memory, and still keep the normal VS Code debugging experience.

## Highlights

- Launch a debug session with `backend: "auto"`, `backend: "gdb"`, or `backend: "lldb"`
- Auto-detect `gdb`, `gdb-multiarch`, and `lldb-dap` from the system environment
- Debug a compiled executable directly
- Stop at `main` for C/C++ programs and `_start` for assembly programs
- Step by instruction
- View disassembly through DAP `disassemble`
- Set source and instruction breakpoints
- Inspect registers, locals, and memory
- Use the sidebar flow or a normal `launch.json`

## Launch configuration

```json
{
  "type": "gdbui",
  "request": "launch",
  "name": "Launch with GDB UI",
  "backend": "auto",
  "program": "${workspaceFolder}/a.out",
  "cwd": "${workspaceFolder}",
  "args": [],
  "stopAtEntry": true,
  "disassemblyFlavor": "intel"
}
```

Auto backend selection uses the binary format and platform to pick a recommended debugger:

- Mach-O on macOS: prefer `lldb-dap`
- ELF on Linux and other non-macOS platforms: prefer `gdb`
- If the recommended debugger is not found, the extension falls back to the other supported backend when possible

Debugger auto-discovery looks for:

- `gdb`
- `gdb-multiarch`
- `lldb-dap`
- macOS also tries `xcrun -f lldb-dap`

## Recommended configurations

### C / C++

Use auto detection for the best default per binary and platform:

```json
{
  "type": "gdbui",
  "request": "launch",
  "name": "Debug C or C++",
  "backend": "auto",
  "program": "${workspaceFolder}/a.out",
  "cwd": "${workspaceFolder}",
  "stopAtEntry": true
}
```

### Assembly

For ELF assembly workflows, prefer GDB explicitly:

```json
{
  "type": "gdbui",
  "request": "launch",
  "name": "Debug Assembly",
  "backend": "gdb",
  "program": "${workspaceFolder}/hello",
  "cwd": "${workspaceFolder}",
  "stopAtEntry": true,
  "disassemblyFlavor": "intel"
}
```

### LLDB-first launch

Use this when you want to force LLDB or point to a specific `lldb-dap`:

```json
{
  "type": "gdbui",
  "request": "launch",
  "name": "Debug with LLDB",
  "backend": "lldb",
  "lldbPath": "/path/to/lldb-dap",
  "program": "${workspaceFolder}/app",
  "cwd": "${workspaceFolder}",
  "stopAtEntry": true
}
```

## Example use cases

- Debug a stripped-down ELF with source, disassembly, and register inspection
- Debug a pure assembly program that starts at `_start`
- Debug a normal C program and stop at `main`
- Inspect memory near the current instruction pointer inside VS Code

## Development

```bash
npm install
npm run compile
```

Open this folder in VS Code and press `F5` to start an Extension Development Host.

## Packaging

```bash
npm run package:pre
```

## CI

GitHub Actions are included for:

- universal VSIX packaging for Marketplace publishing
- multi-platform build and VSIX packaging for Linux, macOS, and Windows
- target-specific release assets for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64`
- tag-based release publishing for packaged `.vsix` artifacts
- optional Marketplace publishing from tags with a universal package when `VSCE_PAT` is configured

Create a version tag like `v0.1.1` to trigger the release workflow. GitHub Releases will receive the multi-platform packages, while the Marketplace can receive the universal package.

## License

MIT. See [LICENSE](LICENSE).
