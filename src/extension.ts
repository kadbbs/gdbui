import * as vscode from 'vscode';
import { DebugAdapterExecutable, DebugAdapterInlineImplementation } from 'vscode';
import { GdbDebugSession } from './gdbDebugSession';
import { accessSync, constants, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import * as path from 'path';

type DebugBackend = 'auto' | 'gdb' | 'lldb';
type ResolvedBackend = Exclude<DebugBackend, 'auto'>;
type BinaryFormat = 'elf' | 'macho' | 'unknown';
interface DebuggerCandidate {
  backend: ResolvedBackend;
  label: string;
  executablePath: string;
  detail: string;
}

interface ResolvedDebugConfiguration extends vscode.DebugConfiguration {
  backend?: DebugBackend;
  gdbPath?: string;
  lldbPath?: string;
  stopAtEntry?: boolean;
  stopOnEntry?: boolean;
  __resolvedBackend?: ResolvedBackend;
  __resolvedAdapterPath?: string;
}

function isLldbDapExecutable(executablePath: string): boolean {
  const executableName = path.basename(executablePath).toLowerCase();
  return executableName === 'lldb-dap' || executableName === 'lldb-dap.exe' || executableName === 'lldb-vscode' || executableName === 'lldb-vscode.exe';
}

class GdbSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gdb-ui.sidebar';
  public static readonly programStateKey = 'gdb-ui.selectedProgram';
  public static readonly debuggerStateKey = 'gdb-ui.selectedDebugger';
  private _view?: vscode.WebviewView;
  private _debuggerPath = '';
  private _programPath = '';

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _workspaceState: vscode.Memento
  ) {
    this._debuggerPath = this._workspaceState.get<string>(GdbSidebarProvider.debuggerStateKey, '');
    this._programPath = this._workspaceState.get<string>(GdbSidebarProvider.programStateKey, '');
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
    void webviewView.webview.postMessage({ type: 'updateDebugger', value: this._debuggerPath });
    void webviewView.webview.postMessage({ type: 'updateProgram', value: this._programPath });

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'setDebuggerPath':
          this._debuggerPath = message.value;
          void this._workspaceState.update(GdbSidebarProvider.debuggerStateKey, this._debuggerPath);
          break;
        case 'setProgramPath':
          this._programPath = message.value;
          void this._workspaceState.update(GdbSidebarProvider.programStateKey, this._programPath);
          break;
        case 'browseProgram':
          this._browseProgram();
          break;
        case 'browseDebugger':
          this._browseDebugger();
          break;
        case 'startDebug':
          this._startDebugging();
          break;
      }
    });
  }

  private _browseProgram(): void {
    vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select executable'
    }).then((picked) => {
      if (picked?.[0]) {
        this._programPath = picked[0].fsPath;
        void this._workspaceState.update(GdbSidebarProvider.programStateKey, this._programPath);
        this._view?.webview.postMessage({ type: 'updateProgram', value: this._programPath });
      }
    });
  }

  private _browseDebugger(): void {
    vscode.commands.executeCommand<string>('gdb-ui.pickDebuggerExecutable').then((pickedPath) => {
      if (pickedPath) {
        this._debuggerPath = pickedPath;
        void this._workspaceState.update(GdbSidebarProvider.debuggerStateKey, this._debuggerPath);
        this._view?.webview.postMessage({ type: 'updateDebugger', value: this._debuggerPath });
      }
    });
  }

  private _startDebugging(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!this._programPath) {
      vscode.window.showErrorMessage('Please select a program to debug');
      return;
    }

    const config: ResolvedDebugConfiguration = {
      type: 'gdbui',
      request: 'launch',
      name: 'GDB UI Debug',
      backend: 'auto',
      program: this._programPath,
      cwd: folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      args: [],
      stopAtEntry: true,
      disassemblyFlavor: 'intel'
    };

    if (this._debuggerPath) {
      if (isLldbDapExecutable(this._debuggerPath)) {
        config.lldbPath = this._debuggerPath;
      } else {
        config.gdbPath = this._debuggerPath;
      }
    }

    vscode.debug.startDebugging(folder, config);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GDB UI Debugger</title>
  <style>
    body {
      padding: 10px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background-color: var(--vscode-sideBar-background);
    }
    .section {
      margin-bottom: 15px;
    }
    .section-title {
      font-weight: bold;
      margin-bottom: 5px;
      color: var(--vscode-titleBar-activeForeground);
    }
    .input-row {
      display: flex;
      gap: 5px;
      align-items: center;
    }
    input[type="text"] {
      flex: 1;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      padding: 5px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button {
      background-color: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 5px 10px;
      cursor: pointer;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    button:hover {
      background-color: var(--vscode-button-hoverBackground);
    }
    .debug-btn {
      width: 100%;
      padding: 10px;
      font-size: 14px;
      font-weight: bold;
      margin-top: 10px;
    }
    .icon {
      width: 16px;
      height: 16px;
      display: inline-block;
      vertical-align: middle;
    }
  </style>
</head>
<body>
  <div class="section">
    <div class="section-title">🔧 Debugger Executable</div>
    <div class="input-row">
      <input type="text" id="debuggerPath" placeholder="Optional override: gdb, gdb-multiarch, or lldb-dap">
      <button id="browseDebugger" title="Browse">📁</button>
    </div>
  </div>
  
  <div class="section">
    <div class="section-title">📦 Program to Debug</div>
    <div class="input-row">
      <input type="text" id="programPath" placeholder="Select executable...">
      <button id="browseProgram" title="Browse">📁</button>
    </div>
  </div>
  
  <button class="debug-btn" id="startDebug">🚀 Start Debugging</button>
  
  <script>
    const vscode = acquireVsCodeApi();
    
    document.getElementById('debuggerPath').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setDebuggerPath', value: e.target.value });
    });
    
    document.getElementById('programPath').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setProgramPath', value: e.target.value });
    });
    
    document.getElementById('browseDebugger').addEventListener('click', () => {
      vscode.postMessage({ type: 'browseDebugger' });
    });
    
    document.getElementById('browseProgram').addEventListener('click', () => {
      vscode.postMessage({ type: 'browseProgram' });
    });
    
    document.getElementById('startDebug').addEventListener('click', () => {
      vscode.postMessage({ type: 'startDebug' });
    });
    
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'updateDebugger') {
        document.getElementById('debuggerPath').value = message.value;
      }
      if (message.type === 'updateProgram') {
        document.getElementById('programPath').value = message.value;
      }
    });
  </script>
</body>
</html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  function getSelectedProgramFromState(): string | undefined {
    return context.workspaceState.get<string>(GdbSidebarProvider.programStateKey);
  }

  function getSelectedDebuggerFromState(): string | undefined {
    return context.workspaceState.get<string>(GdbSidebarProvider.debuggerStateKey);
  }

  async function revealInitialStoppedFrame(session: vscode.DebugSession): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const activeSession = vscode.debug.activeDebugSession;
      if (activeSession && activeSession.id !== session.id) {
        return;
      }

      try {
        const threads = await session.customRequest('threads');
        const thread = threads?.threads?.[0];
        if (!thread?.id) {
          await delay(250);
          continue;
        }

        const stackTrace = await session.customRequest('stackTrace', {
          threadId: thread.id,
          startFrame: 0,
          levels: 1
        });
        const topFrame = stackTrace?.stackFrames?.[0];
        const sourcePath = topFrame?.source?.path;
        const line = topFrame?.line;
        if (!sourcePath || typeof line !== 'number' || line < 1) {
          await delay(250);
          continue;
        }

        const document = await vscode.workspace.openTextDocument(sourcePath);
        const editor = await vscode.window.showTextDocument(document, {
          preview: false,
          preserveFocus: false
        });
        const position = new vscode.Position(line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        return;
      } catch {
        await delay(250);
      }
    }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function detectExecutablesInPath(executableNames: string[]): string[] {
    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const discovered = new Set<string>();

    for (const entry of pathEntries) {
      for (const executableName of executableNames) {
        const candidate = path.join(entry, executableName);
        try {
          accessSync(candidate, constants.X_OK);
          discovered.add(candidate);
        } catch {
          // Keep scanning PATH entries.
        }
      }
    }

    return [...discovered];
  }

  function detectExecutableInPath(executableNames: string[]): string | undefined {
    return detectExecutablesInPath(executableNames)[0];
  }

  function detectGdbPath(): string | undefined {
    return detectExecutableInPath(process.platform === 'win32'
      ? ['gdb.exe', 'gdb-multiarch.exe']
      : ['gdb', 'gdb-multiarch']);
  }

  function detectLldbDapPath(): string | undefined {
    if (process.platform === 'darwin') {
      try {
        const xcrunPath = execFileSync('xcrun', ['-f', 'lldb-dap'], { encoding: 'utf8' }).trim();
        if (xcrunPath) {
          accessSync(xcrunPath, constants.X_OK);
          return xcrunPath;
        }
      } catch {
        // Fall back to PATH lookup.
      }
    }

    return detectExecutableInPath(process.platform === 'win32'
      ? ['lldb-dap.exe', 'lldb-vscode.exe']
      : ['lldb-dap', 'lldb-vscode']);
  }

  function findDebuggerCandidates(): DebuggerCandidate[] {
    const candidates: DebuggerCandidate[] = [];

    for (const executablePath of detectExecutablesInPath(process.platform === 'win32'
      ? ['gdb.exe', 'gdb-multiarch.exe']
      : ['gdb', 'gdb-multiarch'])) {
      candidates.push({
        backend: 'gdb',
        label: path.basename(executablePath),
        executablePath,
        detail: `GDB backend from PATH: ${executablePath}`
      });
    }

    for (const executablePath of detectExecutablesInPath(process.platform === 'win32'
      ? ['lldb-dap.exe', 'lldb-vscode.exe']
      : ['lldb-dap', 'lldb-vscode'])) {
      candidates.push({
        backend: 'lldb',
        label: path.basename(executablePath),
        executablePath,
        detail: `LLDB backend from PATH: ${executablePath}`
      });
    }

    if (process.platform === 'darwin') {
      try {
        const xcrunPath = execFileSync('xcrun', ['-f', 'lldb-dap'], { encoding: 'utf8' }).trim();
        if (xcrunPath) {
          accessSync(xcrunPath, constants.X_OK);
          candidates.push({
            backend: 'lldb',
            label: 'lldb-dap',
            executablePath: xcrunPath,
            detail: `LLDB backend from xcrun: ${xcrunPath}`
          });
        }
      } catch {
        // Ignore xcrun lookup failures.
      }
    }

    const deduped = new Map<string, DebuggerCandidate>();
    for (const candidate of candidates) {
      deduped.set(`${candidate.backend}:${candidate.executablePath}`, candidate);
    }
    return [...deduped.values()];
  }

  function detectBinaryFormat(programPath: string): BinaryFormat {
    try {
      const header = readFileSync(programPath, { encoding: null }).subarray(0, 4);
      if (header.length < 4) {
        return 'unknown';
      }

      if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
        return 'elf';
      }

      const machoHeaders = new Set([
        'feedface',
        'cefaedfe',
        'feedfacf',
        'cffaedfe',
        'cafebabe',
        'bebafeca',
        'cafebabf',
        'bfbafeca'
      ]);

      if (machoHeaders.has(header.toString('hex'))) {
        return 'macho';
      }
    } catch {
      // Fall through to unknown.
    }

    return 'unknown';
  }

  function recommendBackend(programPath: string): { backend: ResolvedBackend; reason: string; format: BinaryFormat } {
    const format = detectBinaryFormat(programPath);
    if (format === 'macho') {
      return {
        backend: 'lldb',
        format,
        reason: 'Mach-O binaries are usually best handled by lldb-dap.'
      };
    }

    if (format === 'elf') {
      return {
        backend: 'gdb',
        format,
        reason: 'ELF binaries default to the existing GDB backend.'
      };
    }

    if (process.platform === 'darwin') {
      return {
        backend: 'lldb',
        format,
        reason: 'On macOS, lldb-dap is the recommended default when the binary format is unknown.'
      };
    }

    return {
      backend: 'gdb',
      format,
      reason: 'GDB is the recommended default on non-macOS platforms when the binary format is unknown.'
    };
  }

  async function promptForGdbPath(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: 'GDB UI',
      prompt: 'Enter the absolute path to a GDB executable.',
      placeHolder: '/path/to/gdb or /path/to/gdb-multiarch',
      ignoreFocusOut: true
    });
  }

  async function promptForLldbDapPath(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: 'GDB UI',
      prompt: 'Enter the absolute path to lldb-dap. Plain lldb is not a DAP server and is not valid here.',
      placeHolder: '/path/to/lldb-dap',
      ignoreFocusOut: true
    });
  }

  async function browseDebuggerExecutable(): Promise<string | undefined> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select debugger executable'
    });
    return picked?.[0]?.fsPath;
  }

  async function pickDebuggerExecutable(
    preferredBackend?: DebugBackend,
    recommendedPath?: string
  ): Promise<string | undefined> {
    const candidates = findDebuggerCandidates().filter((candidate) =>
      !preferredBackend || preferredBackend === 'auto' || candidate.backend === preferredBackend
    );

    if (candidates.length === 0) {
      return browseDebuggerExecutable();
    }

    if (candidates.length === 1) {
      return candidates[0].executablePath;
    }

    const recommendedCandidate = recommendedPath
      ? candidates.find((candidate) => candidate.executablePath === recommendedPath)
      : undefined;

    const picked = await vscode.window.showQuickPick(
      [
        ...candidates.map((candidate) => ({
          label: candidate.label,
          description: candidate.backend === 'gdb' ? 'GDB' : 'LLDB',
          detail: candidate === recommendedCandidate ? `${candidate.detail} (recommended)` : candidate.detail,
          executablePath: candidate.executablePath
        })),
        {
          label: 'Browse manually',
          description: 'Custom executable path',
          detail: 'Use a debugger executable that was not auto-detected from PATH.',
          executablePath: '__browse__'
        }
      ],
      {
        title: 'Select debugger executable',
        placeHolder: 'Pick an auto-detected debugger, or browse manually.'
      }
    );

    if (!picked) {
      return undefined;
    }

    if (picked.executablePath === '__browse__') {
      return browseDebuggerExecutable();
    }

    return picked.executablePath;
  }

  async function resolveBackend(
    config: ResolvedDebugConfiguration
  ): Promise<{ backend: ResolvedBackend; adapterPath: string; reason: string }> {
    const backend = config.backend ?? 'auto';

    if (backend === 'gdb') {
      const gdbPath = config.gdbPath || await pickDebuggerExecutable('gdb', detectGdbPath()) || await promptForGdbPath();
      if (!gdbPath) {
        return Promise.reject(new Error('No GDB executable was provided or found in PATH.'));
      }
      return { backend: 'gdb', adapterPath: gdbPath, reason: 'Using the explicitly selected GDB backend.' };
    }

    if (backend === 'lldb') {
      const lldbPath = config.lldbPath || await pickDebuggerExecutable('lldb', detectLldbDapPath()) || await promptForLldbDapPath();
      if (!lldbPath) {
        return Promise.reject(new Error('No lldb-dap executable was provided or found in PATH.'));
      }
      if (!isLldbDapExecutable(lldbPath)) {
        return Promise.reject(new Error('The selected LLDB executable is not lldb-dap. Please install or select lldb-dap (or lldb-vscode), not plain lldb.'));
      }
      return { backend: 'lldb', adapterPath: lldbPath, reason: 'Using the explicitly selected LLDB backend.' };
    }

    const recommendation = recommendBackend(config.program);
    const recommendedPath = recommendation.backend === 'lldb'
      ? (config.lldbPath || detectLldbDapPath())
      : (config.gdbPath || detectGdbPath());
    if (recommendedPath) {
      const selectedPath = await pickDebuggerExecutable(recommendation.backend, recommendedPath) || recommendedPath;
      return {
        backend: recommendation.backend,
        adapterPath: selectedPath,
        reason: recommendation.reason
      };
    }

    const fallbackPath = recommendation.backend === 'lldb'
      ? (config.gdbPath || detectGdbPath())
      : (config.lldbPath || detectLldbDapPath());
    if (fallbackPath) {
      const fallbackBackend = recommendation.backend === 'lldb' ? 'gdb' : 'lldb';
      const selectedPath = await pickDebuggerExecutable(fallbackBackend, fallbackPath) || fallbackPath;
      return {
        backend: fallbackBackend,
        adapterPath: selectedPath,
        reason: `${recommendation.reason} Falling back because the recommended debugger was not found in PATH.`
      };
    }

    const choice = await vscode.window.showWarningMessage(
      'No suitable debugger executable was found in PATH. Select a backend to provide a debugger path manually.',
      'Use GDB',
      'Use LLDB'
    );
    if (choice === 'Use GDB') {
      const gdbPath = await promptForGdbPath();
      if (!gdbPath) {
        return Promise.reject(new Error('No GDB executable was provided.'));
      }
      return { backend: 'gdb', adapterPath: gdbPath, reason: 'Using the manually selected GDB backend.' };
    }
    if (choice === 'Use LLDB') {
      const lldbPath = await promptForLldbDapPath();
      if (!lldbPath) {
        return Promise.reject(new Error('No lldb-dap executable was provided.'));
      }
      if (!isLldbDapExecutable(lldbPath)) {
        return Promise.reject(new Error('The selected LLDB executable is not lldb-dap. Please install or select lldb-dap (or lldb-vscode), not plain lldb.'));
      }
      return { backend: 'lldb', adapterPath: lldbPath, reason: 'Using the manually selected LLDB backend.' };
    }
    return Promise.reject(new Error('No suitable debugger executable was provided or found in PATH.'));
  }

  async function promptForLaunchConfig(folder?: vscode.WorkspaceFolder): Promise<vscode.DebugConfiguration | undefined> {
    const programPick = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select executable to debug'
    });
    if (!programPick?.[0]) {
      return undefined;
    }

    return {
      type: 'gdbui',
      request: 'launch',
      name: `Debug ${vscode.workspace.asRelativePath(programPick[0], false)}`,
      program: programPick[0].fsPath,
      backend: 'auto',
      cwd: folder?.uri.fsPath ?? vscode.workspace.getWorkspaceFolder(programPick[0])?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      args: [],
      stopAtEntry: true,
      disassemblyFlavor: 'intel'
    };
  }

  const configurationProvider: vscode.DebugConfigurationProvider = {
    provideDebugConfigurations(
      folder: vscode.WorkspaceFolder | undefined
    ): vscode.ProviderResult<vscode.DebugConfiguration[]> {
      const selectedProgram = getSelectedProgramFromState();
      const selectedDebugger = getSelectedDebuggerFromState();

      const config: ResolvedDebugConfiguration = {
        type: 'gdbui',
        request: 'launch',
        name: 'GDB UI Debug',
        backend: 'auto',
        cwd: folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        args: [],
        stopAtEntry: true,
        disassemblyFlavor: 'intel'
      };

      if (selectedProgram) {
        config.program = selectedProgram;
      }

      if (selectedDebugger) {
        if (isLldbDapExecutable(selectedDebugger)) {
          config.lldbPath = selectedDebugger;
        } else {
          config.gdbPath = selectedDebugger;
        }
      }

      return [config];
    },
    async resolveDebugConfiguration(
      folder: vscode.WorkspaceFolder | undefined,
      config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined> {
      const resolved = { ...config } as ResolvedDebugConfiguration;

      if (!resolved.type && !resolved.request && !resolved.name) {
        resolved.type = 'gdbui';
        resolved.request = 'launch';
        resolved.name = 'Launch with GDB UI';
      }

      resolved.type ??= 'gdbui';
      resolved.request ??= 'launch';
      resolved.name ??= 'Launch with GDB UI';
      resolved.backend ??= 'auto';
      resolved.cwd ??= folder?.uri.fsPath;
      resolved.args ??= [];
      resolved.stopAtEntry ??= true;
      resolved.disassemblyFlavor ??= 'intel';

      if (resolved.name === 'GDB UI Debug') {
        const selectedProgram = getSelectedProgramFromState();
        if (selectedProgram) {
          resolved.program = selectedProgram;
        }
        const selectedDebugger = getSelectedDebuggerFromState();
        if (selectedDebugger) {
          if (isLldbDapExecutable(selectedDebugger)) {
            resolved.lldbPath = selectedDebugger;
            delete resolved.gdbPath;
          } else {
            resolved.gdbPath = selectedDebugger;
            delete resolved.lldbPath;
          }
        }
      }

      if (!resolved.program) {
        const prompted = await promptForLaunchConfig(folder);
        if (!prompted) {
          return undefined;
        }
        return {
          ...prompted,
          ...resolved,
          type: 'gdbui',
          request: 'launch'
        };
      }

      try {
        const backend = await resolveBackend(resolved);
        resolved.__resolvedBackend = backend.backend;
        resolved.__resolvedAdapterPath = backend.adapterPath;

        if (backend.backend === 'gdb') {
          resolved.gdbPath ??= backend.adapterPath;
        } else {
          resolved.lldbPath ??= backend.adapterPath;
          resolved.stopOnEntry ??= resolved.stopAtEntry;
        }
      } catch (error) {
        vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        return undefined;
      }

      return resolved;
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gdb-ui.pickDebuggerExecutable', async () => {
      return pickDebuggerExecutable();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gdb-ui.getProgramName', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: 'Select executable'
      });

      return picked?.[0].fsPath;
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('gdb-ui.startDebuggingExecutable', async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      const config = await promptForLaunchConfig(folder);
      if (!config) {
        return;
      }

      await vscode.debug.startDebugging(folder, config);
    })
  );

  const factory: vscode.DebugAdapterDescriptorFactory = {
    createDebugAdapterDescriptor(
      session: vscode.DebugSession
    ): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
      const config = session.configuration as ResolvedDebugConfiguration;
      if (config.__resolvedBackend === 'lldb' && config.__resolvedAdapterPath) {
        return new DebugAdapterExecutable(config.__resolvedAdapterPath, []);
      }

      return new DebugAdapterInlineImplementation(new GdbDebugSession());
    }
  };

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('gdbui', configurationProvider));
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'gdbui',
      configurationProvider,
      vscode.DebugConfigurationProviderTriggerKind.Dynamic
    )
  );
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('gdbui', factory));
  context.subscriptions.push(
    vscode.debug.onDidStartDebugSession((session) => {
      if (session.type !== 'gdbui') {
        return;
      }

      void revealInitialStoppedFrame(session);
    })
  );

  // Register sidebar provider
  const sidebarProvider = new GdbSidebarProvider(context.extensionUri, context.workspaceState);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GdbSidebarProvider.viewType, sidebarProvider)
  );
}

export function deactivate(): void {
  // Nothing to clean up explicitly; the debug session owns its child process lifecycle.
}
