// The content mappers of tsgo's compiler tests, ported in content-mappers.mjs. Every file that the upstream
// cases named contentMapper*.ts give to a mapper, and inputs that reach the rest of each mapper, go to the port
// and to tsgo's mapper (packages/tsgo/dist/contentmapper-oracle, built by `npm run build:oracle`). The raw
// responses are compared, and then what tsc-ts and tsgo make of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCases, runOracle } from './content-mapper-cases.mjs';
import {
  createTestMapperSpawner,
  failingMapper,
  lispMapper,
  supplementalDiagnosticsMapper,
  supplementalGlobalsMapper,
  supplementalMapper,
  supplementalModuleMapper,
  transformingMapper,
} from './content-mappers.mjs';
import { parseTestCase } from './module-resolution-cases.mjs';
import { compileSources } from './temp.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const oracle = join(repo, 'packages/tsgo/dist/contentmapper-oracle');
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
  cases.push(item('no-such-mapper', 'export {};'));
  return cases;
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
  const call = (method, params) => {
    try {
      responses[method] = testMapper.handleRequest(method, JSON.parse(params)) ?? null;
    } catch (error) {
      responses[method] = { $error: `ipc: remote error [-32603]: ${error.message}` };
    }
  };
  const options = compilerOptions(item.compilerOptions);
  call('initialize', protocol.marshalInitializeParams(''));
  call('openProject', protocol.marshalOpenProjectParams(item.configFileName, 'wire', mapper(item.mapper), options));
  call('transform', protocol.marshalTransformParams(item.fileName, item.content, 'wire'));
  call('closeProject', protocol.marshalCloseProjectParams('wire'));
  return responses;
}

test("the ported test mappers answer as tsgo's, and both hosts make the same of the answers", { skip }, () => {
  const fromUpstream = upstreamCases();
  const cases = [...fromUpstream, ...otherCases()];
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
