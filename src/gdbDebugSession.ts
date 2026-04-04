import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Buffer } from 'buffer';
import * as fs from 'fs';
import * as path from 'path';
import {
  Breakpoint,
  ContinuedEvent,
  Handles,
  InitializedEvent,
  InvalidatedEvent,
  LoggingDebugSession,
  OutputEvent,
  Scope,
  Source,
  StackFrame,
  StoppedEvent,
  TerminatedEvent,
  Thread,
  ThreadEvent,
  logger,
  Logger
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { MiAsyncRecord, MiRecord, MiResult, MiTuple, MiValue, parseMiLine } from './mi';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  gdbPath?: string;
  cwd?: string;
  args?: string[];
  stopAtEntry?: boolean;
  disassemblyFlavor?: 'intel' | 'att';
}

interface PendingCommand {
  resolve: (value: MiResultRecordLike) => void;
  reject: (error: Error) => void;
  command: string;
}

interface MiResultRecordLike {
  class: string;
  results: Record<string, MiValue>;
}

interface BreakpointInfo {
  id: number;
  verified: boolean;
  file: string;
  line: number;
}

interface StackFrameRecord {
  level: number;
  addr: string;
  func: string;
  file?: string;
  fullname?: string;
  line?: number;
}

type VariableRef = { kind: 'locals'; frameId: number } | { kind: 'registers' };

export class GdbDebugSession extends LoggingDebugSession {
  private static readonly THREAD_ID = 1;

  private process?: ChildProcessWithoutNullStreams;
  private readonly commandQueue = new Map<number, PendingCommand>();
  private tokenCounter = 1;
  private stdoutBuffer = '';
  private readonly variableHandles = new Handles<VariableRef>();
  private readonly breakpointByPath = new Map<string, BreakpointInfo[]>();
  private stackFrames = new Map<number, StackFrameRecord>();
  private inferiorRunning = false;
  private initialized = false;
  private startupWaiter?: {
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
    timeout: NodeJS.Timeout;
  };
  private configurationDoneWaiter?: {
    resolve: () => void;
    reject: (error: Error) => void;
    settled: boolean;
    timeout: NodeJS.Timeout;
  };

  public constructor() {
    super('gdb-ui-debug.txt');

    logger.setup(Logger.LogLevel.Verbose, false);
    this.setDebuggerLinesStartAt1(true);
    this.setDebuggerColumnsStartAt1(true);
  }

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsDisassembleRequest = true;
    response.body.supportsInstructionBreakpoints = true;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsReadMemoryRequest = true;
    response.body.supportTerminateDebuggee = true;
    response.body.supportsSetVariable = false;
    this.sendResponse(response);
  }

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    try {
      const debuggerPath = this.resolveDebuggerPath(args.gdbPath);
      this.ensureFile(debuggerPath, 'gdbPath');
      this.ensureFile(args.program, 'program');

      this.process = spawn(debuggerPath, ['--interpreter=mi2', '--quiet'], {
        cwd: args.cwd || path.dirname(args.program)
      });

      this.process.stdout.setEncoding('utf8');
      this.process.stderr.setEncoding('utf8');

      this.process.stdout.on('data', (chunk: string) => this.onStdout(chunk));
      this.process.stderr.on('data', (chunk: string) => this.sendEvent(new OutputEvent(chunk, 'stderr')));
      this.process.on('exit', () => {
        this.inferiorRunning = false;
        this.sendEvent(new TerminatedEvent());
      });
      this.process.on('error', (error) => {
        this.sendEvent(new OutputEvent(`${error.message}\n`, 'stderr'));
      });

      await this.waitForPrompt();
      await this.sendMi('-gdb-set pagination off');
      await this.sendMi('-gdb-set confirm off');
      await this.sendMi('-gdb-set breakpoint pending on');
      await this.sendMi('-gdb-set debuginfod enabled off', true);
      await this.sendMi(`-gdb-set disassembly-flavor ${args.disassemblyFlavor ?? 'intel'}`);
      await this.sendMi('-interpreter-exec console "set print asm-demangle on"', true);

      if (args.cwd) {
        await this.sendMi(`-environment-cd ${quote(args.cwd)}`);
      }

      await this.sendMi(`-file-exec-and-symbols ${quote(args.program)}`);

      if (args.args && args.args.length > 0) {
        await this.sendMi(`-exec-arguments ${args.args.map(quote).join(' ')}`);
      }

      this.sendResponse(response);
      if (!this.initialized) {
        this.initialized = true;
        this.sendEvent(new InitializedEvent());
      }

      await this.waitForConfigurationDone();

      if (args.stopAtEntry) {
        await this.runToEntryPoint();
      } else {
        await this.sendMi('-exec-run');
      }
    } catch (error) {
      this.sendErrorResponse(response, {
        id: 1,
        format: error instanceof Error ? error.message : String(error)
      });
    }
  }

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse
  ): void {
    this.resolveConfigurationDoneWaiter();
    this.sendResponse(response);
  }

  protected async setBreakPointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    const sourcePath = args.source.path;
    if (!sourcePath) {
      response.body = { breakpoints: [] };
      this.sendResponse(response);
      return;
    }

    const previous = this.breakpointByPath.get(sourcePath) ?? [];
    for (const bp of previous) {
      await this.sendMi(`-break-delete ${bp.id}`);
    }

    const breakpoints: DebugProtocol.Breakpoint[] = [];
    const nextState: BreakpointInfo[] = [];
    for (const sourceBreakpoint of args.breakpoints ?? []) {
      const result = await this.sendMi(`-break-insert ${quote(`${sourcePath}:${sourceBreakpoint.line}`)}`);
      const bkpt = asTuple(result.results.bkpt);
      const info: BreakpointInfo = {
        id: Number(stringValue(bkpt.number, '0')),
        verified: true,
        file: sourcePath,
        line: Number(stringValue(bkpt.line, String(sourceBreakpoint.line)))
      };
      nextState.push(info);
      breakpoints.push(new Breakpoint(true, info.line, 1, new Source(path.basename(sourcePath), sourcePath)));
    }

    this.breakpointByPath.set(sourcePath, nextState);
    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected async setInstructionBreakpointsRequest(
    response: DebugProtocol.SetInstructionBreakpointsResponse,
    args: DebugProtocol.SetInstructionBreakpointsArguments
  ): Promise<void> {
    const breakpoints: DebugProtocol.Breakpoint[] = [];
    for (const breakpoint of args.breakpoints) {
      const result = await this.sendMi(`-break-insert *${breakpoint.instructionReference}`);
      const bkpt = asTuple(result.results.bkpt);
      breakpoints.push({
        verified: true,
        id: Number(stringValue(bkpt.number, '0')),
        instructionReference: breakpoint.instructionReference
      });
    }
    response.body = { breakpoints };
    this.sendResponse(response);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    response.body = {
      threads: [new Thread(GdbDebugSession.THREAD_ID, 'Main Thread')]
    };
    this.sendResponse(response);
  }

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    _args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    const result = await this.sendMi('-stack-list-frames');
    const stack = asList(result.results.stack).map((entry) => asTuple(asResult(entry).value));
    this.stackFrames = new Map();
    const frames = stack.map((item) => {
      const frame = asTuple(item.frame ?? item);
      const record: StackFrameRecord = {
        level: Number(stringValue(frame.level, '0')),
        addr: stringValue(frame.addr, '0x0'),
        func: stringValue(frame.func, '<unknown>'),
        file: optionalString(frame.file),
        fullname: optionalString(frame.fullname),
        line: optionalNumber(frame.line)
      };
      this.stackFrames.set(record.level, record);
      const sourcePath = record.fullname || record.file;
      const stackFrame = new StackFrame(
        record.level,
        record.func,
        sourcePath ? new Source(path.basename(sourcePath), sourcePath) : undefined,
        record.line ?? 0,
        1
      );
      (stackFrame as DebugProtocol.StackFrame).instructionPointerReference = record.addr;
      return stackFrame;
    });

    response.body = {
      stackFrames: frames,
      totalFrames: frames.length
    };
    this.sendResponse(response);
  }

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
      scopes: [
        new Scope('Locals', this.variableHandles.create({ kind: 'locals', frameId: args.frameId }), false),
        new Scope('Registers', this.variableHandles.create({ kind: 'registers' }), false)
      ]
    };
    this.sendResponse(response);
  }

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    const handle = this.variableHandles.get(args.variablesReference);
    if (!handle) {
      response.body = { variables: [] };
      this.sendResponse(response);
      return;
    }

    if (handle.kind === 'locals') {
      try {
        await this.sendMi(`-stack-select-frame ${handle.frameId}`);
        let result = await this.sendMi('-stack-list-variables --simple-values', true);
        if (result.class !== 'done') {
          result = await this.sendMi('-stack-list-variables 1');
        }

        const variables = asList(result.results.variables).map((entry) => {
          const tuple = asTuple(asResult(entry).value);
          return {
            name: stringValue(tuple.name, ''),
            value: stringValue(tuple.value, '<optimized out>'),
            variablesReference: 0
          };
        });
        response.body = { variables };
        this.sendResponse(response);
      } catch (error) {
        this.sendErrorResponse(response, {
          id: 4,
          format: error instanceof Error ? error.message : String(error)
        });
      }
      return;
    }

    const namesResult = await this.sendMi('-data-list-register-names');
    const valuesResult = await this.sendMi('-data-list-register-values x');
    const names = asList(namesResult.results['register-names']).map((value) => String(value));
    const values = asList(valuesResult.results['register-values']).map((entry) => asTuple(asResult(entry).value));
    response.body = {
      variables: values.map((tuple) => {
        const number = Number(stringValue(tuple.number, '0'));
        return {
          name: names[number] || `r${number}`,
          value: stringValue(tuple.value, ''),
          variablesReference: 0
        };
      })
    };
    this.sendResponse(response);
  }

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse
  ): Promise<void> {
    await this.sendMi('-exec-continue');
    this.inferiorRunning = true;
    this.sendEvent(new ContinuedEvent(GdbDebugSession.THREAD_ID));
    this.sendResponse(response);
  }

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    const instruction = args.granularity === 'instruction';
    await this.sendMi(instruction ? '-exec-next-instruction' : '-exec-next');
    this.inferiorRunning = true;
    this.sendResponse(response);
  }

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    const instruction = args.granularity === 'instruction';
    await this.sendMi(instruction ? '-exec-step-instruction' : '-exec-step');
    this.inferiorRunning = true;
    this.sendResponse(response);
  }

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse
  ): Promise<void> {
    await this.sendMi('-exec-finish');
    this.inferiorRunning = true;
    this.sendResponse(response);
  }

  protected async pauseRequest(response: DebugProtocol.PauseResponse): Promise<void> {
    await this.sendMi('-exec-interrupt');
    this.sendResponse(response);
  }

  protected async disassembleRequest(
    response: DebugProtocol.DisassembleResponse,
    args: DebugProtocol.DisassembleArguments
  ): Promise<void> {
    try {
      const instructionCount = args.instructionCount ?? 32;
      const offset = args.offset ?? 0;
      const startRef = parseInt(args.memoryReference, 16) + offset;
      const startHex = `0x${startRef.toString(16)}`;
      const endHex = `0x${(startRef + instructionCount * 8).toString(16)}`;
      const mixed = await this.sendMi(`-data-disassemble -s ${startHex} -e ${endHex} -- 1`, true);
      const fallback = mixed.class === 'done' ? mixed : await this.sendMi(`-data-disassemble -s ${startHex} -e ${endHex} -- 0`);
      const instructionsRoot = fallback.results.src_and_asm_line ?? fallback.results.asm_insns;
      const instructions = flattenInstructions(instructionsRoot).slice(0, instructionCount);
      let previousFile: string | undefined;
      let previousLine: number | undefined;
      response.body = {
        instructions: instructions.map((item) => {
          const sameLocation = item.file === previousFile && item.line === previousLine;
          previousFile = item.file;
          previousLine = item.line;
          return {
            address: item.address,
            instructionBytes: item.instructionBytes,
            instruction: item.inst,
            symbol: item.funcName,
            location: item.file && item.line && !sameLocation ? new Source(path.basename(item.file), item.file) : undefined,
            line: item.line ?? undefined,
            column: item.line ? 1 : undefined
          };
        })
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, {
        id: 2,
        format: error instanceof Error ? error.message : String(error)
      });
    }
  }

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    const result = await this.sendMi(`-data-evaluate-expression ${quote(args.expression)}`);
    response.body = {
      result: stringValue(result.results.value, ''),
      variablesReference: 0
    };
    this.sendResponse(response);
  }

  protected async readMemoryRequest(
    response: DebugProtocol.ReadMemoryResponse,
    args: DebugProtocol.ReadMemoryArguments
  ): Promise<void> {
    try {
      const address = normalizeAddress(args.memoryReference, args.offset ?? 0);
      const result = await this.sendMi(`-data-read-memory-bytes ${address} ${args.count}`, true);
      if (result.class !== 'done') {
        response.body = {
          address,
          unreadableBytes: args.count
        };
        this.sendResponse(response);
        return;
      }

      const memory = asList(result.results.memory);
      const first = memory.length > 0 ? asTuple(asResult(memory[0]).value) : {};
      const contents = stringValue(first.contents, '');
      const bytes = contents ? Buffer.from(contents, 'hex') : Buffer.alloc(0);
      response.body = {
        address: stringValue(first.begin, address),
        data: bytes.length > 0 ? bytes.toString('base64') : undefined,
        unreadableBytes: Math.max(0, args.count - bytes.length)
      };
      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, {
        id: 3,
        format: error instanceof Error ? error.message : String(error)
      });
    }
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse
  ): Promise<void> {
    if (this.process) {
      try {
        if (this.inferiorRunning) {
          await this.sendMi('-exec-interrupt');
        }
        await this.sendMi('-gdb-exit');
      } catch {
        // Ignore shutdown races.
      }
      this.process.kill();
      this.process = undefined;
    }

    this.sendResponse(response);
  }

  private ensureFile(filePath: string, label: string): void {
    if (!path.isAbsolute(filePath)) {
      throw new Error(`${label} must be an absolute path.`);
    }
    if (!fs.existsSync(filePath)) {
      throw new Error(`${label} does not exist: ${filePath}`);
    }
  }

  private resolveDebuggerPath(explicitPath?: string): string {
    if (explicitPath) {
      return explicitPath;
    }

    const pathEntries = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
    const executableNames = process.platform === 'win32'
      ? ['gdb.exe', 'gdb-multiarch.exe']
      : ['gdb', 'gdb-multiarch'];

    for (const entry of pathEntries) {
      for (const executableName of executableNames) {
        const candidate = path.join(entry, executableName);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    throw new Error('No GDB executable was found in PATH. Plain LLDB/lldb-dap is not directly compatible with this adapter yet.');
  }

  private waitForPrompt(): Promise<void> {
    if (this.startupWaiter && !this.startupWaiter.settled) {
      return Promise.reject(new Error('Already waiting for GDB startup.'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.startupWaiter || this.startupWaiter.settled) {
          return;
        }
        this.startupWaiter.settled = true;
        reject(new Error('Timed out waiting for GDB to start.'));
      }, 10000);

      this.startupWaiter = {
        resolve,
        reject,
        settled: false,
        timeout
      };

      if (this.stdoutBuffer.includes('(gdb)')) {
        this.resolveStartupWaiter();
      }
    });
  }

  private waitForConfigurationDone(): Promise<void> {
    if (this.configurationDoneWaiter && !this.configurationDoneWaiter.settled) {
      return Promise.reject(new Error('Already waiting for configurationDone.'));
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.configurationDoneWaiter || this.configurationDoneWaiter.settled) {
          return;
        }
        this.configurationDoneWaiter.settled = true;
        reject(new Error('Timed out waiting for configurationDone.'));
      }, 10000);

      this.configurationDoneWaiter = {
        resolve,
        reject,
        settled: false,
        timeout
      };
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? '';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      if (line === '(gdb)') {
        this.resolveStartupWaiter();
        continue;
      }

      const record = parseMiLine(line);
      if (!record) {
        continue;
      }

      this.resolveStartupWaiter();

      if (record.kind === 'console' || record.kind === 'target' || record.kind === 'log') {
        const category = record.kind === 'target' ? 'stdout' : record.kind === 'console' ? 'console' : 'stderr';
        if (record.text) {
          this.sendEvent(new OutputEvent(record.text, category));
        }
        continue;
      }

      if (record.kind === 'result') {
        const pending = record.token !== undefined ? this.commandQueue.get(record.token) : undefined;
        if (pending) {
          this.commandQueue.delete(record.token!);
          if (record.class === 'error') {
            pending.reject(new Error(stringValue(record.results.msg, `GDB command failed: ${pending.command}`)));
          } else {
            pending.resolve(record);
          }
        }
        continue;
      }

      if (record.kind === 'exec' || record.kind === 'notify' || record.kind === 'status') {
        this.handleAsyncRecord(record);
      }
    }
  }

  private handleAsyncRecord(record: MiAsyncRecord): void {
    if (record.kind !== 'exec') {
      return;
    }

    if (record.class === 'running') {
      this.inferiorRunning = true;
      this.sendEvent(new ContinuedEvent(GdbDebugSession.THREAD_ID));
      return;
    }

    if (record.class !== 'stopped') {
      return;
    }

    this.inferiorRunning = false;
    const reason = stringValue(record.results.reason, 'stop');
    const frame = asOptionalTuple(record.results.frame);
    const threadId = Number(stringValue(record.results['thread-id'], String(GdbDebugSession.THREAD_ID)));

    if (reason === 'exited-normally' || reason === 'exited' || reason === 'signal-received' && stringValue(record.results['signal-name'], '') === 'SIGTERM') {
      this.sendEvent(new TerminatedEvent());
      return;
    }

    if (reason === 'thread-created') {
      this.sendEvent(new ThreadEvent('started', threadId));
      return;
    }

    const event = new StoppedEvent(mapStopReason(reason), threadId) as DebugProtocol.StoppedEvent;
    if (frame?.addr) {
      event.body = {
        ...event.body,
        hitBreakpointIds: optionalNumber(record.results.bkptno) ? [Number(record.results.bkptno)] : undefined,
        description: `${reason} at ${stringValue(frame.addr, '')}`,
        text: frame.func ? `${stringValue(frame.func, '')}` : undefined
      };
    }
    this.sendEvent(event);
    this.sendEvent(new InvalidatedEvent(['stacks', 'threads', 'variables']));
  }

  private sendMi(command: string, allowError = false): Promise<MiResultRecordLike> {
    if (!this.process) {
      return Promise.reject(new Error('GDB process is not running.'));
    }

    const token = this.tokenCounter++;
    const payload = `${token}${command}\n`;

    return new Promise<MiResultRecordLike>((resolve, reject) => {
      this.commandQueue.set(token, { resolve, reject, command });
      this.process!.stdin.write(payload, 'utf8', (error) => {
        if (error) {
          this.commandQueue.delete(token);
          reject(error);
        }
      });
    }).catch((error) => {
      if (allowError) {
        return { class: 'error', results: {} };
      }
      throw error;
    });
  }

  private async runToEntryPoint(): Promise<void> {
    const mainBreakpoint = await this.sendMi('-break-insert -t main', true);
    if (mainBreakpoint.class === 'done') {
      await this.sendMi('-exec-run');
      return;
    }

    const tempEntryBreakpoint = await this.sendMi('-break-insert -t _start', true);
    if (tempEntryBreakpoint.class === 'done') {
      await this.sendMi('-exec-run');
      return;
    }

    const startResult = await this.sendMi('-exec-run --start', true);
    if (startResult.class === 'done') {
      return;
    }

    throw new Error('Failed to stop at entry point. GDB could not find _start or main.');
  }

  private resolveStartupWaiter(): void {
    if (!this.startupWaiter || this.startupWaiter.settled) {
      return;
    }

    this.startupWaiter.settled = true;
    clearTimeout(this.startupWaiter.timeout);
    this.startupWaiter.resolve();
  }

  private resolveConfigurationDoneWaiter(): void {
    if (!this.configurationDoneWaiter || this.configurationDoneWaiter.settled) {
      return;
    }

    this.configurationDoneWaiter.settled = true;
    clearTimeout(this.configurationDoneWaiter.timeout);
    this.configurationDoneWaiter.resolve();
  }
}

function flattenInstructions(root: MiValue | undefined): Array<{ address: string; inst: string; instructionBytes?: string; funcName?: string; file?: string; line?: number }> {
  if (!root) {
    return [];
  }

  const entries = asList(root);
  const instructions: Array<{ address: string; inst: string; instructionBytes?: string; funcName?: string; file?: string; line?: number }> = [];
  for (const entry of entries) {
    const tuple = asTuple(asResult(entry).value ?? entry);
    if (tuple.address && tuple.inst) {
      instructions.push({
        address: stringValue(tuple.address, '0x0'),
        inst: stringValue(tuple.inst, ''),
        instructionBytes: optionalString(tuple.opcodes),
        funcName: optionalString(tuple['func-name']),
        file: optionalString(tuple.file),
        line: optionalNumber(tuple.line)
      });
      continue;
    }

    const lineFile = optionalString(tuple.fullname) ?? optionalString(tuple.file);
    const lineNumber = optionalNumber(tuple.line);
    const nested = tuple.line_asm_insn ?? tuple.asm_insns;
    for (const item of asList(nested)) {
      const insn = asTuple(asResult(item).value ?? item);
      instructions.push({
        address: stringValue(insn.address, '0x0'),
        inst: stringValue(insn.inst, ''),
        instructionBytes: optionalString(insn.opcodes),
        funcName: optionalString(insn['func-name']),
        file: lineFile,
        line: lineNumber
      });
    }
  }
  return instructions;
}

function mapStopReason(reason: string): string {
  switch (reason) {
    case 'breakpoint-hit':
      return 'breakpoint';
    case 'end-stepping-range':
    case 'function-finished':
      return 'step';
    case 'signal-received':
      return 'pause';
    case 'exited':
    case 'exited-normally':
      return 'exit';
    default:
      return 'pause';
  }
}

function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeAddress(memoryReference: string, offset: number): string {
  const base = memoryReference.startsWith('0x') ? parseInt(memoryReference, 16) : parseInt(memoryReference, 10);
  const adjusted = base + offset;
  return memoryReference.startsWith('0x') ? `0x${adjusted.toString(16)}` : String(adjusted);
}

function asTuple(value: MiValue | undefined): MiTuple {
  if (!value || typeof value === 'string' || Array.isArray(value)) {
    return {};
  }
  return value;
}

function asOptionalTuple(value: MiValue | undefined): MiTuple | undefined {
  if (!value || typeof value === 'string' || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function asList(value: MiValue | undefined): Array<MiValue | MiResult> {
  if (!value || typeof value === 'string' || !Array.isArray(value)) {
    return [];
  }
  return value;
}

function asResult(value: MiValue | MiResult): MiResult {
  if ((value as MiResult).variable !== undefined) {
    return value as MiResult;
  }
  return { variable: '', value: value as MiValue };
}

function stringValue(value: MiValue | undefined, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function optionalString(value: MiValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: MiValue | undefined): number | undefined {
  return typeof value === 'string' ? Number(value) : undefined;
}
