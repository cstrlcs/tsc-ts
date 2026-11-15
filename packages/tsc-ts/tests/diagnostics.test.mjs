import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

// Compares messages, translations, locale matching, formatting and diagnostic output with tsgo's
// (packages/tsgo/dist/diag-oracle, built by `npm run build:oracle`), also for diagnostics in files a
// content mapper produced and for a mapper's own diagnostics.
const root = resolve(import.meta.dirname, '..');
const repo = resolve(root, '../..');
const oracle = join(repo, 'packages/tsgo/dist/diag-oracle');
const skip = existsSync(oracle) ? false : 'diag-oracle is not built';

let compiled;
function compile() {
  if (compiled !== undefined) return compiled;
  const out = compileSources('tsc-ts-diag-', ['drivers/diagnostics.ts']);
  compiled = out;
  return out;
}

function run(request, name) {
  const out = compile();
  const file = join(out, name + '.json');
  writeFileSync(file, JSON.stringify(request));
  const options = { maxBuffer: 1 << 30, encoding: 'utf8' };
  const expected = JSON.parse(execFileSync(oracle, [file], options));
  const actual = JSON.parse(execFileSync(process.execPath, [join(out, 'drivers/diagnostics.js'), file], options));
  // DIAG_NATIVE names a scriptc build of src/drivers/diagnostics.ts, which must print the same.
  if (process.env.DIAG_NATIVE) {
    const native = JSON.parse(execFileSync(process.env.DIAG_NATIVE, [file], options));
    assert.deepEqual(native, actual, `${name}: native`);
  }
  return { expected, actual };
}

async function localeTags() {
  const { localeTags } = await import(pathToFileURL(join(compile(), 'compiler/diagnostic-locales.js')).href);
  return localeTags;
}

/** Reports the first few differing entries of two equal-length arrays. */
function compareLists(name, expected, actual) {
  assert.equal(actual.length, expected.length, `${name}: length`);
  const bad = [];
  for (let i = 0; i < expected.length; i++) {
    if (JSON.stringify(expected[i]) !== JSON.stringify(actual[i])) bad.push(i);
  }
  for (const i of bad.slice(0, Number(process.env.DIAG_SHOW ?? 5))) {
    console.log(`${name}[${i}]\n  expected ${JSON.stringify(expected[i])}\n  actual   ${JSON.stringify(actual[i])}`);
  }
  assert.equal(bad.length, 0, `${name}: ${bad.length} of ${expected.length} differ`);
}

test('messages and translations match tsgo in every locale', { skip }, async () => {
  const tags = ['en', ...(await localeTags()).slice(1)];
  const { expected, actual } = run({ locales: tags, matches: [], formats: [], renders: [] }, 'messages');
  compareLists(
    'messages',
    expected.messages.map((m) => ({ code: m.code, category: m.category, key: m.key, text: m.text, flags: m.flags })),
    actual.messages,
  );
  // Enum members carry tsgo's names.
  const source = readFileSync(join(root, 'src/compiler/diagnostic-messages.ts'), 'utf8');
  const names = [...source.matchAll(/^ {2}(\w+) = \d+,$/gm)].map((m) => m[1]);
  compareLists(
    'names',
    expected.messages.map((m) => m.name),
    names,
  );
  for (const tag of tags) compareLists(tag, expected.localized[tag], actual.localized[tag]);
  console.log(`${expected.messages.length} messages, ${tags.length} locales`);
});

test('formatting with arguments matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const { expected: table } = run({ locales: ['en'], matches: [], formats: [], renders: [] }, 'table');
  const formats = [];
  const missing = [];
  for (const m of table.messages) {
    const count = Math.max(0, ...[...m.text.matchAll(/\{(\d+)\}/g)].map((p) => Number(p[1]) + 1));
    const args = Array.from({ length: count }, (_, i) => `<${String.fromCharCode(0x41 + i)}${i}{${i}}>`);
    for (const locale of tags) formats.push({ locale, key: m.key, args });
    if (count > 0) {
      formats.push({ locale: 'en', key: m.key, args: [] });
      // With no arguments at all a message is returned as it is.
      if (count > 1) missing.push(formats.length);
      formats.push({ locale: 'de', key: m.key, args: args.slice(0, count - 1) });
      formats.push({ locale: 'de', key: m.key, args: [] });
      formats.push({ locale: 'ja', key: m.key, args: [...args, 'extra'] });
    }
  }
  formats.push({ locale: 'en', key: '_0_expected_1005', args: ['😀 {0} $& $1'] });
  const { expected, actual } = run({ locales: [], matches: [], formats, renders: [] }, 'formats');
  // A placeholder without an argument: tsgo panics, tsc-ts leaves the placeholder in the message (the
  // message without arguments is the next request) and goes on.
  for (const k of missing) {
    assert.equal(expected.formats[k], 'panic: Invalid formatting placeholder', `formats[${k}]: tsgo`);
    const args = formats[k].args;
    expected.formats[k] = expected.formats[k + 1].replace(/\{(\d+)\}/g, (p, n) =>
      Number(n) < args.length ? args[Number(n)] : p,
    );
  }
  compareLists('formats', expected.formats, actual.formats);
  console.log(`${formats.length} formatted messages`);
});

/** Language, script and region subtags to combine, from the locale tables. */
function localeCorpus() {
  const source = readFileSync(join(root, 'src/compiler/locale-data.ts'), 'utf8');
  const block = (name) =>
    source
      .slice(source.indexOf(`const ${name} = `))
      .split('`')[1]
      .trim()
      .split(/\s+/);
  const list = (name) => {
    const start = source.indexOf(`const ${name} =`);
    const text = source.slice(start, source.indexOf(';', start));
    return [...text.matchAll(/'([^']*)'/g)]
      .map((m) => m[1])
      .join('')
      .split(' ');
  };
  const languages = block('likelyScripts').map((entry) => entry.split('=')[0]);
  const aliases = block('languageAliases').map((entry) => entry.split('=')[0]);
  // Zmth (mathematical notation) is left out: x/text's answers for it do not follow its data.
  const scripts = list('scripts')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .filter((s) => s !== 'Zmth');
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const codes = [];
  for (const a of letters) for (const b of letters) codes.push(a + b);
  for (const a of letters) for (const b of letters) for (const c of letters) codes.push(a + b + c);
  const regions = codes.slice(0, 26 * 26).map((r) => r.toUpperCase());
  for (let i = 0; i < 1000; i += 7) regions.push(String(i).padStart(3, '0'));
  regions.push('001', '005', '013', '030', '034', '142', '150', '156', '158', '419', '999');

  const tags = [...codes];
  for (const language of ['und', ...languages, ...aliases]) {
    for (const script of ['', ...scripts]) tags.push(script === '' ? language : `${language}-${script}`);
    for (const script of ['', 'Latn', 'Cyrl', 'Hans', 'Hant', 'Arab', 'Armn', 'Xyzw']) {
      for (const region of regions)
        tags.push(script === '' ? `${language}-${region}` : `${language}-${script}-${region}`);
    }
  }
  for (const script of scripts) for (const region of regions) tags.push(`und-${script}-${region}`);
  for (const code of codes.slice(0, 26 * 26)) tags.push(`${code}-DE`, `${code}-Hant`, `${code}-TW`);
  // Odd and malformed values, and tags that only parse as tsgo does with its special cases.
  const odd = `
    - de- -de de--de de_DE DE-de zh_tw ZH-HANT pt-br en-US C POSIX C.UTF-8 de_DE.UTF-8 fr_FR@euro
    ja_JP.eucJP über de-ü toolong de-toolongsubtag x-de i-klingon i-lux I_LUX zh-guoyu zh-hakka zh-xiang
    zh-min zh-min-nan root en-GB-oed art-lojban no-bok sgn-CH-DE zh-cmn zh-cmn-Hant zh-yue-HK zh-xyz-TW
    de-a de-a-bb de-x de-x-a de-1901 de-DE-1901 de-u-co-phonebk de-Latn-DE-x-private arm arm-AM arm-Xyzw
    baq-ES baq-Xyzw ger-Xyzw chi-TW-Xyzw de-AAA qq-DE 12-DE
  `;
  tags.push('', ' ', ...odd.trim().split(/\s+/));
  return tags;
}

test('locale matching matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const matches = localeCorpus();
  const { expected, actual } = run({ locales: tags, matches, formats: [], renders: [] }, 'matches');
  // Identifier_expected tells the locales apart.
  const probes = tags.map((tag) => expected.localized[tag][1]);
  assert.equal(new Set(probes).size, tags.length);
  compareLists(
    'matches',
    expected.matches.map((text, i) => `${matches[i]}: ${tags[probes.indexOf(text)]}`),
    actual.matches.map((text, i) => `${matches[i]}: ${tags[probes.indexOf(text)]}`),
  );
  const translated = expected.matches.filter((text) => text !== probes[0]).length;
  console.log(`${matches.length} locale tags, ${translated} translated`);
});

function diag(file, pos, end, key, args = [], chain = [], related = []) {
  return { file, pos, end, key, args, chain, related };
}

const sources = [
  { name: '/project/src/a.ts', text: 'let x: number = "one";\nfunction f() {\n\treturn  \t\n}\n' },
  { name: '/project/src/b.ts', text: 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n' },
  {
    name: '/project/lib/c.ts',
    text: 'line1 line2 line3\rline4\nline5\nline6\nline7  　\nline8 😀 x\nline9\nline10\nline11',
  },
  { name: '/project/d.ts', text: 'export {};' },
  { name: '/Project/Src/E.ts', text: '' },
  { name: '/other/root/f.ts', text: 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n' },
];

const scenarios = [
  // One error in one file, with a chain.
  [
    diag(
      0,
      4,
      5,
      'Type_0_is_not_assignable_to_type_1_2322',
      ['string', 'number'],
      [
        diag(
          -1,
          0,
          0,
          'Type_0_is_not_assignable_to_type_1_2322',
          ['"one"', 'number'],
          [diag(-1, 0, 0, 'Property_0_is_missing_in_type_1_but_required_in_type_2_2741', ['p', 'A', 'B'])],
        ),
        diag(-1, 0, 0, 'The_types_of_0_are_incompatible_between_these_types_2200', ['x']),
      ],
    ),
  ],
  // A single global error.
  [diag(-1, -1, -1, 'Cannot_find_global_type_0_2318', ['Array'])],
  // Errors, warnings, suggestions and messages over several files, with related information.
  [
    diag(
      0,
      16,
      21,
      'Type_0_is_not_assignable_to_type_1_2322',
      ['string', 'number'],
      [],
      [
        diag(0, 4, 5, 'The_expected_type_comes_from_property_0_which_is_declared_here_on_type_1_6500', ['x', 'T']),
        diag(-1, -1, -1, 'Did_you_mean_0_1369', ['y']),
        diag(1, 15, 20, '_0_is_declared_here_2728', ['b']),
      ],
    ),
    diag(1, 0, 40, 'Unreachable_code_detected_7027'),
    diag(1, 14, 14, 'Identifier_expected_1003'),
    diag(2, 0, sources[2].text.length, 'Unused_label_7028'),
    diag(2, 6, 18, '_0_is_declared_but_its_value_is_never_read_6133', ['line2']),
    diag(2, 70, 75, 'Cannot_find_name_0_2304', ['x']),
    diag(3, 0, 6, 'An_export_assignment_cannot_be_used_in_a_module_with_other_exported_elements_2309'),
    diag(4, 0, 0, 'File_appears_to_be_binary_1490'),
    diag(5, 2, 20, 'Cannot_find_name_0_2304', ['b']),
    diag(5, 4, 4, 'Cannot_find_name_0_2304', ['c']),
    diag(-1, -1, -1, 'Found_1_error_Watching_for_file_changes_6193'),
    diag(-1, -1, -1, 'Cannot_find_global_type_0_2318', ['Promise']),
  ],
  // Many errors in one file.
  Array.from({ length: 12 }, (_, i) => diag(5, i * 2, i * 2 + 1, 'Cannot_find_name_0_2304', [String(i)])),
  // Over nine errors in several files, for the table's padding.
  [
    ...Array.from({ length: 11 }, (_, i) => diag(0, i, i + 1, 'Identifier_expected_1003')),
    diag(1, 0, 1, 'Identifier_expected_1003'),
  ],
  // No errors.
  [
    diag(0, 0, 3, 'Unreachable_code_detected_7027'),
    diag(-1, -1, -1, 'Found_0_errors_Watching_for_file_changes_6194', ['0']),
  ],
];

test('diagnostic output matches tsgo', { skip }, async () => {
  const tags = await localeTags();
  const renders = [];
  for (const locale of tags) {
    for (const diagnostics of scenarios) {
      for (const [currentDirectory, useCaseSensitiveFileNames] of [
        ['/project', true],
        ['/project/src', false],
        ['/PROJECT/src', false],
        ['', true],
      ]) {
        for (const newLine of ['\n', '\r\n']) {
          renders.push({ locale, currentDirectory, useCaseSensitiveFileNames, newLine, files: sources, diagnostics });
        }
      }
    }
  }
  const { expected, actual } = run({ locales: [], matches: [], formats: [], renders }, 'renders');
  for (const field of ['plain', 'pretty', 'summary', 'flattened', 'status']) {
    compareLists(
      field,
      expected.renders.map((r) => r[field]),
      actual.renders.map((r) => r[field]),
    );
  }
  console.log(`${renders.length} renders`);
});

/** The range of `part` in `text`. */
function range(text, part) {
  const pos = text.indexOf(part);
  assert.ok(pos >= 0, part);
  return [pos, pos + part.length];
}

/** A diagnostic a content mapper reported, at a range of the original text of its file. */
function external(file, pos, end, source, code, text, related = [], chain = []) {
  return { file, pos, end, key: '', args: [], chain, related, source, code, text };
}

// A file a content mapper produced from `boxOriginal`. The tuples are what the mapper sends for the parts of
// the virtual text that come from the original: [virtualStart, virtualLength, originalStart, originalLength,
// kind], with the features as an optional sixth value, in UTF-16 offsets.
const boxOriginal = '<box title="café 😀">\n  {{ count + total }}\n\t(+ 1 2) {{ naïve }}\n</box>\n';
const boxVirtual =
  '// café 😀\nexport const a = count + total;\nexport const b = plus(1, 2);\nexport const c = __atom("naïve");\n';
const boxSupplemental = 'declare const total: number;\n';
const badOriginal = '<box>\n  {{ oops\n';
const configText = '{\n  "contentMappers": [{ "package": "box-mapper", "strict": 1 }]\n}\n';
const [Verbatim, Atom, Alias] = [0, 1, 2];
const inVirtual = (part) => range(boxVirtual, part);
const inOriginal = (part) => range(boxOriginal, part);
const mapper = 'box-mapper 1.0.0';

const mappedSources = [
  {
    name: '/project/src/app.box',
    text: boxVirtual,
    mapped: {
      mapper,
      original: boxOriginal,
      mappings: [
        [inVirtual('count + total')[0], 13, inOriginal('count + total')[0], 13, Verbatim],
        // The mapper named the original's `+` `plus`.
        [inVirtual('plus')[0], 4, inOriginal('(+ 1')[0] + 1, 1, Alias],
        [inVirtual('__atom("naïve")')[0], 15, inOriginal('{{ naïve }}')[0], 11, Atom, 1],
      ],
    },
  },
  // A supplemental file of app.box, which diagnostics show under the name of app.box.
  {
    name: '/project/src/app.box.0.ts',
    text: boxSupplemental,
    mapped: {
      mapper,
      original: boxOriginal,
      mappings: [[range(boxSupplemental, 'total')[0], 5, inOriginal('total')[0], 5, Verbatim]],
      canonical: 0,
    },
  },
  { name: '/project/src/a.ts', text: 'import "./app.box";\n' },
  // The empty file of a transform that failed, which has no span map.
  { name: '/project/src/bad.box', text: '', mapped: { mapper, original: badOriginal } },
  // A file with an empty span map: all of it is synthesized.
  {
    name: '/project/lib/all.box',
    text: 'export {};\n',
    mapped: { mapper: 'other', original: 'ünused\n', mappings: null },
  },
  { name: '/project/src/bad.box.0.ts', text: 'export {};\n', mapped: { mapper, original: badOriginal, canonical: 3 } },
  { name: '/project/tsconfig.json', text: configText },
  // A mapper without an identity: tsgo takes the text itself for the original text of its file.
  {
    name: '/project/lib/anonymous.box',
    text: 'plus(1)\n// é\n',
    mapped: { mapper: '', original: '(+ 1)\n', mappings: [[0, 4, 1, 1, Alias]] },
  },
];

const mappedScenarios = [
  // A range in a verbatim segment is shown in the original text, as are those of its related information.
  [
    diag(
      0,
      ...inVirtual('total'),
      'Cannot_find_name_0_2304',
      ['total'],
      [],
      [
        diag(0, ...inVirtual('export const b'), 'Did_you_mean_0_1369', ['x']),
        diag(2, 7, 18, '_0_is_declared_here_2728', ['app']),
        diag(1, ...range(boxSupplemental, 'total'), '_0_is_declared_here_2728', ['total']),
        diag(-1, -1, -1, 'Did_you_mean_0_1369', ['y']),
        external(0, ...inOriginal('title'), 'box', 12, 'Declared here.'),
      ],
    ),
  ],
  // A range in synthesized text is shown in the virtual text with a note, which each elaboration that is in
  // synthesized text has too.
  [
    diag(
      0,
      ...inVirtual('export const a'),
      'Type_0_is_not_assignable_to_type_1_2322',
      ['string', 'number'],
      [
        diag(
          0,
          ...inVirtual('export const a'),
          'Type_0_is_not_assignable_to_type_1_2322',
          ['"one"', 'number'],
          [
            diag(-1, 0, 0, 'Property_0_is_missing_in_type_1_but_required_in_type_2_2741', ['p', 'A', 'B']),
            diag(0, ...inVirtual('// café'), 'The_types_of_0_are_incompatible_between_these_types_2200', ['y']),
          ],
        ),
        diag(0, ...inVirtual('count'), 'The_types_of_0_are_incompatible_between_these_types_2200', ['x']),
        diag(2, 0, 6, 'The_types_of_0_are_incompatible_between_these_types_2200', ['z']),
      ],
    ),
  ],
  // A diagnostic about a whole alias shows the original name for the virtual one, also in an elaboration.
  [
    diag(0, ...inVirtual('plus'), 'Cannot_find_name_0_Did_you_mean_1_2552', ['plus', 'plus']),
    diag(0, ...inVirtual('plus'), 'Cannot_find_name_0_Did_you_mean_1_2552', ['plus2', 'plus']),
    diag(0, ...inVirtual('plus'), 'Cannot_find_name_0_2304', ['Plus']),
    diag(0, ...inVirtual('lus'), 'Cannot_find_name_0_2304', ['plus']),
    diag(
      0,
      ...inVirtual('plus(1, 2)'),
      'Type_0_is_not_assignable_to_type_1_2322',
      ['plus', 'number'],
      [diag(0, ...inVirtual('plus'), 'Cannot_find_name_0_2304', ['plus'])],
      [diag(0, ...inVirtual('plus'), '_0_is_declared_here_2728', ['plus'])],
    ),
  ],
  // Ranges in an atom, across segments, from synthesized text into a segment, an empty one in synthesized
  // text, and over the whole file.
  [
    diag(0, ...inVirtual('naïve'), 'Cannot_find_name_0_2304', ['naïve']),
    diag(0, inVirtual('total')[0], inVirtual('plus')[1], 'Unreachable_code_detected_7027'),
    diag(0, inVirtual('export const b')[0], inVirtual('plus')[1], 'Unreachable_code_detected_7027'),
    diag(0, inVirtual('total')[1], inVirtual('total')[1], 'Identifier_expected_1003'),
    diag(0, 0, boxVirtual.length, 'Unused_label_7028'),
  ],
  // A mapper's diagnostics: in a mapped file, in a supplemental one, in the file of a failed transform, in a
  // file no mapper produced, and without a file.
  [
    external(0, ...inOriginal('{{ naïve }}'), 'box', 1000, 'Unclosed interpolation.', [
      diag(0, ...inVirtual('naïve'), 'Did_you_mean_0_1369', ['}}']),
    ]),
    external(
      0,
      0,
      boxOriginal.length,
      'box',
      7,
      'Not a box: é 😀.',
      [],
      [
        diag(-1, 0, 0, 'Did_you_mean_0_1369', ['<box>']),
        diag(0, ...inVirtual('export const a'), 'Did_you_mean_0_1369', ['a']),
      ],
    ),
    external(1, ...inOriginal('title'), 'vue', 5, 'In a supplemental file.'),
    external(3, ...range(badOriginal, 'oops'), 'box', 1001, 'Unexpected end of input.'),
    external(6, ...range(configText, '"strict"'), 'box', 2000, "Unknown option 'strict'."),
    external(-1, -1, -1, 'box', 3000, 'No file.'),
  ],
  // Supplemental files, the file of a failed transform and a wholly synthesized file.
  [
    diag(1, ...range(boxSupplemental, 'total'), 'Cannot_find_name_0_2304', ['total']),
    diag(1, 0, 7, 'Cannot_find_name_0_2304', ['declare']),
    diag(3, 0, 0, 'The_content_mapper_0_did_not_provide_the_required_position_mappings_18071', ['box-mapper']),
    diag(5, 0, 6, 'Cannot_find_name_0_2304', ['export']),
    diag(4, 0, 6, 'Cannot_find_name_0_2304', ['export']),
  ],
  // Several errors in one mapped file and in another file, for the summary.
  [
    diag(0, ...inVirtual('count'), 'Cannot_find_name_0_2304', ['count']),
    diag(0, ...inVirtual('total'), 'Cannot_find_name_0_2304', ['total']),
    diag(2, 0, 6, 'Cannot_find_name_0_2304', ['import']),
    diag(0, ...inVirtual('export const a'), 'Cannot_find_name_0_2304', ['a']),
    diag(0, ...inVirtual('export const b'), 'Cannot_find_name_0_2304', ['b']),
    diag(2, 7, 18, 'Cannot_find_name_0_2304', ['app']),
    external(0, ...inOriginal('title'), 'box', 1, 'One.'),
  ],
  // One error in a mapped file.
  [diag(0, ...inVirtual('count'), 'Cannot_find_name_0_2304', ['count'])],
  // The order of diagnostics with one range and code: by source, then text. And of a mapper's diagnostic
  // against a compiler diagnostic: UTF-16 offset 12 of the original text is UTF-8 offset 12, before UTF-16
  // offset 11 of the virtual text, which is UTF-8 offset 14.
  [
    diag(0, ...inVirtual('count'), 'Cannot_find_name_0_2304', ['count']),
    external(0, ...inVirtual('count'), 'box', 2304, 'b'),
    external(0, ...inVirtual('count'), 'box', 2304, 'a'),
    external(0, ...inVirtual('count'), 'abc', 2304, 'a'),
    external(0, ...inVirtual('count'), 'box', 2304, 'a'),
    diag(0, ...inVirtual('count'), 'Cannot_find_name_0_2304', ['count']),
    diag(0, 11, 17, 'Cannot_find_name_0_2304', ['export']),
    external(0, 12, 13, 'box', 1, 'Before export.'),
  ],
  // Errors in synthesized text of one file, which the summary counts as one file.
  [
    diag(0, ...inVirtual('export const a'), 'Cannot_find_name_0_2304', ['a']),
    diag(0, ...inVirtual('export const b'), 'Cannot_find_name_0_2304', ['b']),
    diag(0, ...inVirtual('// café'), 'Unreachable_code_detected_7027'),
  ],
  // The file of a mapper without an identity.
  [
    diag(7, 0, 4, 'Cannot_find_name_0_2304', ['plus']),
    diag(7, 4, 7, 'Cannot_find_name_0_2304', ['x']),
    external(7, 8, 12, 'box', 1, 'In the text itself.'),
  ],
];

const directories = [
  ['/project', true],
  ['/project/src', false],
  ['/PROJECT/src', false],
  ['', true],
];

/** A summary with the rows of each file name in order: tsgo lists the files of one name in no fixed order. */
function orderedSummary(summary) {
  const lines = summary.split('\n');
  // A row is a count, the file name and, in grey, the line of its first error.
  const name = (line) => (/^ *\d+ {2}/.test(line) ? line.replace(/^ *\d+ {2}/, '').split('\u001b[90m:')[0] : undefined);
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    if (name(lines[i]) !== undefined) while (end < lines.length && name(lines[end]) === name(lines[i])) end++;
    lines.splice(i, end - i, ...lines.slice(i, end).sort());
    i = end;
  }
  return lines.join('\n');
}

test('diagnostics in content mapped files match tsgo', { skip }, async () => {
  const tags = await localeTags();
  const renders = [];
  for (const locale of tags) {
    for (const diagnostics of mappedScenarios) {
      for (const [currentDirectory, useCaseSensitiveFileNames] of directories) {
        for (const newLine of ['\n', '\r\n']) {
          const files = mappedSources;
          renders.push({ locale, currentDirectory, useCaseSensitiveFileNames, newLine, files, diagnostics });
        }
      }
    }
  }
  const { expected, actual } = run({ locales: [], matches: [], formats: [], renders }, 'mapped');
  for (const field of ['plain', 'pretty', 'flattened', 'status', 'order', 'equal']) {
    compareLists(
      field,
      expected.renders.map((r) => r[field]),
      actual.renders.map((r) => r[field]),
    );
  }
  compareLists(
    'summary',
    expected.renders.map((r) => orderedSummary(r.summary)),
    actual.renders.map((r) => orderedSummary(r.summary)),
  );
  // What the cases are there for, in English from /project.
  const english = (scenario) => expected.renders[scenario * directories.length * 2];
  const note =
    "  This location is in virtual code produced by the content mapper 'box-mapper 1.0.0' and has no " +
    'corresponding location in the original file.';
  assert.equal(
    english(0).plain.split('\n')[0],
    "src/app.box(2,14): error TS2304: Cannot find name 'total'.",
    'a mapped range',
  );
  assert.deepEqual(
    english(1)
      .plain.split('\n')
      .filter((line) => line.endsWith(note))
      .map((line) => line.length - note.length),
    [4, 2, 0],
    'the note of each diagnostic of the chain that is in synthesized text',
  );
  assert.equal(english(2).flattened[0], "Cannot find name '+'. Did you mean '+'?", 'an alias');
  assert.equal(english(4).plain.split('\n')[0], 'src/app.box(3,10): error box1000: Unclosed interpolation.');
  assert.match(english(6).summary, /^\nFound 7 errors in 5 files\.\n/, 'mapped errors are files of their own');
  assert.deepEqual(english(8).order, [7, 6, 0, 5, 3, 2, 4, 1]);
  assert.deepEqual(english(8).equal, [false, false, true, false, false, true, false]);
  assert.match(english(9).summary, /^\nFound 3 errors in the same file, starting at: src\/app\.box/);
  console.log(`${renders.length} renders`);
});

test('an external diagnostic without a text has an empty message, where tsgo panics', { skip }, async () => {
  const render = (text) => ({
    locale: 'en',
    currentDirectory: '/project',
    useCaseSensitiveFileNames: true,
    newLine: '\n',
    files: mappedSources,
    diagnostics: [external(0, ...inOriginal('title'), 'box', 1000, text)],
  });
  const request = { locales: [], matches: [], formats: [], renders: [render(''), render('MESSAGE')] };
  const { expected, actual } = run(request, 'empty');
  const [empty, texted] = expected.renders;
  const panic = 'panic: Unknown diagnostic message: ';
  assert.deepEqual([empty.plain, empty.pretty, ...empty.flattened, ...empty.status], Array(5).fill(panic));
  for (const field of ['plain', 'pretty', 'flattened', 'status'])
    assert.equal(
      JSON.stringify(actual.renders[0][field]),
      JSON.stringify(texted[field]).replaceAll('MESSAGE', ''),
      field,
    );
  assert.equal(actual.renders[0].plain, 'src/app.box(1,6): error box1000: \n');
});

test('span map problems are reported with the offsets tsgo counts', { skip }, async () => {
  const virtual = 'const é = "😀";\nexport const a = count;\n';
  const original = '<é 😀>{{ count }}</é>\n';
  const v = virtual.indexOf('count');
  const o = original.indexOf('count');
  const problem = (label, mappings, texts = [virtual, original]) => ({
    label,
    virtual: texts[0],
    original: texts[1],
    mappings,
  });
  const problems = [
    problem('valid', [[v, 5, o, 5, Verbatim]]),
    problem('empty', []),
    // A segment that starts inside the one before it.
    problem('overlap é', [
      [v, 5, o, 5, Verbatim],
      [v + 2, 1, o + 2, 1, Verbatim],
    ]),
    // An original range that ends before it starts.
    problem('bounds', [[v, 5, o + 5, -2, Atom]]),
    problem('mismatch', [[v, 5, o + 1, 5, Verbatim]]),
    problem('length', [[v, 5, o, 4, Verbatim]]),
    problem('kind', [[v, 5, o, 5, 9]]),
    problem('feature', [[v, 5, o, 5, Alias, 1 << 20]]),
    // In ASCII text the offsets are the same in UTF-8 and UTF-16.
    problem('ascii', [[6, 1, 3, 2, Verbatim]], ['const a = 1;\n', 'a = 1\n']),
  ];
  const { expected, actual } = run({ locales: [], matches: [], formats: [], renders: [], problems }, 'problems');
  assert.deepEqual(actual.problems, expected.problems);
  assert.deepEqual(
    expected.problems.map((text) => text.split(':')[0]),
    ['', '', 'TS18081', 'TS18072', 'TS18073', 'TS18073', 'TS18083', 'TS18082', 'TS18073'],
  );
  // The offsets are UTF-8 offsets: three more than the UTF-16 offsets of `count` in both texts.
  assert.equal(
    expected.problems[4],
    `TS18073: The content mapper 'mismatch' produced a verbatim mapping that does not match the original ` +
      `content (virtual offset ${v + 3}, original offset ${o + 4}).`,
  );
});
