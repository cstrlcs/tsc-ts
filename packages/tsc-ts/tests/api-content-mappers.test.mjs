// The content mappers a host of tsc-ts/api runs itself (ProgramHost.contentMappers). TypeScript 7's API has no such
// member: it runs the mappers a config file names as processes. So tsc-ts is compared with itself: a program whose
// host runs a mapper answers as the program that runs the same mapper as a process (content-mapper-server.mjs)
// through the compiler's process host, for the members of its source files, its diagnostics and the symbol and
// type at every node, and an updated program answers as one created from the new text.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { writeMapperLaunchers } from './content-mapper-server.mjs';
import { hostMapper, libraryFileMembers } from './library-mappers.mjs';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/tsc-ts/src');
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const skip =
  (typescriptLib === '' && 'needs the scriptc toolchain') ||
  (!existsSync(join(dist, 'library/index.js')) && 'run npm run build') ||
  (process.platform === 'win32' && 'tsc-ts starts no content mapper processes on Windows');

const load = async (path) => import(pathToFileURL(join(dist, path)).href);
const api = skip ? {} : await load('library/index.js');
const spanMap = skip ? {} : await load('compiler/span-map.js');

function hostFor(dir, contentMappers) {
  return {
    getCurrentDirectory: () => dir,
    useCaseSensitiveFileNames: () => true,
    getDefaultLibraryDirectory: () => typescriptLib,
    contentMappers,
  };
}

const compilerOptions = {
  target: 'es2022',
  module: 'esnext',
  moduleResolution: 'bundler',
  strict: true,
  noEmit: true,
  types: [],
};

/**
 * A project in a new directory: `tsconfig.json`, which names the mapper `command` for `.box` files as a package,
 * and `tsconfig.host.json`, the same config without the mapper, for a host that runs it.
 */
function project(command, files, configFiles) {
  const dir = realpathSync(tempDir('tsc-ts-api-content-mappers-'));
  const config = { compilerOptions, ...(configFiles === undefined ? { include: ['src'] } : { files: configFiles }) };
  const all = {
    'tsconfig.host.json': JSON.stringify(config),
    'tsconfig.json': JSON.stringify({ ...config, contentMappers: [{ package: 'box-mapper', extensions: ['.box'] }] }),
    'node_modules/box-mapper/package.json': JSON.stringify({
      name: 'box-mapper',
      version: '1.0.0',
      typescript: { contentMapper: { exec: [command] } },
    }),
    ...files,
  };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

/** The mapper `command` as a mapper of a host, named as the process's package is. */
const boxMapper = (command, diagnosticSource) =>
  hostMapper(spanMap, command, 'box-mapper', diagnosticSource, ['.box'], { strict: true });

/**
 * The program of `tsconfig.json` in `dir` with its mapper run as a process, as the command line loads it with
 * `--runExternalCode`, behind the members of a program of tsc-ts/api that `answers` reads: the files of the
 * library's compiler host, and the library's diagnostics and checker.
 */
async function processProgram(dir) {
  const { ConfigParser } = await load('compiler/tsconfig.js');
  const { CachedFileSystem } = await load('compiler/file-system.js');
  const { FileLoader } = await load('compiler/file-loader.js');
  const { Program } = await load('compiler/program.js');
  const { CheckedProgram } = await load('compiler/program-checker.js');
  const { ContentMapperProjectSpec } = await load('compiler/content-mapper.js');
  const { ContentMapperProcessHost } = await load('compiler/content-mapper-process-host.js');
  const { createNodeSystem } = await load('drivers/node-system.js');
  const { HostFileSystem, LibraryCompilerHost } = await load('library/host.js');
  const { diagnosticOf, programDiagnostics } = await load('library/diagnostics.js');
  const { LibraryTypeChecker } = await load('library/checker.js');

  const fs = new CachedFileSystem(new HostFileSystem(hostFor(dir)));
  const errors = [];
  const config = new ConfigParser(fs, dir).parseConfigFile(
    join(dir, 'tsconfig.json'),
    { runExternalCode: true },
    undefined,
    errors,
  );
  const mappers = new ContentMapperProcessHost(createNodeSystem(typescriptLib, ''), '');
  const host = new LibraryCompilerHost(
    fs,
    dir,
    typescriptLib,
    undefined,
    mappers.project(new ContentMapperProjectSpec(config.configName, config.contentMappers, config.options)),
  );
  const program = new Program(config, host, new FileLoader(host, config, true));
  host.closeContentMappers();
  mappers.close();
  const checked = new CheckedProgram(program);
  const diagnostics = (kind) => (file) => programDiagnostics(checked, kind, file).map(diagnosticOf);
  return {
    getSourceFileNames: () => program.getSourceFiles().map((file) => file.fileName),
    getSourceFiles: () => program.getSourceFiles(),
    getSourceFile: (fileName) => program.getSourceFile(fileName),
    getConfigFileParsingDiagnostics: diagnostics('config'),
    getProgramDiagnostics: diagnostics('program'),
    getGlobalDiagnostics: diagnostics('global'),
    getSyntacticDiagnostics: diagnostics('syntactic'),
    getBindDiagnostics: diagnostics('bind'),
    getSemanticDiagnostics: diagnostics('semantic'),
    getSuggestionDiagnostics: diagnostics('suggestion'),
    getTypeChecker: () => new LibraryTypeChecker(checked.createChecker()),
  };
}

/**
 * What a program answers: its files and the members of those in `dir`, its diagnostics of every kind, and the
 * symbol and type at every node of the files in `dir`.
 */
function answers(program, dir) {
  const checker = program.getTypeChecker();
  const result = { files: program.getSourceFileNames(), members: {}, diagnostics: {}, nodes: [] };
  for (const kind of ['ConfigFileParsing', 'Program', 'Global', 'Syntactic', 'Bind', 'Semantic', 'Suggestion'])
    result.diagnostics[kind] = program[`get${kind}Diagnostics`]();
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(dir)) continue;
    result.members[file.fileName] = JSON.parse(JSON.stringify(libraryFileMembers(file)));
    result.diagnostics[file.fileName] = [program.getSyntacticDiagnostics(file), program.getSemanticDiagnostics(file)];
    api.walkPreorder(file, (node) => {
      if (node === file) return;
      const symbol = checker.getSymbolAtLocation(node);
      result.nodes.push(
        `${file.fileName}:${node.kind}:${node.pos}-${node.end} ` +
          `${symbol === undefined ? '-' : symbol.escapedName} ${checker.typeToString(checker.getTypeAtLocation(node))}`,
      );
    });
  }
  return result;
}

/** The codes of a program's diagnostics of one kind, each with the prefix of its source. */
const codes = (diagnostics) => diagnostics.map((d) => `${d.source ?? 'TS'}${d.code}`);

const launchers = skip
  ? ''
  : writeMapperLaunchers(tempDir('tsc-ts-api-content-mapper-launchers-'), join(dist, 'compiler/span-map.js'));
// The process host finds the command of a mapper on PATH.
if (!skip) process.env.PATH = `${launchers}:${process.env.PATH}`;

const box = [
  'export const strict = #{strict};',
  "export const greeting: string = 'hello';",
  '// @box-ignore',
  "const ignored: number = 'ignored';",
  '// @box-expect-error: Unused box directive.',
  'const fine = 1;',
  'const mismatch: string = strict;',
  'export const version: number = __VERSION;',
  'export const open = #{unclosed',
  '',
].join('\n');

test('a root file a host mapper transforms is the file of the mapper process', { skip, timeout: 300_000 }, async () => {
  const dir = project('compiler-test-mapper', { 'src/app.box': box }, ['src/app.box']);
  const host = hostFor(dir, [boxMapper('compiler-test-mapper', 'box')]);
  const program = api.createProgramFromConfigFile(join(dir, 'tsconfig.host.json'), host);
  const expected = answers(await processProgram(dir), dir);
  assert.deepEqual(answers(program, dir), expected);

  const fileName = join(dir, 'src/app.box');
  const members = expected.members[fileName];
  assert.equal(members.originalText, box);
  assert.ok(members.text.startsWith('const __VERSION = "1.0.0";\nexport const strict = true;\n'));
  assert.equal(members.contentMapper, 'box-mapper@1.0.0');
  assert.equal(members.virtualFileName, fileName + '.ts');
  assert.equal(members.spanMap.length, 5);
  assert.equal(members.diagnosticDirectives.length, 2);
  assert.deepEqual(codes(expected.diagnostics.Syntactic), ['box1000']);
  assert.deepEqual(codes(expected.diagnostics.Semantic), ['box2578', 'TS2322', 'TS2322']);
  // The type at a position of the virtual text that an atom of the original text maps to.
  assert.ok(expected.nodes.some((line) => line.endsWith(' strict true')));

  // The same program from root names and options, and from the config file's own answer.
  const parsed = api.parseConfigFile(join(dir, 'tsconfig.host.json'), host);
  assert.deepEqual(parsed.fileNames, [fileName]);
  const fromOptions = api.createProgram({ rootNames: ['src/app.box'], options: parsed.options, host });
  assert.deepEqual(answers(fromOptions, dir), expected);
  // Without the mapper the file has an extension the compiler does not read.
  const plain = api.createProgram({ rootNames: ['src/app.box'], options: parsed.options, host: hostFor(dir) });
  assert.deepEqual(codes(plain.getProgramDiagnostics()), ['TS6054']);
});

test('an import of a mapped file resolves to it under bundler resolution', { skip, timeout: 300_000 }, async () => {
  const main = [
    "import { greeting, strict } from './app.box';",
    'export const length: number = greeting.length;',
    'export const wrong: string = strict;',
    '',
  ].join('\n');
  // The mapped file is in the program only through the import.
  const dir = project('compiler-test-mapper', { 'src/main.ts': main, 'src/app.box': box }, ['src/main.ts']);
  const program = api.createProgramFromConfigFile(
    join(dir, 'tsconfig.host.json'),
    hostFor(dir, [boxMapper('compiler-test-mapper', 'box')]),
  );
  const expected = answers(await processProgram(dir), dir);
  assert.deepEqual(answers(program, dir), expected);
  assert.deepEqual(
    expected.files.filter((name) => name.startsWith(dir)),
    [join(dir, 'src/app.box'), join(dir, 'src/main.ts')],
  );
  assert.deepEqual(codes(expected.diagnostics[join(dir, 'src/main.ts')][1]), ['TS2322']);
  assert.ok(
    expected.nodes.some((line) => line.startsWith(join(dir, 'src/main.ts')) && line.endsWith(' greeting string')),
  );

  // A config file's `include` matches the files with the extensions of the host's mappers.
  const included = project('compiler-test-mapper', { 'src/main.ts': main, 'src/app.box': box });
  const includedHost = hostFor(included, [boxMapper('compiler-test-mapper', 'box')]);
  assert.deepEqual(api.parseConfigFile(join(included, 'tsconfig.host.json'), includedHost).fileNames, [
    join(included, 'src/app.box'),
    join(included, 'src/main.ts'),
  ]);
  assert.deepEqual(
    answers(api.createProgramFromConfigFile(join(included, 'tsconfig.host.json'), includedHost), included),
    answers(await processProgram(included), included),
  );
});

test(
  'a host mapper that throws fails the transform as a mapper process that fails',
  { skip, timeout: 300_000 },
  async () => {
    const files = { 'src/main.ts': "import './app.box';\nexport const one: number = 'one';\n", 'src/app.box': box };
    const dir = project('failing-mapper', files);
    const program = api.createProgramFromConfigFile(
      join(dir, 'tsconfig.host.json'),
      hostFor(dir, [boxMapper('failing-mapper', 'mapper')]),
    );
    const expected = answers(await processProgram(dir), dir);
    assert.deepEqual(answers(program, dir), expected);
    // The file is in the program, empty, with the failure as its syntax error.
    const fileName = join(dir, 'src/app.box');
    assert.deepEqual(expected.members[fileName], {
      text: '',
      originalText: box,
      contentMapper: 'box-mapper@1.0.0',
      virtualFileName: fileName + '.ts',
    });
    const [failure] = expected.diagnostics[fileName][0];
    assert.equal(failure.code, 18069);
    assert.match(
      api.flattenDiagnosticMessageText(failure, '\n'),
      /^The content mapper 'box-mapper' failed to transform this file\.\n  .*failed while handling the transform request\.$/,
    );
    assert.deepEqual(codes(expected.diagnostics.Semantic), ['TS2322']);
  },
);

test(
  'a result of a host mapper is checked as the response of a mapper process',
  { skip, timeout: 300_000 },
  async () => {
    // Diagnostic directives whose virtual ranges overlap, from the mapper both ways.
    const overlap = '// @box-invalid-directive: overlap\nexport const value = 1;\n';
    const dir = project('compiler-test-mapper', { 'src/app.box': overlap });
    const program = api.createProgramFromConfigFile(
      join(dir, 'tsconfig.host.json'),
      hostFor(dir, [boxMapper('compiler-test-mapper', 'box')]),
    );
    const expected = answers(await processProgram(dir), dir);
    assert.deepEqual(answers(program, dir), expected);
    assert.deepEqual(codes(expected.diagnostics.Syntactic), ['TS18069']);

    // Results no mapper of content-mappers.mjs gives, each with the diagnostic of its file: a failed transform
    // (TS18069) with the reason tsgo gives for the response of a process, a span map that does not fit the texts
    // (TS18073), or none. The file of a result that is not valid is empty.
    const invalidResponse = 'The content mapper returned an invalid transform response.';
    const cycle = { text: '', extension: '.ts' };
    cycle.supplemental = [cycle];
    const cases = [
      ['not-an-object.box', 'text', invalidResponse],
      ['mappings.box', { text: 'let a = 1;', extension: '.ts', mappings: 1 }, invalidResponse],
      ['fraction.box', { text: 'let a = 1;', extension: '.ts', mappings: [[0, 1.5, 0, 1, 0]] }, invalidResponse],
      ['past-the-end.box', { text: 'let a = 1;', extension: '.ts', mappings: [[0, 99, 0, 99, 0]] }, invalidResponse],
      [
        'diagnostic.box',
        { text: '', extension: '.ts', diagnostics: [{ messageText: 'm', start: 0, length: 99, code: 1 }] },
        invalidResponse,
      ],
      [
        'extension.box',
        { text: 'export {};', extension: '.vue' },
        "The content mapper returned an output with unsupported virtual extension '.vue'.",
      ],
      [
        'supplemental.box',
        { text: '', extension: '.ts', supplemental: [{ text: '', extension: '.exe' }] },
        "The content mapper returned an output with unsupported virtual extension '.exe'.",
      ],
      // A text JSON cannot hold is no response.
      ['surrogate.box', { text: 'let a = "\ud800";', extension: '.ts' }, invalidResponse],
      // A result that is no JSON value fails as a request does.
      ['cycle.box', cycle, 'The content mapper process failed while handling the transform request.'],
      ['verbatim.box', { text: 'let a = 1;', extension: '.ts', mappings: [[0, 3, 0, 3, 0]] }, 18073],
      ['valid.box', { text: 'export let a: string = 1;', extension: '.ts', mappings: null, diagnostics: null }, 0],
    ];
    const results = new Map(cases.map(([name, result]) => [name, result]));
    // A mapper that fails five times is not asked again, so each program has fewer failures.
    for (let first = 0; first < cases.length; first += 4) {
      const group = cases.slice(first, first + 4);
      const invalid = project(
        'compiler-test-mapper',
        Object.fromEntries(group.map(([name]) => [`src/${name}`, 'original\n'])),
      );
      const checked = api.createProgramFromConfigFile(
        join(invalid, 'tsconfig.host.json'),
        hostFor(invalid, [
          {
            name: 'results',
            diagnosticSource: 'results',
            extensions: ['.box'],
            transform: (fileName) => results.get(fileName.slice(fileName.lastIndexOf('/') + 1)),
          },
        ]),
      );
      for (const [name, , expected] of group) {
        const file = checked.getSourceFile(join(invalid, 'src', name));
        const syntactic = checked.getSyntacticDiagnostics(file);
        assert.equal(file.originalText, 'original\n', name);
        assert.equal(file.contentMapper, 'results', name);
        if (expected === 0) {
          assert.deepEqual(syntactic, [], name);
          assert.equal(file.text, 'export let a: string = 1;');
          // Without mappings the whole text is synthesized: a diagnostic in it stays where it is, with the note.
          const [synthesized] = checked.getSemanticDiagnostics(file);
          assert.deepEqual(
            [synthesized.code, synthesized.pos, synthesized.end, synthesized.messageChain.map((entry) => entry.code)],
            [2322, 11, 12, [18074]],
          );
          continue;
        }
        assert.equal(file.text, '', name);
        assert.equal(file.spanMap, undefined, name);
        assert.equal(syntactic.length, 1, name);
        if (typeof expected === 'number') assert.equal(syntactic[0].code, expected, name);
        else
          assert.equal(
            api.flattenDiagnosticMessageText(syntactic[0], '\n'),
            `The content mapper 'results' failed to transform this file.\n  ${expected}`,
            name,
          );
      }
      assert.deepEqual(codes(checked.getProgramDiagnostics()), []);
    }
  },
);

test('what a host mapper declares is checked as what a mapper process declares', { skip }, () => {
  const dir = project('compiler-test-mapper', { 'src/app.box': 'export const value = 1;\n' }, ['src/app.box']);
  const transform = () => ({ text: 'export const value = 1;', extension: '.ts' });
  const programOf = (mapper) =>
    api.createProgramFromConfigFile(join(dir, 'tsconfig.host.json'), hostFor(dir, [{ transform, ...mapper }]));

  // A diagnostic source that is reserved fails the mapper, as an `initialize` response with it does.
  const reserved = programOf({ name: 'mapper', diagnosticSource: 'ts', extensions: ['.box'] });
  assert.deepEqual(codes(reserved.getProgramDiagnostics()), ['TS18099']);
  assert.equal(reserved.getSourceFile(join(dir, 'src/app.box')).text, '');
  // An extension the compiler reads itself is reported as a config file's is, and the mapper does not get it.
  const builtIn = programOf({ name: 'mapper', diagnosticSource: 'mapper', extensions: ['.ts', '.box'] });
  assert.deepEqual(codes(builtIn.getConfigFileParsingDiagnostics()), ['TS18066']);
  assert.equal(builtIn.getSourceFile(join(dir, 'src/app.box')).contentMapper, 'mapper');
  // A file is one a mapper produced by the mapper's identity.
  assert.throws(() => programOf({ name: '', diagnosticSource: 'mapper', extensions: ['.box'] }), TypeError);

  // The mappers a config file names do not run, as in TypeScript 7's API without `runExternalCode`: the config
  // reports them and has none, so a file with their extension is in the program only as a mapper of the host
  // transforms it.
  const config = join(dir, 'tsconfig.json');
  const unmapped = api.createProgramFromConfigFile(config, hostFor(dir));
  assert.deepEqual(codes(unmapped.getConfigFileParsingDiagnostics()), ['TS18068']);
  assert.equal(unmapped.getSourceFile(join(dir, 'src/app.box')), undefined);
  const mapped = api.createProgramFromConfigFile(
    config,
    hostFor(dir, [{ transform, name: 'mapper', diagnosticSource: 'mapper', extensions: ['.box'] }]),
  );
  assert.deepEqual(codes(mapped.getConfigFileParsingDiagnostics()), ['TS18068']);
  assert.equal(mapped.getSourceFile(join(dir, 'src/app.box')).contentMapper, 'mapper');
});

/**
 * A mapper whose output is the file itself, and whose supplemental outputs are the lines after `//+ `; it counts
 * the files it transforms.
 */
function countingMapper() {
  const mapper = {
    name: 'lines',
    diagnosticSource: 'lines',
    extensions: ['.box'],
    transforms: 0,
    transform(fileName, text) {
      mapper.transforms++;
      const supplemental = text
        .split('\n')
        .filter((line) => line.startsWith('//+ '))
        .map((line) => ({ text: line.slice(4), extension: '.ts' }));
      return { text, extension: '.ts', mappings: [[0, text.length, 0, text.length, 0]], supplemental };
    },
  };
  return mapper;
}

test('updateFile transforms a mapped file again and gives the program of the new text', { skip }, () => {
  const main = "import { value } from './a.box';\nexport const main: string = value;\n";
  const first = 'export const value = 1;\n//+ const extra: number = "x";\n';
  const dir = project('compiler-test-mapper', { 'src/main.ts': main, 'src/a.box': first });
  const config = join(dir, 'tsconfig.host.json');
  const mapper = countingMapper();
  const host = hostFor(dir, [mapper]);
  const fileName = join(dir, 'src/a.box');
  const supplementalName = join(dir, 'src/a.box.0.ts');
  const program = api.createProgramFromConfigFile(config, host);
  const before = answers(program, dir);
  assert.deepEqual(codes(before.diagnostics.Semantic), ['TS2322', 'TS2322']);
  assert.equal(mapper.transforms, 1);

  const next = 'export const value = "one";\n//+ const extra: number = 2;\n';
  const updated = program.updateFile(fileName, next);
  assert.ok(updated !== undefined);
  assert.equal(mapper.transforms, 2);
  assert.equal(updated.getSourceFile(fileName).originalText, next);
  // The mapped file and its supplemental file are new, with their members; every other file is the first program's.
  for (const file of program.getSourceFiles())
    assert.equal(
      updated.getSourceFile(file.fileName) === file,
      file.fileName !== fileName && file.fileName !== supplementalName,
      file.fileName,
    );
  assert.deepEqual(updated.getSourceFile(fileName).supplementalSourceFileNames, [supplementalName]);
  assert.equal(updated.getSourceFile(supplementalName).canonicalSourceFileName, fileName);
  writeFileSync(fileName, next);
  const expected = answers(api.createProgramFromConfigFile(config, host), dir);
  assert.deepEqual(answers(updated, dir), expected);
  assert.deepEqual(codes(expected.diagnostics.Semantic), []);
  // The first program stays as it was.
  assert.deepEqual(answers(program, dir), before);

  // An update of the updated program, and of a file no mapper produced beside a mapped one.
  const again = updated.updateFile(fileName, first);
  assert.ok(again !== undefined);
  assert.deepEqual(answers(again, dir), before);
  const mainName = join(dir, 'src/main.ts');
  const edited = again.updateFile(mainName, main + 'export const more: number = value;\n');
  assert.ok(edited !== undefined);
  assert.equal(edited.getSourceFile(fileName), again.getSourceFile(fileName));
  assert.deepEqual(codes(edited.getSemanticDiagnostics(edited.getSourceFile(mainName))), ['TS2322']);

  // A transform that changes the program's structure answers undefined: the program must be created again.
  for (const [change, text] of [
    ['another supplemental file', first + '//+ const more = 2;\n'],
    ['no supplemental file', 'export const value = 1;\n'],
    ['a supplemental file that is a module', 'export const value = 1;\n//+ export const extra = 1;\n'],
    ['another import', "import './b.box';\n" + first],
  ])
    assert.ok(program.updateFile(fileName, text) === undefined, change);
  // And so does a transform that fails, which the loader of a new program reports.
  const failing = {
    ...mapper,
    transform: (name, text) => (text.includes('fail') ? null.fail : mapper.transform(name, text)),
  };
  const fragile = api.createProgramFromConfigFile(config, hostFor(dir, [failing]));
  assert.ok(fragile.updateFile(fileName, '// fail\n' + next) === undefined);
  assert.ok(fragile.updateFile(fileName, next) !== undefined);
  // A supplemental file has no text of its own to replace.
  assert.ok(program.updateFile(supplementalName, 'const extra = 1;\n') === undefined);
});

test('a program takes the mapped files of an old program that are unchanged', { skip }, () => {
  const main = "import { value } from './a.box';\nimport './b.box';\nexport const main: string = value;\n";
  const files = {
    'src/main.ts': main,
    'src/a.box': 'export const value = 1;\n//+ const extra = 1;\n',
    'src/b.box': '',
  };
  const dir = project('compiler-test-mapper', files);
  const config = join(dir, 'tsconfig.host.json');
  const mapper = countingMapper();
  const host = hostFor(dir, [mapper]);
  const old = api.createProgramFromConfigFile(config, host);
  assert.equal(mapper.transforms, 2);
  const names = ['src/a.box', 'src/a.box.0.ts', 'src/b.box', 'src/main.ts'].map((name) => join(dir, name));

  // Nothing changed: no file is transformed or parsed again.
  const same = api.createProgramFromConfigFile(config, host, old);
  assert.equal(mapper.transforms, 2);
  for (const name of names) assert.equal(same.getSourceFile(name), old.getSourceFile(name), name);
  assert.deepEqual(answers(same, dir), answers(old, dir));

  // A mapped file with another text is transformed again; the other mapped file is the old program's.
  writeFileSync(names[0], 'export const value = "one";\n//+ const extra = 2;\n');
  const next = api.createProgramFromConfigFile(config, host, old);
  assert.equal(mapper.transforms, 3);
  for (const name of names)
    assert.equal(next.getSourceFile(name) === old.getSourceFile(name), !name.includes('/a.box'), name);
  assert.deepEqual(answers(next, dir), answers(api.createProgramFromConfigFile(config, host), dir));
  assert.deepEqual(codes(next.getSemanticDiagnostics()), []);
  assert.deepEqual(codes(old.getSemanticDiagnostics()), ['TS2322']);

  // A mapper with another diagnostic source produced them otherwise: its diagnostics have another prefix.
  const before = mapper.transforms;
  const resourced = api.createProgramFromConfigFile(
    config,
    hostFor(dir, [{ ...mapper, diagnosticSource: 'other' }]),
    next,
  );
  assert.equal(mapper.transforms, before + 2);
  assert.notEqual(resourced.getSourceFile(names[2]), next.getSourceFile(names[2]));
  // A supplemental file whose name is now that of a file on disk fails the transform, as in a new program.
  writeFileSync(names[1], 'export {};\n');
  const collided = api.createProgramFromConfigFile(config, host, next);
  assert.deepEqual(answers(collided, dir), answers(api.createProgramFromConfigFile(config, host), dir));
  assert.deepEqual(codes(collided.getSyntacticDiagnostics(collided.getSourceFile(names[0]))), ['TS18069']);
  assert.equal(collided.getSourceFile(names[1]).canonicalSourceFileName, undefined);
  rmSync(names[1]);

  // A mapper with another identity produced none of the old program's files.
  const renamed = api.createProgramFromConfigFile(config, hostFor(dir, [{ ...mapper, name: 'other' }]), next);
  assert.equal(mapper.transforms, before + 7);
  assert.notEqual(renamed.getSourceFile(names[2]), next.getSourceFile(names[2]));
  assert.equal(renamed.getSourceFile(names[2]).contentMapper, 'other');
  assert.equal(renamed.getSourceFile(names[3]), next.getSourceFile(names[3]));
});
