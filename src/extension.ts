import * as vscode from 'vscode';
import { DebugAdapterInlineImplementation } from 'vscode';
import { GdbDebugSession } from './gdbDebugSession';

class GdbSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'gdb-ui.sidebar';
  private _view?: vscode.WebviewView;
  private _gdbPath = '/usr/bin/gdb';
  private _programPath = '';

  constructor(private readonly _extensionUri: vscode.Uri) {}

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

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.type) {
        case 'setGdbPath':
          this._gdbPath = message.value;
          break;
        case 'setProgramPath':
          this._programPath = message.value;
          break;
        case 'browseProgram':
          this._browseProgram();
          break;
        case 'browseGdb':
          this._browseGdb();
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
        this._view?.webview.postMessage({ type: 'updateProgram', value: this._programPath });
      }
    });
  }

  private _browseGdb(): void {
    vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'Select GDB executable'
    }).then((picked) => {
      if (picked?.[0]) {
        this._gdbPath = picked[0].fsPath;
        this._view?.webview.postMessage({ type: 'updateGdb', value: this._gdbPath });
      }
    });
  }

  private _startDebugging(): void {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!this._programPath) {
      vscode.window.showErrorMessage('Please select a program to debug');
      return;
    }
    if (!this._gdbPath) {
      vscode.window.showErrorMessage('Please select GDB path');
      return;
    }

    const config: vscode.DebugConfiguration = {
      type: 'gdbui',
      request: 'launch',
      name: 'GDB UI Debug',
      gdbPath: this._gdbPath,
      program: this._programPath,
      cwd: folder?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      args: [],
      stopAtEntry: true,
      disassemblyFlavor: 'intel'
    };

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
    <div class="section-title">🔧 GDB Executable</div>
    <div class="input-row">
      <input type="text" id="gdbPath" placeholder="/usr/bin/gdb" value="/usr/bin/gdb">
      <button id="browseGdb" title="Browse">📁</button>
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
    
    document.getElementById('gdbPath').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setGdbPath', value: e.target.value });
    });
    
    document.getElementById('programPath').addEventListener('change', (e) => {
      vscode.postMessage({ type: 'setProgramPath', value: e.target.value });
    });
    
    document.getElementById('browseGdb').addEventListener('click', () => {
      vscode.postMessage({ type: 'browseGdb' });
    });
    
    document.getElementById('browseProgram').addEventListener('click', () => {
      vscode.postMessage({ type: 'browseProgram' });
    });
    
    document.getElementById('startDebug').addEventListener('click', () => {
      vscode.postMessage({ type: 'startDebug' });
    });
    
    window.addEventListener('message', (event) => {
      const message = event.data;
      if (message.type === 'updateGdb') {
        document.getElementById('gdbPath').value = message.value;
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
  async function promptForGdbPath(): Promise<string | undefined> {
    return vscode.window.showInputBox({
      title: 'GDB UI',
      prompt: 'Enter the absolute path to your gdb executable',
      placeHolder: '/path/to/gdb-tools/bin/gdb',
      ignoreFocusOut: true
    });
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

    const gdbPath = await promptForGdbPath();
    if (!gdbPath) {
      return undefined;
    }

    return {
      type: 'gdbui',
      request: 'launch',
      name: `Debug ${vscode.workspace.asRelativePath(programPick[0], false)}`,
      program: programPick[0].fsPath,
      gdbPath,
      cwd: folder?.uri.fsPath ?? vscode.workspace.getWorkspaceFolder(programPick[0])?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      args: [],
      stopAtEntry: true,
      disassemblyFlavor: 'intel'
    };
  }

  const configurationProvider: vscode.DebugConfigurationProvider = {
    async resolveDebugConfiguration(
      folder: vscode.WorkspaceFolder | undefined,
      config: vscode.DebugConfiguration
    ): Promise<vscode.DebugConfiguration | undefined> {
      const resolved = { ...config };

      if (!resolved.type && !resolved.request && !resolved.name) {
        resolved.type = 'gdbui';
        resolved.request = 'launch';
        resolved.name = 'Launch with GDB UI';
      }

      resolved.type ??= 'gdbui';
      resolved.request ??= 'launch';
      resolved.name ??= 'Launch with GDB UI';
      resolved.cwd ??= folder?.uri.fsPath;
      resolved.args ??= [];
      resolved.stopAtEntry ??= true;
      resolved.disassemblyFlavor ??= 'intel';

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

      if (!resolved.gdbPath) {
        const gdbPath = await promptForGdbPath();
        if (!gdbPath) {
          return undefined;
        }
        resolved.gdbPath = gdbPath;
      }

      return resolved;
    }
  };

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
    createDebugAdapterDescriptor(): vscode.ProviderResult<vscode.DebugAdapterDescriptor> {
      return new DebugAdapterInlineImplementation(new GdbDebugSession());
    }
  };

  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('gdbui', configurationProvider));
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('gdbui', factory));

  // Register sidebar provider
  const sidebarProvider = new GdbSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(GdbSidebarProvider.viewType, sidebarProvider)
  );
}

export function deactivate(): void {
  // Nothing to clean up explicitly; the debug session owns its child process lifecycle.
}
