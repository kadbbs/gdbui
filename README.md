# GDB UI

GDB UI is a VS Code debugging extension for executable-first native debugging with GDB.

It is designed for workflows where you want to point directly at an existing binary, debug assembly comfortably, inspect disassembly and memory, and still keep the normal VS Code debugging experience.

## Highlights

- Launch a debug session with a custom `gdbPath`
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
  "gdbPath": "/usr/bin/gdb",
  "program": "${workspaceFolder}/a.out",
  "cwd": "${workspaceFolder}",
  "args": [],
  "stopAtEntry": true,
  "disassemblyFlavor": "intel"
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

- multi-platform build and VSIX packaging for Linux, macOS, and Windows
- target-specific release assets for `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `win32-x64`, and `win32-arm64`
- tag-based release publishing for packaged `.vsix` artifacts

Create a version tag like `v0.0.5` to trigger the release workflow and upload the packaged `.vsix` to GitHub Releases.

## License

MIT. See [LICENSE](LICENSE).
