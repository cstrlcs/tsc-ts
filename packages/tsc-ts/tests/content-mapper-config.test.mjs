// `contentMappers` of a config file (src/compiler/tsconfig.ts): the cases of tsgo's config parsing tests about
// what a parsed config holds, which no command line output shows. The diagnostics are compared with tsgo in
// program.test.mjs (the content-mappers fixtures of program-cases.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-content-mapper-config-', ['compiler/tsconfig.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { ConfigParser, ParsedCommandLine, getContentMapperOptionDiagnosticLocation } =
  await load('compiler/tsconfig.js');
const { FileSystem, DirectoryEntries } = await load('compiler/file-system.js');
const { ContentMapper, ContentMapperDefinition, OptionPathSegment } = await load('compiler/content-mapper.js');
const { rewriteExtension } = await load('compiler/path.js');

const requiresFlag = 18068;
const requiresRewrite = 18120;

/** A file system of files given by absolute name. */
class MemoryFileSystem extends FileSystem {
  constructor(files, useCaseSensitiveFileNames = true) {
    super(useCaseSensitiveFileNames);
    this.files = new Map(Object.entries(files).map(([name, text]) => [this.key(name), text]));
  }

  key(path) {
    return this.useCaseSensitiveFileNames ? path : path.toLowerCase();
  }

  fileExists(path) {
    return this.files.has(this.key(path));
  }

  directoryExists(path) {
    const prefix = this.key(path.endsWith('/') ? path : path + '/');
    for (const name of this.files.keys()) if (name.startsWith(prefix)) return true;
    return false;
  }

  readFile(path) {
    return this.files.get(this.key(path));
  }

  getAccessibleEntries(path) {
    const prefix = this.key(path.endsWith('/') ? path : path + '/');
    const files = new Set();
    const directories = new Set();
    for (const name of this.files.keys()) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) files.add(rest);
      else directories.add(rest.slice(0, slash));
    }
    return new DirectoryEntries([...files].sort(), [...directories].sort(), undefined);
  }

  realpath(path) {
    return path;
  }
}

/** Parses `configFileName` of `files`, with --runExternalCode unless `options` says otherwise. */
function parse(files, configFileName = '/tsconfig.json', options = { runExternalCode: true }, caseSensitive = true) {
  const errors = [];
  const fs = new MemoryFileSystem(files, caseSensitive);
  const parsed = new ConfigParser(fs, '/').parseConfigFile(configFileName, options, undefined, errors);
  assert.deepEqual(errors, []);
  return parsed;
}

const codes = (parsed) => parsed.configFileParsingDiagnostics().map((diagnostic) => diagnostic.code);
const manifest = (name, contentMapper = { exec: ['mapper'] }, version = '1.0.0') =>
  JSON.stringify({ name, version, typescript: { contentMapper } });

/** A command line without a config file whose mappers are given as `[extensions, outputExtensions]`. */
function commandLine(mappers, useCaseSensitiveFileNames = true) {
  const parsed = new ParsedCommandLine({}, undefined, [], [], undefined, [], '/', useCaseSensitiveFileNames, 0);
  parsed.contentMappers = mappers.map(([extensions, outputExtensions]) => {
    const definition = new ContentMapperDefinition();
    definition.extensions = extensions;
    if (outputExtensions !== undefined) definition.outputExtensions = new Map(Object.entries(outputExtensions));
    return new ContentMapper(definition);
  });
  return parsed;
}

test('a mapper has its definition from the config and its manifest from its package', () => {
  const parsed = parse({
    '/tsconfig.json': `{
      "contentMappers": [
        { "package": "vue-mapper", "extensions": [".vue"], "options": { "strictTemplates": true } }
      ],
      "include": ["src"]
    }`,
    '/src/app.ts': 'export {}',
    '/src/Component.vue': '<template></template>',
    '/node_modules/vue-mapper/package.json': manifest(
      'vue-mapper',
      { exec: ['node', './mapper.js'], dynamicConfig: true, compilerOptions: ['target', 'jsx'] },
      '1.2.3',
    ),
  });
  assert.deepEqual(codes(parsed), []);
  assert.equal(parsed.contentMappers.length, 1);
  const [mapper] = parsed.contentMappers;
  assert.equal(mapper.definition.package, 'vue-mapper');
  assert.deepEqual(mapper.definition.extensions, ['.vue']);
  assert.equal(mapper.definition.options, '{"strictTemplates":true}');
  assert.deepEqual(parsed.contentMapperExtensions(), ['.vue']);
  assert.equal(mapper.manifest.name, 'vue-mapper');
  assert.equal(mapper.manifest.version, '1.2.3');
  assert.deepEqual(mapper.manifest.exec, ['node', './mapper.js']);
  assert.deepEqual(mapper.manifest.compilerOptions, ['target', 'jsx']);
  assert.ok(mapper.manifest.dynamicConfig);
  assert.equal(mapper.packageDirectory, '/node_modules/vue-mapper');
  assert.equal(mapper.identity(), 'vue-mapper@1.2.3');
  assert.equal(parsed.getContentMapperForFileName('/src/Component.vue'), mapper);
  assert.equal(parsed.getContentMapperForFileName('/src/app.ts'), undefined);
});

// The expected text is what tsgo sent a mapper process as the `options` of this entry.
test('options are kept as the JSON tsgo writes for them', () => {
  const parsed = parse({
    '/tsconfig.json': `{
      "contentMappers": [{
        "package": "mapper",
        "extensions": [".vue"],
        // Comments, spacing and a trailing comma are not kept; a repeated name keeps its first place.
        "options": {
          "b": [1, -2.5, 1e21, "x\\n\\u00e9<", true, null, {}], "a": null, "b ": {}, "a": [null],
          "c": [-0, 0.000001, 1e-7, 123456789012345680000, 1.0, 5e-324, "\\u2028\\u0007\\u007f\\ud83d\\ude00"],
        },
      }],
      "files": ["/index.ts"]
    }`,
    '/index.ts': 'export {};',
    '/node_modules/mapper/package.json': manifest('mapper'),
  });
  assert.equal(
    parsed.contentMappers[0].definition.options,
    '{"b":[1,-2.5,1e+21,"x\\n\u00e9<",true,{}],"a":[],"b ":{},' +
      '"c":[-0,0.000001,1e-7,123456789012345680000,1,5e-324,"\u2028\\u0007\u007f\ud83d\ude00"]}',
  );
});

test('a package is found in the node_modules above the config file', () => {
  const files = {
    '/home/project/src/tsconfig.json': `{ "contentMappers": [
      { "package": "@scope/noversion", "extensions": [".a"] },
      { "package": "near", "extensions": [".b"] },
      { "package": "missing", "extensions": [".c"] }
    ], "files": ["a.ts"] }`,
    '/home/project/src/a.ts': 'export {};',
    '/home/node_modules/@scope/noversion/package.json': JSON.stringify({
      name: '@scope/noversion',
      typescript: { contentMapper: { exec: ['run'] } },
    }),
    '/home/project/node_modules/near/package.json': manifest('near'),
    '/home/node_modules/near/package.json': manifest('far'),
  };
  const parsed = parse(files, '/home/project/src/tsconfig.json');
  assert.deepEqual(codes(parsed), [18075]);
  const [scoped, near] = parsed.contentMappers;
  assert.equal(parsed.contentMappers.length, 2);
  assert.equal(scoped.packageDirectory, '/home/node_modules/@scope/noversion');
  assert.equal(scoped.manifest.version, '');
  assert.equal(scoped.identity(), '@scope/noversion');
  assert.equal(near.packageDirectory, '/home/project/node_modules/near');
  assert.equal(near.manifest.name, 'near');
  assert.deepEqual(parsed.contentMapperExtensions(), ['.a', '.b']);
});

test('without --runExternalCode a config has no mappers', () => {
  const files = {
    '/tsconfig.json': '{ "contentMappers": [{ "package": "vue-mapper", "extensions": [".vue"] }] }',
    '/app.ts': 'export {}',
    '/node_modules/vue-mapper/package.json': manifest('vue-mapper'),
  };
  for (const options of [{}, { runExternalCode: false }, { rewriteRelativeImportExtensions: true }]) {
    const parsed = parse(files, '/tsconfig.json', options);
    assert.deepEqual(codes(parsed), [requiresFlag]);
    assert.deepEqual(parsed.contentMappers, []);
    assert.deepEqual(parsed.contentMapperExtensions(), []);
    assert.deepEqual(parsed.contentMapperExtensionRewrites(), []);
    assert.equal(parsed.getContentMapperForFileName('/Component.vue'), undefined);
  }
  assert.deepEqual(codes(parse(files)), []);
});

test('the outputExtensions of an entry replace those of the manifest, null and {} included', () => {
  for (const [override, rewrite, outputExtensions] of [
    ['', true, { '.astro': '.js' }],
    [', "outputExtensions": null', false, undefined],
    [', "outputExtensions": {}', false, {}],
    [', "outputExtensions": {".astro": ".mjs"}', true, { '.astro': '.mjs' }],
  ]) {
    const parsed = parse({
      '/tsconfig.json': `{
        "compilerOptions": {
          "declaration": true, "rootDir": "/src", "outDir": "/dist",
          "rewriteRelativeImportExtensions": ${rewrite}
        },
        "contentMappers": [{ "package": "mapper", "extensions": [".astro"]${override} }],
        "files": ["/src/Card.ts"]
      }`,
      '/src/Card.ts': 'export {};',
      '/node_modules/mapper/package.json': manifest('mapper', {
        exec: ['mapper'],
        outputExtensions: { '.astro': '.js' },
      }),
    });
    assert.deepEqual(codes(parsed), [], override);
    assert.equal(parsed.contentMappers.length, 1);
    const [mapper] = parsed.contentMappers;
    const actual = mapper.definition.outputExtensions;
    assert.deepEqual(actual === undefined ? undefined : Object.fromEntries(actual), outputExtensions, override);
    assert.equal(parsed.contentMapperExtensionRewrites().length > 0, rewrite, override);
    // The definition has a copy of the manifest's extensions.
    mapper.manifest.defaultOutputExtensions.set('.astro', '.cjs');
    assert.deepEqual(actual === undefined ? undefined : Object.fromEntries(actual), outputExtensions, override);
  }
});

test('an output extension that differs needs rewriteRelativeImportExtensions, in the letter case of the file system', () => {
  const files = {
    '/tsconfig.json': `{
      "contentMappers": [{ "package": "mapper", "extensions": [".vue", ".Astro"], "outputExtensions": { ".vue": ".VUE", ".astro": ".js" } }],
      "files": ["/a.ts"]
    }`,
    '/a.ts': 'export {};',
    '/node_modules/mapper/package.json': manifest('mapper'),
  };
  // `.astro` is not `.Astro` where case matters, so it is no extension of the mapper, and `.VUE` is not `.vue`.
  assert.deepEqual(codes(parse(files)), [18119, requiresRewrite]);
  const insensitive = parse(files, '/tsconfig.json', { runExternalCode: true }, false);
  assert.deepEqual(codes(insensitive), [requiresRewrite]);
  assert.deepEqual(
    insensitive.contentMapperExtensionRewrites().map((rewrite) => [rewrite.source, rewrite.target]),
    [
      ['.Astro', '.js'],
      ['.vue', '.vue'],
    ],
  );
});

test('a diagnostic about options is located by its path in the entry', () => {
  const files = {
    '/tsconfig.json': `{
      "contentMappers": [{
        "package": "mapper",
        "extensions": [".vue"],
        "options": { "plugins": [{ "name": 1 }] }
      }, { "package": "mapper", "extensions": [".astro"] }]
    }`,
    '/index.ts': 'export {};',
    '/node_modules/mapper/package.json': manifest('mapper'),
  };
  const parsed = parse(files);
  const [mapper, bare] = parsed.contentMappers;
  const property = (name) => new OptionPathSegment(name, 0, false);
  const index = (value) => new OptionPathSegment('', value, true);
  const text = (config, target, path) => {
    const location = getContentMapperOptionDiagnosticLocation(config, target, path);
    return location?.file.text.slice(location.pos, location.end);
  };
  assert.equal(text(parsed, mapper, [property('plugins'), index(0), property('name')]), '1');
  assert.equal(text(parsed, mapper, [property('plugins'), index(0)]), '{ "name": 1 }');
  assert.equal(text(parsed, mapper, []), '{ "plugins": [{ "name": 1 }] }');
  // A path is followed as far as it leads.
  assert.equal(text(parsed, mapper, [property('plugins'), index(3), property('name')]), '[{ "name": 1 }]');
  assert.equal(text(parsed, mapper, [property('plugins'), property('name')]), '[{ "name": 1 }]');
  assert.equal(text(parsed, mapper, [index(0)]), '{ "plugins": [{ "name": 1 }] }');
  // Without options the entry stands for them, and the list for a mapper that is not the config's.
  assert.equal(text(parsed, bare, [property('plugins')]), '{ "package": "mapper", "extensions": [".astro"] }');
  assert.match(text(parsed, new ContentMapper(new ContentMapperDefinition()), []), /^\[\{[^]*\}\]$/);
  // No location without a config file, or in a config that inherits its mappers.
  assert.equal(text(commandLine([[['.vue']]]), mapper, []), undefined);
  const inherited = parse(
    { ...files, '/sub/tsconfig.json': '{ "extends": "../tsconfig.json" }' },
    '/sub/tsconfig.json',
  );
  assert.equal(inherited.contentMappers.length, 2);
  assert.equal(text(inherited, inherited.contentMappers[0], []), undefined);
});

test('mappers are inherited from the last extended config that has contentMappers', () => {
  const files = {
    '/project/tsconfig.json': '{ "extends": "./base.json" }',
    '/project/base.json':
      '{ "contentMappers": [{ "package": "vue-mapper", "extensions": [".vue"] }], "include": ["src"] }',
    '/project/other.json': '{ "contentMappers": [{ "package": "vue-mapper", "extensions": [".astro"] }] }',
    '/project/none.json': '{ "contentMappers": [] }',
    '/project/both/tsconfig.json': '{ "extends": ["../base.json", "../other.json"] }',
    '/project/own/tsconfig.json':
      '{ "extends": "../base.json", "contentMappers": [{ "package": "vue-mapper", "extensions": [".svelte"] }] }',
    '/project/emptied/tsconfig.json': '{ "extends": ["../base.json", "../none.json"] }',
    '/project/src/index.ts': 'export {};',
    '/project/node_modules/vue-mapper/package.json': manifest('vue-mapper', { exec: ['node', './mapper.js'] }),
  };
  for (const [configFileName, extensions] of [
    ['/project/tsconfig.json', ['.vue']],
    ['/project/both/tsconfig.json', ['.astro']],
    ['/project/own/tsconfig.json', ['.svelte']],
    ['/project/emptied/tsconfig.json', []],
  ]) {
    const parsed = parse(files, configFileName);
    assert.deepEqual(codes(parsed), [], configFileName);
    assert.deepEqual(parsed.contentMapperExtensions(), extensions, configFileName);
    for (const mapper of parsed.contentMappers) {
      assert.equal(mapper.definition.package, 'vue-mapper');
      assert.equal(mapper.packageDirectory, '/project/node_modules/vue-mapper');
    }
  }
  // An inherited list is reported without a place in the config that inherits it.
  const [diagnostic] = parse(files, '/project/tsconfig.json', {}).configFileParsingDiagnostics();
  assert.equal(diagnostic.code, requiresFlag);
  assert.equal(diagnostic.file, undefined);
});

test('the longest registered extension of a file name chooses the mapper of a config', () => {
  const parsed = commandLine([[['.z']], [['.y.z']]]);
  const [z, yz] = parsed.contentMappers;
  assert.equal(parsed.getContentMapperForFileName('/src/Component.y.z'), yz);
  assert.equal(parsed.getContentMapperForFileName('/src/Component.z'), z);
  assert.equal(commandLine([[['.vue']]], true).getContentMapperForFileName('/src/Component.VUE'), undefined);
  const insensitive = commandLine([[['.vue']]], false);
  assert.equal(insensitive.getContentMapperForFileName('/src/Component.VUE'), insensitive.contentMappers[0]);
});

test('extension rewrites keep the longest extension, and are computed once', () => {
  const parsed = commandLine([
    [
      ['.z', '.y.z', '.identity.y.z', '.unmapped.y.z'],
      { '.z': '.js', '.y.z': '.mjs', '.identity.y.z': '.identity.y.z' },
    ],
  ]);
  const rewrites = parsed.contentMapperExtensionRewrites();
  assert.deepEqual(
    rewrites.map((rewrite) => [rewrite.source, rewrite.target]),
    [
      ['.identity.y.z', '.identity.y.z'],
      ['.unmapped.y.z', '.unmapped.y.z'],
      ['.y.z', '.mjs'],
      ['.z', '.js'],
    ],
  );
  for (const file of ['./Widget.identity.y.z', './Widget.unmapped.y.z'])
    assert.equal(rewriteExtension(file, rewrites, true), undefined);
  assert.equal(rewriteExtension('./Widget.y.z', rewrites, true), './Widget.mjs');
  assert.equal(parsed.contentMapperExtensionRewrites(), rewrites);
  // Mappers that keep every extension have no rewrites.
  assert.deepEqual(commandLine([[['.vue'], { '.vue': '.vue' }], [['.astro']]]).contentMapperExtensionRewrites(), []);
  assert.deepEqual(commandLine([[['.vue'], { '.VUE': '.Vue' }]], false).contentMapperExtensionRewrites(), []);
  // Of extensions as long in bytes the first stays first, though it is shorter in UTF-16.
  assert.deepEqual(
    commandLine([[['.a\u00e9', '.bbb', '.cc'], { '.bbb': '.js' }]])
      .contentMapperExtensionRewrites()
      .map((rewrite) => rewrite.source),
    ['.a\u00e9', '.bbb', '.cc'],
  );
});
