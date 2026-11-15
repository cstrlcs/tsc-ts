import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestMapperSpawner, transformingMapper } from './content-mappers.mjs';
import { tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist/tsc-ts/src');
const skip = !existsSync(dist) && 'run npm run build';
const load = (path) => import(pathToFileURL(resolve(dist, path)).href);
// tsgo's encoder (npm run build:oracle), which also encodes what a content mapper's response is parsed into.
const oracle = resolve(here, '../../tsgo/dist/encode-oracle');

const source = `
/** A shape. */
export type Shape = { kind: "circle"; radius: number } | readonly [x: number, y?: string, ...rest: boolean[]];
export declare function area<T extends Shape>(shape: T, ...scale: number[]): \`size-\${number}\` | keyof T | -1n;
`;

test('nodes survive encoding and decoding', { skip }, async () => {
  const { parseSourceFile } = await load('compiler/parser.js');
  const { decodeNodes } = await load('compiler/decoder.js');
  const { encodeNode, encodeSourceFile } = await load('compiler/encoder.js');
  const { printNode } = await load('api/backend.js');

  const file = parseSourceFile('/a.ts', source);
  const decodedFile = decodeNodes(encodeSourceFile(file));
  assert.equal(decodedFile.fileName, '/a.ts');
  assert.equal(decodedFile.text, source);
  assert.equal(decodedFile.statements.nodes.length, 2);

  for (const statement of file.statements.nodes) {
    const encoded = encodeNode(statement);
    const decoded = decodeNodes(encoded);
    assert.equal(decoded.kind, statement.kind);
    assert.equal(decoded.pos, statement.pos);
    assert.deepEqual(encodeNode(decoded), encoded);
  }
  assert.equal(
    printNode(decodeNodes(encodeNode(file.statements.nodes[0])), false, false, false),
    'export type Shape = {\n    kind: "circle";\n    radius: number;\n} | readonly [\n    x: number,\n    y?: string,\n    ...rest: boolean[]\n];',
  );

  // The right side of a qualified name in a type query can be a private name.
  const privateName = parseSourceFile('/b.ts', 'class C {\n    #x = 1;\n    y: typeof this.#x;\n}');
  const classNode = privateName.statements.nodes[0];
  assert.deepEqual(encodeNode(decodeNodes(encodeNode(classNode))), encodeNode(classNode));
  assert.equal(
    printNode(decodeNodes(encodeNode(classNode)), false, false, false),
    'class C {\n    #x = 1;\n    y: typeof this.#x;\n}',
  );

  assert.throws(() => decodeNodes(new Uint8Array(4)), /too short/);
  const corrupt = encodeNode(file.statements.nodes[1]);
  corrupt[3] = 0;
  assert.throws(() => decodeNodes(corrupt), /protocol version/);
});

test('encodings use the protocol 9 layout', { skip }, async () => {
  const { parseSourceFile } = await load('compiler/parser.js');
  const { decodeNodes } = await load('compiler/decoder.js');
  const { encodeNode, encodeSourceFile } = await load('compiler/encoder.js');
  const { ModuleDeclaration } = await load('compiler/ast.js');
  const u32 = (bytes, at) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(at, true);

  const file = parseSourceFile('/b.ts', 'f(a, b,);\ng(a, b);\n');
  const bytes = encodeSourceFile(file);
  assert.equal(bytes[3], 9);
  // Source file ID, lease ID and binder data offset are 0.
  for (let at = 44; at < 64; at += 4) assert.equal(u32(bytes, at), 0);
  assert.equal(u32(bytes, 24), 64);

  // The source file's extended data has 19 words; the original text of a file that no content
  // mapper produced is its text, and its content mapper fields are empty.
  const extended = u32(bytes, 32);
  assert.equal(u32(bytes, extended + 48), u32(bytes, extended));
  for (let at = 52; at < 76; at += 4) assert.equal(u32(bytes, extended + at), 0xffffffff);

  // A node list record's last word is 1 when the list has a trailing comma: the statements,
  // then the arguments of `f` and of `g`.
  const nodes = u32(bytes, 40);
  const listWords = [];
  for (let at = nodes; at < bytes.length; at += 28) {
    if (u32(bytes, at) === 0xffffffff && u32(bytes, at + 20) === 2) listWords.push(u32(bytes, at + 24));
  }
  assert.deepEqual(listWords, [0, 1, 0]);

  // A module declaration's attributes come before its body.
  const typed = parseSourceFile('/c.ts', 'declare module "m" {}\ntype T = { a: 1 };\n');
  const [module, alias] = typed.statements.nodes;
  const withAttributes = new ModuleDeclaration(undefined, module.keyword, module.name, alias.type, module.body);
  const decoded = decodeNodes(encodeNode(withAttributes));
  assert.equal(decoded.attributes?.kind, alias.type.kind);
  assert.equal(decoded.body?.kind, module.body.kind);
});

// The responses of content mappers to the transform of one file, with positions in UTF-8 as tsgo's own mappers
// give them. `at` and `length` count the bytes before a part of a text and the bytes of a text.
const length = (text) => Buffer.byteLength(text);
const at = (text, part) => length(text.slice(0, text.indexOf(part)));

function mappedCases(spanMap) {
  // A component whose script is copied, whose interpolation becomes a call, and which has a file of types and a
  // file of its markup besides. Its texts are not ASCII, so positions differ between UTF-8 and UTF-16.
  const script = 'export const greeting: string = "héllo 😀";\n// @vue-expect-error\nlet count: number = "one";\n';
  const content = `<!-- naïve 😀 -->\n<script>\n${script}</script>\n<p>{{ count }} · {{ greeting }}</p>\n`;
  const text = `/* généré 😀 */\n${script}__render(count_1, greeting);\n`;
  const types = 'export interface Props { naïve: boolean }\n';
  const markup = 'const p = <p>{count}</p>;\n';
  const line = 'let count: number = "one";\n';
  const component = {
    text,
    extension: '.ts',
    mappings: [
      [at(text, script), length(script), at(content, script), length(script), 0],
      // No feature of the language service uses the call, and two use the name of the count.
      [at(text, '__render'), length('__render'), at(content, '{{'), length('{{'), 1, 0],
      [at(text, 'count_1'), length('count_1'), at(content, 'count }}'), length('count'), 2, 9],
      [at(text, 'greeting);'), length('greeting'), at(content, 'greeting }}'), length('greeting'), 0, 1 << 19],
    ],
    diagnosticDirectives: {
      unusedExpectDirectiveDiagnostics: [
        { code: 2578, messageText: 'Unused directive.' },
        { code: 70000, messageText: 'Nothing to expect.' },
      ],
      directives: [
        [0, at(content, '\n'), 0, at(text, '\n'), 0],
        [
          at(content, '// @vue-expect-error'),
          length('// @vue-expect-error'),
          at(text, line),
          at(text, line) + length(line),
          1,
          1,
        ],
        [at(content, '<p>'), length('<p>'), at(text, '__render'), length(text), 1, 0],
      ],
    },
    diagnostics: [{ messageText: 'Unknown tag.', start: at(content, '<p>'), length: 3, code: 1000 }],
    supplemental: [
      // A file of types that is a module by its extension, and a file with JSX that nothing maps.
      {
        text: types,
        extension: '.mts',
        mappings: [[at(types, 'naïve'), length('naïve'), at(content, 'naïve'), length('naïve'), 0]],
      },
      { text: markup, extension: '.tsx' },
    ],
  };

  // What the mapper of TypeScript's compiler tests makes of a file with its directives and an interpolation.
  const box =
    '// @box-ignore\nexport const a: string = 1;\n// @box-expect-error: Unused.\nexport const b = #{strict};\n';
  const mapper = createTestMapperSpawner(spanMap)([transformingMapper]);
  mapper.handleRequest('openProject', { projectHandle: 'p', compilerOptions: { strict: true } });
  const boxed = mapper.handleRequest('transform', { fileName: '/widget.box', content: box, projectHandle: 'p' });

  return [
    ['Component.vue', content, component, []],
    ['Component.vue', content, component, ['--jsx', '--force']],
    ['widget.box', box, boxed, []],
    // A response without mappings, whose text is synthesized as a whole, for a file that is empty.
    ['empty.box', '', { text: 'export {};\n', extension: '.ts' }, []],
  ];
}

test(
  'mapped files are encoded as tsgo encodes them',
  { skip: skip || (!existsSync(oracle) && 'needs packages/tsgo/dist/encode-oracle') },
  async () => {
    const { ExternalModuleIndicatorOptions } = await load('compiler/ast.js');
    const { ContentMapper, ContentMapperDefinition, ContentMapperManifest } = await load('compiler/content-mapper.js');
    const { decodeTransformResult } = await load('compiler/content-mapper-protocol.js');
    const { encodeSourceFile } = await load('compiler/encoder.js');
    const { ContentMappedSourceFiles, parseResult } = await load('compiler/file-loader.js');
    const { parseJson } = await load('compiler/package-json.js');
    const spanMap = await load('compiler/span-map.js');
    const u32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset, true);

    // The mapper the oracle gives its files: `mapper@1.0.0`.
    const definition = new ContentMapperDefinition();
    definition.package = 'mapper';
    const mapper = new ContentMapper(definition);
    mapper.manifest = new ContentMapperManifest('mapper', '1.0.0', undefined, undefined, false, undefined);

    const directory = tempDir('tsc-ts-encoder-');
    let mapped = 0;
    for (const [name, content, response, flags] of mappedCases(spanMap)) {
      const file = join(directory, name);
      const responseFile = join(directory, 'response.json');
      writeFileSync(file, content);
      writeFileSync(responseFile, JSON.stringify(response));
      const result = decodeTransformResult(parseJson(JSON.stringify(response)), content, 'utf-8', 'mapper');
      const options = new ExternalModuleIndicatorOptions(flags.includes('--jsx'), flags.includes('--force'));
      const files = parseResult(`/${name}`, `/${name}`, options, content, mapper, 'identity', result);
      assert.ok(files instanceof ContentMappedSourceFiles, `${name} is parsed`);
      assert.equal(files.supplemental.length, response.supplemental?.length ?? 0);
      const encode = (args) => execFileSync(oracle, [file, `--mapped=${responseFile}`, ...flags, ...args]);
      const where = `${name} ${flags.join(' ')}`;
      const canonical = encodeSourceFile(files.canonical);
      assert.deepEqual(Buffer.from(canonical), encode([]), `${where}: the canonical file`);
      files.supplemental.forEach((supplemental, index) =>
        assert.deepEqual(
          Buffer.from(encodeSourceFile(supplemental)),
          encode([`--supplemental=${index}`]),
          `${where}: supplemental file ${index}`,
        ),
      );

      // The original text is a string of its own, and the mapper and the virtual file name are set.
      const extended = u32(canonical, 32);
      assert.notEqual(u32(canonical, extended + 48), u32(canonical, extended), `${where}: the original text`);
      for (const offset of [64, 68]) assert.notEqual(u32(canonical, extended + offset), 0xffffffff);
      mapped += 1 + files.supplemental.length;
    }
    assert.equal(mapped, 8);

    // A session's hash of a mapped file takes the place of the hash of its text in the header.
    const [name, content, response] = mappedCases(spanMap)[0];
    const result = decodeTransformResult(parseJson(JSON.stringify(response)), content, 'utf-8', 'mapper');
    const options = new ExternalModuleIndicatorOptions(false, false);
    const { canonical } = parseResult(`/${name}`, `/${name}`, options, content, mapper, 'identity', result);
    const hash = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const encoded = encodeSourceFile(canonical, hash);
    assert.deepEqual(encoded.subarray(4, 20), hash);
    const plain = encodeSourceFile(canonical);
    assert.deepEqual(
      [...encoded.subarray(0, 4), ...encoded.subarray(20)],
      [...plain.subarray(0, 4), ...plain.subarray(20)],
    );
  },
);
