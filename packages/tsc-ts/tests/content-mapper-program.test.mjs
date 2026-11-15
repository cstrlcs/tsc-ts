// Programs with content mapped files that the command line does not reach: `Program.updateFile` on a mapped
// file, which transforms it again through the new host, as tsgo's ReuseProgram does. The updated program must
// be the program a new load makes of the same files, and the cases that tsgo loads again must return none.
// The mapper is an object of this process behind the host of content-mapper-host.mjs: the lines of a file that
// start with `//+ ` are the texts of its supplemental outputs, which are `.mts` files where they end with
// `// mts`, a line `//! fail` fails the transform, and the whole file is the canonical output, an `.mts` file
// with a line `//! mts`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInProcessHost } from './content-mapper-host.mjs';
import { compileSources, tempDir } from './temp.mjs';

const root = resolve(import.meta.dirname, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');

const out = compileSources('tsc-ts-content-mapper-program-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const mapperModule = await load('compiler/content-mapper.js');
const protocol = await load('compiler/content-mapper-protocol.js');
const { parseJson } = await load('compiler/package-json.js');
const { createNodeSystem } = await load('drivers/node-system.js');
const { SystemFileSystem } = await load('compiler/tsc-cli.js');
const { CachedFileSystem } = await load('compiler/file-system.js');
const { ConfigParser } = await load('compiler/tsconfig.js');
const { CompilerHost } = await load('compiler/file-loader.js');
const { Program } = await load('compiler/program.js');
const { CheckedProgram } = await load('compiler/program-checker.js');
const { ContentMapperProjectSpec } = mapperModule;
// `Locale.Default`, a const enum member.
const defaultLocale = 0;

const supplementalPrefix = '//+ ';

/** The mapper: see the head of this file. Positions are UTF-8 offsets; the files here are ASCII. */
const mapper = {
  handleRequest(method, params) {
    if (method === 'initialize') return { positionEncoding: 'utf-8', diagnosticSource: 'test' };
    if (method !== 'transform') return method === 'openProject' ? {} : null;
    const lines = params.content.split('\n');
    if (lines.includes('//! fail')) throw new Error('the mapper failed');
    const supplemental = lines
      .filter((line) => line.startsWith(supplementalPrefix))
      .map((line) => ({
        text: line.slice(supplementalPrefix.length),
        extension: line.endsWith('// mts') ? '.mts' : '.ts',
      }));
    const length = params.content.length;
    const extension = lines.includes('//! mts') ? '.mts' : '.ts';
    return { text: params.content, extension, mappings: [[0, length, 0, length, 0]], supplemental };
  },
};

/** A project in a new directory whose `.vue` files the mapper transforms. */
function project(files) {
  const dir = tempDir('tsc-ts-content-mapper-program-project-');
  const all = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        lib: ['es2022'],
        types: [],
      },
      contentMappers: [{ package: 'mapper', extensions: ['.vue'] }],
    }),
    'node_modules/mapper/package.json': JSON.stringify({
      name: 'mapper',
      version: '1.0.0',
      typescript: { contentMapper: { exec: ['in-process'] } },
    }),
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const sys = createNodeSystem(bundledLibs, '');
  const errors = [];
  const config = new ConfigParser(
    new CachedFileSystem(new SystemFileSystem(sys)),
    sys.currentDirectory,
  ).parseConfigFile(join(dir, 'tsconfig.json'), { runExternalCode: true }, undefined, errors);
  assert.deepEqual(errors, []);
  const mappers = createInProcessHost({ ...mapperModule, ...protocol, parseJson }, () => mapper).project(
    new ContentMapperProjectSpec(config.configName, config.contentMappers, config.options),
  );
  /** A host that reads the files as they are now. */
  const host = () =>
    new CompilerHost(
      new CachedFileSystem(new SystemFileSystem(sys)),
      sys.currentDirectory,
      sys.defaultLibraryPath,
      mappers,
    );
  return {
    write: (name, text) => writeFileSync(join(dir, name), text),
    load: () => new Program(config, host()),
    update: (program, name) => program.updateFile(program.toPath(join(dir, name)), host()),
    file: (program, name) => program.getSourceFile(join(dir, name)),
  };
}

/** The files of a program and every diagnostic of it, as text. */
function describe(program) {
  const diagnostic = (d) =>
    `${d.file?.fileName ?? ''}:${d.pos}-${d.end}:${d.source}${d.code}:${d.localize(defaultLocale)}`;
  const lines = [program.explainFiles(defaultLocale)];
  for (const file of program.getSourceFiles()) {
    if (file.fileName.includes('/libs/')) continue;
    lines.push(`file ${file.fileName} ${file.virtualFileName()} ${file.contentMapper()} ${JSON.stringify(file.text)}`);
    lines.push(`  original ${JSON.stringify(file.originalText())} of ${file.originalFileName()}`);
    for (const supplemental of file.supplementalSourceFiles()) lines.push(`  supplemental ${supplemental.fileName}`);
  }
  for (const d of program.getSyntacticDiagnostics()) lines.push('syntactic ' + diagnostic(d));
  for (const d of program.getProgramDiagnostics()) lines.push('program ' + diagnostic(d));
  for (const d of new CheckedProgram(program).getSemanticDiagnostics(undefined))
    lines.push('semantic ' + diagnostic(d));
  return lines.join('\n');
}

const main = 'import { value } from "./a.vue";\nexport const main: string = value;\n';

test('a mapped file that changes is transformed again and replaced with its supplemental files', () => {
  const p = project({ 'main.ts': main, 'a.vue': 'export const value = 1;\n//+ const extra: number = "x";\n' });
  const before = p.load();
  assert.match(describe(before), /semantic .*main\.ts:\d+-\d+:2322:/);
  assert.match(describe(before), /semantic .*a\.vue\.0\.ts:\d+-\d+:2322:/);

  p.write('a.vue', 'export const value = "one";\n//+ const extra: number = 2;\n');
  const updated = p.update(before, 'a.vue');
  assert.ok(updated !== undefined);
  const expected = describe(p.load());
  assert.equal(describe(updated), expected);
  assert.doesNotMatch(expected, /semantic/);
  assert.match(expected, /supplemental .*a\.vue\.0\.ts/);
  // The other files are those of the program before.
  assert.equal(p.file(updated, 'main.ts'), p.file(before, 'main.ts'));
  assert.notEqual(p.file(updated, 'a.vue'), p.file(before, 'a.vue'));
  assert.notEqual(p.file(updated, 'a.vue.0.ts'), p.file(before, 'a.vue.0.ts'));
  assert.equal(p.file(updated, 'a.vue.0.ts'), p.file(updated, 'a.vue').supplementalSourceFiles()[0]);
  assert.equal(p.file(updated, 'a.vue.0.ts').canonicalSourceFile(), p.file(updated, 'a.vue'));
  // The program before is as it was.
  assert.match(describe(before), /semantic .*a\.vue\.0\.ts:\d+-\d+:2322:/);
});

test('a mapped file whose transform no longer fits the program is not replaced', () => {
  const start = 'export const value = 1;\n//+ export const extra = 1;\n';
  for (const [change, next] of [
    ['another supplemental file', start + '//+ export const more = 2;\n'],
    ['no supplemental file', 'export const value = 1;\n'],
    ['a supplemental file at another path', 'export const value = 1;\n//+ export const extra = 1; // mts\n'],
    ['a supplemental file that is no module', 'export const value = 1;\n//+ const extra = 1;\n'],
    ['a failed transform', start + '//! fail\n'],
    ['a canonical file that is a module by its extension', start + '//! mts\n'],
    ['another import', 'import "./b.vue";\n' + start],
  ]) {
    const p = project({ 'main.ts': main, 'a.vue': start, 'b.vue': 'export {};\n' });
    const before = p.load();
    p.write('a.vue', next);
    // Not `assert.equal`, which would print a whole program.
    assert.ok(p.update(before, 'a.vue') === undefined, change);
  }
});

test('a supplemental file that imports another module is not replaced', () => {
  const p = project({
    'main.ts': main,
    'a.vue': 'export const value = 1;\n//+ import {} from "./b.vue";\n',
    'b.vue': '',
  });
  const before = p.load();
  p.write('a.vue', 'export const value = 1;\n//+ import {} from "./main";\n');
  assert.ok(p.update(before, 'a.vue') === undefined);
  // With the same import it is.
  p.write('a.vue', 'export const value = 2;\n//+ import {} from "./b.vue";\n');
  const updated = p.update(before, 'a.vue');
  assert.ok(updated !== undefined);
  assert.equal(describe(updated), describe(p.load()));
});

test('the empty file of a failed transform is replaced when the transform succeeds', () => {
  const p = project({ 'main.ts': 'export {};\n', 'a.vue': '//! fail\n' });
  const before = p.load();
  assert.match(describe(before), /syntactic .*a\.vue:0-0:18069:/);
  assert.ok(p.file(before, 'a.vue').isContentMapperFailureStub());
  // The empty file is a script, and so is the file that replaces it.
  p.write('a.vue', 'const value: number = "x";\n');
  const updated = p.update(before, 'a.vue');
  assert.ok(updated !== undefined);
  assert.equal(describe(updated), describe(p.load()));
  assert.match(describe(updated), /semantic .*a\.vue:\d+-\d+:2322:/);
  assert.ok(!p.file(updated, 'a.vue').isContentMapperFailureStub());
});
