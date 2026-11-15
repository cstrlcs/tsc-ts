// The tsc command line on the disk, for `tsc-ts` and the cli driver.
import { exitWithDoctorReport } from '../compiler/doctor-report.js';
import { mark, markMemory } from '../compiler/timeline.js';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  type Dirent,
  type FSWatcher,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  watch as watchPath,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import type { ProcessChannel } from '../compiler/content-mapper-process-host.js';
import { DirectoryEntries } from '../compiler/file-system.js';
import { combinePaths, isNetworkPath, normalizePath, pathIsAbsolute } from '../compiler/path.js';
import type { Program } from '../compiler/program.js';
import { ParseThread } from '../compiler/parse-thread.js';
import {
  type CommandLineResult,
  type DirectoryWatch,
  System,
  executeCommandLine,
  readThreadProject,
} from '../compiler/tsc-cli.js';
import type { OutputWriter } from '../compiler/compile-program.js';
import {
  compile,
  compileEmitThreads,
  compileInParallel,
  compileThreads,
  compileWithDeclarationThread,
  compileWithEmitThreads,
  SystemWriter,
} from '../compiler/tsc-compile.js';
import { buildWithThreads } from '../compiler/tsc-build.js';
import { watch, watchBuild, watchRestart } from '../compiler/tsc-watch.js';

/** What a directory entry is (`NodeSystem.getAccessibleEntries`). */
const enum EntryKind {
  Other,
  Directory,
  File,
  Symlink,
}

const bundledPrefix = 'bundled:///libs/';

// The processes of content mappers in the native build (native/spawn-posix.c, linked into the Linux and macOS
// builds): a process started in a directory from the file to run and its arguments, each followed by a NUL, or
// -1, which `tscTsSpawnError` explains in the words of the system; writing its standard input (0, or -1 when
// the process ended); reading its standard output (the number of bytes, 0 at its end, -1 when nothing arrived
// within the timeout, -2 after an error) and what it wrote to a captured standard error; its exit code (-1 after
// a signal, -2 while it runs after waiting the given milliseconds); and ending it.
declare function tscTsSpawn(command: string, directory: string, captureError: boolean): number;
declare function tscTsSpawnError(buffer: Uint8Array): number;
declare function tscTsProcessWrite(process: number, bytes: Uint8Array): number;
declare function tscTsProcessRead(process: number, buffer: Uint8Array, timeoutMs: number): number;
declare function tscTsProcessReadError(process: number, buffer: Uint8Array): number;
declare function tscTsProcessExitCode(process: number, waitMs: number): number;
declare function tscTsProcessClose(process: number): void;

/** The process of a content mapper in the native build. */
class NativeProcessChannel implements ProcessChannel {
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly process: number,
    private readonly capturesStandardError: boolean,
  ) {}

  write(bytes: Uint8Array): boolean {
    return tscTsProcessWrite(this.process, bytes) === 0;
  }

  read(buffer: Uint8Array, timeoutMilliseconds: number): number {
    const count = tscTsProcessRead(this.process, buffer, timeoutMilliseconds);
    // Output that cannot be read has ended.
    return count < -1 ? 0 : count;
  }

  readStandardError(): string {
    if (!this.capturesStandardError) return '';
    const chunk = new Uint8Array(4096);
    let text = '';
    for (;;) {
      const count = tscTsProcessReadError(this.process, chunk);
      if (count <= 0) return text;
      text += this.decoder.decode(chunk.subarray(0, count), { stream: true });
    }
  }

  exitCode(): number | undefined {
    // A process that closed its output is about to end: its exit is awaited for a moment.
    const code = tscTsProcessExitCode(this.process, exitWaitMilliseconds);
    return code === -2 ? undefined : code;
  }

  close(): void {
    tscTsProcessClose(this.process);
  }
}

/** How long the native build waits for a process to end when it asks for its exit code. */
const exitWaitMilliseconds = 100;

/**
 * The process of a content mapper under Node.js. Node.js gives the pipes of a child process as streams, which
 * its event loop reads and writes, and the event loop does not run while the compiler waits for a mapper. So
 * the process is started with named pipes as its standard input, output and error (`startProcess`), which this
 * process reads and writes itself. Node.js learns that a child ended, and its exit code, only on its event
 * loop too.
 */
class NodeProcessChannel implements ProcessChannel {
  private readonly decoder = new TextDecoder();
  private readonly pause = new Int32Array(new SharedArrayBuffer(4));
  /** What the process wrote to a captured standard error and `readStandardError` has not returned yet. */
  private captured = '';

  constructor(
    private readonly child: ChildProcess,
    /** Where the standard input of the process is written, without waiting for the process to read. */
    private readonly input: number,
    /** Where its standard output is read without waiting, and where it is read waiting. */
    private readonly output: number,
    private readonly waitingOutput: number,
    /** Where a captured standard error is read without waiting, or -1. */
    private readonly error: number,
  ) {}

  write(bytes: Uint8Array): boolean {
    let written = 0;
    while (written < bytes.length) {
      try {
        written += writeSync(this.input, bytes, written, bytes.length - written);
      } catch (e) {
        // A pipe that is full reports EAGAIN until the process reads; any other failure is a process that ended.
        if (!(e instanceof Error) || !e.message.includes('EAGAIN')) return false;
        // A process that waits for room in the pipe of its standard error does not read.
        this.captureStandardError();
        Atomics.wait(this.pause, 0, 0, 1);
      }
    }
    return true;
  }

  read(buffer: Uint8Array, timeoutMilliseconds: number): number {
    // Without a time limit, and without a standard error to empty meanwhile, the read itself waits.
    if (timeoutMilliseconds < 0 && this.error < 0) return Math.max(this.readOutput(this.waitingOutput, buffer), 0);
    const deadline = performance.now() + timeoutMilliseconds;
    for (;;) {
      const count = this.readOutput(this.output, buffer);
      if (count >= 0) return count;
      if (timeoutMilliseconds >= 0 && performance.now() >= deadline) return -1;
      this.captureStandardError();
      Atomics.wait(this.pause, 0, 0, 1);
    }
  }

  /** Reads the output through `descriptor`: the bytes read, 0 at its end, -1 when there is nothing to read now. */
  private readOutput(descriptor: number, buffer: Uint8Array): number {
    try {
      return readSync(descriptor, buffer, 0, buffer.length, null);
    } catch (e) {
      // A pipe read without waiting reports EAGAIN until data arrives; any other failure ends the output.
      return e instanceof Error && e.message.includes('EAGAIN') ? -1 : 0;
    }
  }

  /** Empties the pipe of a captured standard error, so that a process that fills it does not wait for this one. */
  private captureStandardError(): void {
    if (this.error < 0) return;
    const chunk = new Uint8Array(4096);
    for (;;) {
      let count = 0;
      try {
        count = readSync(this.error, chunk, 0, chunk.length, null);
      } catch {
        // Nothing to read now.
      }
      if (count <= 0) return;
      this.captured += this.decoder.decode(chunk.subarray(0, count), { stream: true });
    }
  }

  readStandardError(): string {
    this.captureStandardError();
    const text = this.captured;
    this.captured = '';
    return text;
  }

  exitCode(): number | undefined {
    return this.child.exitCode ?? undefined;
  }

  close(): void {
    this.captureStandardError();
    closeDescriptors([this.input, this.output, this.waitingOutput, this.error]);
    this.child.kill('SIGKILL');
  }
}

function closeDescriptors(descriptors: readonly number[]): void {
  for (const descriptor of descriptors) if (descriptor >= 0) closeSync(descriptor);
}

/**
 * What the shell runs to give a process its pipes: it opens the named pipes of the output and the error, then
 * the one of the input, and becomes the process.
 */
const pipedProcessScript = 'output=$1 error=$2 input=$3; shift 3; exec "$@" >"$output" 2>"$error" <"$input"';

/** How long a process may take to open its pipes. */
const connectMilliseconds = 5000;

/**
 * Starts `file` with the arguments after the first word of `command` in `directory` under Node.js, with named
 * pipes in `pipeDirectory`, which the caller removes, as its standard input, output and, if captured, error.
 * Node.js can hand a child only pipes of its own, as streams, so a shell opens the named pipes for the process.
 * Returns why the process could not be started, in the words of Go's os/exec.
 */
function startProcess(
  pipeDirectory: string,
  file: string,
  command: readonly string[],
  directory: string,
  captureStandardError: boolean,
): ProcessChannel | string {
  const inputName = combinePaths(pipeDirectory, 'input');
  const outputName = combinePaths(pipeDirectory, 'output');
  const errorName = combinePaths(pipeDirectory, 'error');
  if (spawnSync('mkfifo', [inputName, outputName, errorName], { stdio: ['ignore', 'ignore', 'ignore'] }).status !== 0)
    return 'pipe: mkfifo failed';
  // A pipe opened for both reading and writing opens at once, and then so does an end that waits; an end
  // that does not wait opens at once to read. The output is kept open for writing until the process has it,
  // so that it does not seem to have ended before.
  const outputBoth = openSync(outputName, constants.O_RDWR);
  const waitingOutput = openSync(outputName, constants.O_RDONLY);
  const output = openSync(outputName, constants.O_RDONLY | constants.O_NONBLOCK);
  const error = captureStandardError ? openSync(errorName, constants.O_RDONLY | constants.O_NONBLOCK) : -1;
  const args = ['-c', pipedProcessScript, 'sh', outputName, captureStandardError ? errorName : '/dev/null', inputName];
  // The file found is run, since the shell would look the name up again from the mapper's directory; the
  // process sees the file as its name, where tsgo's sees the first word of the command.
  args.push(file);
  for (let i = 1; i < command.length; i++) args.push(command[i]);
  let child: ChildProcess;
  try {
    child = spawn('/bin/sh', args, { cwd: directory, stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    closeDescriptors([outputBoth, waitingOutput, output, error]);
    const message = e instanceof Error ? e.message : '';
    return `fork/exec ${file}: ${systemErrorText(message.slice(message.lastIndexOf(' ') + 1))}`;
  }
  // Node.js reports a process that did not start on its event loop, where nothing else listens for it.
  child.on('error', () => {});
  // The input opens for writing once the shell reads it, which it does after it opened the other pipes.
  let input = -1;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = performance.now() + connectMilliseconds;
  while (input < 0 && child.pid !== undefined && performance.now() < deadline) {
    try {
      input = openSync(inputName, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch {
      Atomics.wait(pause, 0, 0, 1);
    }
  }
  closeSync(outputBoth);
  if (input < 0) {
    closeDescriptors([waitingOutput, output, error]);
    child.kill('SIGKILL');
    // The file exists and may be executed, so what is missing is what it names to run it, or its directory.
    return `fork/exec ${file}: ${systemErrorText('ENOENT')}`;
  }
  child.unref();
  return new NodeProcessChannel(child, input, output, waitingOutput, error);
}

/** The text of tsgo for the system error `code` (`ENOENT`), which is Go's; `code` itself for one not listed. */
function systemErrorText(code: string): string {
  switch (code) {
    case 'ENOENT':
      return 'no such file or directory';
    case 'EACCES':
      return 'permission denied';
    case 'ENOTDIR':
      return 'not a directory';
    case 'ELOOP':
      return 'too many levels of symbolic links';
    case 'ENAMETOOLONG':
      return 'file name too long';
    case 'ENOEXEC':
      return 'exec format error';
    default:
      return code;
  }
}

/** Why `file` cannot be run, as a system error code, or `''` when it is a file this user may execute. */
function executableProblem(file: string): string {
  try {
    if (statSync(file).isDirectory()) return 'EACCES';
    accessSync(file, constants.X_OK);
    return '';
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    const colon = message.indexOf(':');
    return colon < 0 ? 'EACCES' : message.slice(0, colon);
  }
}

/**
 * The file that the first word of a command runs, as Go's os/exec finds it for tsgo, and why it cannot be run,
 * in the words of tsgo's diagnostic, or `''`. A name without a separator is looked up in the directories of
 * `PATH`, where a match in a relative directory is refused. Any other name is used as it is, relative to
 * `directory`.
 */
function resolveCommand(name: string, directory: string, path: string): { file: string; problem: string } {
  if (name === '') return { file: name, problem: 'exec: no command' };
  if (!name.includes('/')) {
    for (const entry of path === '' ? [] : path.split(':')) {
      const file = combinePaths(entry === '' ? '.' : entry, name);
      if (executableProblem(file) !== '') continue;
      if (pathIsAbsolute(file)) return { file, problem: '' };
      const problem = `exec: ${JSON.stringify(name)}: cannot run executable found relative to current directory`;
      return { file, problem };
    }
    return { file: name, problem: `exec: ${JSON.stringify(name)}: executable file not found in $PATH` };
  }
  const code = executableProblem(pathIsAbsolute(name) ? name : combinePaths(directory, name));
  return { file: name, problem: code === '' ? '' : `fork/exec ${name}: ${systemErrorText(code)}` };
}

class NodeSystem extends System {
  constructor(
    currentDirectory: string,
    writeOutputIsTTY: boolean,
    terminalWidth: number,
    defaultLibraryPath: string,
    /** The directory `bundled:///libs/` maps to, or `''`. */
    private readonly bundledLibs: string,
  ) {
    super(currentDirectory, writeOutputIsTTY, terminalWidth, true, defaultLibraryPath);
  }

  getEnvironmentVariable(name: string): string {
    return process.env[name] ?? '';
  }

  hasEnvironmentVariable(name: string): boolean {
    return process.env[name] !== undefined;
  }

  write(text: string): void {
    // A pipe may be non-blocking (EAGAIN): retry a while until everything is written.
    const bytes = Buffer.from(text);
    let offset = 0;
    let failures = 0;
    while (offset < bytes.length) {
      try {
        offset += writeSync(1, bytes, offset);
        failures = 0;
      } catch {
        if (++failures > 100000) throw new Error('cannot write to stdout');
      }
    }
  }

  private toOsPath(path: string): string {
    if (this.bundledLibs !== '' && path.startsWith(bundledPrefix)) {
      return this.bundledLibs + '/' + path.slice(bundledPrefix.length);
    }
    return path;
  }

  // Network paths are never accessed (`isNetworkPath`).

  readFile(path: string): string | undefined {
    if (isNetworkPath(path)) return undefined;
    try {
      return readFileSync(this.toOsPath(path), 'utf8');
    } catch {
      return undefined;
    }
  }

  writeFile(path: string, text: string): boolean {
    if (isNetworkPath(path)) return false;
    // Most outputs go to directories that exist: write first, and create the directory only when that fails.
    try {
      writeFileSync(path, text);
      return true;
    } catch {
      // Created below.
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return true;
    } catch {
      return false;
    }
  }

  fileExists(path: string): boolean {
    if (isNetworkPath(path)) return false;
    try {
      return statSync(this.toOsPath(path)).isFile();
    } catch {
      return false;
    }
  }

  directoryExists(path: string): boolean {
    if (isNetworkPath(path)) return false;
    try {
      return statSync(this.toOsPath(path)).isDirectory();
    } catch {
      return false;
    }
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const files: string[] = [];
    const directories: string[] = [];
    const symlinks = new Set<string>();
    let entries: Dirent[];
    if (isNetworkPath(path)) return new DirectoryEntries(files, directories, symlinks);
    try {
      entries = readdirSync(this.toOsPath(path), { withFileTypes: true });
    } catch {
      return new DirectoryEntries(files, directories, symlinks);
    }
    // Each entry's name and kind, read once, then the entries by name.
    const names: string[] = [];
    const kinds: number[] = [];
    for (const entry of entries) {
      names.push(entry.name);
      kinds.push(
        entry.isDirectory()
          ? EntryKind.Directory
          : entry.isFile()
            ? EntryKind.File
            : entry.isSymbolicLink()
              ? EntryKind.Symlink
              : EntryKind.Other,
      );
    }
    const order: number[] = [];
    for (let i = 0; i < names.length; i++) order.push(i);
    order.sort((a, b) => compareUtf8(names[a]!, names[b]!));
    for (const i of order) {
      const name = names[i]!;
      const kind = kinds[i]!;
      if (kind === EntryKind.Directory) directories.push(name);
      else if (kind === EntryKind.File) files.push(name);
      else if (kind === EntryKind.Symlink) {
        try {
          const stat = statSync(this.toOsPath(path) + '/' + name);
          if (stat.isDirectory()) directories.push(name);
          else if (stat.isFile()) files.push(name);
          else continue;
          symlinks.add(name);
        } catch {
          // A broken link.
        }
      }
    }
    return new DirectoryEntries(files, directories, symlinks);
  }

  realpath(path: string): string {
    if (isNetworkPath(path)) return path;
    try {
      // A local path may resolve to a network location (a mapped network drive): keep the original.
      const real = normalizePath(realpathSync(path));
      return isNetworkPath(real) ? path : real;
    } catch {
      return path;
    }
  }

  getMTime(path: string): number | undefined {
    if (isNetworkPath(path)) return undefined;
    try {
      return statSync(this.toOsPath(path)).mtimeMs;
    } catch {
      return undefined;
    }
  }

  setMTime(path: string, time: number): boolean {
    if (isNetworkPath(path)) return false;
    try {
      const date = new Date(time);
      utimesSync(path, date, date);
      return true;
    } catch {
      return false;
    }
  }

  removeFile(path: string): boolean {
    if (isNetworkPath(path)) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  watchDirectory(path: string, onChange: () => void): DirectoryWatch | undefined {
    // inotify and ReadDirectoryChangesW report writes to a directory's files; kqueue only its entries.
    if (process.platform !== 'linux' && process.platform !== 'win32') return undefined;
    try {
      return new NodeDirectoryWatch(watchPath(path, () => onChange()));
    } catch {
      return undefined;
    }
  }

  spawn(command: readonly string[], directory: string, captureStandardError: boolean): ProcessChannel | string {
    if (process.platform === 'win32') return 'tsc-ts does not start content mapper processes on Windows';
    const name = command[0] ?? '';
    const { file, problem } = resolveCommand(name, directory, process.env.PATH ?? '');
    if (problem !== '') return problem;
    if (!isNode()) {
      const started = tscTsSpawn([file, ...command].join('\0') + '\0', directory, captureStandardError);
      if (started >= 0) return new NativeProcessChannel(started, captureStandardError);
      const text = new Uint8Array(256);
      const reason = new TextDecoder().decode(text.subarray(0, tscTsSpawnError(text)));
      // Go words a system error as the system does, without the capital.
      return `fork/exec ${file}: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`;
    }
    let pipeDirectory: string;
    try {
      pipeDirectory = mkdtempSync(combinePaths(tmpdir(), 'tsc-ts-mapper-'));
    } catch {
      return 'pipe: no temporary directory';
    }
    try {
      return startProcess(pipeDirectory, file, command, directory, captureStandardError);
    } finally {
      rmSync(pipeDirectory, { recursive: true, force: true });
    }
  }
}

function isNode(): boolean {
  return /(^|[/\\])node(\.exe)?$/.test(process.execPath);
}

class NodeDirectoryWatch implements DirectoryWatch {
  constructor(private readonly watcher: FSWatcher) {}

  close(): void {
    this.watcher.close();
  }
}

/** Orders names by UTF-8 bytes, as Go's directory listing does. */
function compareUtf8(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return Buffer.compare(x, y);
}

/** Columns of the terminal, from `stty` since there's no portable API for it. */
function terminalWidth(): number {
  const result = spawnSync('stty', ['size'], { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] });
  if (result.status !== 0) return 0;
  const columns = Number(result.stdout.trim().split(' ')[1]);
  return Number.isInteger(columns) ? columns : 0;
}

/**
 * The system of a `tsc` run in the current directory. Lib files are read from `libraryPath`;
 * `bundled:///libs/` maps to `bundledLibs` when it isn't `''`.
 */
export function createNodeSystem(libraryPath: string, bundledLibs: string): System {
  const isTTY = process.stdout.isTTY === true;
  return new NodeSystem(
    normalizePath(process.cwd()),
    isTTY,
    isTTY ? terminalWidth() : 0,
    normalizePath(libraryPath),
    bundledLibs,
  );
}

/** Writes the files checker threads emit (parallel-check.ts) as the system of `runTsc` does. */
export function outputWriterOfThread(libraryPath: string): OutputWriter {
  return new SystemWriter(new NodeSystem(normalizePath(process.cwd()), false, 0, normalizePath(libraryPath), ''));
}

/** What `runTsc` returns when it keeps watching for changes instead of exiting. */
export const watching = -1;

/** Runs the tsc command line `args` and returns the exit status, or `watching`. */
export function runTsc(args: readonly string[], libraryPath: string): number {
  const sys = tscSystem(libraryPath);
  return runCommandLineResult(sys, executeCommandLine(sys, args));
}

/** The program the tsc command line `args` compiles, if it compiles one: a checker thread's own copy. */
export function programOfCommandLine(args: readonly string[], libraryPath: string): Program | undefined {
  const result = executeCommandLine(tscSystem(libraryPath), args);
  return result.kind === 'compile' ? result.program : undefined;
}

/**
 * A parse thread (parallel-parse.ts) for the compile command line `args`, whose main thread found its
 * config at `configFileName`; `undefined` if the project cannot be read.
 */
export function parseThreadOfCommandLine(
  args: readonly string[],
  configFileName: string,
  libraryPath: string,
): ParseThread | undefined {
  const sys = tscSystem(libraryPath);
  const project = readThreadProject(sys, args, configFileName);
  return project === undefined
    ? undefined
    : new ParseThread(project.config, project.fs, sys.currentDirectory, sys.defaultLibraryPath);
}

function tscSystem(libraryPath: string): System {
  // With TSC_TS_BUNDLED_LIBS set, lib files are read from there as `bundled:///libs/`, like tsgo's embedded ones.
  const bundledLibs = process.env.TSC_TS_BUNDLED_LIBS ?? '';
  return createNodeSystem(bundledLibs !== '' ? 'bundled:///libs' : libraryPath, bundledLibs);
}

function runCommandLineResult(sys: System, result: CommandLineResult): number {
  if (result.kind === 'exit') return result.status;
  if (result.kind === 'compile') {
    const threads = compileThreads(sys, result);
    if (threads <= 1) {
      // Emit threads report back on this thread's event loop too.
      const emitThreads = compileEmitThreads(result);
      if (
        emitThreads > 0 &&
        compileWithEmitThreads(sys, result, emitThreads, (status) => {
          markMemory();
          mark('exit');
          exitWithDoctorReport(status);
        })
      )
        return watching;
      // Declaration errors are found on a thread of their own while this thread checks.
      if (
        compileWithDeclarationThread(sys, result, (status) => {
          markMemory();
          mark('exit');
          exitWithDoctorReport(status);
        })
      )
        return watching;
      return compile(sys, result);
    }
    // Checker threads report back on this thread's event loop.
    compileInParallel(sys, result, threads, (status) => {
      markMemory();
      mark('exit');
      exitWithDoctorReport(status);
    });
    return watching;
  }
  if (result.kind === 'deferred') {
    // Parse threads prepare the program's files first (parallel-parse.ts).
    result.run((ready) => {
      const status = runCommandLineResult(sys, ready);
      if (status !== watching) {
        markMemory();
        mark('exit');
        exitWithDoctorReport(status);
      }
    });
    return watching;
  }
  if (result.kind === 'build') {
    if (result.commandLine.compilerOptions.watch === true) {
      if (!superviseWatch()) watchBuild(sys, result.commandLine);
      return watching;
    }
    const status = buildWithThreads(sys, result.commandLine, (s) => {
      markMemory();
      mark('exit');
      process.exit(s);
    });
    return status ?? watching;
  }
  if (!superviseWatch()) watch(sys, result.config, result.commandLine);
  return watching;
}

/** The environment variable that marks a watch process started by `superviseWatch`, and how. */
const watchProcessVariable = 'TSC_TS_WATCH_PROCESS';
/** The exit status of a watch process that stops for a new one to continue (`watchRestart`). */
const watchRestartStatus = 75;

/**
 * Natively, watch mode runs in a child process of this one, started again whenever it stops for its
 * memory (`WatchRestart`, tsc-watch.ts), since syntax trees, symbols and types are never freed. Returns
 * whether this process supervises; in the child, sets up `watchRestart` and returns false. Under
 * Node.js, or with TSC_TS_WATCH_MEMORY=0, watch mode runs in this process.
 *
 * TSC_TS_WATCH_MEMORY sets the limit in megabytes; by default it is 2.5 times the resident memory
 * after the first build.
 *
 * Signals are not forwarded: a terminal's SIGINT and SIGHUP reach the child too, which is in this
 * process's group, and a child whose supervisor ends exits within a second (its `process.ppid` check).
 * A signal listener here would link scriptc's events unit, which turns off int32 specialization for
 * hundreds of functions in the whole program and makes every compile slower.
 */
function superviseWatch(): boolean {
  if (/(^|[/\\])node(\.exe)?$/.test(process.execPath)) return false;
  const memory = process.env.TSC_TS_WATCH_MEMORY ?? '';
  if (memory === '0') return false;
  const role = process.env[watchProcessVariable];
  if (role !== undefined) {
    watchRestart.resumed = role === 'resume';
    const megabytes = Number(memory);
    if (memory !== '' && megabytes > 0) watchRestart.limit = megabytes * 1048576;
    watchRestart.restart = () => process.exit(watchRestartStatus);
    // A supervisor that ends (on SIGTERM, or SIGKILL) leaves this process to init.
    const parent = process.ppid;
    setInterval(() => {
      if (process.ppid !== parent) process.exit(1);
    }, 1000);
    return false;
  }
  const start = (resumed: boolean): void => {
    const env: Record<string, string | undefined> = { ...process.env };
    env[watchProcessVariable] = resumed ? 'resume' : 'start';
    const child = spawn(process.execPath, process.argv.slice(2), { stdio: 'inherit', env });
    child.on('error', (error) => {
      process.stderr.write(error.message + '\n');
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      if (code === watchRestartStatus) start(true);
      else if (signal !== null) process.kill(process.pid, signal);
      else process.exit(code ?? 1);
    });
  };
  start(false);
  return true;
}
