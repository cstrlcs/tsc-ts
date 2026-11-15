// The content mapper contract (src/compiler/content-mapper.ts) and protocol (content-mapper-protocol.ts): the
// cases of tsgo's own tests that need no mapper process, then a comparison with tsgo's content mapper host
// (packages/tsgo/dist/contentmapper-oracle, built by `npm run build:oracle`) given the same mapper responses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCases, runOracle } from './content-mapper-cases.mjs';
import { compileSources } from './temp.mjs';

const repo = resolve(import.meta.dirname, '../../..');
const oracle = join(repo, 'packages/tsgo/dist/contentmapper-oracle');
const skip = !existsSync(oracle) && 'contentmapper-oracle is not built';
const tsgoOptions = join(repo, 'upstream/TypeScript/tsc/internal/core/options_generated.go');

const out = compileSources('tsc-ts-content-mapper-', [
  'compiler/content-mapper-protocol.ts',
  'compiler/parser.ts',
  'compiler/option-declarations.ts',
]);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const mapperModule = await load('compiler/content-mapper.js');
const protocol = await load('compiler/content-mapper-protocol.js');
const { parseJson } = await load('compiler/package-json.js');
const { SpanMap, SpanMapSegment, MappingError } = await load('compiler/span-map.js');
const { getScriptKindFromFileName } = await load('compiler/parser.js');
const { compilerOptionNames } = await load('compiler/options.js');
const { optionDeclarations } = await load('compiler/option-declarations.js');
const { toHex } = await load('compiler/xxh3.js');
const paths = await load('compiler/path.js');
const { messageCode } = await load('compiler/diagnostics.js');
const { mapper, answer, assertSameAnswers } = createCases({
  ...mapperModule,
  ...protocol,
  parseJson,
  MappingError,
  getScriptKindFromFileName,
  toHex,
});
const {
  ContentMapperManifest,
  ContentMapperResult,
  ContentMapperTimings,
  DiagnosticDirectiveError,
  InitializeError,
  InvalidVirtualExtensionError,
  MappedResult,
  MapperTimings,
  OperationTiming,
  ProjectError,
  TransformError,
} = mapperModule;

// Const enums leave no object to import; the oracle comparison fails if one of these is not tsgo's number.
const TransformErrorKind = { Initialize: 1, Project: 2, Request: 3, Response: 4, Mappings: 5 };
const DirectiveErrorKind = {
  InvalidRange: 0,
  InvalidPolicy: 1,
  ExpectMissingUnusedDiagnostic: 2,
  InvalidUnusedDiagnosticIndex: 3,
  Overlap: 4,
};
const ProjectErrorKind = {
  MalformedResponse: 0,
  MissingConfigIdentity: 1,
  NonAbsoluteWatchedFile: 2,
  UnexpectedConfigIdentity: 3,
  UnexpectedWatchedFiles: 4,
};
const InitializeErrorKind = { InvalidResponse: 3, PositionEncoding: 5, EmptySource: 6, ReservedSource: 7 };
const ScriptKind = { JS: 1, JSX: 2, TS: 3, TSX: 4, JSON: 6 };
// The codes of the diagnostics about a mapper's configuration, which are tsgo's.
const Code = {
  extensionWithoutDot: 18065,
  builtInExtension: 18066,
  extensionRegisteredTwice: 18067,
  packageNotResolved: 18075,
  packageJsonNotParsed: 18076,
  packageWithoutName: 18077,
  packageWithoutContentMapper: 18078,
  execNotStrings: 18079,
  invalidOutputExtension: 18118,
  outputSourceNotRegistered: 18119,
  manifestInvalidMapping: 18121,
  manifestOutputExtensionsNotStrings: 18122,
  pathSeparators: 18123,
};

const json = (value) => parseJson(JSON.stringify(value));
const decode = (response, content = 'x', encoding = 'utf-8') =>
  protocol.decodeTransformResult(json(response), content, encoding, 'mapper');

// ---- Mappers

test('a mapper is named by its manifest, then its package, then its contribution', () => {
  assert.equal(
    mapper({ package: 'configured', name: 'resolved', contributionId: 'contributed' }).diagnosticName(),
    'resolved',
  );
  assert.equal(mapper({ package: 'configured', contributionId: 'contributed' }).diagnosticName(), 'configured');
  assert.equal(mapper({ contributionId: 'contributed' }).diagnosticName(), 'contributed');
});

test('the identity of a mapper is its name and version', () => {
  assert.equal(mapper({ package: 'p' }).identity(), '');
  assert.equal(mapper({ name: 'vue' }).identity(), 'vue');
  assert.equal(mapper({ name: 'vue', version: '1.0.0' }).identity(), 'vue@1.0.0');
  assert.equal(mapper({ name: 'vue', version: '1.0.0', contributionId: 'ext' }).identity(), 'ext (vue@1.0.0)');
});

test('mappers are equal when every part of their configuration is', () => {
  const fields = {
    package: 'mapper',
    extensions: ['.vue'],
    outputExtensions: { '.vue': '.js' },
    options: { a: 1 },
    name: 'mapper',
    version: '1.0.0',
    exec: ['run'],
    compilerOptions: ['target'],
  };
  assert.ok(mapper(fields).equals(mapper(fields)));
  for (const change of [
    { package: 'other' },
    { extensions: ['.vue', '.astro'] },
    { extensions: undefined },
    { outputExtensions: { '.vue': '.mjs' } },
    { outputExtensions: undefined },
    { options: { a: 2 } },
    { version: '1.0.1' },
    { exec: ['run', '--fast'] },
    { compilerOptions: [] },
    { dynamicConfig: true },
    { defaultOutputExtensions: {} },
    { contributionId: 'ext' },
  ])
    assert.ok(!mapper(fields).equals(mapper({ ...fields, ...change })), JSON.stringify(change));
});

test('the longest registered extension of a file name chooses its mapper', () => {
  const z = mapper({ package: 'z', extensions: ['.z'] });
  const yz = mapper({ package: 'yz', extensions: ['.y.z'] });
  const { getContentMapperForFileName } = mapperModule;
  assert.equal(getContentMapperForFileName([z, yz], '/src/Component.y.z', true), yz);
  assert.equal(getContentMapperForFileName([z, yz], '/src/Component.z', true), z);
  assert.equal(getContentMapperForFileName([z, yz], '/src/Component.ts', true), undefined);
});

test('a file system that ignores case chooses a mapper in any letter case', () => {
  const vue = mapper({ extensions: ['.vue'] });
  assert.equal(mapperModule.getContentMapperForFileName([vue], '/src/Component.VUE', false), vue);
  assert.equal(mapperModule.getContentMapperForFileName([vue], '/src/Component.VUE', true), undefined);
});

test('an output extension is found for a source extension, in any letter case when case is ignored', () => {
  const outputs = new Map([['.vue', '.js']]);
  const { getContentMapperOutputExtension } = mapperModule;
  assert.equal(getContentMapperOutputExtension(outputs, '.vue', false), '.js');
  assert.equal(getContentMapperOutputExtension(outputs, '.VUE', false), undefined);
  assert.equal(getContentMapperOutputExtension(outputs, '.VUE', true), '.js');
  assert.equal(getContentMapperOutputExtension(undefined, '.vue', true), undefined);
});

test('the longest of the extensions a path ends with is found as the path spells it', () => {
  const extensions = ['.z', '.y.z', '.other'];
  const { getLongestExtensionFromPath } = paths;
  assert.equal(getLongestExtensionFromPath('/src/Component.y.z', extensions, true), '.y.z');
  assert.equal(getLongestExtensionFromPath('/src/Component.z', extensions, true), '.z');
  assert.equal(getLongestExtensionFromPath('/src/Component.y.Z', extensions, true), '');
  assert.equal(getLongestExtensionFromPath('/src/Component.y.Z', extensions, false), '.y.Z');
  assert.equal(getLongestExtensionFromPath('/src/Component.y.z/', ['y.z', 'z'], true), '.y.z');
  assert.equal(getLongestExtensionFromPath('/src/Componenty.z', ['.y.z', 'ty.z'], true), '');
});

test('the rewrite with the longest source extension changes a module specifier', () => {
  const { ExtensionRewrite, rewriteExtension, shouldRewriteExtension } = paths;
  const rewrites = [new ExtensionRewrite('.z', '.js'), new ExtensionRewrite('.y.z', '.mjs')];
  assert.equal(rewriteExtension('./Widget.y.z', rewrites, true), './Widget.mjs');
  assert.equal(rewriteExtension('./Widget.Y.Z', rewrites, false), './Widget.mjs');
  assert.equal(rewriteExtension('.y', rewrites, true), undefined);
  assert.equal(rewriteExtension('.z', rewrites, true), undefined);
  rewrites.push(new ExtensionRewrite('.identity.y.z', '.identity.y.z'));
  assert.equal(rewriteExtension('./Widget.IDENTITY.Y.Z', rewrites, false), undefined);
  assert.ok(!shouldRewriteExtension('./Widget.identity.y.z', rewrites, true));
});

test('a rewrite changes the extension of a file name unless it keeps it', () => {
  const { ExtensionRewrite, getExtensionRewrite, rewriteExtension } = paths;
  const identity = new ExtensionRewrite('.identity.y.z', '.identity.y.z');
  const rewrites = [new ExtensionRewrite('.z', '.js'), new ExtensionRewrite('.y.z', '.mjs'), identity];
  for (const [path, expected, useCaseSensitiveFileNames] of [
    ['/src/Widget.y.z', '/src/Widget.mjs', true],
    ['/src/Widget.Y.Z', '/src/Widget.mjs', false],
    ['/src/Widget.Y.Z', undefined, true],
    ['/src/Widget.IDENTITY.Y.Z', undefined, false],
    ['/src/Widget.txt', undefined, true],
  ])
    assert.equal(rewriteExtension(path, rewrites, useCaseSensitiveFileNames), expected, path);
  assert.equal(getExtensionRewrite('/src/Widget.IDENTITY.Y.Z', rewrites, false), identity);
  assert.equal(getExtensionRewrite('/src/Widget.y.z', rewrites, true), rewrites[1]);
  assert.equal(getExtensionRewrite('/src/Widget.txt', rewrites, true), undefined);
});

test('relative specifiers of mapped and TypeScript files are the ones to rewrite', () => {
  const rewrites = [new paths.ExtensionRewrite('.astro', '.js')];
  for (const [specifier, expected] of [
    ['./Card.astro', true],
    ['../Card.astro', true],
    ['./file.ts', true],
    ['./file.d.ts', false],
    ['./file.d.astro.ts', false],
    ['./file.js', false],
    ['package.astro', false],
    ['/Card.astro', false],
  ])
    assert.equal(paths.shouldRewriteExtension(specifier, rewrites, true), expected, specifier);
});

test('extensions of virtual files, valid extensions and reserved ones', () => {
  const { isSupportedVirtualExtension, isValidExtension, hasReservedSourceExtension, equalFold } = mapperModule;
  for (const extension of ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json'])
    assert.ok(isSupportedVirtualExtension(extension), extension);
  for (const extension of ['', '.coffee', '.d.ts', '.TS', 'ts'])
    assert.ok(!isSupportedVirtualExtension(extension), extension);
  for (const extension of ['.vue', '.y.z']) assert.ok(isValidExtension(extension), extension);
  for (const extension of ['', '.', 'vue', '.a/b', '.a\\b']) assert.ok(!isValidExtension(extension), extension);
  for (const extension of ['.ts', '.TS', '.d.ts', '.vue.ts', '.x.JSON', '.mjs', '.tſ'])
    assert.ok(hasReservedSourceExtension(extension), extension);
  for (const extension of ['.vue', '.tss', '.s', '']) assert.ok(!hasReservedSourceExtension(extension), extension);
  assert.ok(equalFold('TypeScript', 'typescript'));
  assert.ok(equalFold('K', 'k'));
  assert.ok(!equalFold('ts', 'tsx'));
});

test('the extensions of contentMappers entries are validated in order', () => {
  const mappers = [
    mapper({ extensions: ['vue', '.a/b', '.vue', '.d.ts', '.vue'], outputExtensions: { '.vue': 'js', '.x/y': '.js' } }),
    mapper({ extensions: ['.VUE', '.astro'], outputExtensions: { '.astro': '.js' } }),
  ];
  const problems = mapperModule.validateContentMapperExtensions(mappers, false);
  assert.deepEqual(
    problems.map((problem) => [
      messageCode(problem.message),
      problem.extension,
      problem.mapper,
      problem.inOutputExtensions,
    ]),
    [
      [Code.extensionWithoutDot, 'vue', 0, false],
      [Code.pathSeparators, '.a/b', 0, false],
      [Code.builtInExtension, '.d.ts', 0, false],
      [Code.extensionRegisteredTwice, '.vue', 0, false],
      [Code.invalidOutputExtension, 'js', 0, true],
      [Code.pathSeparators, '.x/y', 0, true],
      [Code.outputSourceNotRegistered, '.x/y', 0, true],
      [Code.extensionRegisteredTwice, '.VUE', 1, false],
    ],
  );
  assert.deepEqual(mappers[0].definition.extensions, ['.vue']);
  assert.deepEqual(mappers[1].definition.extensions, ['.astro']);
  // With case-sensitive file names `.VUE` is another extension than `.vue`.
  const sensitive = [mapper({ extensions: ['.vue'] }), mapper({ extensions: ['.VUE'] })];
  assert.deepEqual(mapperModule.validateContentMapperExtensions(sensitive, true), []);
});

// ---- The manifest

const manifestOf = (packageJson) => mapperModule.readContentMapperManifest('mapper', packageJson);
const codeOf = (diagnostic) => (diagnostic instanceof ContentMapperManifest ? 'manifest' : diagnostic.code);

test('a manifest keeps the name, the version and the command of the package', () => {
  const manifest = manifestOf(`{
    "name": "vue-ts-mapper",
    "version": "1.2.3",
    "typescript": { "contentMapper": { "exec": ["node", "./dist/mapper.js"], "compilerOptions": ["target", "jsx"], "outputExtensions": { ".vue": ".js" } } }
  }`);
  assert.ok(manifest instanceof ContentMapperManifest);
  assert.equal(manifest.name, 'vue-ts-mapper');
  assert.equal(manifest.version, '1.2.3');
  assert.deepEqual(manifest.exec, ['node', './dist/mapper.js']);
  assert.deepEqual(manifest.compilerOptions, ['target', 'jsx']);
  assert.equal(manifest.dynamicConfig, false);
  assert.deepEqual(manifest.defaultOutputExtensions, new Map([['.vue', '.js']]));

  // A list of compiler options with another value in it is kept up to that value, which reads as ''.
  const partial = manifestOf(
    `{ "name": "m", "typescript": { "contentMapper": { "exec": ["x"], "compilerOptions": ["strict", 1, "target"] } } }`,
  );
  assert.deepEqual(partial.compilerOptions, ['strict', '']);

  const noVersion = manifestOf(
    `{ "name": "@scope/noversion", "typescript": { "contentMapper": { "exec": ["run"], "dynamicConfig": true } } }`,
  );
  assert.equal(noVersion.version, '');
  assert.equal(noVersion.compilerOptions, undefined);
  assert.equal(noVersion.dynamicConfig, true);
  assert.equal(noVersion.defaultOutputExtensions, undefined);
});

test('a package that cannot be a mapper has a diagnostic for a manifest', () => {
  for (const [packageJson, code] of [
    [undefined, Code.packageNotResolved],
    ['{', Code.packageJsonNotParsed],
    ['[]', Code.packageJsonNotParsed],
    ['{ "version": "1.0.0" }', Code.packageWithoutName],
    ['null', Code.packageWithoutName],
    ['{ "name": "no-manifest" }', Code.packageWithoutContentMapper],
    ['{ "name": "no-manifest", "typescript": { "contentMapper": null } }', Code.packageWithoutContentMapper],
    ['{ "name": "no-exec", "typescript": { "contentMapper": {} } }', Code.execNotStrings],
    ['{ "name": "bad-exec", "typescript": { "contentMapper": { "exec": "node ./mapper.js" } } }', Code.execNotStrings],
    [
      '{ "name": "bad-output-extension", "typescript": { "contentMapper": { "exec": ["run"], "outputExtensions": { ".vue": "js" } } } }',
      Code.manifestInvalidMapping,
    ],
  ])
    assert.equal(codeOf(manifestOf(packageJson)), code, packageJson);
});

test('malformed outputExtensions of a manifest are rejected', () => {
  const objectWithStrings = Code.manifestOutputExtensionsNotStrings;
  const invalidMapping = Code.manifestInvalidMapping;
  const separators = Code.pathSeparators;
  for (const [value, code] of [
    ['"invalid"', objectWithStrings],
    ['null', objectWithStrings],
    ['[]', objectWithStrings],
    ['{".vue": 1}', objectWithStrings],
    ['{".vue": null}', invalidMapping],
    ['{".vue/foo": ".js"}', separators],
    ['{".vue\\\\foo": ".js"}', separators],
    ['{".vue": ".js/foo"}', separators],
    ['{".vue": ".js\\\\foo"}', separators],
  ]) {
    const packageJson = `{ "name": "mapper", "typescript": { "contentMapper": { "exec": ["run"], "outputExtensions": ${value} } } }`;
    assert.equal(codeOf(manifestOf(packageJson)), code, value);
  }
});

// ---- Virtual files

test('virtual files are named after the mapped file and parsed by their extension', () => {
  const { getVirtualFileName, getSupplementalFileName, isModuleVirtualExtension } = mapperModule;
  assert.equal(getVirtualFileName('/src/App.vue', '.tsx'), '/src/App.vue.tsx');
  assert.equal(getScriptKindFromFileName(getVirtualFileName('/src/App.vue', '.tsx')), ScriptKind.TSX);
  const expected = [
    ['/component.astro.0.js', ScriptKind.JS, false],
    ['/component.astro.1.jsx', ScriptKind.JSX, false],
    ['/component.astro.2.ts', ScriptKind.TS, false],
    ['/component.astro.3.tsx', ScriptKind.TSX, false],
    ['/component.astro.4.mts', ScriptKind.TS, true],
    ['/component.astro.5.cts', ScriptKind.TS, true],
    ['/component.astro.6.json', ScriptKind.JSON, false],
  ];
  ['.js', '.jsx', '.ts', '.tsx', '.mts', '.cts', '.json'].forEach((extension, i) => {
    const fileName = getSupplementalFileName('/component.astro', i, extension);
    assert.deepEqual([fileName, getScriptKindFromFileName(fileName), isModuleVirtualExtension(extension)], expected[i]);
  });
});

test('a result is validated before it is parsed', () => {
  const empty = new SpanMap([]);
  const result = (canonical, ...supplemental) =>
    new ContentMapperResult(
      canonical.text ?? '',
      canonical.extension ?? '.ts',
      canonical.mappings,
      [],
      [],
      supplemental,
    );
  const output = (fields) => new MappedResult(fields.text ?? '', fields.extension ?? '.ts', fields.mappings, []);
  const { validateResult } = mapperModule;
  assert.equal(
    validateResult(result({ mappings: empty }, output({ mappings: empty, extension: '.json' })), ''),
    undefined,
  );

  const noMappings = validateResult(result({}), '');
  assert.ok(noMappings instanceof TransformError);
  assert.equal(noMappings.kind, TransformErrorKind.Mappings);
  const supplementalWithoutMappings = validateResult(result({ mappings: empty }, output({})), '');
  assert.equal(supplementalWithoutMappings.kind, TransformErrorKind.Mappings);

  const mismatch = new SpanMap([new SpanMapSegment(0, 1, 0, 1, 0, 0)]);
  assert.ok(validateResult(result({ text: 'a', mappings: mismatch }), 'b') instanceof MappingError);
  assert.ok(
    validateResult(result({ mappings: empty }, output({ text: 'a', mappings: mismatch })), 'b') instanceof MappingError,
  );

  const badExtension = validateResult(result({ mappings: empty, extension: '.coffee' }), '');
  assert.ok(badExtension instanceof TransformError);
  assert.equal(badExtension.kind, TransformErrorKind.Response);
  assert.equal(badExtension.cause, undefined);
  // A problem of the canonical output comes before one of a supplemental output.
  const both = validateResult(result({ mappings: empty, extension: '.coffee' }, output({})), '');
  assert.equal(both.kind, TransformErrorKind.Response);
});

test('a supplemental file must not have the name of a file that exists', () => {
  const empty = new SpanMap([]);
  const result = new ContentMapperResult(
    '',
    '.ts',
    empty,
    [],
    [],
    [new MappedResult('', '.ts', empty, []), new MappedResult('', '.mts', empty, [])],
  );
  const { checkSupplementalFileNameCollisions } = mapperModule;
  assert.equal(
    checkSupplementalFileNameCollisions('/a.vue', result, () => false),
    undefined,
  );
  const collision = checkSupplementalFileNameCollisions('/a.vue', result, (name) => name === '/a.vue.1.mts');
  assert.equal(collision.fileName, '/a.vue.1.mts');
  assert.equal(collision.error(), 'content mapper supplemental output file "/a.vue.1.mts" already exists');
});

test('timings since an earlier snapshot are never negative', () => {
  const timing = (count, duration) => new OperationTiming(count, duration);
  const timings = (transform, wait) =>
    new ContentMapperTimings(
      new Map([['m', new MapperTimings(timing(1, 5), timing(1, 2), timing(0, 0), timing(0, 0), transform)]]),
      wait,
    );
  const since = timings(timing(7, 40), 50).since(timings(timing(3, 15), 20));
  assert.deepEqual(since.mappers.get('m').transform, timing(4, 25));
  assert.deepEqual(since.mappers.get('m').spawn, timing(0, 0));
  assert.equal(since.requestWait, 30);
  const fresh = timings(timing(2, 9), 4).since(new ContentMapperTimings(new Map(), 10));
  assert.deepEqual(fresh.mappers.get('m').transform, timing(2, 9));
  assert.equal(fresh.requestWait, 0);
});

// ---- Responses

test('diagnostic directives are decoded with their unused diagnostic', () => {
  const directives = (tuples, ...unused) => ({ unusedExpectDirectiveDiagnostics: unused, directives: tuples });
  let result = decode(
    {
      text: 'virtual source',
      extension: '.ts',
      diagnosticDirectives: directives([[0, 9, 8, 14, 1]], { code: 2578, messageText: 'Unused framework directive.' }),
    },
    'directive\nsource',
  );
  assert.deepEqual(
    { ...result.diagnosticDirectives[0] },
    {
      originalPos: 0,
      originalEnd: 9,
      virtualPos: 8,
      virtualEnd: 14,
      policy: 1,
      unusedCode: 2578,
      unusedMessageText: 'Unused framework directive.',
      source: 'mapper',
    },
  );
  result = decode(
    {
      text: 'virtual source',
      extension: '.ts',
      diagnosticDirectives: directives(
        [[0, 9, 8, 14, 1, 1]],
        { code: 1, messageText: 'first' },
        { code: 2, messageText: 'second' },
      ),
    },
    'directive\nsource',
  );
  assert.equal(result.diagnosticDirectives[0].unusedCode, 2);
  assert.equal(result.diagnosticDirectives[0].unusedMessageText, 'second');
  // An Ignore directive needs no range in the original text.
  result = decode({ text: 'x', extension: '.ts', diagnosticDirectives: directives([[-1, 0, 0, 0, 0]], {}) });
  assert.ok(result instanceof ContentMapperResult);
  assert.deepEqual([result.diagnosticDirectives[0].originalPos, result.diagnosticDirectives[0].originalEnd], [0, 0]);
});

test('invalid diagnostic directives are rejected by kind', () => {
  for (const [name, text, tuples, unused, kind] of [
    ['invalid range', 'x', [[0, 0, -1, 0, 0]], [], DirectiveErrorKind.InvalidRange],
    ['unknown policy', 'x', [[0, 0, 0, 0, 2]], [], DirectiveErrorKind.InvalidPolicy],
    ['expect requires unused diagnostic', 'x', [[0, 0, 0, 0, 1]], [], DirectiveErrorKind.ExpectMissingUnusedDiagnostic],
    [
      'multiple unused diagnostics require index',
      'x',
      [[0, 0, 0, 0, 1]],
      [{}, {}],
      DirectiveErrorKind.ExpectMissingUnusedDiagnostic,
    ],
    [
      'unused diagnostic index out of range',
      'x',
      [[0, 0, 0, 0, 1, 1]],
      [{}],
      DirectiveErrorKind.InvalidUnusedDiagnosticIndex,
    ],
    ['original range out of bounds', 'x', [[99, 0, 0, 0, 1]], [{}], DirectiveErrorKind.InvalidRange],
    ['virtual range out of bounds', 'x', [[0, 0, 99, 99, 0]], [], DirectiveErrorKind.InvalidRange],
    [
      'overlap',
      'abc',
      [
        [0, 0, 0, 2, 0],
        [0, 0, 1, 3, 0],
      ],
      [],
      DirectiveErrorKind.Overlap,
    ],
  ]) {
    const error = decode({
      text,
      extension: '.ts',
      diagnosticDirectives: { unusedExpectDirectiveDiagnostics: unused, directives: tuples },
    });
    assert.ok(error instanceof TransformError, name);
    assert.equal(error.kind, TransformErrorKind.Response, name);
    assert.ok(error.cause instanceof DiagnosticDirectiveError, name);
    assert.equal(error.cause.kind, kind, name);
    assert.equal(error.cause.supplementalIndex, -1, name);
  }
});

test('supplemental outputs are decoded, and their directive errors say which output', () => {
  const result = decode(
    {
      text: 'export default 1;',
      extension: '.ts',
      supplemental: [
        {
          text: 'declare const first: string;',
          extension: '.ts',
          diagnosticDirectives: { unusedExpectDirectiveDiagnostics: [], directives: [[0, 0, 0, 7, 0]] },
        },
        { text: 'declare const second: number;', extension: '.mjs' },
      ],
    },
    'component',
  );
  assert.equal(result.supplemental.length, 2);
  assert.equal(result.supplemental[0].text, 'declare const first: string;');
  assert.equal(result.supplemental[0].virtualExtension, '.ts');
  assert.deepEqual(result.supplemental[0].mappings.segments, []);
  assert.equal(result.supplemental[0].diagnosticDirectives[0].virtualEnd, 7);
  assert.equal(result.supplemental[1].virtualExtension, '.mjs');

  const error = decode({
    text: 'export {};',
    extension: '.ts',
    supplemental: [
      { text: 'export {};', extension: '.ts' },
      {
        text: 'export {};',
        extension: '.ts',
        diagnosticDirectives: { unusedExpectDirectiveDiagnostics: [], directives: [[0, 0, 0, 0, 1]] },
      },
    ],
  });
  assert.deepEqual(
    [error.cause.kind, error.cause.index, error.cause.supplementalIndex],
    [DirectiveErrorKind.ExpectMissingUnusedDiagnostic, 0, 1],
  );
});

test('an output needs an extension a virtual file may have', () => {
  for (const extension of ['', '.coffee']) {
    for (const response of [
      { text: 'export {};', extension },
      { text: 'export {};', extension: '.ts', supplemental: [{ text: 'export {};', extension }] },
    ]) {
      const error = decode(response);
      assert.ok(error.cause instanceof InvalidVirtualExtensionError);
      assert.equal(error.cause.extension, extension);
      assert.equal(error.error(), `content mapper transform failed: invalid virtual extension "${extension}"`);
    }
  }
});

test('positions in either encoding become UTF-16 offsets', () => {
  // `é` is two bytes in UTF-8 and one code unit in UTF-16.
  for (const [encoding, emojiLength, textLength] of [
    ['utf-8', 2, 3],
    ['utf-16', 1, 2],
  ]) {
    const result = decode(
      {
        text: 'éx',
        extension: '.ts',
        mappings: [
          [0, emojiLength, 0, emojiLength, 0],
          [emojiLength, textLength - emojiLength, emojiLength, textLength - emojiLength, 0],
        ],
        diagnosticDirectives: {
          unusedExpectDirectiveDiagnostics: [],
          directives: [[emojiLength, textLength - emojiLength, emojiLength, textLength, 0]],
        },
        diagnostics: [
          {
            messageText: 'after non-ASCII character',
            start: emojiLength,
            length: textLength - emojiLength,
            code: 1001,
          },
        ],
      },
      'éx',
      encoding,
    );
    assert.deepEqual(
      result.mappings.segments.map((s) => [s.virtualStart, s.virtualEnd, s.originalStart, s.originalEnd]),
      [
        [0, 1, 0, 1],
        [1, 2, 1, 2],
      ],
      encoding,
    );
    assert.equal(result.mappings.validate(result.text, 'éx'), undefined);
    assert.deepEqual(
      { ...result.diagnostics[0] },
      {
        pos: 1,
        end: 2,
        source: 'mapper',
        code: 1001,
        messageText: 'after non-ASCII character',
      },
    );
    const directive = result.diagnosticDirectives[0];
    assert.deepEqual(
      [directive.originalPos, directive.originalEnd, directive.virtualPos, directive.virtualEnd],
      [1, 2, 1, 2],
    );
  }
});

test('a position inside a character is rejected', () => {
  for (const [encoding, content] of [
    ['utf-8', 'é'],
    ['utf-16', '😀'],
  ]) {
    const error = decode(
      { extension: '.ts', diagnostics: [{ messageText: 'invalid boundary', start: 1, code: 1002 }] },
      content,
      encoding,
    );
    assert.equal(error.kind, TransformErrorKind.Response);
    assert.match(error.error(), /position 1 splits a Unicode code point$/, encoding);
  }
});

test('an initialize response selects an encoding and a diagnostic source that is not reserved', () => {
  const initialize = (response) => protocol.decodeInitializeResult(json(response));
  assert.deepEqual(
    { ...initialize({ positionEncoding: 'utf-16', diagnosticSource: 'vue' }) },
    {
      positionEncoding: 'utf-16',
      diagnosticSource: 'vue',
    },
  );
  const unsupported = initialize({ positionEncoding: 'utf-32', diagnosticSource: 'vue' });
  assert.equal(unsupported.kind, InitializeErrorKind.PositionEncoding);
  assert.equal(unsupported.error(), 'unsupported position encoding "utf-32"');
  for (const source of ['', ' ', 'ts', 'TS', 'd.ts', 'json', 'typescript', 'TypeScript', 'tsc', 'TSC']) {
    const error = initialize({ positionEncoding: 'utf-8', diagnosticSource: source });
    assert.ok(error instanceof InitializeError, source);
    if (source === '' || source === ' ') assert.equal(error.error(), 'diagnostic source must not be empty');
    else assert.equal(error.error(), `diagnostic source "${source}" is reserved by TypeScript`);
  }
  const invalid = initialize({ positionEncoding: 5 });
  assert.equal(invalid.kind, InitializeErrorKind.InvalidResponse);
});

test('an integer of a response is written without a fraction or an exponent', () => {
  // tsgo's decoder rejects `1.0` and `1e0` for an integer, as the span map oracle shows for mappings.
  const response = (start) =>
    protocol.decodeTransformResult(
      parseJson(
        `{"text":"ab","extension":".ts","diagnostics":[{"messageText":"m","start":${start},"length":1,"code":1}]}`,
      ),
      'ab',
      'utf-8',
      'mapper',
    );
  assert.equal(response('1').diagnostics.length, 1);
  for (const start of ['1.0', '1e0', '10E-1']) {
    const error = response(start);
    assert.ok(error instanceof TransformError, start);
    assert.equal(error.kind, TransformErrorKind.Response, start);
  }
  const opened = (code) =>
    protocol.decodeOpenProjectResult(
      parseJson(`{"optionDiagnostics":[{"path":["a",0],"messageText":"m","code":${code}}]}`),
      mapper({ name: 'mapper' }),
      'mapper',
    );
  assert.equal(opened('7').optionDiagnostics[0].code, 7);
  assert.ok(opened('7.0') instanceof ProjectError);
});

test('an openProject response follows what the mapper declared', () => {
  const open = (response, fields = {}) =>
    protocol.decodeOpenProjectResult(json(response), mapper({ name: 'm', exec: ['m'], ...fields }), 'vue');
  const dynamic = { dynamicConfig: true };
  const opened = open(
    {
      configIdentity: 'c1',
      watchedFiles: ['/repo/b/../mapper.config.js'],
      optionDiagnostics: [{ path: ['plugins', 0, 'name'], messageText: "Option 'name' requires a string.", code: 123 }],
    },
    dynamic,
  );
  assert.equal(opened.configIdentity, 'c1');
  assert.deepEqual(opened.watchedFiles, ['/repo/mapper.config.js']);
  const diagnostic = opened.optionDiagnostics[0];
  assert.deepEqual(
    [diagnostic.source, diagnostic.code, diagnostic.messageText],
    ['vue', 123, "Option 'name' requires a string."],
  );
  assert.deepEqual(
    diagnostic.path.map((segment) => (segment.isIndex ? segment.index : segment.property)),
    ['plugins', 0, 'name'],
  );
  assert.deepEqual({ ...open({}) }, { configIdentity: '', watchedFiles: [], optionDiagnostics: [] });

  for (const [name, response, fields, kind] of [
    [
      'relative watched file',
      { configIdentity: 'c', watchedFiles: ['mapper.config.js'] },
      dynamic,
      ProjectErrorKind.NonAbsoluteWatchedFile,
    ],
    ['dynamic without identity', {}, dynamic, ProjectErrorKind.MissingConfigIdentity],
    ['static with identity', { configIdentity: 'dynamic' }, {}, ProjectErrorKind.UnexpectedConfigIdentity],
    [
      'static with watched files',
      { watchedFiles: ['/repo/mapper.config.js'] },
      {},
      ProjectErrorKind.UnexpectedWatchedFiles,
    ],
    [
      'null path segment',
      { optionDiagnostics: [{ path: [null], messageText: 'Invalid option.', code: 123 }] },
      {},
      ProjectErrorKind.MalformedResponse,
    ],
    ['negative path index', { optionDiagnostics: [{ path: [-1] }] }, {}, ProjectErrorKind.MalformedResponse],
    ['not an object', [], {}, ProjectErrorKind.MalformedResponse],
  ]) {
    const error = open(response, fields);
    assert.ok(error instanceof ProjectError, name);
    assert.equal(error.kind, kind, name);
  }
});

test('request parameters are written as tsgo writes them', () => {
  assert.equal(protocol.marshalInitializeParams(''), '{"positionEncodings":["utf-8","utf-16"]}');
  assert.equal(protocol.marshalInitializeParams('pt-BR'), '{"locale":"pt-BR","positionEncodings":["utf-8","utf-16"]}');
  assert.equal(protocol.marshalCloseProjectParams('m:0'), '{"projectHandle":"m:0"}');
  assert.equal(
    protocol.marshalTransformParams('/a.vue', 'a "b"\n', 'm:0'),
    '{"fileName":"/a.vue","content":"a \\"b\\"\\n","projectHandle":"m:0"}',
  );
});

// ---- The same responses, given to tsgo

const baseMapper = { package: 'mapper', extensions: ['.vue'], name: 'mapper', version: '1.0.0', exec: ['run'] };
const initialized = (encoding = 'utf-8') => ({ positionEncoding: encoding, diagnosticSource: 'vue' });

/** A case with the defaults of a mapper that initializes and returns `transform` for the content `content`. */
function mapped(transform, content = 'const a = 1;', rest = {}) {
  return { mapper: baseMapper, fileName: '/src/a.vue', content, initialize: initialized(), transform, ...rest };
}

test(
  'the compiler options are the fields of tsgo in its order, runExternalCode among them',
  { skip: !existsSync(tsgoOptions) && 'needs upstream/TypeScript' },
  () => {
    const struct = /^type CompilerOptions struct \{\n([^}]*)\}/m.exec(readFileSync(tsgoOptions, 'utf8'))[1];
    const fields = Array.from(struct.matchAll(/`json:"(\w+),omitzero"`/g), (match) => match[1]);
    assert.equal(fields.length, 132);
    assert.deepEqual(compilerOptionNames, fields);
    assert.equal(
      mapperModule.marshalCompilerOptions({ all: false, runExternalCode: true, pprofDir: '/profiles' }),
      '{"all":false,"runExternalCode":true,"pprofDir":"/profiles"}',
    );
  },
);

// The compiler options that no option declaration describes, and a value for each.
const undeclaredOptions = {
  allowNonTsExtensions: true,
  suppressOutputPathCheck: false,
  configFilePath: '/src/tsconfig.json',
  noDtsResolution: true,
  pathsBasePath: '/src',
  noEmitForJsFiles: false,
  build: true,
};

/** Compiler options with every option set, to a value of the kind its declaration gives. */
function everyCompilerOption() {
  const declarations = new Map(optionDeclarations.map((declaration) => [declaration.name, declaration]));
  const options = {};
  let flag = false;
  for (const name of compilerOptionNames) {
    const declaration = declarations.get(name);
    if (name === 'paths') options.paths = { '@/*': ['./src/*'], '*': null };
    else if (name === 'plugins') options.plugins = [{ name: 'plugin' }, { name: '' }];
    else if (name === 'lib') options.lib = ['lib.es2015.d.ts', 'lib.dom.d.ts'];
    else if (declaration === undefined) options[name] = undeclaredOptions[name];
    else if (declaration.kind === 'boolean') options[name] = flag = !flag;
    else if (declaration.kind === 'string') options[name] = `/value/${name}`;
    else if (declaration.kind === 'number') options[name] = 3;
    else if (declaration.kind === 'enum')
      options[name] = Array.from(declaration.values.values()).find((value) => typeof value === 'number' && value > 0);
    else options[name] = [`${name}-a`, 'b'];
    assert.notEqual(options[name], undefined, name);
  }
  return options;
}

const directives = (tuples, ...unused) => ({ unusedExpectDirectiveDiagnostics: unused, directives: tuples });
const verbatim = (content) => ({
  text: content,
  extension: '.ts',
  mappings: [[0, content.length, 0, content.length, 0]],
});

function oracleCases() {
  const cases = [];
  const content = 'const a = 1;';
  // Mappers and compiler options: identities, declared options and the parameters of each request.
  cases.push(
    mapped(verbatim(content), content, {
      mapper: {
        ...baseMapper,
        compilerOptions: [
          'target',
          'jsx',
          'strict',
          'paths',
          'unknown',
          'lib',
          'maxNodeModuleJsDepth',
          'target',
          'outDir',
        ],
        options: { plugins: [1, 'x', null, { deep: true }], 'a"b': 1.5 },
        outputExtensions: { '.vue': '.js', '.astro': '.mjs' },
      },
      compilerOptions: {
        target: 7,
        strict: true,
        noEmit: false,
        paths: { a: ['b'], c: null },
        lib: ['lib.es5.d.ts'],
        maxNodeModuleJsDepth: 0,
        module: 0,
        outDir: '/out',
        plugins: [{ name: 'p' }],
      },
      configFileName: '/src/tsconfig.json',
    }),
    mapped(verbatim(content), content, { compilerOptions: everyCompilerOption() }),
    mapped(verbatim(content), content, { mapper: { name: 'bare', exec: ['run'] } }),
    mapped(verbatim(content), content, { mapper: { package: 'unresolved', exec: ['run'] } }),
    mapped(verbatim(content), content, { mapper: { ...baseMapper, contributionId: 'ext.vue', outputExtensions: {} } }),
    mapped(verbatim(content), content, { mapper: { ...baseMapper, version: '', compilerOptions: [] } }),
  );
  // Dynamic configuration and option diagnostics.
  const dynamic = { ...baseMapper, dynamicConfig: true, options: { strict: true } };
  for (const openProject of [
    { configIdentity: 'c1', watchedFiles: ['/repo/b/../w.json', '/a', '/a'] },
    {
      configIdentity: 'c1',
      optionDiagnostics: [{ path: ['a', 0, 'b'], messageText: 'bad option', code: 3 }, { path: [] }],
    },
    { configIdentity: '' },
    {},
    { configIdentity: 'c1', watchedFiles: ['relative.json'] },
    { configIdentity: 'c1', watchedFiles: ['file:///a/b.json?x'] },
    { configIdentity: 'c1', watchedFiles: ['file:///a/b.json', 'c:/a#b'] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: [2 ** 60], messageText: 'x', code: 1 }] },
    { configIdentity: 'c1', watchedFiles: [null] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: [null], messageText: 'x', code: 1 }] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: [-1], messageText: 'x', code: 1 }] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: [{}], messageText: 'x', code: 1 }] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: 'a', messageText: 'x', code: 1 }] },
    { configIdentity: 'c1', optionDiagnostics: [{ path: ['a'], messageText: 1, code: 1 }] },
    { configIdentity: 5 },
    { watchedFiles: 'x' },
    [],
    null,
    { $error: 'the mapper could not open the project' },
  ]) {
    cases.push(mapped(verbatim(content), content, { mapper: dynamic, openProject }));
    cases.push(mapped(verbatim(content), content, { openProject }));
  }
  // initialize.
  for (const initialize of [
    initialized('utf-16'),
    { positionEncoding: true, diagnosticSource: 'vue' },
    { positionEncoding: 'utf-8', diagnosticSource: 5 },
    { diagnosticSource: [1], positionEncoding: {} },
    'text',
    5,
    true,
    [],
    null,
    { positionEncoding: null, diagnosticSource: null },
    { positionEncoding: 'utf-32', diagnosticSource: 'x' },
    { positionEncoding: 'UTF-8', diagnosticSource: 'x' },
    { positionEncoding: 'utf-8', diagnosticSource: 'x', extra: [1] },
    { $error: 'the mapper does not start' },
    ...[
      '',
      ' ',
      '\t\n',
      '\u0085\u00a0\u3000',
      '\ufeff',
      'ts',
      'TS',
      'd.ts',
      'D.Ts',
      'json',
      'mjs',
      'typescript',
      'TypeScript',
      'tsc',
      'TSC',
      '.ts',
      'vue',
    ].map((diagnosticSource) => ({ positionEncoding: 'utf-8', diagnosticSource })),
  ])
    cases.push(mapped(verbatim(content), content, { initialize }));
  // transform: the shape of the response.
  for (const transform of [
    { $error: 'the mapper failed to transform the file' },
    null,
    {},
    [],
    'text',
    { text: 1, extension: '.ts' },
    { text: null, extension: '.ts' },
    { text: 'x', extension: 1 },
    { text: 'x' },
    { text: 'x', extension: '.coffee' },
    { text: 'x', extension: '.TS' },
    { text: 'x', extension: '.d.ts' },
    ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.json'].map((extension) => ({
      text: '{}',
      extension,
    })),
    { text: 'x', extension: '.ts', unknown: 1, Text: 'y' },
    { text: 'x', extension: '.ts', supplemental: {} },
    { text: 'x', extension: '.ts', supplemental: [1] },
    { text: 'x', extension: '.ts', supplemental: [null] },
    {
      text: 'x',
      extension: '.ts',
      supplemental: [
        { text: 'y', extension: '.mts' },
        { text: 'z', extension: '.json' },
        { text: 'w', extension: '.tsx' },
      ],
    },
    { text: 'x', extension: '.ts', supplemental: [{ text: 'y', extension: '.ts' }, { text: 'z' }] },
    { text: 'x', extension: '.coffee', supplemental: [{ text: 1 }] },
    { text: 'x', extension: '.ts', diagnostics: {} },
    { text: 'x', extension: '.ts', diagnostics: [1] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 1 }] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: 1.5 }] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', code: 2 ** 31 }] },
    { text: 'x', extension: '.ts', diagnostics: [{}] },
    {
      text: 'x',
      extension: '.ts',
      diagnostics: [
        { messageText: 'whole', start: 0, length: 12, code: 1 },
        { messageText: 'end', start: 12, code: -2 },
      ],
    },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: -1, length: 1 }] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: 1, length: -1 }] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: 13 }] },
    { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: 12, length: 1 }] },
    { text: 'x', extension: '.ts', diagnosticDirectives: [] },
    { text: 'x', extension: '.ts', diagnosticDirectives: null },
    { text: 'x', extension: '.ts', diagnosticDirectives: {} },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0, 0, 0, 0]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0, 256]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0, -1]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0, '0']] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[0, 0, 0, 0, 0.5]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [[null, null, null, null, null]] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [null] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { directives: [{}] } },
    { text: 'x', extension: '.ts', diagnosticDirectives: { unusedExpectDirectiveDiagnostics: [1], directives: [] } },
    {
      text: 'x',
      extension: '.ts',
      diagnosticDirectives: { unusedExpectDirectiveDiagnostics: [{ code: 'x' }], directives: [] },
    },
  ])
    cases.push(mapped(transform, content));
  // transform: diagnostic directives.
  for (const diagnosticDirectives of [
    directives([[0, 5, 0, 5, 1]], { code: 2578, messageText: 'Unused directive.' }),
    directives([[0, 5, 0, 5, 1, 1]], { code: 1, messageText: 'first' }, { code: 2, messageText: 'second' }),
    directives([[0, 5, 0, 5, 1, null]], { code: 1, messageText: 'only' }),
    directives([[-1, 0, 0, 0, 0]], {}),
    directives([[99, 0, 0, 0, 0]]),
    directives([[2 ** 60, 0, 0, 0, 0]]),
    directives([[0, 99, 0, 0, 0]]),
    directives([[0, -1, 0, 0, 0]]),
    directives([[0, 0, -1, 0, 0]]),
    directives([[0, 0, 3, 2, 0]]),
    directives([[0, 0, 0, 0, 2]]),
    directives([[0, 0, 0, 0, 255]]),
    directives([[0, 0, 0, 0, 1]]),
    directives([[0, 0, 0, 0, 1]], {}, {}),
    directives([[0, 0, 0, 0, 1, 1]], {}),
    directives([[0, 0, 0, 0, 1, -1]], {}),
    directives([[99, 0, 0, 0, 1]], {}),
    directives([[0, 99, 0, 0, 1]], {}),
    directives([[-1, 0, 0, 0, 1]], {}),
    directives([[0, 0, 99, 99, 0]]),
    directives([[0, 0, 0, 99, 0]]),
    directives(
      [
        [0, 0, 0, 2, 0],
        [0, 0, 1, 3, 0],
      ],
      {},
    ),
    directives([
      [0, 0, 4, 6, 0],
      [0, 0, 0, 2, 0],
      [0, 0, 2, 4, 0],
    ]),
    directives([
      [0, 0, 4, 6, 0],
      [0, 0, 3, 3, 0],
      [0, 0, 3, 5, 0],
    ]),
    directives([
      [0, 0, 2, 2, 0],
      [0, 0, 2, 2, 0],
    ]),
    directives([
      [0, 0, 2, 4, 0],
      [0, 0, 2, 2, 0],
    ]),
    directives(
      [
        [0, 0, 0, 2, 1, 2],
        [0, 0, 0, 0, 2],
      ],
      {},
    ),
  ]) {
    cases.push(mapped({ ...verbatim(content), diagnosticDirectives }, content));
    cases.push(
      mapped(
        {
          ...verbatim(content),
          supplemental: [
            { text: 'a', extension: '.ts' },
            { ...verbatim(content), diagnosticDirectives },
          ],
        },
        content,
      ),
    );
  }
  // transform: position mappings.
  for (const mappings of [
    undefined,
    null,
    [],
    [[0, 12, 0, 12, 0]],
    [[0, 12, 0, 12, 0, 0]],
    [
      [6, 1, 6, 1, 0, 8],
      [0, 5, 0, 5, 0, 1],
    ],
    [
      [0, 5, 0, 5, 1],
      [6, 1, 0, 12, 2, 3],
    ],
    [
      [0, 5, 0, 5, 0],
      [3, 2, 0, 0, 1],
    ],
    [[0, 5, 1, 5, 0]],
    [[0, 5, 0, 4, 0]],
    [[0, 5, 0, 5, 3]],
    [[0, 5, 0, 5, -1]],
    [[0, 5, 0, 5, 1, 1 << 20]],
    [[0, 5, 0, 5, 1, -1]],
    [[0, 13, 0, 5, 1]],
    [[13, 0, 0, 5, 1]],
    [[0, 5, 0, 13, 1]],
    [[0, 5, 13, 0, 1]],
    [[-1, 5, 0, 5, 1]],
    [[0, -1, 0, 5, 1]],
    [[0, 5, -1, 5, 1]],
    [[0, 5, 0, -1, 1]],
    [[0, 5, 0, 5]],
    [[0, 5, 0, 5, 0, 0, 0]],
    [[0, 5, 0, 5, '0']],
    [[0, 5, 0, 5.5, 0]],
    [null],
    {},
    'mappings',
    [[0, 2 ** 31, 0, 5, 0]],
  ]) {
    cases.push(mapped({ text: content, extension: '.ts', mappings }, content));
    cases.push(
      mapped(
        { text: 'export {};', extension: '.ts', supplemental: [{ text: content, extension: '.mts', mappings }] },
        content,
      ),
    );
  }
  // Positions in both encodings, in texts with characters of one to four UTF-8 bytes.
  const unicode = 'aé€😀b';
  for (const encoding of ['utf-8', 'utf-16']) {
    const length = encoding === 'utf-8' ? 11 : 6;
    for (let position = 0; position <= length + 1; position++) {
      const initialize = initialized(encoding);
      cases.push(
        mapped({ text: unicode, extension: '.ts', mappings: [[0, position, 0, position, 0]] }, unicode, { initialize }),
        mapped({ text: 'x', extension: '.ts', mappings: [[0, 0, position, 0, 1]] }, unicode, { initialize }),
        mapped({ text: unicode, extension: '.ts', mappings: [[position, 0, 0, 0, 1]] }, 'x', { initialize }),
        mapped(
          { text: 'x', extension: '.ts', diagnostics: [{ messageText: 'm', start: position, length: 1 }] },
          unicode,
          { initialize },
        ),
        mapped(
          { text: unicode, extension: '.ts', diagnosticDirectives: directives([[position, 0, position, position, 0]]) },
          unicode,
          { initialize },
        ),
        mapped(
          { text: unicode, extension: '.ts', diagnosticDirectives: directives([[position, 1, 0, position, 1]], {}) },
          unicode,
          { initialize },
        ),
      );
    }
  }
  return cases;
}

/** The mapper of a case, which gives the responses the case has; `$error` in a response fails the request. */
function cannedMapper(item) {
  const openProject = 'openProject' in item ? item.openProject : {};
  const responses = { initialize: item.initialize, openProject, transform: item.transform };
  return {
    handleRequest(method) {
      const response = responses[method];
      if (typeof response?.$error === 'string') throw new Error(response.$error);
      return response;
    },
  };
}

test('tsgo makes the same of a mapper and of its responses', { skip }, () => {
  const cases = oracleCases();
  const expected = runOracle(oracle, out, cases);
  const answers = cases.map((item) => answer(item, () => cannedMapper(item)));
  const outcomes = assertSameAnswers(cases, answers, expected);
  // The cases reach a failure at every stage and of every cause, and results that parse.
  assert.equal(outcomes.size, 12, Array.from(outcomes).join('\n'));
  assert.ok(expected.filter((item) => item.parse?.files !== undefined).length > 100);
});
