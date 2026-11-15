/**
 * The content mapper host that runs each mapper as a process, as tsgo's does: the command a mapper's package
 * declares is started in the package's directory with the first request for it, once for all the mappers with
 * the same identity, and answers JSON-RPC requests on its standard input and output until the last project
 * that uses it is closed.
 *
 * ```ts
 * const host = new ContentMapperProcessHost(sys, '');
 * const project = host.project(new ContentMapperProjectSpec(configFileName, mappers, options));
 * const result = project.transform(mapper, new ContentMapperRequest('/src/App.vue', text));
 * project.close();
 * host.close();
 * ```
 *
 * tsgo reads a mapper's responses on a thread of their own and sends the requests of several files at once.
 * This host loads one file at a time, so a request is written and its response is read before the next: the
 * `ProcessChannel` a `ProcessSpawner` gives for a command blocks on the process. What a mapper writes while
 * no request waits is read with the next one.
 */
import {
  combinedIdentity,
  ContentMapperProjectSpec,
  ContentMapperTimings,
  InitializeError,
  InitializeErrorKind,
  MapperTimings,
  OperationTiming,
  ProjectError,
  ProjectErrorKind,
  RequestError,
  TransformError,
  TransformErrorKind,
  type ContentMapper,
  type ContentMapperHost,
  type ContentMapperOptionDiagnostic,
  type ContentMapperProject,
  type ContentMapperRequest,
  type ContentMapperResult,
  type ProjectFailure,
} from './content-mapper.js';
import {
  decodeInitializeResult,
  decodeOpenProjectResult,
  decodeTransformResult,
  initializeTimeoutSeconds,
  InitializeResult,
  marshalCloseProjectParams,
  marshalInitializeParams,
  marshalOpenProjectParams,
  marshalTransformParams,
  methodCloseProject,
  methodInitialize,
  methodOpenProject,
  methodTransform,
  type OpenProjectResult,
} from './content-mapper-protocol.js';
import { compareCodePoints } from './diagnostics.js';
import type { CompilerOptions } from './options.js';
import { JsonParser, type JsonValue } from './package-json.js';

// ---- Processes

/** The standard input and output of a running process, read and written by a caller that waits for both. */
export interface ProcessChannel {
  /** Writes `bytes` to the process's standard input. False when they cannot be written: the process ended. */
  write(bytes: Uint8Array): boolean;
  /**
   * Waits for output of the process and reads it into `buffer`. Returns the number of bytes read, 0 when the
   * process closed its standard output, and -1 when nothing arrived within `timeoutMilliseconds`; a negative
   * timeout waits without limit.
   */
  read(buffer: Uint8Array, timeoutMilliseconds: number): number;
  /**
   * What the process wrote to its standard error since the last call, for a channel that was asked to capture
   * it; `''` otherwise.
   */
  readStandardError(): string;
  /** The exit code of a process that is known to have ended, -1 for one a signal ended. */
  exitCode(): number | undefined;
  /** Closes the standard input of the process and ends it. */
  close(): void;
}

/** What starts the process of a mapper: the system of the command line. */
export interface ProcessSpawner {
  /**
   * Starts `command` in `directory`, with a first word that has no directory separator looked up on `PATH`.
   * The standard error of the process is discarded unless `captureStandardError` asks for it. Returns the
   * channel to the process, or why it could not be started, in the words of tsgo's diagnostic.
   */
  spawn(command: readonly string[], directory: string, captureStandardError: boolean): ProcessChannel | string;
}

/** Receives each message of the protocol and each line a mapper writes to standard error. */
export type ContentMapperLogger = (message: string) => void;

// ---- The connection to a mapper

/** What tsgo's connection reports for a request made after the mapper closed its output. */
const connectionClosed = 'ipc: connection closed';

const jsonRpcInternalError = -32603;

/** How a request ended: with the `result` of the response, or with `error`. */
class CallOutcome {
  constructor(
    readonly result: JsonValue | undefined,
    readonly error: string | undefined,
    /** Whether the request was given up because the response did not arrive in time. */
    readonly timedOut: boolean,
  ) {}
}

/** A message of the protocol as it is read from a mapper. */
class IncomingMessage {
  constructor(
    /** The JSON of the message's `id`, or `''` for a message without one. */
    readonly id: string,
    readonly method: string,
    readonly result: JsonValue | undefined,
    readonly error: JsonValue | undefined,
  ) {}
}

/**
 * JSON-RPC 2.0 over the channel of a mapper process, each message after a `Content-Length` header. A request
 * of the mapper is rejected and a notification is ignored, since only the compiler makes requests.
 */
class MapperConnection {
  private sequence = 0;
  /** Why no request can be made any more, once the mapper's output ended or stopped being the protocol. */
  private terminal: string | undefined;
  /** The exit code the process had when the connection failed, read before the process was ended. */
  private failedExitCode: number | undefined;
  private buffer = new Uint8Array(65536);
  private start = 0;
  private end = 0;
  private pendingStandardError = '';
  private closed = false;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(
    private readonly channel: ProcessChannel,
    private readonly mapperName: string,
    private readonly logger: ContentMapperLogger | undefined,
  ) {}

  /**
   * Sends the request `method` with the parameters `params`, which are JSON, and waits for its response, up to
   * `timeoutMilliseconds` when that is not negative.
   */
  call(method: string, params: string, timeoutMilliseconds: number): CallOutcome {
    if (this.terminal !== undefined) return new CallOutcome(undefined, this.terminal, false);
    this.sequence += 1;
    const id = JSON.stringify(`api${this.sequence}`);
    if (!this.send(`{"jsonrpc":"2.0","id":${id},"method":${JSON.stringify(method)},"params":${params}}`))
      return new CallOutcome(undefined, this.fail(undefined), false);
    const deadline = timeoutMilliseconds < 0 ? -1 : performance.now() + timeoutMilliseconds;
    for (;;) {
      // The limit also ends a wait in which the mapper sends other messages than the response.
      const late = deadline >= 0 && performance.now() >= deadline;
      const message = late ? undefined : this.readMessage(deadline);
      this.logStandardError(false);
      if (message === undefined) {
        if (this.terminal === undefined) return new CallOutcome(undefined, 'context deadline exceeded', true);
        return new CallOutcome(undefined, this.terminal, false);
      }
      // A notification.
      if (message.id === '') continue;
      if (message.method !== '') {
        const text = `content mapper sent an unexpected request: ${message.method}`;
        const error = `{"code":${jsonRpcInternalError},"message":${JSON.stringify(text)}}`;
        if (!this.send(`{"jsonrpc":"2.0","id":${message.id},"error":${error}}`))
          return new CallOutcome(undefined, this.fail(undefined), false);
        continue;
      }
      // A response to a request that is no longer waited for.
      if (message.id !== id) continue;
      if (message.error === undefined) return new CallOutcome(message.result, undefined, false);
      const entries = message.error.type === 'object' ? message.error.entries : undefined;
      const code = entries?.get('code');
      const text = entries?.get('message');
      return new CallOutcome(
        undefined,
        `ipc: remote error [${code?.type === 'number' ? code.value : 0}]: ${text?.type === 'string' ? text.value : ''}`,
        false,
      );
    }
  }

  /** Ends the process. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.close();
    this.logStandardError(true);
  }

  /** The exit code of the process, if it is known to have ended by itself. */
  exitCode(): number | undefined {
    return this.terminal === undefined ? this.channel.exitCode() : this.failedExitCode;
  }

  /**
   * Records that the connection is over, with the reason the mapper's output could not be read if there is
   * one, and ends the process, as tsgo does when its reader stops. Returns what requests fail with from now.
   */
  private fail(cause: string | undefined): string {
    this.terminal = cause === undefined ? connectionClosed : `${connectionClosed}\n${cause}`;
    this.failedExitCode = this.channel.exitCode();
    this.close();
    return this.terminal;
  }

  private send(message: string): boolean {
    this.logger?.(`[content mapper: ${this.mapperName}] send: ${message}`);
    const body = this.encoder.encode(message);
    const header = this.encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
    const bytes = new Uint8Array(header.length + body.length);
    bytes.set(header);
    bytes.set(body, header.length);
    return this.channel.write(bytes);
  }

  /** Logs the lines the mapper wrote to standard error; `flush` also logs a last line that has no end. */
  private logStandardError(flush: boolean): void {
    if (this.logger === undefined) return;
    this.pendingStandardError += this.channel.readStandardError();
    for (;;) {
      const index = this.pendingStandardError.indexOf('\n');
      if (index < 0) break;
      this.logStandardErrorLine(this.pendingStandardError.slice(0, index));
      this.pendingStandardError = this.pendingStandardError.slice(index + 1);
    }
    if (!flush || this.pendingStandardError === '') return;
    this.logStandardErrorLine(this.pendingStandardError);
    this.pendingStandardError = '';
  }

  private logStandardErrorLine(line: string): void {
    this.logger?.(`[content mapper: ${this.mapperName}] stderr: ${line.endsWith('\r') ? line.slice(0, -1) : line}`);
  }

  /**
   * Reads more of the mapper's output. Returns the number of bytes read, 0 when the output ended, and -1 when
   * `deadline` passed first.
   */
  private fill(deadline: number): number {
    if (this.start > 0) {
      this.buffer.copyWithin(0, this.start, this.end);
      this.end -= this.start;
      this.start = 0;
    }
    if (this.end === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    const timeout = deadline < 0 ? -1 : Math.max(0, Math.ceil(deadline - performance.now()));
    const count = this.channel.read(this.buffer.subarray(this.end), timeout);
    if (count > 0) this.end += count;
    return count;
  }

  /**
   * The next message of the mapper. `undefined` when none arrives before `deadline`, and when the output ends
   * or is not a message, which ends the connection.
   */
  private readMessage(deadline: number): IncomingMessage | undefined {
    let contentLength = 0;
    for (;;) {
      // The line of a header, with its end.
      let searched = 0;
      let lineEnd = -1;
      while (lineEnd < 0) {
        const index = this.buffer.subarray(this.start + searched, this.end).indexOf(0x0a);
        if (index >= 0) {
          lineEnd = this.start + searched + index + 1;
          break;
        }
        searched = this.end - this.start;
        const count = this.fill(deadline);
        if (count < 0) return undefined;
        // Output that ends between messages, or inside a header, closes the connection without a reason.
        if (count === 0) return this.invalid(undefined);
      }
      const line = this.decoder.decode(this.buffer.subarray(this.start, lineEnd));
      this.start = lineEnd;
      if (line === '\r\n') break;
      const colon = line.indexOf(':');
      if (colon < 0) return this.invalid(`jsonrpc: invalid header: ${quote(line)}`);
      if (line.slice(0, colon) !== 'Content-Length') continue;
      const value = line.slice(colon + 1).trim();
      const invalidLength = 'jsonrpc: invalid content length: ';
      if (!/^[+-]?[0-9]+$/.test(value))
        return this.invalid(`${invalidLength}parse error: strconv.ParseInt: parsing ${quote(value)}: invalid syntax`);
      contentLength = Number(value);
      if (Math.abs(contentLength) >= 9223372036854775808)
        return this.invalid(
          `${invalidLength}parse error: strconv.ParseInt: parsing ${quote(value)}: value out of range`,
        );
      if (contentLength < 0) return this.invalid(`${invalidLength}negative value ${value}`);
    }
    if (contentLength <= 0) return this.invalid('jsonrpc: no content length');
    while (this.end - this.start < contentLength) {
      const partial = this.end > this.start;
      const count = this.fill(deadline);
      if (count < 0) return undefined;
      if (count === 0) return this.invalid(partial ? 'jsonrpc: read content: unexpected EOF' : undefined);
    }
    const body = this.decoder.decode(this.buffer.subarray(this.start, this.start + contentLength));
    this.start += contentLength;
    const message = this.parseMessage(body);
    if (message === undefined) return this.invalid('jsonrpc: invalid message');
    this.logger?.(`[content mapper: ${this.mapperName}] receive: ${body}`);
    return message;
  }

  /** Ends the connection because the mapper's output ended or, with `cause`, is not the protocol. */
  private invalid(cause: string | undefined): undefined {
    this.fail(cause);
    return undefined;
  }

  /** A message from its JSON: an object whose names are not repeated and whose `jsonrpc` is `"2.0"`. */
  private parseMessage(body: string): IncomingMessage | undefined {
    const parser = new JsonParser(body);
    const value = parser.value();
    parser.skipWhitespace();
    if (value === undefined || parser.pos !== body.length || parser.repeatedName || value.type !== 'object')
      return undefined;
    const version = value.entries.get('jsonrpc');
    if (version !== undefined && (version.type !== 'string' || version.value !== '2.0')) return undefined;
    const id = value.entries.get('id');
    const method = value.entries.get('method');
    const error = value.entries.get('error');
    if (id !== undefined && id.type !== 'null' && id.type !== 'string' && !isInt32(id)) return undefined;
    if (method !== undefined && method.type !== 'null' && method.type !== 'string') return undefined;
    if (error !== undefined && error.type !== 'null') {
      if (error.type !== 'object') return undefined;
      const code = error.entries.get('code');
      const text = error.entries.get('message');
      if (code !== undefined && code.type !== 'null' && !isInt32(code)) return undefined;
      if (text !== undefined && text.type !== 'null' && text.type !== 'string') return undefined;
    }
    return new IncomingMessage(
      id === undefined
        ? ''
        : id.type === 'string'
          ? JSON.stringify(id.value)
          : id.type === 'number'
            ? `${id.value}`
            : '',
      method === undefined || method.type === 'null' ? '' : method.value,
      value.entries.get('result'),
      error === undefined || error.type === 'null' ? undefined : error,
    );
  }
}

/** Whether a JSON value is a number written as an integer of 32 bits, as the id and the code of a message are. */
function isInt32(value: JsonValue): boolean {
  return value.type === 'number' && value.integer && (value.value | 0) === value.value;
}

/** `text` in double quotes as Go writes it with `%q`, which the errors of tsgo's reader do. */
function quote(text: string): string {
  let quoted = '"';
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (character === '"' || character === '\\') quoted += `\\${character}`;
    else if (code === 0x07) quoted += '\\a';
    else if (code === 0x08) quoted += '\\b';
    else if (code === 0x09) quoted += '\\t';
    else if (code === 0x0a) quoted += '\\n';
    else if (code === 0x0b) quoted += '\\v';
    else if (code === 0x0c) quoted += '\\f';
    else if (code === 0x0d) quoted += '\\r';
    else if (code < 0x20 || code === 0x7f) quoted += `\\x${code.toString(16).padStart(2, '0')}`;
    else quoted += character;
  }
  return `${quoted}"`;
}

/** What tsgo's decoder says of an `initialize` response that has no result to decode. */
function missingResult(): InitializeError {
  const error = new InitializeError(InitializeErrorKind.InvalidResponse);
  error.detail = 'jsontext: unexpected EOF';
  return error;
}

// ---- The host

/** The process of the mappers with one identity, or why it does not run. */
class MapperProcess {
  connection: MapperConnection | undefined;
  /** Why the mapper did not start. It is not started again until the locale changes. */
  error: InitializeError | RequestError | undefined;
  initialized: InitializeResult | undefined;
  /** The number of projects and `acquire` calls that keep the process. */
  references = 0;
}

/** A mapper as one project configures it. */
class ProjectEntry {
  opened: OpenProjectResult | undefined;

  constructor(
    readonly mapper: ContentMapper,
    readonly spec: ContentMapperProjectSpec,
    /** The name the mapper's process knows this project by. */
    readonly projectHandle: string,
  ) {}
}

/** How often an operation ran and for how long. */
class OperationTimer {
  count = 0;
  duration = 0;

  record(start: number): void {
    this.count += 1;
    this.duration += performance.now() - start;
  }

  snapshot(): OperationTiming {
    return new OperationTiming(this.count, this.duration);
  }
}

/** The timers of one mapper identity. */
class MapperTimers {
  readonly spawn = new OperationTimer();
  readonly initialize = new OperationTimer();
  readonly openProject = new OperationTimer();
  readonly closeProject = new OperationTimer();
  readonly transform = new OperationTimer();
}

/**
 * The state the projects with one spec share: an entry for each of the spec's mappers, kept until the last of
 * the projects is closed.
 */
class ProjectLease {
  /** The handle of each mapper's entry among the host's. */
  readonly entries = new Map<ContentMapper, string>();
  references = 1;

  constructor(readonly spec: ContentMapperProjectSpec) {}

  /** Whether the lease is for `spec`: the same config file, and the same options and mappers by identity. */
  serves(spec: ContentMapperProjectSpec): boolean {
    if (spec.configFileName !== this.spec.configFileName || spec.compilerOptions !== this.spec.compilerOptions)
      return false;
    if (spec.mappers.length !== this.spec.mappers.length) return false;
    for (let i = 0; i < spec.mappers.length; i++) if (spec.mappers[i] !== this.spec.mappers[i]) return false;
    return true;
  }
}

/** One reference to a lease, which a caller of `ContentMapperProcessHost.project` closes once. */
class LeasedProject implements ContentMapperProject {
  private closed = false;

  constructor(
    private readonly host: ContentMapperProcessHost,
    private readonly lease: ProjectLease,
  ) {}

  refresh(): ProjectFailure | undefined {
    return this.host.refreshLease(this.lease);
  }

  identities(): string[] | ProjectFailure {
    const identities: string[] = [];
    for (const mapper of this.lease.spec.mappers) {
      const entry = this.host.entryOf(this.lease, mapper);
      if (entry === undefined) continue;
      const identity = this.host.identityOf(entry);
      if (typeof identity !== 'string') return identity;
      identities.push(identity);
    }
    return identities;
  }

  identity(mapper: ContentMapper): string | ProjectFailure {
    const entry = this.host.entryOf(this.lease, mapper);
    return entry === undefined ? '' : this.host.identityOf(entry);
  }

  watchedFiles(): string[] | ProjectFailure {
    const files = new Set<string>();
    for (const mapper of this.lease.entries.keys()) {
      const entry = this.host.entryOf(this.lease, mapper);
      if (entry === undefined) continue;
      if (mapper.manifest.dynamicConfig) {
        const failure = this.host.openProject(entry);
        if (failure !== undefined) return failure;
      }
      if (entry.opened !== undefined) for (const file of entry.opened.watchedFiles) files.add(file);
    }
    return Array.from(files).sort(compareCodePoints);
  }

  diagnostics(): ContentMapperOptionDiagnostic[] {
    const diagnostics: ContentMapperOptionDiagnostic[] = [];
    for (const mapper of this.lease.spec.mappers) {
      const opened = this.host.entryOf(this.lease, mapper)?.opened;
      if (opened !== undefined) for (const diagnostic of opened.optionDiagnostics) diagnostics.push(diagnostic);
    }
    return diagnostics;
  }

  transform(mapper: ContentMapper, request: ContentMapperRequest): ContentMapperResult | TransformError {
    const entry = this.host.entryOf(this.lease, mapper);
    if (entry === undefined)
      return new TransformError(TransformErrorKind.Unknown, new RequestError('content mapper project is closed'));
    const failure = this.host.openProject(entry);
    if (failure !== undefined)
      return new TransformError(
        failure instanceof InitializeError ? TransformErrorKind.Initialize : TransformErrorKind.Project,
        failure,
      );
    return this.host.transformEntry(entry, request);
  }

  close(): ProjectFailure | undefined {
    if (this.closed) return undefined;
    this.closed = true;
    return this.host.releaseLease(this.lease);
  }
}

/** Runs content mappers as processes that a `ProcessSpawner` starts. */
export class ContentMapperProcessHost implements ContentMapperHost {
  /** The processes by mapper identity; `undefined` once the host is closed. */
  private processes: Map<string, MapperProcess> | undefined = new Map<string, MapperProcess>();
  /** The mapper projects by handle. */
  private readonly projects = new Map<string, ProjectEntry>();
  private leases: ProjectLease[] = [];
  private nextProjectId = 0;
  private readonly timers = new Map<string, MapperTimers>();
  /** The time spent waiting for mappers. Requests never overlap, so it is the time of all of them. */
  private requestWait = 0;

  constructor(
    private readonly spawner: ProcessSpawner,
    /** The BCP 47 locale mappers write their messages in, or `''` for the default. */
    private diagnosticLocale: string,
    /** Receives the messages exchanged with each mapper and what it writes to standard error. */
    private readonly logger?: ContentMapperLogger,
  ) {}

  timings(): ContentMapperTimings {
    const mappers = new Map<string, MapperTimings>();
    for (const [identity, timers] of this.timers)
      mappers.set(
        identity,
        new MapperTimings(
          timers.spawn.snapshot(),
          timers.initialize.snapshot(),
          timers.openProject.snapshot(),
          timers.closeProject.snapshot(),
          timers.transform.snapshot(),
        ),
      );
    return new ContentMapperTimings(mappers, this.requestWait);
  }

  project(spec: ContentMapperProjectSpec): ContentMapperProject {
    for (const lease of this.leases)
      if (lease.serves(spec)) {
        lease.references += 1;
        return new LeasedProject(this, lease);
      }
    const lease = new ProjectLease(
      new ContentMapperProjectSpec(spec.configFileName, [...spec.mappers], spec.compilerOptions),
    );
    // The project of a closed host has no mappers.
    if (this.processes === undefined) return new LeasedProject(this, lease);
    for (const mapper of spec.mappers) {
      const identity = mapper.identity();
      const projectHandle = `${identity}:${this.nextProjectId}`;
      this.nextProjectId += 1;
      this.projects.set(projectHandle, new ProjectEntry(mapper, spec, projectHandle));
      this.processOf(this.processes, identity).references += 1;
      lease.entries.set(mapper, projectHandle);
    }
    this.leases.push(lease);
    return new LeasedProject(this, lease);
  }

  acquire(mappers: readonly ContentMapper[]): () => void {
    const identities: string[] = [];
    if (this.processes !== undefined)
      for (const mapper of mappers) {
        const identity = mapper.identity();
        if (identities.includes(identity)) continue;
        identities.push(identity);
        this.processOf(this.processes, identity).references += 1;
      }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(identities);
    };
  }

  setLocale(locale: string): void {
    if (locale === this.diagnosticLocale) return;
    this.diagnosticLocale = locale;
    if (this.processes === undefined) return;
    for (const process of this.processes.values()) {
      process.connection?.close();
      process.connection = undefined;
      process.error = undefined;
      process.initialized = undefined;
    }
    for (const entry of this.projects.values()) entry.opened = undefined;
  }

  transform(mapper: ContentMapper, request: ContentMapperRequest): ContentMapperResult | TransformError {
    const options: CompilerOptions = {};
    const project = this.project(new ContentMapperProjectSpec('', [mapper], options));
    const result = project.transform(mapper, request);
    project.close();
    return result;
  }

  close(): void {
    if (this.processes === undefined) return;
    for (const process of this.processes.values()) process.connection?.close();
    this.processes = undefined;
    this.projects.clear();
    this.leases = [];
  }

  // ---- For the projects of this host

  /** The entry of `mapper` in a lease, unless the host or the lease's last project is closed. */
  entryOf(lease: ProjectLease, mapper: ContentMapper): ProjectEntry | undefined {
    const projectHandle = lease.entries.get(mapper);
    return projectHandle === undefined ? undefined : this.projects.get(projectHandle);
  }

  /** The identity of an entry's mapper in its project, for which a mapper with `dynamicConfig` is opened. */
  identityOf(entry: ProjectEntry): string | ProjectFailure {
    const options = entry.spec.compilerOptions;
    if (!entry.mapper.manifest.dynamicConfig) return combinedIdentity(entry.mapper, undefined, options);
    const failure = this.openProject(entry);
    if (failure !== undefined) return failure;
    return combinedIdentity(entry.mapper, entry.opened?.configIdentity ?? '', options);
  }

  /** Opens the mapper project of an entry if it is not open. Returns the failure, if any. */
  openProject(entry: ProjectEntry): ProjectFailure | undefined {
    if (entry.opened !== undefined) return undefined;
    const process = this.connect(entry.mapper);
    if (process.connection === undefined || process.initialized === undefined)
      return process.error ?? new RequestError('content mapper host is closed');
    const spec = entry.spec;
    const params = marshalOpenProjectParams(
      spec.configFileName,
      entry.projectHandle,
      entry.mapper,
      spec.compilerOptions,
    );
    const timers = this.timersOf(entry.mapper.identity());
    const outcome = this.request(process.connection, timers.openProject, methodOpenProject, params);
    if (outcome.error !== undefined) return new RequestError(outcome.error);
    // A response without a result does not decode.
    if (outcome.result === undefined) return new ProjectError(ProjectErrorKind.MalformedResponse);
    const opened = decodeOpenProjectResult(outcome.result, entry.mapper, process.initialized.diagnosticSource);
    if (opened instanceof ProjectError) return opened;
    entry.opened = opened;
    return undefined;
  }

  /** Transforms a file in the open mapper project of an entry. */
  transformEntry(entry: ProjectEntry, request: ContentMapperRequest): ContentMapperResult | TransformError {
    const process = this.connect(entry.mapper);
    if (process.connection === undefined || process.initialized === undefined)
      return new TransformError(
        TransformErrorKind.Initialize,
        process.error ?? new RequestError('content mapper host is closed'),
      );
    const params = marshalTransformParams(request.fileName, request.content, entry.projectHandle);
    const timers = this.timersOf(entry.mapper.identity());
    const outcome = this.request(process.connection, timers.transform, methodTransform, params);
    if (outcome.error !== undefined)
      return new TransformError(TransformErrorKind.Request, new RequestError(outcome.error));
    if (outcome.result === undefined)
      return new TransformError(
        TransformErrorKind.Response,
        new RequestError('content mapper returned a malformed transform response'),
      );
    const { positionEncoding, diagnosticSource } = process.initialized;
    return decodeTransformResult(outcome.result, request.content, positionEncoding, diagnosticSource);
  }

  /** Closes the open mapper projects of a lease, which open again when they are next needed. */
  refreshLease(lease: ProjectLease): ProjectFailure | undefined {
    let failure: ProjectFailure | undefined;
    for (const projectHandle of lease.entries.values()) {
      const entry = this.projects.get(projectHandle);
      if (entry !== undefined) failure ??= this.closeProject(entry);
    }
    return failure;
  }

  /** Gives back one reference to a lease. The last one closes its mapper projects and releases their processes. */
  releaseLease(lease: ProjectLease): ProjectFailure | undefined {
    lease.references -= 1;
    if (lease.references !== 0) return undefined;
    this.leases = this.leases.filter((other) => other !== lease);
    let failure: ProjectFailure | undefined;
    const identities: string[] = [];
    for (const projectHandle of lease.entries.values()) {
      const entry = this.projects.get(projectHandle);
      if (entry === undefined) continue;
      failure ??= this.closeProject(entry);
      this.projects.delete(projectHandle);
      identities.push(entry.mapper.identity());
    }
    this.release(identities);
    return failure;
  }

  // ---- Processes

  /** Tells the mapper of an entry that its project is closed, if it was opened and the mapper runs. */
  private closeProject(entry: ProjectEntry): RequestError | undefined {
    if (entry.opened === undefined) return undefined;
    entry.opened = undefined;
    const identity = entry.mapper.identity();
    const connection = this.processes?.get(identity)?.connection;
    if (connection === undefined) return undefined;
    const params = marshalCloseProjectParams(entry.projectHandle);
    const outcome = this.request(connection, this.timersOf(identity).closeProject, methodCloseProject, params);
    return outcome.error === undefined ? undefined : new RequestError(outcome.error);
  }

  /** Gives back a reference to the process of each identity. A process without references is ended. */
  private release(identities: readonly string[]): void {
    if (this.processes === undefined) return;
    for (const identity of identities) {
      const process = this.processes.get(identity);
      if (process === undefined) continue;
      process.references -= 1;
      if (process.references !== 0) continue;
      this.processes.delete(identity);
      process.connection?.close();
    }
  }

  private processOf(processes: Map<string, MapperProcess>, identity: string): MapperProcess {
    let process = processes.get(identity);
    if (process === undefined) {
      process = new MapperProcess();
      processes.set(identity, process);
    }
    return process;
  }

  private timersOf(identity: string): MapperTimers {
    let timers = this.timers.get(identity);
    if (timers === undefined) {
      timers = new MapperTimers();
      this.timers.set(identity, timers);
    }
    return timers;
  }

  /** Makes a request that has no time limit, and counts it. */
  private request(connection: MapperConnection, timer: OperationTimer, method: string, params: string): CallOutcome {
    return this.timedCall(connection, timer, method, params, -1);
  }

  private timedCall(
    connection: MapperConnection,
    timer: OperationTimer,
    method: string,
    params: string,
    timeoutMilliseconds: number,
  ): CallOutcome {
    const start = performance.now();
    const outcome = connection.call(method, params, timeoutMilliseconds);
    timer.record(start);
    this.requestWait += performance.now() - start;
    return outcome;
  }

  /**
   * The process of a mapper's identity, started and initialized on first use. A mapper that failed to start
   * keeps its error and is not started again.
   */
  private connect(mapper: ContentMapper): MapperProcess {
    if (this.processes === undefined) return new MapperProcess();
    const process = this.processOf(this.processes, mapper.identity());
    if (process.connection !== undefined || process.error !== undefined) return process;
    const exec = mapper.manifest.exec ?? [];
    if (exec.length === 0) {
      process.error = new RequestError(`content mapper ${quote(mapper.definition.package)} declares no command to run`);
      return process;
    }
    const timers = this.timersOf(mapper.identity());
    const mapperName = mapper.diagnosticName();
    const fail = (kind: InitializeErrorKind): InitializeError => {
      const error = new InitializeError(kind);
      error.mapperName = mapperName;
      process.error = error;
      return error;
    };
    const spawnStart = performance.now();
    const channel = this.spawner.spawn(exec, mapper.packageDirectory, this.logger !== undefined);
    timers.spawn.record(spawnStart);
    if (typeof channel === 'string') {
      const error = fail(InitializeErrorKind.ProcessStart);
      error.command = exec[0]!;
      error.detail = channel;
      return process;
    }
    const connection = new MapperConnection(channel, mapperName, this.logger);
    const outcome = this.timedCall(
      connection,
      timers.initialize,
      methodInitialize,
      marshalInitializeParams(this.diagnosticLocale),
      initializeTimeoutSeconds * 1000,
    );
    if (outcome.error === undefined) {
      const initialized = outcome.result === undefined ? missingResult() : decodeInitializeResult(outcome.result);
      if (initialized instanceof InitializeResult) {
        process.connection = connection;
        process.initialized = initialized;
        return process;
      }
      connection.close();
      initialized.mapperName = mapperName;
      process.error = initialized;
      return process;
    }
    // Whether the process ended is asked before it is ended here.
    const exitCode = connection.exitCode();
    connection.close();
    if (exitCode !== undefined) fail(InitializeErrorKind.ProcessExit).exitCode = exitCode;
    else if (outcome.timedOut) fail(InitializeErrorKind.NoResponse).timeoutSeconds = initializeTimeoutSeconds;
    else fail(InitializeErrorKind.Request).detail = outcome.error;
    return process;
  }
}
