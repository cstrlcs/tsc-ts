// The content mappers of tsgo's compiler tests and the verbatim mappers of its build and watch tests, ported in
// content-mappers.mjs. Every file that the upstream cases named contentMapper*.ts give to a mapper, and inputs
// that reach the rest of each mapper, go to the port and to tsgo's mapper (packages/tsgo/dist/contentmapper-oracle, built by `npm run build:oracle`). The raw
// responses are compared, and then what tsc-ts and tsgo make of them. The same inputs go to the port running as
// a process (content-mapper-server.mjs), which tsgo's command line then runs through a launcher.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as spawnProcess, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCases, runOracle } from './content-mapper-cases.mjs';
import { createFrameReader, frame, mapperNames, writeMapperLaunchers } from './content-mapper-server.mjs';
import {
  createTestMapperSpawner,
  dynamicVerbatimMapper,
  failingMapper,
  lispMapper,
  supplementalDiagnosticsMapper,
  supplementalGlobalsMapper,
  supplementalMapper,
  supplementalModuleMapper,
  transformingMapper,
  verbatimMapper,
} from './content-mappers.mjs';
import { parseTestCase } from './module-resolution-cases.mjs';
import { compileSources, tempDir } from './temp.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const oracle = join(repo, 'packages/tsgo/dist/contentmapper-oracle');
const tsgo = join(repo, 'packages/tsgo/dist/tsgo');
const upstream = join(repo, 'upstream/TypeScript/tsc/testdata/tests/cases/compiler');
const skip = (!existsSync(oracle) || !existsSync(upstream)) && 'needs upstream sources and the contentmapper oracle';

const out = compileSources('tsc-ts-content-mappers-', [
  'compiler/content-mapper-protocol.ts',
  'compiler/parser.ts',
  'compiler/option-declarations.ts',
]);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const mapperModule = await load('compiler/content-mapper.js');
const protocol = await load('compiler/content-mapper-protocol.js');
const { parseJson } = await load('compiler/package-json.js');
const spanMap = await load('compiler/span-map.js');
const { getScriptKindFromFileName } = await load('compiler/parser.js');
const { optionDeclarations } = await load('compiler/option-declarations.js');
const { toHex } = await load('compiler/xxh3.js');
const { mapper, compilerOptions, answer, assertSameAnswers } = createCases({
  ...mapperModule,
  ...protocol,
  parseJson,
  MappingError: spanMap.MappingError,
  getScriptKindFromFileName,
  toHex,
});
const spawn = createTestMapperSpawner(spanMap);

/** The compiler options of a config file as the JSON tsgo keeps them in: enums as numbers. */
function compilerOptionsOf(config) {
  const declarations = new Map(optionDeclarations.map((declaration) => [declaration.name, declaration]));
  const options = {};
  for (const [name, value] of Object.entries(config.compilerOptions ?? {})) {
    const declaration = declarations.get(name);
    options[name] = declaration?.kind === 'enum' ? declaration.values.get(String(value).toLowerCase()) : value;
  }
  return options;
}

/** A case for each file an upstream compiler test gives to a mapper. */
function upstreamCases() {
  const cases = [];
  for (const name of readdirSync(upstream).sort()) {
    if (!/^contentMapper.*\.ts$/.test(name)) continue;
    const files = new Map();
    for (const file of parseTestCase(readFileSync(join(upstream, name), 'utf8'), name).files)
      files.set(file.name, file.content);
    const config = JSON.parse(files.get('/tsconfig.json'));
    for (const entry of config.contentMappers) {
      // The package is in node_modules, or linked there from another directory of the case.
      const packageJson = Array.from(files.keys()).find((file) => file.endsWith(`/${entry.package}/package.json`));
      const manifest = JSON.parse(files.get(packageJson));
      const fields = {
        ...entry,
        name: manifest.name,
        version: manifest.version,
        ...manifest.typescript.contentMapper,
        defaultOutputExtensions: manifest.typescript.contentMapper.outputExtensions,
      };
      fields.outputExtensions = entry.outputExtensions ?? fields.defaultOutputExtensions;
      const mappers = [
        mapper({ ...fields, extensions: entry.extensions.filter((extension) => extension.startsWith('.')) }),
      ];
      for (const [fileName, content] of files)
        if (mapperModule.getContentMapperForFileName(mappers, fileName, true) !== undefined)
          cases.push({
            name,
            mapper: fields,
            compilerOptions: compilerOptionsOf(config),
            configFileName: '/tsconfig.json',
            fileName,
            content,
            testMapper: fields.exec[0],
          });
    }
  }
  return cases;
}

/** Cases that reach the parts of each mapper the upstream cases leave out. */
function otherCases() {
  const box = {
    package: 'mapper',
    extensions: ['.box'],
    name: 'mapper',
    version: '1.0.0',
    compilerOptions: ['target', 'jsx'],
  };
  const item = (testMapper, content, rest = {}) => ({
    compilerOptions: { target: 7, jsx: 4, strict: true, lib: ['lib.es5.d.ts'] },
    configFileName: '/tsconfig.json',
    fileName: '/src/a.box',
    content,
    testMapper,
    ...rest,
    mapper: { ...box, exec: [testMapper], options: rest.options },
  });
  const cases = [];
  for (const content of [
    '',
    'export const plain = 1;',
    'export const a = #{target};\nexport const b = #{jsx}; export const c = #{strict}, d = #{lib};\n',
    'export const a = #{unknown} + #{constructor} + #{};',
    'export const a = #{target\nexport const b = #{jsx};\nexport const c = #{',
    '#{target}#{target}',
    'const é = "😀";\nexport const a: string = #{target}; // é\n// @box-ignore\nexport const b: number = "é";\n',
    '// @box-extension: .tsx\nexport const a = <div />;\n',
    '// @box-extension:   .mts  \nexport {};',
    '// @box-extension: .json',
    '// @box-extension: .coffee\n',
    '// @box-ignore\nexport const a: number = "x";\n  // @box-ignore  \nexport const b: number = "y";',
    '// @box-expect-error: nothing to expect\nexport const a = 1;\n',
    '// @box-expect-error: first\nexport const a: number = "x";\n// @box-expect-error:second\nexport const b = 2;\n// @box-ignore\nexport const c = #{target};',
    '// @box-expect-error\nexport const a = 1;\n// @box-expect-error: last line',
    '// @box-ignore\n',
    '// @box-ignore\n\nexport const a = 1;',
    '// @box-ignore\nexport const a = #{target} + #{jsx};\n// @box-expect-error: e\n#{target}\n',
    '// @box-ignore\r\nexport const a: number = "x";\r\n',
    ...[
      'invalid-range',
      'original-range-out-of-bounds',
      'virtual-range-out-of-bounds',
      'invalid-policy',
      'ignore-with-unused-diagnostic',
      'expect-without-unused-diagnostic',
      'invalid-unused-diagnostic-index',
      'overlap',
      'unknown',
    ].flatMap((kind) => [`// @box-invalid-directive: ${kind}\nexport {};\n`, `// @box-invalid-directive:${kind}`]),
  ]) {
    cases.push(item(transformingMapper, content));
    cases.push(item(transformingMapper, content, { compilerOptions: {} }));
  }
  cases.push(item(transformingMapper, 'export {};', { options: { plugins: [{ name: 1 }] } }));
  cases.push(item(transformingMapper, 'export {};', { options: { plugins: [{ name: 'x' }] } }));
  for (const content of ['(+ 1 2 "oops")', '(+ 1 2 "oops")\n', '(+ 1 2 "oops")\n\n', '(- 1 2)', ''])
    cases.push(item(lispMapper, content));
  for (const testMapper of [failingMapper, supplementalMapper, supplementalDiagnosticsMapper, supplementalModuleMapper])
    for (const content of ['', 'export const a = 1;\n', 'const é = "😀";']) cases.push(item(testMapper, content));
  for (const fileName of ['/src/a.vue', '/b.vue', '/src/c.vue', '/src/a.vue.ts'])
    cases.push(item(supplementalGlobalsMapper, 'component', { fileName }));
  for (const content of ['', 'export const a = 1;\n', 'const é = "😀";']) cases.push(item(verbatimMapper, content));
  // The mapper with configuration of its own: its identity and watched file follow the config file's name and
  // its options, and its option diagnostic is its own.
  const dynamic = (rest) => {
    const base = item(dynamicVerbatimMapper, 'export const a = 1;\n', rest);
    return { ...base, mapper: { ...base.mapper, dynamicConfig: true } };
  };
  for (const configFileName of ['/tsconfig.json', '/project/src/tsconfig.app.json', ''])
    cases.push(dynamic({ configFileName }));
  cases.push(dynamic({ options: { plugins: [{ name: 1 }] } }));
  cases.push(dynamic({ options: { plugins: [{ name: 'x' }], other: [1, 'é'] } }));
  cases.push(item('no-such-mapper', 'export {};'));
  return cases;
}

/** The requests the oracle sends to the mapper of a case, each as its method and its parameters as JSON. */
function requestsOf(item) {
  const options = compilerOptions(item.compilerOptions);
  return [
    ['initialize', protocol.marshalInitializeParams('')],
    ['openProject', protocol.marshalOpenProjectParams(item.configFileName, 'wire', mapper(item.mapper), options)],
    ['transform', protocol.marshalTransformParams(item.fileName, item.content, 'wire')],
    ['closeProject', protocol.marshalCloseProjectParams('wire')],
  ];
}

/** The raw response of the mapper of a case to each request, as the oracle sends them. */
function wire(item) {
  let testMapper;
  try {
    testMapper = spawn([item.testMapper]);
  } catch (error) {
    return { spawn: error.message };
  }
  const responses = {};
  for (const [method, params] of requestsOf(item)) {
    try {
      responses[method] = testMapper.handleRequest(method, JSON.parse(params)) ?? null;
    } catch (error) {
      responses[method] = { $error: `ipc: remote error [-32603]: ${error.message}` };
    }
  }
  return responses;
}

/** A directory with a launcher for each ported mapper, which run them as processes. */
function launchers() {
  return writeMapperLaunchers(tempDir('tsc-ts-content-mapper-launchers-'), join(out, 'compiler/span-map.js'));
}

/**
 * A mapper process started by its launcher. `request(method, params)` sends a request and resolves to its
 * response, in the shape `wire` gives one.
 */
function startMapper(launcher) {
  const child = spawnProcess(launcher, [], {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: process.platform === 'win32',
  });
  const reader = createFrameReader();
  const pending = new Map();
  let nextId = 0;
  child.stdout.on('data', (chunk) => {
    for (const { id, result, error } of reader.push(chunk)) {
      const response = error === undefined ? result : { $error: `ipc: remote error [${error.code}]: ${error.message}` };
      pending.get(id).answer(response);
      pending.delete(id);
    }
  });
  const exited = new Promise((exit) => child.on('exit', exit));
  // A mapper that ends with requests unanswered fails them.
  exited.then((status) => {
    for (const { fail } of pending.values()) fail(new Error(`${launcher} exited with status ${status}`));
  });
  return {
    request(method, params) {
      const id = `api${++nextId}`;
      child.stdin.write(frame({ jsonrpc: '2.0', id, method, params: JSON.parse(params) }));
      return new Promise((answer, fail) => pending.set(id, { answer, fail }));
    },
    /** Ends the mapper's input and resolves to its exit status. */
    end() {
      child.stdin.end();
      return exited;
    },
  };
}

const fromUpstream = skip ? [] : upstreamCases();
const cases = [...fromUpstream, ...otherCases()];

test("the ported test mappers answer as tsgo's, and both hosts make the same of the answers", { skip }, () => {
  const expected = runOracle(oracle, out, cases);
  for (let i = 0; i < cases.length; i++) {
    const name = `case ${i} (${cases[i].name ?? cases[i].testMapper}): ${JSON.stringify(cases[i].content)}`;
    assert.deepEqual(wire(cases[i]), expected[i].wire, name);
    delete expected[i].wire;
  }
  // The oracle records the parameters of requests only for mappers it answers for itself.
  const answers = cases.map((item) => answer(item, spawn));
  for (const item of [...answers, ...expected]) delete item.params;
  const outcomes = assertSameAnswers(cases, answers, expected);
  // A mapper that does not start, a failed request, an invalid extension and invalid directives.
  assert.equal(outcomes.size, 4, Array.from(outcomes).join('\n'));
  // Every upstream case gives a file to a mapper, and between them the cases use each ported mapper.
  assert.equal(new Set(fromUpstream.map((item) => item.name)).size, 25);
  assert.deepEqual(
    Array.from(new Set(fromUpstream.map((item) => item.testMapper))).sort(),
    [
      failingMapper,
      lispMapper,
      supplementalDiagnosticsMapper,
      supplementalGlobalsMapper,
      supplementalMapper,
      supplementalModuleMapper,
      transformingMapper,
    ].sort(),
  );
});

// A mapper that stops answering fails these tests instead of holding them: tsgo limits only `initialize`.
const timeout = 300_000;

test('a mapper running as a process answers as it does in the process of the test', { timeout }, async () => {
  const directory = launchers();
  const processes = new Map();
  let compared = 0;
  try {
    for (const item of cases) {
      // A command that names no mapper has no launcher.
      if (!mapperNames.includes(item.testMapper)) continue;
      let testMapper = processes.get(item.testMapper);
      if (testMapper === undefined) {
        testMapper = startMapper(join(directory, item.testMapper));
        processes.set(item.testMapper, testMapper);
      }
      const responses = {};
      for (const [method, params] of requestsOf(item)) responses[method] = await testMapper.request(method, params);
      assert.deepEqual(responses, wire(item), `${item.testMapper}: ${JSON.stringify(item.content)}`);
      compared++;
    }
  } finally {
    // A mapper ends when the compiler closes its input. All are ended before a status is judged, so that none
    // is left running.
    const statuses = await Promise.all(Array.from(processes.values(), (testMapper) => testMapper.end()));
    assert.deepEqual(
      statuses,
      statuses.map(() => 0),
    );
  }
  assert.equal(compared, cases.length - 1);
  assert.equal(processes.size, mapperNames.length);
});

test(
  "tsgo's command line runs a mapper through its launcher and prints the mapper's diagnostic",
  { skip: skip || (!existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo'), timeout },
  () => {
    // The files of an upstream case, on the disk.
    const project = tempDir('tsc-ts-content-mapper-project-');
    const name = 'contentMapperDiagnostics.ts';
    for (const file of parseTestCase(readFileSync(join(upstream, name), 'utf8'), name).files) {
      mkdirSync(dirname(join(project, file.name)), { recursive: true });
      writeFileSync(join(project, file.name), file.content);
    }
    const run = (path) =>
      spawnSync(tsgo, ['-p', '.', '--runExternalCode', '--noEmit', '--pretty', 'false'], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, PATH: path },
        timeout,
      });
    const mapped = run(`${launchers()}${delimiter}${process.env.PATH}`);
    assert.equal(mapped.stdout, 'widget.box(3,23): error box1000: Unclosed interpolation.\n');
    assert.equal(mapped.status, 2);
    // Without the launcher on PATH the mapper cannot start, so the diagnostic above came from the process.
    const missing = run(process.env.PATH);
    assert.match(missing.stdout, /The content mapper command 'compiler-test-mapper' could not be started/);
    assert.equal(missing.status, 2);
  },
);
