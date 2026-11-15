// Runs the content mapper process host (src/compiler/content-mapper-process-host.ts) with the processes the
// system starts (src/drivers/node-system.ts) through the cases of tsgo's host tests, and prints what happens, one
// line each. The same lines are expected from a Node build and a native build of this file, except where the
// two learn differently that a process ended. Usage, with the launchers of content-mapper-server.mjs on PATH:
//   content-mapper-host-probe <node> <content-mapper-scripted.mjs> <work directory>
import { readFileSync } from 'node:fs';
import {
  ContentMapper,
  ContentMapperDefinition,
  ContentMapperManifest,
  ContentMapperProjectSpec,
  ContentMapperRequest,
  DiagnosticDirectiveError,
  InitializeError,
  InvalidVirtualExtensionError,
  marshalCompilerOptions,
  ProjectError,
  TransformError,
  type ContentMapperProject,
  type ContentMapperResult,
  type ProjectFailure,
} from '../../src/compiler/content-mapper.js';
import {
  ContentMapperProcessHost,
  type ProcessChannel,
  type ProcessSpawner,
} from '../../src/compiler/content-mapper-process-host.js';
import { JsxEmit, ScriptTarget, type CompilerOptions } from '../../src/compiler/options.js';
import { createNodeSystem } from '../../src/drivers/node-system.js';

const node = process.argv[2]!;
const scripted = process.argv[3]!;
const work = process.argv[4]!;

const sys = createNodeSystem(work, '');

const print = (line: string): void => {
  console.log(line);
};

/** A channel that counts when it is closed, as tsgo's tests count the processes their host ends. */
class CountingChannel implements ProcessChannel {
  private closed = false;

  constructor(
    private readonly channel: ProcessChannel,
    private readonly spawner: CountingSpawner,
  ) {}

  write(bytes: Uint8Array): boolean {
    return this.channel.write(bytes);
  }

  read(buffer: Uint8Array, timeoutMilliseconds: number): number {
    return this.channel.read(buffer, timeoutMilliseconds);
  }

  readStandardError(): string {
    return this.channel.readStandardError();
  }

  exitCode(): number | undefined {
    return this.channel.exitCode();
  }

  close(): void {
    if (!this.closed) this.spawner.closes += 1;
    this.closed = true;
    this.channel.close();
  }
}

/** The system's processes, counted. */
class CountingSpawner implements ProcessSpawner {
  spawns = 0;
  closes = 0;

  spawn(command: readonly string[], directory: string, captureStandardError: boolean): ProcessChannel | string {
    this.spawns += 1;
    const channel = sys.spawn(command, directory, captureStandardError);
    return typeof channel === 'string' ? channel : new CountingChannel(channel, this);
  }
}

/** The script of a scripted mapper that logs to the file of `scenario`, with further members as JSON text. */
function script(scenario: string, members: string[]): string {
  return `{${[`"log":${JSON.stringify(logFile(scenario))}`, ...members].join(',')}}`;
}

function logFile(scenario: string): string {
  return `${work}/${scenario}.log`;
}

/** The lines a scenario's mappers logged. */
function logged(scenario: string): string[] {
  let text = '';
  try {
    text = readFileSync(logFile(scenario), 'utf8');
  } catch {
    // No mapper started.
  }
  return text.split('\n').filter((line) => line !== '');
}

/** A mapper whose process is a scripted mapper, or `exec` when that is given. */
function createMapper(
  packageName: string,
  name: string,
  version: string,
  scriptText: string,
  options?: string,
  compilerOptions?: string[],
  dynamicConfig = false,
  exec?: string[],
): ContentMapper {
  const definition = new ContentMapperDefinition();
  definition.package = packageName;
  definition.extensions = ['.vue'];
  definition.options = options;
  const mapper = new ContentMapper(definition);
  mapper.manifest = new ContentMapperManifest(
    name,
    version,
    exec ?? [node, scripted, scriptText],
    compilerOptions,
    dynamicConfig,
    undefined,
  );
  mapper.packageDirectory = work;
  return mapper;
}

function describeFailure(failure: ProjectFailure): string {
  if (failure instanceof InitializeError)
    return `InitializeError kind=${failure.kind} mapper=${failure.mapperName} command=${failure.command} detail=${JSON.stringify(failure.detail)} exitCode=${failure.exitCode} timeoutSeconds=${failure.timeoutSeconds}`;
  if (failure instanceof ProjectError) return `ProjectError kind=${failure.kind}`;
  return `RequestError ${JSON.stringify(failure.message)}`;
}

function describe(result: ContentMapperResult | TransformError): string {
  if (!(result instanceof TransformError)) {
    const diagnostics = result.diagnostics.map(
      (diagnostic) =>
        `${diagnostic.source}${diagnostic.code}@${diagnostic.pos}-${diagnostic.end}:${diagnostic.messageText}`,
    );
    return `result extension=${result.virtualExtension} mappings=${result.mappings?.marshal() ?? 'none'} diagnostics=[${diagnostics.join(',')}] supplemental=${result.supplemental.length} text=${JSON.stringify(result.text.length > 40 ? `${result.text.length} characters` : result.text)}`;
  }
  const cause = result.cause;
  if (cause === undefined) return `TransformError kind=${result.kind}`;
  if (cause instanceof InvalidVirtualExtensionError)
    return `TransformError kind=${result.kind} InvalidVirtualExtensionError`;
  if (cause instanceof DiagnosticDirectiveError) return `TransformError kind=${result.kind} DiagnosticDirectiveError`;
  return `TransformError kind=${result.kind} ${describeFailure(cause)}`;
}

function describeList(list: string[] | ProjectFailure): string {
  return Array.isArray(list) ? JSON.stringify(list) : describeFailure(list);
}

function describeText(text: string | ProjectFailure): string {
  return typeof text === 'string' ? JSON.stringify(text) : describeFailure(text);
}

function describeClose(failure: ProjectFailure | undefined): string {
  return failure === undefined ? 'closed' : describeFailure(failure);
}

const request = new ContentMapperRequest('/a.vue', 'export const x = 1;');
const noOptions: CompilerOptions = {};

function projectOf(
  host: ContentMapperProcessHost,
  configFileName: string,
  mappers: ContentMapper[],
  options: CompilerOptions,
): ContentMapperProject {
  return host.project(new ContentMapperProjectSpec(configFileName, mappers, options));
}

// ---- A transform, with positions and diagnostics decoded

function transform(): void {
  const host = new ContentMapperProcessHost(sys, '');
  const mapper = createMapper('', 'vue', '1.0.0', script('transform', ['"verbatim":true']));
  print(`transform: ${describe(host.transform(mapper, request))}`);
  // A text longer than a pipe holds, with characters of two and of four bytes.
  const long = 'const é = "😀";\n'.repeat(20000);
  const result = host.transform(mapper, new ContentMapperRequest('/long.vue', long));
  print(`transform long: ${describe(result)} same=${!(result instanceof TransformError) && result.text === long}`);
  host.close();
  for (const line of logged('transform')) print(`transform log: ${line.length > 200 ? line.slice(0, 200) : line}`);
}

// ---- Logging, and standard error with and without it

function logging(): void {
  const lines: string[] = [];
  const host = new ContentMapperProcessHost(sys, '', (message) => lines.push(message));
  const mapper = createMapper(
    'configured',
    'resolved',
    '1.0.0',
    script('logging', ['"stderr":"mapper diagnostic\\nlast line"']),
  );
  print(`logging: ${describe(host.transform(mapper, request))}`);
  host.close();
  for (const line of lines) print(`logging line: ${line}`);
}

function loggingWhileWriting(): void {
  let logged = 0;
  const host = new ContentMapperProcessHost(sys, '', (message) => {
    if (message.includes('] stderr: ')) logged += message.length;
  });
  // The mapper stops reading a long request until its standard error is read.
  const mapper = createMapper('', 'mapper', '', script('writing', ['"stderrDuringRequest":300000']));
  const long = 'export const x = 1;\n'.repeat(60000);
  const result = host.transform(mapper, new ContentMapperRequest('/long.vue', long));
  print(
    `logging while writing: ${describe(result)} same=${!(result instanceof TransformError) && result.text === long}`,
  );
  host.close();
  print(`logging while writing: logged=${logged}`);
}

function discardedStandardError(): void {
  const host = new ContentMapperProcessHost(sys, '');
  const mapper = createMapper('configured', 'resolved', '1.0.0', script('stderr', ['"stderrBytes":1048576']));
  print(`stderr discarded: ${describe(host.transform(mapper, request))}`);
  host.close();
}

// ---- Mappers that do not start or do not initialize

function failures(): void {
  const cases: [string, ContentMapper][] = [
    ['no command', createMapper('configured', '', '', '', undefined, undefined, false, [])],
    ['unknown command', createMapper('', 'mapper', '', '', undefined, undefined, false, ['no-such-mapper-command'])],
    ['missing file', createMapper('', 'mapper', '', '', undefined, undefined, false, ['./bin/missing'])],
    ['not executable', createMapper('', 'mapper', '', '', undefined, undefined, false, [scripted])],
    ['directory', createMapper('', 'mapper', '', '', undefined, undefined, false, [work])],
    ['exit', createMapper('', 'mapper', '', script('exit', ['"exit":42']))],
    ['silent', createMapper('', 'mapper', '', script('silent', ['"silent":true']))],
    ['garbage', createMapper('', 'mapper', '', script('garbage', ['"garbage":"garbage\\n"', '"silent":true']))],
    ['invalid response', createMapper('', 'mapper', '', script('invalid', ['"initialize":{"positionEncoding":1}']))],
    [
      'reserved source',
      createMapper(
        '',
        'mapper',
        '',
        script('reserved', ['"initialize":{"positionEncoding":"utf-16","diagnosticSource":"TS"}']),
      ),
    ],
  ];
  for (const [name, mapper] of cases) {
    const spawner = new CountingSpawner();
    const host = new ContentMapperProcessHost(spawner, '');
    const project = projectOf(host, '', [mapper], noOptions);
    const start = Date.now();
    print(`failure ${name}: ${describe(project.transform(mapper, request))}`);
    // A mapper that failed to start is not started again while a project keeps it.
    print(`failure ${name} again: ${describe(project.transform(mapper, request))}`);
    const waited = Date.now() - start;
    print(
      `failure ${name}: spawns=${spawner.spawns} closes=${spawner.closes} waited=${waited >= 5000 ? 'five seconds' : 'less'}`,
    );
    print(`failure ${name}: ${describeClose(project.close())}`);
    // The host's own transform keeps nothing, so the mapper is started again.
    if (name === 'exit')
      print(`failure ${name} once more: ${describe(host.transform(mapper, request))} spawns=${spawner.spawns}`);
    host.close();
  }
}

// ---- A mapper whose output stops being the protocol, and one that makes requests

function brokenOutput(): void {
  const spawner = new CountingSpawner();
  const host = new ContentMapperProcessHost(spawner, '');
  const mapper = createMapper('', 'mapper', '', script('broken', ['"afterInitialize":"oops\\n"']));
  print(`broken output: ${describe(host.transform(mapper, request))}`);
  print(`broken output: spawns=${spawner.spawns} closes=${spawner.closes}`);
  print(`broken output again: ${describe(host.transform(mapper, request))}`);
  print(`broken output: spawns=${spawner.spawns} closes=${spawner.closes}`);
  // A message that repeats a name is not one tsgo's decoder accepts.
  const body = '{"jsonrpc":"2.0","id":"api0","id":"api2","result":{}}';
  const message = `Content-Length: ${body.length}\r\n\r\n${body}`;
  const repeating = createMapper(
    '',
    'repeating',
    '',
    script('repeated', [`"afterInitialize":${JSON.stringify(message)}`]),
  );
  print(`repeated name: ${describe(host.transform(repeating, request))}`);
  host.close();
}

function requestsOfMapper(): void {
  const host = new ContentMapperProcessHost(sys, '');
  const mapper = createMapper('', 'mapper', '', script('ask', ['"ask":true']));
  print(`mapper request: ${describe(host.transform(mapper, request))}`);
  print(`mapper request again: ${describe(host.transform(mapper, request))}`);
  host.close();
  for (const line of logged('ask')) if (line.includes('"error"')) print(`mapper request log: ${line}`);
}

function malformedResult(): void {
  const host = new ContentMapperProcessHost(sys, '');
  // A response without a result does not decode.
  for (const method of ['initialize', 'openProject', 'transform']) {
    const silent = createMapper('', 'mapper', method, script('omitted', [`"omitResult":"${method}"`]));
    print(`no result of ${method}: ${describe(host.transform(silent, request))}`);
  }
  const mapper = createMapper('', 'mapper', '', script('malformed', ['"transform":{"text":1}']));
  print(`malformed result: ${describe(host.transform(mapper, request))}`);
  const failing = createMapper('', 'failing', '', script('failing', ['"transform":{"extension":".coffee"}']));
  print(`invalid extension: ${describe(host.transform(failing, request))}`);
  host.close();
}

// ---- One process for the mappers of one identity, kept while something refers to it

function consolidation(): void {
  const spawner = new CountingSpawner();
  const host = new ContentMapperProcessHost(spawner, '');
  const vueA = createMapper('a', 'vue', '1.0.0', script('consolidation', []));
  const vueB = createMapper('b', 'vue', '1.0.0', script('consolidation', []));
  const svelte = createMapper('', 'svelte', '2.0.0', script('consolidation', []));
  const project = projectOf(host, '', [vueA, vueB, svelte], noOptions);
  for (const mapper of [vueA, vueB, vueA, svelte])
    print(`consolidation: ${describe(project.transform(mapper, new ContentMapperRequest('/x', 'y')))}`);
  print(`consolidation: spawns=${spawner.spawns} closes=${spawner.closes}`);
  print(`consolidation: ${describeClose(project.close())} ${describeClose(project.close())}`);
  print(`consolidation: spawns=${spawner.spawns} closes=${spawner.closes}`);
  host.close();
  print(`consolidation: starts=${logged('consolidation').filter((line) => line === '["start"]').length}`);
}

function leases(): void {
  const spawner = new CountingSpawner();
  const host = new ContentMapperProcessHost(spawner, '');
  const vueA = createMapper('a', 'vue', '1.0.0', script('leases', []));
  const vueB = createMapper('b', 'vue', '1.0.0', script('leases', []));
  const svelte = createMapper('', 'svelte', '2.0.0', script('leases', []));
  const releaseVueA = host.acquire([vueA, vueA]);
  const releaseVueB = host.acquire([vueB]);
  const releaseSvelte = host.acquire([svelte]);
  const counts = (): string => `spawns=${spawner.spawns} closes=${spawner.closes}`;
  print(`leases acquired: ${counts()}`);
  for (const mapper of [vueA, svelte])
    print(`leases: ${describe(host.transform(mapper, new ContentMapperRequest('/x', 'y')))}`);
  print(`leases transformed: ${counts()}`);
  releaseVueA();
  print(`leases vue released once: ${counts()}`);
  releaseSvelte();
  print(`leases svelte released: ${counts()}`);
  releaseVueB();
  releaseVueB();
  print(`leases vue released: ${counts()}`);
  const releaseNew = host.acquire([vueA]);
  print(`leases: ${describe(host.transform(vueA, new ContentMapperRequest('/x', 'y')))}`);
  print(`leases acquired again: ${counts()}`);
  releaseNew();
  print(`leases released again: ${counts()}`);
  host.close();
}

// ---- Projects

function projects(): void {
  const spawner = new CountingSpawner();
  const host = new ContentMapperProcessHost(spawner, '');
  const staticMapper = createMapper('', 'static', '1.0.0', script('projects', []), '{"mode":"static"}');
  const staticProject = projectOf(host, '/repo/tsconfig.json', [staticMapper], noOptions);
  print(`projects static: ${describeList(staticProject.identities())} spawns=${spawner.spawns}`);
  print(`projects static: ${describeClose(staticProject.close())}`);

  const dynamic = script('projects', ['"dynamic":true']);
  const dynamicA = createMapper('', 'dynamic', '1.0.0', dynamic, '{"mode":"a"}', ['jsx'], true);
  const dynamicB = createMapper('', 'dynamic', '1.0.0', dynamic, '{"mode":"b"}', undefined, true);
  const optionsA: CompilerOptions = {};
  const projectA = projectOf(host, '/repo/a/tsconfig.json', [dynamicA, dynamicB], optionsA);
  const projectAReversed = projectOf(host, '/repo/reversed/tsconfig.json', [dynamicB, dynamicA], optionsA);
  const projectDifferentOptions = projectOf(host, '/repo/options/tsconfig.json', [dynamicA], { jsx: JsxEmit.React });
  const projectB = projectOf(host, '/repo/b/tsconfig.json', [dynamicA], {});
  const projectAAgain = projectOf(host, '/repo/a/tsconfig.json', [dynamicA, dynamicB], optionsA);
  print(`projects created: spawns=${spawner.spawns}`);
  print(`projects a: ${describeList(projectA.identities())}`);
  print(`projects a reversed: ${describeList(projectAReversed.identities())}`);
  print(`projects other options: ${describeList(projectDifferentOptions.identities())}`);
  print(`projects b: ${describeList(projectB.identities())}`);
  print(
    `projects a, one mapper: ${describeText(projectA.identity(dynamicB))} ${describeText(projectA.identity(staticMapper))}`,
  );
  print(`projects identities: spawns=${spawner.spawns}`);
  print(`projects a watched: ${describeList(projectA.watchedFiles())}`);
  print(`projects b watched: ${describeList(projectB.watchedFiles())}`);
  print(`projects a diagnostics: ${projectA.diagnostics().length}`);
  print(
    `projects transform: ${describe(projectA.transform(dynamicB, new ContentMapperRequest('/repo/a/file.ext', 'x')))}`,
  );
  print(`projects refresh: ${describeClose(projectB.refresh())} ${describeList(projectB.identities())}`);
  for (const project of [projectAAgain, projectA, projectAReversed, projectDifferentOptions, projectB])
    print(`projects close: ${describeClose(project.close())} closes=${spawner.closes}`);
  const timings = host.timings().mappers.get(dynamicA.identity());
  print(
    `projects timings: spawn=${timings?.spawn.count} initialize=${timings?.initialize.count} openProject=${timings?.openProject.count} transform=${timings?.transform.count} closeProject=${timings?.closeProject.count} waited=${host.timings().requestWait > 0}`,
  );
  host.close();
  for (const line of logged('projects')) print(`projects log: ${line}`);
}

function closedHost(): void {
  const host = new ContentMapperProcessHost(sys, '');
  const mapper = createMapper('', 'dynamic', '1.0.0', script('closed', ['"dynamic":true']), undefined, undefined, true);
  const other = createMapper('', '', '', '');
  const project = projectOf(host, '/repo/tsconfig.json', [mapper], noOptions);
  print(`closed host before: ${describe(project.transform(mapper, new ContentMapperRequest('/repo/file.ext', 'x')))}`);
  print(`closed host before: ${describeText(project.identity(other))}`);
  host.close();
  print(`closed host refresh: ${describeClose(project.refresh())}`);
  print(`closed host identities: ${describeList(project.identities())}`);
  print(`closed host identity: ${describeText(project.identity(mapper))} ${describeText(project.identity(other))}`);
  print(`closed host watched: ${describeList(project.watchedFiles())}`);
  print(`closed host diagnostics: ${project.diagnostics().length}`);
  print(
    `closed host transform: ${describe(project.transform(mapper, new ContentMapperRequest('/repo/file.ext', 'x')))}`,
  );
  print(`closed host close: ${describeClose(project.close())}`);
  print(`closed host new project: ${describe(projectOf(host, '', [mapper], noOptions).transform(mapper, request))}`);
  print(`closed host transform of host: ${describe(host.transform(mapper, request))}`);
}

function projectResponses(): void {
  const cases: [string, string, boolean][] = [
    [
      'relative watched file',
      '"dynamic":true,"openProject":{"configIdentity":"c","watchedFiles":["mapper.config.js"]}',
      true,
    ],
    ['no config identity', '"openProject":{"configIdentity":""}', true],
    ['unexpected config identity', '"openProject":{"configIdentity":"dynamic"}', false],
    ['unexpected watched files', '"openProject":{"watchedFiles":["/repo/mapper.config.js"]}', false],
    [
      'invalid option path',
      '"openProject":{"optionDiagnostics":[{"path":[null],"messageText":"Invalid option.","code":123}]}',
      false,
    ],
    [
      'option diagnostic',
      '"openProject":{"optionDiagnostics":[{"path":["plugins",0],"messageText":"Invalid option.","code":123}]}',
      false,
    ],
  ];
  for (const [name, members, dynamicConfig] of cases) {
    const host = new ContentMapperProcessHost(sys, '');
    const mapper = createMapper(
      'dynamic',
      'dynamic',
      '1.0.0',
      script('responses', [members]),
      undefined,
      undefined,
      dynamicConfig,
    );
    const project = projectOf(host, '/repo/tsconfig.json', [mapper], noOptions);
    print(
      `project response ${name}: ${describe(project.transform(mapper, new ContentMapperRequest('/repo/file.ext', 'x')))}`,
    );
    const diagnostics = project
      .diagnostics()
      .map(
        (diagnostic) =>
          `${diagnostic.source}${diagnostic.code}:${diagnostic.messageText}@${diagnostic.path.map((segment) => (segment.isIndex ? `${segment.index}` : segment.property)).join('/')}`,
      );
    print(`project response ${name}: diagnostics=[${diagnostics.join(',')}]`);
    project.close();
    host.close();
  }
}

function forwardedOptions(): void {
  const host = new ContentMapperProcessHost(sys, 'cs-CZ');
  const mapper = createMapper('', 'vue', '1.0.0', script('options', []), '{"strictTemplates":true}', ['target', 'jsx']);
  const options: CompilerOptions = { target: ScriptTarget.ES2020, strict: true };
  const project = projectOf(host, '', [mapper], options);
  print(`options: ${describe(project.transform(mapper, new ContentMapperRequest('/a.vue', 'x')))}`);
  project.close();
  host.close();
  print(`options marshalled: ${marshalCompilerOptions(options)}`);
  for (const line of logged('options')) print(`options log: ${line}`);
}

function locale(): void {
  const spawner = new CountingSpawner();
  const host = new ContentMapperProcessHost(spawner, '');
  const mapper = createMapper('', 'vue', '1.0.0', script('locale', []));
  const release = host.acquire([mapper]);
  print(`locale: ${describe(host.transform(mapper, new ContentMapperRequest('/a.vue', 'x')))}`);
  print(`locale: spawns=${spawner.spawns} closes=${spawner.closes}`);
  host.setLocale('');
  print(`locale unchanged: spawns=${spawner.spawns} closes=${spawner.closes}`);
  host.setLocale('fr');
  print(`locale fr: spawns=${spawner.spawns} closes=${spawner.closes}`);
  print(`locale: ${describe(host.transform(mapper, new ContentMapperRequest('/a.vue', 'x')))}`);
  print(`locale fr: spawns=${spawner.spawns} closes=${spawner.closes}`);
  release();
  host.close();
  for (const line of logged('locale')) if (line.includes('"initialize"')) print(`locale log: ${line}`);
}

// ---- The mappers of tsgo's compiler cases, through their launchers on PATH

function launched(): void {
  const host = new ContentMapperProcessHost(sys, '');
  const box = createMapper('mapper', 'mapper', '1.0.0', '', undefined, ['target', 'jsx'], false, [
    'compiler-test-mapper',
  ]);
  const options: CompilerOptions = { target: ScriptTarget.ES2020 };
  const project = projectOf(host, '/tsconfig.json', [box], options);
  const content = 'export const label: string = #{target};\nexport const broken = #{unterminated;\n';
  print(`launched: ${describe(project.transform(box, new ContentMapperRequest('/widget.box', content)))}`);
  project.close();
  const failing = createMapper('failing', 'failing', '1.0.0', '', undefined, undefined, false, ['failing-mapper']);
  print(`launched failing: ${describe(host.transform(failing, request))}`);
  host.close();
}

transform();
logging();
loggingWhileWriting();
discardedStandardError();
failures();
brokenOutput();
requestsOfMapper();
malformedResult();
consolidation();
leases();
projects();
closedHost();
projectResponses();
forwardedOptions();
locale();
launched();
