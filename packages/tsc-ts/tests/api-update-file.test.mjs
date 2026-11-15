// Program.updateFile answers the program a new createProgramFromConfigFile gives for the new text: the same files,
// texts, diagnostics, and symbols and types at every node. tsc --api has no such method (it updates a snapshot), so
// tsc-ts is compared with itself: the updated program with a program created from the files as updated on disk.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { tempDir } from './temp.mjs';
import { typescriptLib as bundledLib } from './toolchain.mjs';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist/tsc-ts/src');
const typescriptLib = bundledLib !== undefined && existsSync(bundledLib) ? realpathSync(bundledLib) : '';
const skip =
  (typescriptLib === '' && 'needs the scriptc toolchain') ||
  (!existsSync(join(dist, 'library/index.js')) && 'run npm run build');

const api = skip ? {} : await import(pathToFileURL(join(dist, 'library/index.js')).href);

/** A symbol name without the symbol id that names of unique symbols end with (`__@iterator@10`). */
const withoutSymbolId = (name) => (name.startsWith('__@') ? name.replace(/@\d+$/, '') : name);

function hostFor(dir) {
  return {
    getCurrentDirectory: () => dir,
    useCaseSensitiveFileNames: () => true,
    getDefaultLibraryDirectory: () => typescriptLib,
  };
}

/** A copy of the library fixture, and its program. */
function open() {
  const dir = realpathSync(tempDir('tsc-ts-api-update-'));
  cpSync(join(root, 'tests/fixtures/library'), dir, { recursive: true });
  const config = join(dir, 'tsconfig.json');
  return { dir, config, program: api.createProgramFromConfigFile(config, hostFor(dir)) };
}

/**
 * What a program answers: its files and their texts, its diagnostics of every kind, and the symbol and type at
 * every node of the files in `dir`.
 */
function answers(program, dir) {
  const checker = program.getTypeChecker();
  const result = { files: program.getSourceFileNames(), texts: [], diagnostics: {}, nodes: [] };
  for (const kind of ['ConfigFileParsing', 'Program', 'Global', 'Syntactic', 'Bind', 'Semantic', 'Suggestion'])
    result.diagnostics[kind] = program[`get${kind}Diagnostics`]();
  for (const file of program.getSourceFiles()) {
    if (!file.fileName.startsWith(dir)) continue;
    result.texts.push(file.text);
    result.diagnostics[file.fileName] = program.getSemanticDiagnostics(file);
    api.walkPreorder(file, (node) => {
      if (node === file) return;
      const symbol = checker.getSymbolAtLocation(node);
      const type = checker.getTypeAtLocation(node);
      result.nodes.push(
        `${file.fileName}:${node.kind}:${node.pos}-${node.end} ` +
          `${symbol === undefined ? '-' : withoutSymbolId(api.symbolName(symbol))} ` +
          `${type === undefined ? '-' : checker.typeToString(type)}`,
      );
    });
  }
  return result;
}

/** The program `updated` must equal: a new one of `config`, with `text` written to `fileName`. */
function fromScratch(dir, config, fileName, text) {
  writeFileSync(fileName, text);
  return api.createProgramFromConfigFile(config, hostFor(dir));
}

test('a body-only edit gives the program of the new text', { skip, timeout: 300_000 }, () => {
  const { dir, config, program } = open();
  const fileName = join(dir, 'src/main.ts');
  const text = readFileSync(fileName, 'utf8');
  const before = answers(program, dir);
  // A new semantic error, a new declaration and a syntax error, with the file's imports as they were.
  const edited = text + "export const added: number = 'text';\nexport function twice(x: number) { return x * 2; }\n";
  const updated = program.updateFile(fileName, edited);
  assert.ok(updated !== undefined);
  assert.equal(updated.getSourceFile(fileName).text, edited);
  // Every other file is the first program's.
  for (const file of program.getSourceFiles())
    assert.equal(updated.getSourceFile(file.fileName) === file, file.fileName !== fileName, file.fileName);
  const expected = answers(fromScratch(dir, config, fileName, edited), dir);
  assert.deepEqual(answers(updated, dir), expected);
  assert.ok(expected.diagnostics[fileName].some((d) => d.code === 2322));
  assert.ok(expected.nodes.length > before.nodes.length);
  // The first program stays as it was.
  assert.equal(program.getSourceFile(fileName).text, text);
  assert.deepEqual(answers(program, dir), before);

  // A second update keeps the first one's text, and a file updated twice has its last text.
  const typesName = join(dir, 'src/types.ts');
  const typesText = readFileSync(typesName, 'utf8') + 'export type Added = { added: true };\n';
  const second = updated.updateFile(typesName, typesText);
  assert.ok(second !== undefined);
  assert.equal(second.getSourceFile(fileName).text, edited);
  assert.deepEqual(answers(second, dir), answers(fromScratch(dir, config, typesName, typesText), dir));
  const third = second.updateFile(fileName, text);
  assert.ok(third !== undefined);
  assert.equal(third.getSourceFile(typesName).text, typesText);
  assert.deepEqual(answers(third, dir), answers(fromScratch(dir, config, fileName, text), dir));
});

test('an edit to a file that other files import gives the program of the new text', { skip, timeout: 300_000 }, () => {
  const { dir, config, program } = open();
  const fileName = join(dir, 'src/types.ts');
  const mainName = join(dir, 'src/main.ts');
  const text = readFileSync(fileName, 'utf8');
  const before = answers(program, dir);
  // main.ts subtracts the x of two points: the importing file gets errors where it had none, and other types.
  const edited = text.replace('readonly x: number;', 'readonly x: string;');
  assert.notEqual(edited, text);
  const updated = program.updateFile(fileName, edited);
  assert.ok(updated !== undefined);
  assert.ok(updated.getSourceFile(mainName) === program.getSourceFile(mainName));
  const expected = answers(fromScratch(dir, config, fileName, edited), dir);
  assert.deepEqual(answers(updated, dir), expected);
  assert.notDeepEqual(expected.diagnostics[mainName], before.diagnostics[mainName]);
  assert.notDeepEqual(
    expected.nodes.filter((line) => line.startsWith(mainName)),
    before.nodes.filter((line) => line.startsWith(mainName)),
  );
  assert.deepEqual(answers(program, dir), before);
  // Each program is disposed of on its own: the updated one answers after the first is gone.
  program.dispose();
  assert.deepEqual(answers(updated, dir), expected);
  updated.dispose();
});

test('an edit that changes what a file imports answers undefined', { skip, timeout: 300_000 }, () => {
  const { dir, program } = open();
  const fileName = join(dir, 'src/main.ts');
  const text = readFileSync(fileName, 'utf8');
  const before = answers(program, dir);
  writeFileSync(join(dir, 'src/extra.ts'), 'export const extra = 1;\n');
  assert.ok(program.updateFile(fileName, "import { extra } from './extra.js';\n" + text + 'extra;\n') === undefined);
  // So does an edit that drops an import, and a file not in the program.
  assert.ok(program.updateFile(fileName, text.replace(/^import .*\n/m, '')) === undefined);
  assert.ok(program.updateFile(join(dir, 'src/extra.ts'), 'export const extra = 2;\n') === undefined);
  assert.deepEqual(answers(program, dir), before);
});

test('an edit to a package.json answers undefined', { skip, timeout: 300_000 }, () => {
  // The package.json of a program file's directory gives the file its module format, and here it is a program file
  // too: its text can be replaced as any JSON file's can, but the program must be created again.
  const dir = realpathSync(tempDir('tsc-ts-api-update-'));
  mkdirSync(join(dir, 'src'));
  const options = { strict: true, module: 'nodenext', types: [], noEmit: true, resolveJsonModule: true };
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: options, include: ['src'] }));
  const packageJson = join(dir, 'src/package.json');
  const dataJson = join(dir, 'src/data.json');
  writeFileSync(packageJson, '{ "type": "module" }\n');
  writeFileSync(dataJson, '{ "value": 1 }\n');
  writeFileSync(
    join(dir, 'src/main.ts'),
    "import manifest from './package.json' with { type: 'json' };\n" +
      "import data from './data.json' with { type: 'json' };\n" +
      'export const type: string = manifest.type;\nexport const value: string = data.value;\n',
  );
  const config = join(dir, 'tsconfig.json');
  const program = api.createProgramFromConfigFile(config, hostFor(dir));
  assert.ok(program.getSourceFile(packageJson) !== undefined);
  assert.ok(program.updateFile(packageJson, '{ "type": "commonjs" }\n') === undefined);
  // Another JSON file of the program is updated.
  const edited = '{ "value": "one" }\n';
  const updated = program.updateFile(dataJson, edited);
  assert.ok(updated !== undefined);
  assert.deepEqual(answers(updated, dir), answers(fromScratch(dir, config, dataJson, edited), dir));
});

test('updateFile on a disposed program throws DisposedProgramError', { skip }, () => {
  const { dir, program } = open();
  const fileName = join(dir, 'src/main.ts');
  program.dispose();
  assert.throws(() => program.updateFile(fileName, ''), api.DisposedProgramError);
});

test('the file system of an updated program holds the last text of each replaced file', { skip }, async () => {
  const { HostFileSystem, ReplacedFileSystem } = await import(pathToFileURL(join(dist, 'library/host.js')).href);
  const disk = new HostFileSystem({
    ...hostFor('/'),
    readFile: (path) => (path === '/a.ts' || path === '/b.ts' ? 'disk' : null),
    fileExists: (path) => path === '/a.ts' || path === '/b.ts',
  });
  const once = new ReplacedFileSystem(disk, '/a.ts', 'a1');
  const twice = new ReplacedFileSystem(new ReplacedFileSystem(once, '/c.ts', 'c1'), '/a.ts', 'a2');
  assert.deepEqual(
    ['/a.ts', '/b.ts', '/c.ts', '/d.ts'].map((path) => [twice.readFile(path), twice.fileExists(path)]),
    [
      ['a2', true],
      ['disk', true],
      ['c1', true],
      [undefined, false],
    ],
  );
  // A file system that replaces a file of another one leaves the other as it was.
  assert.deepEqual(
    [once.readFile('/a.ts'), once.readFile('/c.ts'), once.fileExists('/c.ts')],
    ['a1', undefined, false],
  );
});
