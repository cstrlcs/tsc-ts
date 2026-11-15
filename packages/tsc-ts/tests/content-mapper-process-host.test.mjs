// The content mapper host that runs mappers as processes (src/compiler/content-mapper-process-host.ts) with the
// processes the system starts (src/drivers/node-system.ts): the cases of tsgo's host tests, run by
// tests/native/content-mapper-host-probe.ts against mapper processes (content-mapper-scripted.mjs and the
// launchers of content-mapper-server.mjs). What the host reports for a mapper that does not start or does not
// initialize is compared with what tsgo's command line prints for the same mapper, and a native build of the
// probe, with native/spawn-posix.c linked, prints what the Node build prints.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { writeMapperLaunchers } from './content-mapper-server.mjs';
import { compileOptions, compiledDir, tempDir } from './temp.mjs';

const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const tsgo = join(repo, 'packages/tsgo/dist/tsgo');
const scriptc = join(repo, 'node_modules/.bin/scriptc');
const scripted = join(root, 'tests/content-mapper-scripted.mjs');
const probe = 'tests/native/content-mapper-host-probe.ts';
// The system starts processes on Linux and macOS.
const skip = process.platform === 'win32' && 'the system starts no processes on Windows';

const node = compiledDir('tsc-ts-content-mapper-host-probe-');
let launchers = '';
let answers = [];
if (!skip) {
  execFileSync(join(repo, 'node_modules/.bin/tsc'), [...compileOptions, '--outDir', node, '--rootDir', root, probe], {
    cwd: root,
    stdio: 'inherit',
  });
  launchers = writeMapperLaunchers(tempDir('tsc-ts-content-mapper-launchers-'), join(node, 'src/compiler/span-map.js'));
  answers = run([process.execPath, '--stack-size=16000', join(node, probe.replace(/\.ts$/, '.js'))]);
}

/** The lines the probe built as `command` prints, with its work directory written `<work>`. */
function run(command) {
  const work = tempDir('tsc-ts-content-mapper-host-');
  const result = spawnSync(command[0], [...command.slice(1), process.execPath, scripted, work], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${launchers}${delimiter}${process.env.PATH}` },
    maxBuffer: 1 << 28,
    timeout: 300_000,
  });
  assert.equal(result.status, 0, result.stderr);
  // What a mapper writes to standard error is discarded or logged, and never reaches the compiler's.
  assert.equal(result.stderr, '');
  return result.stdout.split('\n').map((line) => line.replaceAll(work, '<work>'));
}

/** What the probe printed after `name: `. */
function printed(name, lines = answers) {
  return lines.filter((line) => line.startsWith(`${name}: `)).map((line) => line.slice(name.length + 2));
}

/** The methods of the requests in the lines a mapper logged, with `start` for each process. */
function methods(lines) {
  return lines.map((line) => (line === '["start"]' ? 'start' : JSON.parse(line).method));
}

const plain = (text) => `result extension=.ts mappings=[] diagnostics=[] supplemental=0 text=${JSON.stringify(text)}`;
const initializeError = (kind, fields = {}) =>
  `TransformError kind=1 InitializeError kind=${kind} mapper=mapper command=${fields.command ?? ''} detail=${JSON.stringify(fields.detail ?? '')} exitCode=${fields.exitCode ?? 0} timeoutSeconds=${fields.timeoutSeconds ?? 0}`;
const requestError = (kind, message) => `TransformError kind=${kind} RequestError ${JSON.stringify(message)}`;
const projectError = (kind) => `TransformError kind=2 ProjectError kind=${kind}`;

// The kinds of InitializeError and ProjectError; const enums leave no object to import.
const ProcessStart = 0;
const ProcessExit = 1;
const NoResponse = 2;
const InvalidResponse = 3;
const Request = 4;
const ReservedDiagnosticSource = 7;

/** The mappers that do not start, by the probe's name for them: the command and what the system says. */
const startFailures = [
  ['unknown command', 'no-such-mapper-command', 'exec: "no-such-mapper-command": executable file not found in $PATH'],
  ['missing file', './bin/missing', 'fork/exec ./bin/missing: no such file or directory'],
  ['not executable', scripted, `fork/exec ${scripted}: permission denied`],
];

test('a transform is sent to the process of the mapper and its response decoded', { skip }, () => {
  assert.deepEqual(printed('transform'), [
    'result extension=.ts mappings=[[0,19,0,19,0]] diagnostics=[mapper9999@0-3:boom] supplemental=0 text="export const x = 1;"',
  ]);
  // A request and a response larger than a pipe holds, with characters of two and four bytes.
  assert.deepEqual(printed('transform long'), [
    'result extension=.ts mappings=[[0,320000,0,320000,0]] diagnostics=[mapper9999@0-3:boom] supplemental=0 text="320000 characters" same=true',
  ]);
  // The host's own transform opens a project for the file, and the process ends with the project.
  const requests = ['start', 'initialize', 'openProject', 'transform', 'closeProject'];
  assert.deepEqual(methods(printed('transform log').map((line) => line.replace(/"content":.*$/, '"content":""}}'))), [
    ...requests,
    ...requests,
  ]);
  assert.equal(
    printed('transform log')[1],
    '{"jsonrpc":"2.0","id":"api1","method":"initialize","params":{"positionEncodings":["utf-8","utf-16"]}}',
  );
});

test("the messages and the mapper's standard error are logged, which is otherwise discarded", { skip }, () => {
  assert.deepEqual(printed('logging'), [plain('export const x = 1;')]);
  const lines = printed('logging line');
  const starts = (text) => lines.some((line) => line.startsWith(text));
  assert.ok(starts('[content mapper: resolved] send: {"jsonrpc":"2.0","id":"api1","method":"initialize"'));
  assert.ok(starts('[content mapper: resolved] receive: {"jsonrpc":"2.0","id":"api1","result":'));
  assert.ok(lines.includes('[content mapper: resolved] stderr: mapper diagnostic'));
  // A last line without an end is logged when the process is closed.
  assert.equal(lines.at(-1), '[content mapper: resolved] stderr: last line');
  // A megabyte on standard error neither stops the mapper nor reaches the compiler's output.
  assert.deepEqual(printed('stderr discarded'), [plain('export const x = 1;')]);
  // A mapper that waits for its standard error to be read, in the middle of a request, gets the rest.
  assert.deepEqual(printed('logging while writing'), [
    'result extension=.ts mappings=[] diagnostics=[] supplemental=0 text="1200000 characters" same=true',
    `logged=${300000 + '[content mapper: mapper] stderr: '.length}`,
  ]);
});

test('a mapper that cannot be started is reported with the command and the reason, once per project', { skip }, () => {
  assert.deepEqual(
    [...printed('failure no command'), ...printed('failure no command again')],
    [
      requestError(2, 'content mapper "configured" declares no command to run'),
      'spawns=0 closes=0 waited=less',
      'closed',
      requestError(2, 'content mapper "configured" declares no command to run'),
    ],
  );
  for (const [name, command, detail] of [
    ...startFailures,
    ['directory', '<work>', 'fork/exec <work>: permission denied'],
  ]) {
    const error = initializeError(ProcessStart, { command, detail });
    assert.deepEqual(printed(`failure ${name}`), [error, 'spawns=1 closes=0 waited=less', 'closed'], name);
    assert.deepEqual(printed(`failure ${name} again`), [error], name);
  }
});

test('a mapper that does not answer initialize, or not with the protocol, is ended and reported', { skip }, () => {
  const failures = (name) => [...printed(`failure ${name}`), ...printed(`failure ${name} again`)];
  // Node.js learns that a child ended on its event loop, which does not run while the compiler waits for the
  // mapper: there the host knows only that the output ended, as tsgo does when it asks before its process is
  // reaped. The native build waits for the process and reports its exit code (the last test).
  const ended = initializeError(Request, { detail: 'ipc: connection closed' });
  assert.deepEqual(failures('exit'), [ended, 'spawns=1 closes=1 waited=less', 'closed', ended]);
  // The host's own transform keeps no project, so it starts the mapper again.
  assert.deepEqual(printed('failure exit once more'), [`${ended} spawns=2`]);
  const silent = initializeError(NoResponse, { timeoutSeconds: 5 });
  assert.deepEqual(failures('silent'), [silent, 'spawns=1 closes=1 waited=five seconds', 'closed', silent]);
  const garbage = initializeError(Request, {
    detail: 'ipc: connection closed\njsonrpc: invalid header: "garbage\\n"',
  });
  assert.deepEqual(failures('garbage'), [garbage, 'spawns=1 closes=1 waited=less', 'closed', garbage]);
  const invalid = initializeError(InvalidResponse, {
    detail: 'json: cannot unmarshal JSON number into Go contentmapper.PositionEncoding within "/positionEncoding"',
  });
  assert.deepEqual(failures('invalid response'), [invalid, 'spawns=1 closes=1 waited=less', 'closed', invalid]);
  const reserved = initializeError(ReservedDiagnosticSource);
  assert.deepEqual(failures('reserved source'), [reserved, 'spawns=1 closes=1 waited=less', 'closed', reserved]);
});

test('a mapper whose output stops being the protocol is ended, and its requests fail', { skip }, () => {
  const error = requestError(2, 'ipc: connection closed\njsonrpc: invalid header: "oops\\n"');
  // The response to initialize arrived, so the mapper started; the next message ends it.
  assert.deepEqual(printed('broken output'), [error, 'spawns=1 closes=1', 'spawns=2 closes=2']);
  assert.deepEqual(printed('broken output again'), [error]);
  // A message that repeats a name in an object is not the protocol either, though JSON.parse reads it.
  assert.deepEqual(printed('repeated name'), [requestError(2, 'ipc: connection closed\njsonrpc: invalid message')]);
  assert.deepEqual(printed('malformed result'), [
    requestError(4, 'content mapper returned a malformed transform response'),
  ]);
  assert.deepEqual(printed('invalid extension'), ['TransformError kind=4 InvalidVirtualExtensionError']);
  // A response without a result is one that does not decode.
  assert.deepEqual(printed('no result of initialize'), [
    initializeError(InvalidResponse, { detail: 'jsontext: unexpected EOF' }),
  ]);
  assert.deepEqual(printed('no result of openProject'), [projectError(0)]);
  assert.deepEqual(printed('no result of transform'), [
    requestError(4, 'content mapper returned a malformed transform response'),
  ]);
});

test('a request of the mapper is rejected and a notification ignored', { skip }, () => {
  assert.deepEqual(printed('mapper request'), [plain('export const x = 1;')]);
  assert.deepEqual(printed('mapper request again'), [plain('export const x = 1;')]);
  const rejected =
    '{"jsonrpc":"2.0","id":7,"error":{"code":-32603,"message":"content mapper sent an unexpected request: readFile"}}';
  assert.deepEqual(printed('mapper request log'), [rejected, rejected]);
});

test('mappers with one identity share a process', { skip }, () => {
  assert.deepEqual(printed('consolidation'), [
    plain('y'),
    plain('y'),
    plain('y'),
    plain('y'),
    'spawns=2 closes=0',
    // A project is closed once.
    'closed closed',
    'spawns=2 closes=2',
    'starts=2',
  ]);
});

test('a process runs while a project or an acquirer refers to its identity', { skip }, () => {
  assert.deepEqual(printed('leases acquired'), ['spawns=0 closes=0']);
  assert.deepEqual(printed('leases'), [plain('y'), plain('y'), plain('y')]);
  assert.deepEqual(printed('leases transformed'), ['spawns=2 closes=0']);
  // The process of the two vue mappers stays with the second acquirer.
  assert.deepEqual(printed('leases vue released once'), ['spawns=2 closes=0']);
  assert.deepEqual(printed('leases svelte released'), ['spawns=2 closes=1']);
  assert.deepEqual(printed('leases vue released'), ['spawns=2 closes=2']);
  // Acquiring again starts a new process with the next transform.
  assert.deepEqual(printed('leases acquired again'), ['spawns=3 closes=2']);
  assert.deepEqual(printed('leases released again'), ['spawns=3 closes=3']);
});

test('projects open their mappers when needed and close them with their last reference', { skip }, () => {
  // The identity of a mapper without dynamicConfig needs no process.
  const [staticIdentities, staticClosed] = printed('projects static');
  assert.match(staticIdentities, /^\["static@1\.0\.0:[0-9a-f]{32}"\] spawns=0$/);
  assert.equal(staticClosed, 'closed');
  assert.deepEqual(printed('projects created'), ['spawns=0']);
  const a = JSON.parse(printed('projects a')[0]);
  const reversed = JSON.parse(printed('projects a reversed')[0]);
  const otherOptions = JSON.parse(printed('projects other options')[0]);
  const b = JSON.parse(printed('projects b')[0]);
  assert.equal(a.length, 2);
  assert.deepEqual(reversed, [a[1], a[0]]);
  assert.equal(otherOptions.length, 1);
  assert.notEqual(otherOptions[0], a[0]);
  // The same mapper, options and configuration identity under another config file.
  assert.deepEqual(b, [a[0]]);
  assert.deepEqual(printed('projects a, one mapper'), [`${JSON.stringify(a[1])} ""`]);
  assert.deepEqual(printed('projects identities'), ['spawns=1']);
  assert.deepEqual(printed('projects a watched'), ['["/repo/a/mapper.config.js"]']);
  assert.deepEqual(printed('projects b watched'), ['["/repo/b/mapper.config.js"]']);
  assert.deepEqual(printed('projects transform'), [plain('x')]);
  // A refreshed project is opened again for its identity.
  assert.deepEqual(printed('projects refresh'), [`closed ${JSON.stringify(b)}`]);
  assert.deepEqual(printed('projects close'), [
    'closed closes=0',
    'closed closes=0',
    'closed closes=0',
    'closed closes=0',
    'closed closes=1',
  ]);
  assert.deepEqual(printed('projects timings'), [
    'spawn=1 initialize=1 openProject=7 transform=1 closeProject=7 waited=true',
  ]);
  const log = printed('projects log').map((line) => (line === '["start"]' ? { method: 'start' } : JSON.parse(line)));
  const handles = (method) =>
    log.filter((message) => message.method === method).map((message) => message.params.projectHandle);
  const opened = handles('openProject');
  // Six mapper projects, the one that was refreshed opened twice, and each closed as often as opened.
  assert.equal(new Set(opened).size, 6);
  assert.deepEqual(handles('closeProject').sort(), opened.toSorted());
  // The transform names the project of the second mapper of the first spec.
  assert.deepEqual(handles('transform'), [opened[1]]);
  assert.equal(log.filter((message) => message.method === 'start').length, 1);
});

test('the projects of a closed host answer as closed', { skip }, () => {
  assert.deepEqual(printed('closed host before'), [plain('x'), '""']);
  assert.deepEqual(printed('closed host refresh'), ['closed']);
  assert.deepEqual(printed('closed host identities'), ['[]']);
  assert.deepEqual(printed('closed host identity'), ['"" ""']);
  assert.deepEqual(printed('closed host watched'), ['[]']);
  assert.deepEqual(printed('closed host diagnostics'), ['0']);
  const closed = requestError(0, 'content mapper project is closed');
  assert.deepEqual(printed('closed host transform'), [closed]);
  assert.deepEqual(printed('closed host close'), ['closed']);
  assert.deepEqual(printed('closed host new project'), [closed]);
  assert.deepEqual(printed('closed host transform of host'), [closed]);
});

test('an openProject response that breaks the protocol fails the transform', { skip }, () => {
  const response = (name) => printed(`project response ${name}`);
  // The kinds of ProjectError: malformed, missing identity, relative watched file, unexpected identity and files.
  assert.deepEqual(response('relative watched file'), [projectError(2), 'diagnostics=[]']);
  assert.deepEqual(response('no config identity'), [projectError(1), 'diagnostics=[]']);
  assert.deepEqual(response('unexpected config identity'), [projectError(3), 'diagnostics=[]']);
  assert.deepEqual(response('unexpected watched files'), [projectError(4), 'diagnostics=[]']);
  assert.deepEqual(response('invalid option path'), [projectError(0), 'diagnostics=[]']);
  assert.deepEqual(response('option diagnostic'), [plain('x'), 'diagnostics=[mapper123:Invalid option.@plugins/0]']);
});

test("a mapper gets the locale, its entry's options and the project's compiler options", { skip }, () => {
  assert.deepEqual(printed('options'), [plain('x')]);
  const [, initialize, openProject, transform] = printed('options log').map((line) => JSON.parse(line));
  assert.equal(initialize.params.locale, 'cs-CZ');
  assert.deepEqual(openProject.params.options, { strictTemplates: true });
  assert.equal(JSON.stringify(openProject.params.compilerOptions), printed('options marshalled')[0]);
  assert.deepEqual(Object.keys(transform.params), ['fileName', 'content', 'projectHandle']);
});

test('a new locale restarts the mappers', { skip }, () => {
  assert.deepEqual(printed('locale'), [plain('x'), 'spawns=1 closes=0', plain('x')]);
  assert.deepEqual(printed('locale unchanged'), ['spawns=1 closes=0']);
  assert.deepEqual(printed('locale fr'), ['spawns=1 closes=1', 'spawns=2 closes=1']);
  assert.deepEqual(
    printed('locale log').map((line) => JSON.parse(line).params.locale),
    [undefined, 'fr'],
  );
});

test("the mappers of tsgo's compiler cases run through their launchers", { skip }, () => {
  assert.deepEqual(printed('launched'), [
    'result extension=.ts mappings=[[27,29,0,29,0],[56,1,29,9,1],[57,24,38,24,0],[81,9,62,15,1],[90,1,77,1,0]] diagnostics=[box1000@62-77:Unclosed interpolation.] supplemental=0 text="91 characters"',
  ]);
  assert.deepEqual(printed('launched failing'), [
    requestError(3, 'ipc: remote error [-32603]: content mapper failed to transform the file'),
  ]);
});

test(
  "tsgo's command line reports the same for a mapper that does not start or initialize",
  { skip: skip || (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo'), timeout: 300_000 },
  () => {
    /** What tsgo prints under TS18099 for a project whose mapper runs `exec`. */
    const reason = (exec) => {
      const project = tempDir('tsc-ts-content-mapper-project-');
      mkdirSync(join(project, 'node_modules/mapper'), { recursive: true });
      writeFileSync(
        join(project, 'tsconfig.json'),
        JSON.stringify({ contentMappers: [{ package: 'mapper', extensions: ['.vue'] }] }),
      );
      writeFileSync(
        join(project, 'node_modules/mapper/package.json'),
        JSON.stringify({ name: 'mapper', typescript: { contentMapper: { exec } } }),
      );
      writeFileSync(join(project, 'a.vue'), '');
      const result = spawnSync(tsgo, ['-p', '.', '--runExternalCode', '--noEmit', '--pretty', 'false'], {
        cwd: project,
        encoding: 'utf8',
        timeout: 120_000,
      });
      const [first, ...rest] = result.stdout.trimEnd().split('\n');
      assert.equal(first, "error TS18099: The content mapper 'mapper' could not be initialized.", result.stdout);
      return rest.join('\n').trimStart();
    };
    const scriptedMapper = (script) => [process.execPath, scripted, JSON.stringify(script)];
    for (const [, command, detail] of startFailures)
      assert.equal(reason([command]), `The content mapper command '${command}' could not be started: ${detail}`);
    // tsgo asks whether the process ended while another thread reaps it, and prints one or the other.
    assert.ok(
      [
        "The content mapper process exited before responding to the 'initialize' request (exit code 42).",
        "The content mapper's 'initialize' request failed: ipc: connection closed",
      ].includes(reason(scriptedMapper({ exit: 42 }))),
    );
    assert.equal(
      reason(scriptedMapper({ silent: true })),
      "The content mapper did not respond to the 'initialize' request within 5 seconds.",
    );
    assert.equal(
      reason(scriptedMapper({ garbage: 'garbage\n', silent: true })),
      "The content mapper's 'initialize' request failed: ipc: connection closed\njsonrpc: invalid header: \"garbage\\n\"",
    );
    // Go's decoder says `cannot` or `unable to`, chosen once per process.
    assert.match(
      reason(scriptedMapper({ initialize: { positionEncoding: 1 } })),
      /^The content mapper returned an 'initialize' response that could not be decoded: json: (cannot|unable to) unmarshal JSON number into Go contentmapper\.PositionEncoding within "\/positionEncoding"$/,
    );
  },
);

test(
  'a native build of the host, with its own processes, answers as the Node build',
  { skip: skip || (!existsSync(scriptc) && 'needs the scriptc toolchain'), timeout: 900_000 },
  () => {
    const buildDir = tempDir('tsc-ts-content-mapper-host-native-');
    const native = join(buildDir, 'content-mapper-host-probe');
    // The processes of the native build, linked as scripts/build-native.mjs links them.
    const object = join(buildDir, 'spawn-posix.o');
    execFileSync(
      'clang',
      ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-c', 'native/spawn-posix.c', '-o', object],
      {
        cwd: root,
        stdio: 'inherit',
      },
    );
    const manifest = join(buildDir, 'spawn-posix.ffi.json');
    writeFileSync(
      manifest,
      JSON.stringify({
        ...JSON.parse(readFileSync(join(root, 'native/spawn-posix.ffi.json'), 'utf8')),
        libraries: [object],
      }),
    );
    // As api-native.test.mjs builds its probe: without emit workers, with the output in a file.
    const log = join(buildDir, 'build.log');
    const fd = openSync(log, 'w');
    const build = spawnSync(scriptc, ['build', probe, '--optimization=dev', '--ffi', manifest, '-o', native], {
      cwd: root,
      env: { ...process.env, SCRIPTC_EMIT_WORKERS: '0' },
      stdio: ['ignore', fd, fd],
      timeout: 600_000,
    });
    closeSync(fd);
    assert.ok(
      build.status === 0 && existsSync(native),
      `${build.error === undefined ? '' : build.error.message + '\n'}${readFileSync(log, 'utf8')}`,
    );

    // The native build waits for a process that closed its output and reports its exit code.
    const exited = initializeError(ProcessExit, { exitCode: 42 });
    const expected = answers.map((line) =>
      line.startsWith('failure exit')
        ? line.replace(initializeError(Request, { detail: 'ipc: connection closed' }), exited)
        : line,
    );
    assert.ok(expected.filter((line) => line.includes(exited)).length === 3);
    const actual = run([native]);
    const first = expected.findIndex((line, i) => line !== actual[i]);
    assert.equal(
      first === -1 && actual.length === expected.length,
      true,
      `first difference at line ${first + 1}:
  node:   ${expected[first]}
  native: ${actual[first]}`,
    );
  },
);
