// Checks that binding is the last write to a program, apart from symbol ids and TypeScript files'
// JSDoc, which are assigned and parsed on first use, and that a program prepared for sharing between
// threads (`Program.prepareForSharing`, used by `--checkers`) is not written at all: deep-freezes
// every object reachable from the prepared program and its bound source files (nodes, symbols, symbol
// tables, flow nodes, diagnostics, the program's caches), then checks the program, emits
// JavaScript, declarations and source maps, and explains its files (`--explainFiles`). Writes to frozen objects throw in strict mode, and Map and
// Set mutators are replaced by throwing ones. The diagnostics and outputs must match those of an
// unfrozen run. As with checker threads, a first checker merges the globals and module augmentations
// before the program is frozen with them (`Program.mergedGlobals`); the checker that checks starts
// from them, and the first checker reports the same diagnostics afterwards. The indexes of the emit
// resolvers are built before freezing too (`Program.emitIndexes`), as the main thread builds them.
// Projects: tsc-ts itself, and test cases from TypeScript's compiler and conformance suites.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeMapperLaunchers } from './content-mapper-server.mjs';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const cases = join(root, 'upstream/TypeScript/tsc/testdata/tests/cases');

const out = compileSources('tsc-ts-immutability-', ['main.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { createNodeSystem } = await load('drivers/node-system.js');
const { executeCommandLine } = await load('compiler/tsc-cli.js');
const { bindProgram, CheckedProgram } = await load('compiler/program-checker.js');
const { NodeVisitor } = await load('compiler/ast.js');
const { getJSDoc, parseSourceFile } = await load('compiler/parser.js');
const { useThreadTextCaches } = await load('compiler/diagnostics.js');
const { Symbol, getSymbolId } = await load('compiler/symbol.js');
const { CompileTimes, EmitIndexes, OutputWriter, PlainProgram, getDiagnosticsOfProgram } =
  await load('compiler/compile-program.js');
const { shareMergedGlobals } = await load('compiler/checker-symbols.js');
// `Locale.Default`, a const enum member.
const defaultLocale = 0;

function rejectWrite(name) {
  return () => {
    throw new TypeError(`${name} on a frozen program`);
  };
}

/** Every object reachable from `roots`. */
function reachable(roots) {
  const seen = new Set();
  const stack = [...roots];
  const push = (v) => {
    if (v !== null && typeof v === 'object' && !ArrayBuffer.isView(v) && !seen.has(v)) stack.push(v);
  };
  while (stack.length > 0) {
    const o = stack.pop();
    if (seen.has(o)) continue;
    seen.add(o);
    if (o instanceof Map)
      for (const [k, v] of o) {
        push(k);
        push(v);
      }
    else if (o instanceof Set) for (const v of o) push(v);
    else for (const key of Object.keys(o)) push(o[key]);
  }
  return seen;
}

/**
 * Freezes every object reachable from the program and its source files; returns how many. Symbol ids
 * and the JSDoc comments of TypeScript files, which are created on first use, are created first (a
 * shared program assigns symbol ids at creation, and its threads keep lazily parsed JSDoc in tables).
 */
function deepFreeze(program, files) {
  for (const file of files) {
    const nodes = [file];
    while (nodes.length > 0) {
      const node = nodes.pop();
      getJSDoc(file, node);
      node.forEachChild(collector(nodes));
    }
  }
  const objects = reachable([program, ...files]);
  for (const o of objects) if (o instanceof Symbol) getSymbolId(o);
  for (const o of objects) {
    if (o instanceof Map) {
      o.set = rejectWrite('Map.set');
      o.delete = rejectWrite('Map.delete');
      o.clear = rejectWrite('Map.clear');
    } else if (o instanceof Set) {
      o.add = rejectWrite('Set.add');
      o.delete = rejectWrite('Set.delete');
      o.clear = rejectWrite('Set.clear');
    }
    Object.freeze(o);
  }
  return objects.size;
}

/** A visitor that pushes each child onto `nodes`. */
function collector(nodes) {
  const visitor = new NodeVisitor();
  visitor.visitNode = (node) => {
    nodes.push(node);
    return false;
  };
  return visitor;
}

class RecordingWriter extends OutputWriter {
  outputs = [];

  write(fileName, text, declarationDiagnostics) {
    this.outputs.push(fileName + '\n' + text + format(declarationDiagnostics).join('\n'));
    return '';
  }
}

function format(diagnostics) {
  return diagnostics.map((d) => {
    // Line and column, as reporters print them, from the file's line starts.
    const starts = d.file?.getLineStarts() ?? [0];
    let line = 0;
    while (line + 1 < starts.length && starts[line + 1] <= d.pos) line++;
    const at = `${line + 1}:${d.pos - starts[line] + 1}`;
    const related = d.relatedInformation.map((r) => `${r.file?.fileName ?? ''}(${r.pos}) TS${r.code}`).join(' ');
    return `${d.file?.fileName ?? ''}(${d.pos},${d.end}) ${at} TS${d.code}: ${d.localize(defaultLocale)} [${related}]`;
  });
}

/** Diagnostics and emitted files of the project of `args`, optionally frozen after binding. */
function compile(args, freeze) {
  const sys = createNodeSystem(bundledLibs, '');
  const work = executeCommandLine(sys, args);
  assert.equal(work.kind, 'compile');
  const program = work.program;
  bindProgram(program);
  let merging = undefined;
  if (freeze) {
    program.prepareForSharing();
    merging = new CheckedProgram(program);
    program.mergedGlobals = shareMergedGlobals(merging.checker);
    program.emitIndexes = new EmitIndexes(program);
  }
  const frozen = freeze ? deepFreeze(program, program.getSourceFiles()) : 0;
  const compiled = new PlainProgram(new CheckedProgram(program), new CompileTimes());
  // Semantic and declaration diagnostics of every file, even after syntax errors.
  const diagnosticsOf = (compiled) =>
    format([
      ...getDiagnosticsOfProgram(compiled, true),
      ...compiled.getSemanticDiagnostics(),
      ...compiled.getDeclarationDiagnostics(),
    ]);
  const diagnostics = diagnosticsOf(compiled);
  const writer = new RecordingWriter();
  const emitted = compiled.emit(writer);
  // The line counts of `--extendedDiagnostics`.
  const lines = program.getSourceFiles().map((file) => `${file.fileName} ${file.lineStarts().length}`);
  // `--explainFiles` is reported after checking, from the program as checker threads share it.
  const explained = program.explainFiles(defaultLocale);
  const mergingDiagnostics =
    merging === undefined ? diagnostics : diagnosticsOf(new PlainProgram(merging, new CompileTimes()));
  return {
    frozen,
    diagnostics,
    mergingDiagnostics,
    outputs: writer.outputs,
    emitDiagnostics: format(emitted.diagnostics),
    lines,
    explained,
  };
}

function assertImmutable(args, minimumFrozen = 100000) {
  const frozen = compile(args, true);
  assert.ok(frozen.frozen > minimumFrozen, `froze only ${frozen.frozen} objects`);
  assert.ok(frozen.outputs.length > 0);
  const plain = compile(args, false);
  assert.deepEqual(frozen.diagnostics, plain.diagnostics);
  assert.deepEqual(frozen.mergingDiagnostics, plain.diagnostics);
  assert.deepEqual(frozen.emitDiagnostics, plain.emitDiagnostics);
  assert.deepEqual(frozen.outputs, plain.outputs);
  assert.deepEqual(frozen.lines, plain.lines);
  assert.equal(frozen.explained, plain.explained);
  return plain;
}

const emitOptions = (dir) => ['--noEmit', 'false', '--outDir', dir, '--declaration', '--declarationMap', '--sourceMap'];

// The parser leaves the line starts and UTF-8 offsets of files to first use; once files may be
// shared (`useThreadTextCaches`), a thread computes them in a copy of its own.
test('a shared file gets its line starts and UTF-8 offsets without being written', () => {
  const text = "declare const a: '\u00e9';\r\n/** \u{1f600} */\rdeclare const b: string;\u2028export {};\n";
  const plain = parseSourceFile('/p/plain.d.ts', text).diagnosticFile();
  const shared = parseSourceFile('/p/shared.d.ts', text);
  const file = shared.diagnosticFile();
  const source = parseSourceFile('/p/source.ts', text);
  const units = source.diagnosticFile();
  Object.freeze(source);
  Object.freeze(units);
  Object.freeze(shared);
  Object.freeze(file);
  useThreadTextCaches();
  assert.deepEqual(units.getLineStarts(), plain.getLineStarts());
  for (let pos = 0; pos <= text.length; pos++) assert.equal(units.toUtf8Offset(pos), plain.toUtf8Offset(pos));
  for (let pos = 0; pos <= Buffer.byteLength(text, 'utf8'); pos++)
    assert.equal(units.fromUtf8Offset(pos), plain.fromUtf8Offset(pos));
  assert.deepEqual(file.getLineStarts(), [0, 23, 33, 58, 69]);
  assert.deepEqual(file.getLineStarts(), plain.getLineStarts());
  for (let pos = 0; pos <= text.length; pos++) assert.equal(file.toUtf8Offset(pos), plain.toUtf8Offset(pos));
  for (let pos = 0; pos <= Buffer.byteLength(text, 'utf8'); pos++)
    assert.equal(file.fromUtf8Offset(pos), plain.fromUtf8Offset(pos));
  assert.equal(file.toUtf8Offset(text.length), Buffer.byteLength(text, 'utf8'));
});

test('checking and emitting tsc-ts never writes to its bound, prepared program', () => {
  assertImmutable(['-p', resolve(here, '..'), ...emitOptions(tempDir('tsc-ts-immutability-out-'))]);
});

// Declaration emit writes module specifiers for inferred types, which probes files and `package.json`
// scopes that loading the program never looked at; JSON modules and the config file are source files
// too, whose line starts reporters and line counts read.
test('declaration emit, JSON files and their line starts never write to a bound, prepared program', () => {
  const dir = tempDir('tsc-ts-immutability-specifiers-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        declaration: true,
        resolveJsonModule: true,
        module: 'nodenext',
        moduleResolution: 'nodenext',
        types: [],
        // A config diagnostic.
        notAnOption: true,
      },
      include: ['src'],
    }),
    'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0' }),
    'src/box.ts':
      'export interface Box {\n  value: number;\n}\nexport function box(value: number): Box {\n  return { value };\n}\n',
    'src/nested/deep.ts': 'import { box } from "../box";\nexport const boxed = () => box(1);\n',
    // `Widget` is named `./widgets` (index stripped), unless a file like `src/widgets.js` exists.
    'src/widgets/index.ts': 'export interface Widget {\n  id: number;\n}\n',
    'src/widgets/make.ts': 'import type { Widget } from "./index";\nexport const make = (): Widget => ({ id: 1 });\n',
    'src/main.ts': [
      'import { boxed } from "./nested/deep";',
      'import { make } from "./widgets/make";',
      'export const widget = make();',
      'import { thing } from "dep";',
      'import * as data from "./data.json";',
      'export const made = boxed();',
      'export const named = thing();',
      'export const count = data.count;',
      '',
    ].join('\n'),
    'src/data.json': '{\n  "count": 1\n}\n',
    'node_modules/dep/package.json': JSON.stringify({
      name: 'dep',
      version: '1.0.0',
      types: 'lib/index.d.ts',
    }),
    'node_modules/dep/lib/index.d.ts':
      'import type { Thing } from "./thing";\nexport declare function thing(): Thing;\n',
    'node_modules/dep/lib/thing.d.ts': 'export interface Thing {\n  name: string;\n}\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  assertImmutable(['-p', dir, ...emitOptions(join(dir, 'out'))], 1000);
});

// Merging globals and module augmentations reports diagnostics, which checkers starting from the
// merged globals add at the same points; a member bound late from a computed name merges into a
// copy of a shared merged symbol.
test('checkers starting from merged globals report the merge diagnostics and never write the shared symbols', () => {
  const dir = tempDir('tsc-ts-immutability-merges-');
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        target: 'es2022',
        types: [],
      },
      include: ['src'],
    }),
    'src/globals1.ts': [
      'interface Shared { a: string }',
      'declare let dup: number;',
      'declare var undefined: string;',
      'namespace NS { export const x = 1; }',
      'declare namespace UmdLib { const w: number }',
      '',
    ].join('\n'),
    'src/globals2.ts': [
      'interface Shared { a: string; b: number }',
      'declare let dup: string;',
      'namespace NS { export const y = 2; }',
      'var globalThis: number;',
      "declare const aKey: 'a';",
      'interface Shared { [aKey]: string }',
      '',
    ].join('\n'),
    'src/mod.ts': "export interface Opts { a: string }\nexport * from './inner';\n",
    'src/inner.ts': 'export interface Inner { a: string }\n',
    'src/aug.ts': [
      "import './mod';",
      "declare module './mod' {",
      '  interface Opts { b: number }',
      '  interface Inner { c: number }',
      '}',
      "declare module './missing' { const z: number }",
      "declare module 'pat-foo' { export const extra: string }",
      'declare global { interface Shared { c: boolean } let dup: boolean; }',
      'export {};',
      '',
    ].join('\n'),
    'src/patterns.d.ts': "declare module 'pat-*' { const v: number; export default v; }\n",
    'src/umd.d.ts': 'export as namespace UmdLib;\nexport declare const u: number;\n',
    'src/use.ts': [
      "import { type Opts, type Inner } from './mod';",
      "import v, { extra } from 'pat-foo';",
      "const s: Shared = { a: '', b: 1, c: true };",
      "const o: Opts = { a: '', b: 1 };",
      "const i: Inner = { a: '', c: 1 };",
      'export const all = [s, o, i, NS.x, NS.y, v, extra, UmdLib.u, UmdLib.w, dup];',
      '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const plain = assertImmutable(['-p', dir, ...emitOptions(join(dir, 'out'))], 800);
  const codes = plain.diagnostics.map((d) => d.match(/ TS(\d+):/)[1]);
  // Redeclared `dup`, `undefined` and `globalThis`, and the augmentation of a missing module.
  for (const code of ['2451', '2397', '2664']) assert.ok(codes.includes(code), `no TS${code}`);
});

// How `rewriteRelativeImportExtensions` rewrites import paths, which emit and the checker ask, and where the
// outputs of a referenced project lie, which the checker asks of a path into it, are computed before the program
// is shared: here nothing else computes them first, since no declarations are emitted and the referenced project
// has no output directory.
test('import path rewrites never write to a bound, prepared program', () => {
  const dir = tempDir('tsc-ts-immutability-rewrites-');
  const files = {
    'lib/tsconfig.json': JSON.stringify({ compilerOptions: { composite: true, types: [] }, files: ['index.ts'] }),
    'lib/index.ts': 'export const lib = 1;\n',
    'lib/index.d.ts': 'export declare const lib = 1;\n',
    'app/tsconfig.json': JSON.stringify({
      compilerOptions: {
        strict: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        rewriteRelativeImportExtensions: true,
        outDir: 'out',
        types: [],
      },
      files: ['main.ts'],
      references: [{ path: '../lib' }],
    }),
    'app/main.ts':
      'import { lib } from "../lib/index.ts";\nimport { other } from "./other.ts";\nexport const all = [lib, other];\n',
    'app/other.ts': 'export const other = 2;\n',
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const plain = assertImmutable(['-p', join(dir, 'app')], 500);
  // The path into the referenced project, whose outputs lie beside its sources and not below `out`.
  assert.match(plain.diagnostics.join('\n'), /main\.ts\(\d+,\d+\) \d+:\d+ TS2878: /);
  assert.match(plain.outputs.join('\n'), /from "\.\/other\.js"/);
});

// A file a content mapper produced keeps its original text and its span map, by which its diagnostics are
// shown, and may come with supplemental virtual files; the mappers that ran are closed and gone from the
// program's host once it is loaded. The mappers are those of TypeScript's test cases, as processes.
test('content mapped files and their diagnostics never write to a bound, prepared program', () => {
  const dir = tempDir('tsc-ts-immutability-mapped-');
  const mapper = (name, exec) =>
    JSON.stringify({ name, version: '1.0.0', typescript: { contentMapper: { exec: [exec] } } });
  const files = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { strict: true, noUnusedLocals: true, module: 'esnext', moduleResolution: 'bundler', types: [] },
      contentMappers: [
        { package: 'box', extensions: ['.box'] },
        { package: 'lisp', extensions: ['.lisp'] },
        { package: 'supplemental', extensions: ['.astro'] },
      ],
    }),
    'node_modules/box/package.json': mapper('box', 'compiler-test-mapper'),
    'node_modules/lisp/package.json': mapper('lisp', 'lisp-mapper'),
    'node_modules/supplemental/package.json': mapper('supplemental', 'supplemental-diagnostics-mapper'),
    'widget.box': [
      'export const label: string = 1;',
      'export const strict = #{strict};',
      '// @box-ignore',
      'export const ignored: string = 2;',
      '// @box-expect-error: Unused directive.',
      'export const fine = 3;',
      'export const open = #{strict',
      '',
    ].join('\n'),
    'expression.lisp': '(+ 1 2 "oops")\n',
    'component.astro': 'const value: number = "a";\n',
    'main.ts': [
      'import { label, strict } from "./widget.box";',
      'import "./expression.lisp";',
      'import "./component.astro";',
      'export const upper: number = label;',
      'export const flag: string = strict;',
      '',
    ].join('\n'),
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  const path = process.env.PATH;
  process.env.PATH = `${writeMapperLaunchers(tempDir('tsc-ts-immutability-mappers-'), join(out, 'compiler/span-map.js'))}${delimiter}${path}`;
  let plain;
  try {
    plain = assertImmutable(['-p', dir, '--runExternalCode', ...emitOptions(join(dir, 'out'))], 800);
  } finally {
    process.env.PATH = path;
  }
  const reported = plain.diagnostics.join('\n');
  // The mapper's own diagnostic, the compiler's in mapped and in synthesized text, one of an alias, the unused
  // directive, and none where a directive ignores it.
  assert.match(reported, /widget\.box\(\d+,\d+\) \d+:\d+ TS1000: Unclosed interpolation\./);
  assert.match(reported, /widget\.box\(\d+,\d+\) \d+:\d+ TS2322: Type 'number' is not assignable to type 'string'\./);
  assert.match(reported, /widget\.box\(\d+,\d+\) \d+:\d+ TS2578: Unused directive\./);
  assert.equal(reported.match(/widget\.box\(\d+,\d+\) \d+:\d+ TS2322/g).length, 1);
  assert.match(reported, /expression\.lisp\(\d+,\d+\) \d+:\d+ TS2304: Cannot find name '\+'\./);
  assert.match(
    reported,
    /component\.astro\.0\.ts\(\d+,\d+\) \d+:\d+ TS2304: Cannot find name 'missingSupplementalGlobal'\./,
  );
  assert.match(
    plain.explained,
    /Supplemental virtual file produced by the content mapper for file '[^']*component\.astro'/,
  );
});

/** Every `step`th single-file test case of `suite`, written as one project. */
function sampleProject(suite, step, offset) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  walk(join(cases, suite));
  const dir = tempDir('tsc-ts-immutability-cases-');
  let count = 0;
  for (let i = offset; i < files.length; i += step) {
    const text = readFileSync(files[i], 'utf8');
    if (/^\s*\/\/\s*@(filename|nolib|lib|types|module|jsx)\b/im.test(text)) continue;
    // Each case is a module of its own, so that their declarations don't collide.
    writeFileSync(join(dir, `case${count++}${files[i].endsWith('x') ? '.tsx' : '.ts'}`), text + '\nexport {};\n');
  }
  return { dir, count };
}

for (const [suite, options] of [
  ['compiler', ['--target', 'es2015', '--jsx', 'react', '--experimentalDecorators', '--emitDecoratorMetadata']],
  ['conformance', ['--target', 'es2016', '--module', 'commonjs', '--esModuleInterop', '--downlevelIteration']],
]) {
  test(`checking and emitting ${suite} test cases never writes to their bound, prepared program`, () => {
    const { dir, count } = sampleProject(suite, 12, 0);
    assert.ok(count > 300);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [] } }));
    assertImmutable(['-p', dir, ...options, ...emitOptions(join(dir, 'out'))]);
  });
}
