// Projects for comparing tsconfig.json handling and program construction with tsgo.
// Each fixture is a set of files and the argument lists to run in its directory.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTestCase } from './module-resolution-cases.mjs';

/** A content mapper process that answers as its argument says (content-mapper-scripted.mjs). */
const scriptedMapper = fileURLToPath(new URL('./content-mapper-scripted.mjs', import.meta.url));

const listArgs = [['--listFilesOnly'], ['--explainFiles', '--listFilesOnly'], ['--showConfig']];

function json(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * A project's `env` holds environment variables for its runs.
 * @returns {{ name: string, files: Record<string, string>, args?: string[][], symlinks?: Record<string, string>, env?: Record<string, string> }[]}
 */
export function fixtureProjects() {
  const fixtures = [];
  const add = (name, files, args = listArgs, env = {}) => fixtures.push({ name, files, args, env });

  // ---- extends
  add('extends-relative', {
    'tsconfig.json': json({ extends: './base.json', compilerOptions: { strict: true }, include: ['src'] }),
    'base.json': json({ compilerOptions: { target: 'es2020', outDir: 'out', lib: ['es2020'] } }),
    'src/a.ts': 'export const a = 1;\n',
  });
  add('extends-without-extension', {
    'tsconfig.json': json({ extends: './configs/base' }),
    'configs/base.json': json({ compilerOptions: { noImplicitAny: true }, include: ['../src/**/*'] }),
    'src/a.ts': 'export {};\n',
    'other/b.ts': 'export {};\n',
  });
  add('extends-chain-with-files', {
    'tsconfig.json': json({ extends: './a/tsconfig.json' }),
    'a/tsconfig.json': json({ extends: '../b/tsconfig.json', compilerOptions: { declaration: true } }),
    'b/tsconfig.json': json({ files: ['../main.ts'], compilerOptions: { target: 'es2022', strict: false } }),
    'main.ts': 'export {};\n',
    'b/ignored.ts': 'export {};\n',
  });
  add(
    'extends-compile-on-save',
    {
      'tsconfig.json': json({ extends: './base.json', files: ['a.ts'] }),
      'base.json': json({ compileOnSave: true }),
      'own.json': json({ extends: './base.json', compileOnSave: false, files: ['a.ts'] }),
      'a.ts': 'export {};\n',
    },
    [['--showConfig'], ['-p', 'own.json', '--showConfig'], ['-p', 'base.json', '--showConfig']],
  );
  add('extends-array', {
    'tsconfig.json': json({ extends: ['./one.json', './two.json'], compilerOptions: { noEmit: true } }),
    'one.json': json({ compilerOptions: { target: 'es2018', module: 'commonjs' }, exclude: ['skip'] }),
    'two.json': json({ compilerOptions: { target: 'esnext', strict: true } }),
    'a.ts': 'export {};\n',
    'skip/b.ts': 'export {};\n',
  });
  add('extends-package', {
    'tsconfig.json': json({ extends: '@scope/config/base.json', include: ['*.ts'] }),
    'node_modules/@scope/config/package.json': json({ name: '@scope/config', version: '1.0.0' }),
    'node_modules/@scope/config/base.json': json({ compilerOptions: { strict: true, types: [] } }),
    'a.ts': 'export {};\n',
  });
  add('extends-package-main', {
    'tsconfig.json': json({ extends: 'shared-config' }),
    'node_modules/shared-config/package.json': json({ name: 'shared-config', tsconfig: './tsconfig.shared.json' }),
    'node_modules/shared-config/tsconfig.shared.json': json({ compilerOptions: { checkJs: true, allowJs: true } }),
    'node_modules/shared-config/tsconfig.json': json({ compilerOptions: { strict: true } }),
    'a.js': 'module.exports = 1;\n',
  });
  add('extends-package-exports', {
    'tsconfig.json': json({ extends: 'cfg/strict' }),
    'node_modules/cfg/package.json': json({ name: 'cfg', exports: { './strict': './strict.json' } }),
    'node_modules/cfg/strict.json': json({ compilerOptions: { strict: true, exactOptionalPropertyTypes: true } }),
    'a.ts': 'export {};\n',
  });
  add('extends-missing', {
    'tsconfig.json': json({ extends: './nope.json' }),
    'a.ts': 'export {};\n',
  });
  add('extends-missing-package', {
    'tsconfig.json': json({ extends: ['missing-package', ''] }),
    'a.ts': 'export {};\n',
  });
  add('extends-cycle', {
    'tsconfig.json': json({ extends: './a.json' }),
    'a.json': json({ extends: './b.json', compilerOptions: { strict: true } }),
    'b.json': json({ extends: './a.json' }),
    'x.ts': 'export {};\n',
  });
  add('extends-self', {
    'tsconfig.json': json({ extends: './tsconfig.json', compilerOptions: { strict: true } }),
    'x.ts': 'export {};\n',
  });
  add('extends-errors-in-base', {
    'tsconfig.json': json({ extends: './base.json' }),
    'base.json': '{ "compilerOptions": { "target": "es1999", "bogus": true, "strict": "yes" } }',
    'x.ts': 'export {};\n',
  });
  add('extends-syntax-error-in-base', {
    'tsconfig.json': json({ extends: './base.json' }),
    'base.json': '{ "compilerOptions": { "target": "es2020", } ',
    'x.ts': 'export {};\n',
  });
  add('extends-null-resets', {
    'tsconfig.json': json({ extends: './base.json', compilerOptions: { outDir: null, lib: null } }),
    'base.json': json({ compilerOptions: { outDir: 'dist', lib: ['es5'], types: ['node'] } }),
    'x.ts': 'export {};\n',
  });
  add('extends-paths-base', {
    'tsconfig.json': json({ extends: './configs/base.json' }),
    'configs/base.json': json({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    'x.ts': 'import "@/y";\n',
    'configs/src/y.ts': 'export {};\n',
  });
  add('extends-diamond', {
    'tsconfig.json': json({ extends: ['./a.json', './b.json'] }),
    'a.json': json({ extends: './c.json', compilerOptions: { strict: true } }),
    'b.json': json({ extends: './c.json' }),
    'c.json': json({ compilerOptions: { target: 'es5x' } }),
    'x.ts': 'export {};\n',
  });
  add('extends-bad-value', {
    'tsconfig.json': '{ "extends": 42, "compilerOptions": {} }',
    'x.ts': 'export {};\n',
  });
  add('extends-array-bad-items', {
    'tsconfig.json': '{ "extends": ["./a.json", 1, null, true], "compilerOptions": {} }',
    'a.json': '{}',
    'x.ts': 'export {};\n',
  });

  // ---- ${configDir}
  add('config-dir', {
    'tsconfig.json': json({ extends: './shared/base.json' }),
    'shared/base.json': json({
      compilerOptions: { outDir: '${configDir}/dist', rootDir: '${configDir}/src', typeRoots: ['${configDir}/types'] },
      include: ['${configDir}/src'],
    }),
    'src/a.ts': 'export {};\n',
    'shared/src/b.ts': 'export {};\n',
  });
  add('config-dir-case', {
    'tsconfig.json': json({ compilerOptions: { outDir: '${CONFIGDIR}/dist' }, files: ['${configDir}/a.ts'] }),
    'a.ts': 'export {};\n',
  });

  // ---- include / exclude / files
  add('include-globs', {
    'tsconfig.json': json({ include: ['src/**/*.ts', 'lib/*', 'x?.ts', 'deep/**/*'], exclude: ['src/skip'] }),
    'src/a.ts': '',
    'src/nested/b.ts': '',
    'src/skip/c.ts': '',
    'src/d.tsx': '',
    'lib/e.ts': '',
    'lib/inner/f.ts': '',
    'x1.ts': '',
    'x12.ts': '',
    'deep/.hidden/g.ts': '',
    'deep/node_modules/h.ts': '',
    'deep/i.d.ts': '',
    'deep/i.ts': '',
  });
  // Several includes over the same directories, matched a directory at a time.
  add('include-shared-directories', {
    'tsconfig.json': json({
      compilerOptions: { allowJs: true },
      include: ['src/*/lib/*', 'src/a?/**/*', 'src/deep/**/est/*', 'test/**/*', '*.ts'],
      exclude: ['**/fixtures/**', 'src/a2/other', '**/*.test.ts'],
    }),
    'a.ts': '',
    'a.tsx': '',
    'src/a1/lib/m.ts': '',
    'src/a1/lib/m.js': '',
    'src/a2/lib/n.ts': '',
    'src/a2/other/o.ts': '',
    'src/b1/lib/.hidden.ts': '',
    'src/b1/lib/z.min.js': '',
    'src/deep/er/est/p.ts': '',
    'src/deep/er/est/p.test.ts': '',
    'src/deep/node_modules/est/q.ts': '',
    'test/t.ts': '',
    'test/fixtures/f.ts': '',
    'test/.dot/d.ts': '',
  });
  add('include-default-excludes', {
    'tsconfig.json': json({ compilerOptions: { outDir: 'build', declarationDir: 'types', declaration: true } }),
    'a.ts': '',
    'build/a.js': '',
    'build/a.d.ts': '',
    'types/a.d.ts': '',
    'node_modules/pkg/index.ts': '',
    'bower_components/x.ts': '',
    'jspm_packages/y.ts': '',
    '.git/z.ts': '',
  });
  add('include-priority', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true } }),
    'a.ts': '',
    'a.d.ts': '',
    'a.js': '',
    'b.js': '',
    'b.d.ts': '',
    'c.tsx': '',
    'c.ts': '',
    'd.mts': '',
    'd.d.mts': '',
    'e.min.js': '',
    'f.cjs': '',
  });
  add('include-json', {
    'tsconfig.json': json({ compilerOptions: { resolveJsonModule: true }, include: ['*.ts', 'data/*.json', '**/*'] }),
    'a.ts': 'import d from "./data/d.json";\n',
    'data/d.json': '{ "a": 1 }',
    'data/e.json': '{}',
    'other.json': '{}',
  });
  add('files-and-include', {
    'tsconfig.json': json({ files: ['a.ts', './a.ts', 'missing.ts'], include: ['*.ts'] }),
    'a.ts': '',
    'b.ts': '',
  });
  add('files-empty', { 'tsconfig.json': json({ files: [] }), 'a.ts': '' });
  add('files-empty-with-references', {
    'tsconfig.json': json({ files: [], references: [{ path: './lib' }] }),
    'lib/tsconfig.json': json({ compilerOptions: { composite: true } }),
    'lib/a.ts': 'export {};\n',
  });
  add('files-null-items', { 'tsconfig.json': '{ "files": [null], "exclude": [null] }', 'a.ts': '' });
  add('no-inputs', { 'tsconfig.json': json({ include: ['src'], exclude: ['<html>&'] }), 'a.ts': '' });
  add('no-inputs-default', { 'tsconfig.json': '{}', 'readme.md': '' });
  add('invalid-specs', {
    'tsconfig.json': json({ include: ['**', 'src/**', 'a/**/../b/*.ts', 'ok/*.ts'], exclude: ['**/../x'] }),
    'ok/a.ts': '',
  });
  add('wrong-spec-types', {
    'tsconfig.json': '{ "include": "src", "exclude": [1, "x"], "files": "a.ts", "references": {} }',
    'src/a.ts': '',
  });
  add('excludes-typo', { 'tsconfig.json': json({ excludes: ['a'], include: ['*.ts'] }), 'a.ts': '' });
  add('include-parent', {
    'proj/tsconfig.json': json({ include: ['../shared/**/*', '*.ts'] }),
    'proj/a.ts': '',
    'shared/b.ts': '',
    'shared/sub/c.ts': '',
  });

  // ---- config syntax and option errors
  add('config-syntax-error', {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, }, "files": ["a.ts"] ',
    'a.ts': '',
  });
  add('config-root-array', { 'tsconfig.json': '[{ "compilerOptions": { "strict": true } }]', 'a.ts': '' });
  add('config-root-string', { 'tsconfig.json': '"hello"', 'a.ts': '' });
  add('config-empty-file', { 'tsconfig.json': '', 'a.ts': '' });
  add('config-comments', {
    'tsconfig.json': '// leading\n{\n  /* block */ "compilerOptions": { "strict": true, // trailing\n },\n}\n',
    'a.ts': '',
  });
  add('config-option-errors', {
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "es1999",
    "module": 5,
    "strict": "yes",
    "lib": ["es5", "bogus", "", null, "DOM"],
    "types": "node",
    "bogusOption": true,
    "Strict": true,
    "outdir": "x",
    "help": true,
    "watch": true,
    "locale": "not a locale",
    "maxNodeModuleJsDepth": "2",
    "jsx": "react-jsxdev",
    "paths": { "a": "b", "c/*/*": ["./d/*/*", "e", "/abs"], "f": [] },
    "moduleResolution": "classic",
    "newLine": "lf",
    "plugins": [{ "name": "x" }],
    "rootDirs": ["a", 1],
    "checkers": 2.7,
    "noEmit": null
  },
  "typeAcquisition": { "enable": true, "bogus": 1, "Include": [] },
  "watchOptions": { "watchFile": "bogus" },
  "compileOnSave": "yes"
}`,
    'a.ts': '',
  });
  add('config-property-errors', {
    'tsconfig.json': '{ "compilerOptions": { a, "b"?: 1, "c": undefined, "d": -1, "e": -"x", "f": [1, x] } }',
    'a.ts': '',
  });
  add('config-wrong-object-types', {
    'tsconfig.json': '{ "compilerOptions": "strict", "typeAcquisition": [] }',
    'a.ts': '',
  });
  add('jsconfig', { 'jsconfig.json': json({ compilerOptions: { checkJs: true } }), 'a.js': 'export {};\n' }, [
    ['-p', 'jsconfig.json', '--listFilesOnly'],
    ['-p', 'jsconfig.json', '--showConfig'],
    ['-p', 'jsconfig.json', '--explainFiles', '--listFilesOnly'],
  ]);
  add('config-unreadable', { 'tsconfig.json/x': '' }, [['-p', 'tsconfig.json/x/..']]);

  // ---- program option diagnostics
  add('removed-options', {
    'tsconfig.json': json({
      compilerOptions: {
        baseUrl: './src',
        outFile: 'out.js',
        target: 'es5',
        module: 'amd',
        moduleResolution: 'node10',
        alwaysStrict: false,
        esModuleInterop: false,
        allowSyntheticDefaultImports: false,
        downlevelIteration: true,
      },
    }),
    'a.ts': '',
  });
  add('removed-options-command-line', { 'a.ts': '' }, [
    ['--listFilesOnly', '--module', 'system', '--baseUrl', '.', 'a.ts'],
    ['--listFilesOnly', '--module', 'umd', '--moduleResolution', 'classic', 'a.ts'],
  ]);
  add('option-conflicts', {
    'tsconfig.json': json({
      compilerOptions: {
        strict: false,
        strictPropertyInitialization: true,
        exactOptionalPropertyTypes: true,
        isolatedDeclarations: true,
        allowJs: true,
        sourceMap: true,
        inlineSourceMap: true,
        mapRoot: 'maps',
        composite: true,
        declaration: false,
        incremental: false,
        inlineSources: true,
        declarationMap: true,
        lib: ['es5'],
        noLib: true,
        isolatedModules: true,
        preserveConstEnums: false,
        checkJs: true,
        emitDecoratorMetadata: true,
        jsxFactory: 'h.',
        reactNamespace: 'React',
        jsxFragmentFactory: '1',
        jsx: 'react-jsx',
        jsxImportSource: 'preact',
        allowImportingTsExtensions: true,
        resolvePackageJsonExports: true,
        customConditions: ['x'],
        moduleResolution: 'node16',
        module: 'esnext',
      },
    }),
    'a.ts': '',
  });
  add('option-conflicts-2', {
    'tsconfig.json': json({
      compilerOptions: {
        declarationDir: 'types',
        emitDeclarationOnly: true,
        sourceRoot: 'src',
        reactNamespace: '1abc',
        jsx: 'react',
        jsxImportSource: 'preact',
        module: 'nodenext',
        moduleResolution: 'bundler',
        resolvePackageJsonImports: true,
        incremental: true,
      },
    }),
    'a.ts': '',
  });
  add('incremental-without-config', { 'a.ts': '' }, [['--incremental', '--listFilesOnly', 'a.ts']]);
  add('root-dir', {
    'tsconfig.json': json({ compilerOptions: { rootDir: 'src', outDir: 'out' } }),
    'src/a.ts': '',
    'other/b.ts': '',
  });
  add('root-dir-inferred-change', {
    'tsconfig.json': json({ compilerOptions: { outDir: 'out' }, include: ['src'] }),
    'src/a.ts': '',
    'src/b/c.ts': '',
  });
  add('outputs-overwrite-inputs', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, declaration: true } }),
    'a.ts': '',
    'a.js': '',
    'b.js': '',
    'b.d.ts': '',
  });
  add('outputs-overwrite-inputs-command-line', { 'a.js': '', 'a.ts': '' }, [
    ['--listFilesOnly', '--allowJs', 'a.ts', 'a.js'],
  ]);
  add('composite-unlisted', {
    'tsconfig.json': json({ compilerOptions: { composite: true }, files: ['a.ts'] }),
    'a.ts': 'import "./b";\n',
    'b.ts': 'export {};\n',
  });

  // ---- references
  add('references', {
    'tsconfig.json': json({
      files: ['main.ts'],
      references: [
        { path: './lib' },
        { path: './lib/tsconfig.json' },
        { path: './missing' },
        { path: './plain' },
        { path: './noemit', circular: true },
      ],
    }),
    'main.ts': 'import "./lib/a";\nimport "./plain/p";\n',
    'lib/tsconfig.json': json({
      compilerOptions: { composite: true, outDir: 'out' },
      references: [{ path: '../base' }],
    }),
    'lib/a.ts': 'import "../base/b";\nexport {};\n',
    'base/tsconfig.json': json({ compilerOptions: { composite: true, declarationDir: 'types' } }),
    'base/b.ts': 'export {};\n',
    'plain/tsconfig.json': json({}),
    'plain/p.ts': 'export {};\n',
    'noemit/tsconfig.json': json({ compilerOptions: { composite: true, noEmit: true } }),
    'noemit/n.ts': 'export {};\n',
  });
  add('references-buildinfo-clash', {
    'tsconfig.json': json({
      compilerOptions: { composite: true, tsBuildInfoFile: 'x.tsbuildinfo' },
      references: [{ path: 'a' }],
    }),
    'index.ts': '',
    'a/tsconfig.json': json({ compilerOptions: { composite: true, tsBuildInfoFile: '../x.tsbuildinfo' } }),
    'a/a.ts': '',
  });
  add('references-invalid', {
    'tsconfig.json': '{ "references": [{ "path": "" }, {}, "x", { "path": "./a", "circular": true }] }',
    'a/tsconfig.json': '{ "compilerOptions": { "composite": true } }',
    'a/a.ts': '',
    'b.ts': '',
  });

  // ---- libraries
  add('libs', {
    'tsconfig.json': json({ compilerOptions: { lib: ['ES2015', 'dom', 'lib.es2017.object.d.ts'] } }),
    'a.ts':
      '/// <reference lib="es2019.array" />\n/// <reference lib="ES2016" />\n/// <reference lib="bogus" />\n/// <reference lib="dom.iterabl" />\nexport {};\n',
  });
  add('no-lib', {
    'tsconfig.json': json({ compilerOptions: { noLib: true } }),
    'a.ts': '/// <reference lib="es2015" />\nexport {};\n',
  });
  add('lib-targets', { 'a.ts': '' }, [
    ['--listFilesOnly', '--target', 'es2015', 'a.ts'],
    ['--explainFiles', '--listFilesOnly', '--target', 'es2016', 'a.ts'],
    ['--listFilesOnly', '--target', 'esnext', 'a.ts'],
    ['--listFilesOnly', '--target', 'es5', 'a.ts'],
    ['--listFilesOnly', '--lib', 'es5,webworker', 'a.ts'],
  ]);
  add('target-related-info', {
    'tsconfig.json': json({ compilerOptions: { target: 'ES2020' } }),
    'a.ts': '/// <reference lib="nope" />\n',
  });
  add(
    'lib-replacement',
    {
      'tsconfig.json': json({ compilerOptions: { libReplacement: true, lib: ['dom', 'es2015'] } }),
      'node_modules/@typescript/lib-dom/package.json': json({ name: '@typescript/lib-dom', types: 'index.d.ts' }),
      'node_modules/@typescript/lib-dom/index.d.ts': 'declare var replaced: number;\n',
      'a.ts': '',
    },
    [...listArgs, ['--listFilesOnly', '--traceResolution']],
  );

  // ---- types
  add('types-automatic', {
    'tsconfig.json': '{}',
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': 'declare var process: any;\n',
    'node_modules/@types/node/package.json': json({ name: '@types/node', version: '20.0.0' }),
    'node_modules/@types/jest/index.d.ts': '',
    'node_modules/@types/.hidden/index.d.ts': '',
  });
  add('types-wildcard', {
    'tsconfig.json': json({ compilerOptions: { types: ['*'] } }),
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': '',
    'node_modules/@types/scope__pkg/index.d.ts': '',
  });
  add('types-list', {
    'tsconfig.json': json({
      compilerOptions: { types: ['node', 'missing'], typeRoots: ['./typings', './node_modules/@types'] },
    }),
    'a.ts': '/// <reference types="other" />\n/// <reference types="nowhere" />\n',
    'typings/node/index.d.ts': '',
    'node_modules/@types/other/index.d.ts': '',
  });
  add('types-empty', {
    'tsconfig.json': json({ compilerOptions: { types: [] } }),
    'a.ts': '',
    'node_modules/@types/node/index.d.ts': '',
  });

  // ---- references between files
  add(
    'triple-slash',
    {
      'a.ts':
        '/// <reference path="b.ts" />\n/// <reference path="c" />\n/// <reference path="missing.ts" />\n/// <reference path="a.ts" />\n/// <reference path="d.js" />\n/// <reference path="e.txt" />\n/// <reference path="nope" />\n',
      'b.ts': '',
      'c.d.ts': '',
      'd.js': '',
      'e.txt': '',
    },
    [
      ['--listFilesOnly', 'a.ts'],
      ['--explainFiles', '--listFilesOnly', 'a.ts'],
      ['--listFilesOnly', '--noResolve', 'a.ts'],
    ],
  );
  add('root-file-errors', { 'a.ts': '', 'b.js': '', 'c.txt': '', 'dir/x.ts': '' }, [
    ['--listFilesOnly', 'a.ts', 'b.js', 'c.txt', 'missing.ts', 'noext'],
    ['--listFilesOnly', 'a', 'dir/x'],
    ['--explainFiles', '--listFilesOnly', 'b.js', 'c.txt'],
  ]);
  add('casing', {
    'tsconfig.json': json({ files: ['a.ts', 'A.ts'] }),
    'a.ts': 'import "./B";\nimport "./b";\n',
    'A.ts': '',
    'b.ts': '',
    'B.ts': '',
  });
  add('casing-off', {
    'tsconfig.json': json({ compilerOptions: { forceConsistentCasingInFileNames: false }, files: ['a.ts', 'A.ts'] }),
    'a.ts': '',
    'A.ts': '',
  });

  // ---- modules and JavaScript
  add(
    'imports',
    {
      'tsconfig.json': json({ compilerOptions: { module: 'nodenext' } }),
      'package.json': json({ type: 'module' }),
      'a.ts': 'import "./b.js";\nimport type {} from "pkg";\nconst c = require("./c.cjs");\nexport {};\n',
      'b.ts': 'export {};\n',
      'c.cts': 'export = 1;\n',
      'node_modules/pkg/package.json': json({ name: 'pkg', version: '1.2.3', types: 'index.d.ts' }),
      'node_modules/pkg/index.d.ts': 'export {};\n',
    },
    [...listArgs, ['--listFilesOnly', '--traceResolution']],
  );
  add('js-depth', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, maxNodeModuleJsDepth: 1 }, include: ['*.js'] }),
    'a.js': 'require("lib1");\n',
    'node_modules/lib1/index.js': 'require("lib2");\n',
    'node_modules/lib2/index.js': 'module.exports = 1;\n',
  });
  // `pc` is reached first at depth 3, through `pa` and `pb`, and later at depth 1, through a chain of local
  // imports from b.ts: its JavaScript import loads within `maxNodeModuleJsDepth` only from the lower depth.
  for (const depth of [1, 2]) {
    add(`js-depth-lowered-${depth}`, {
      'tsconfig.json': json({
        compilerOptions: { allowJs: true, maxNodeModuleJsDepth: depth },
        files: ['a.ts', 'b.ts'],
      }),
      'a.ts': 'import "pa";\n',
      'b.ts': 'import "./c";\n',
      'c.ts': 'import "./d";\n',
      'd.ts': 'import "./e";\n',
      'e.ts': 'import "./f";\n',
      'f.ts': 'import "./g";\n',
      'g.ts': 'import "./h";\n',
      'h.ts': 'import "pc";\n',
      'node_modules/pa/index.d.ts': 'import "pb";\n',
      'node_modules/pb/index.d.ts': 'import "pc";\n',
      'node_modules/pc/index.d.ts': 'import "pj";\n',
      'node_modules/pj/index.js': 'require("pk");\n',
      'node_modules/pk/index.js': 'module.exports = 1;\n',
    });
  }
  add('js-without-allowjs', {
    'tsconfig.json': '{}',
    'a.ts': 'import "./b";\nimport "lib";\n',
    'b.js': '',
    'node_modules/lib/index.js': '',
  });
  add('dedupe-packages', {
    'tsconfig.json': '{}',
    'a.ts': 'import "x";\nimport "y";\n',
    'node_modules/x/index.d.ts': 'import "z";\n',
    'node_modules/x/package.json': json({ name: 'x', version: '1.0.0' }),
    'node_modules/x/node_modules/z/index.d.ts': '',
    'node_modules/x/node_modules/z/package.json': json({ name: 'z', version: '2.0.0' }),
    'node_modules/y/index.d.ts': 'import "z";\n',
    'node_modules/y/package.json': json({ name: 'y', version: '1.0.0' }),
    'node_modules/y/node_modules/z/index.d.ts': '',
    'node_modules/y/node_modules/z/package.json': json({ name: 'z', version: '2.0.0' }),
  });
  add('import-helpers-and-jsx', {
    'tsconfig.json': json({ compilerOptions: { importHelpers: true, jsx: 'react-jsx', isolatedModules: true } }),
    'a.tsx': 'export const x = <div />;\n',
    'b.ts': 'export {};\n',
    'node_modules/tslib/package.json': json({ name: 'tslib', version: '2.0.0', types: 'tslib.d.ts' }),
    'node_modules/tslib/tslib.d.ts': '',
    'node_modules/react/jsx-runtime.d.ts': '',
    'node_modules/react/package.json': json({ name: 'react', version: '18.0.0' }),
  });
  add('syntax-errors', {
    'tsconfig.json': json({ compilerOptions: { allowJs: true, outDir: 'o' } }),
    'a.ts': 'let x = ;\n',
    'b.js': 'function f(@dec x) {}\nlet y: number = 1;\n',
  });
  add(
    'pretty-summary',
    {
      'tsconfig.json': json({ compilerOptions: { pretty: true, target: 'es5' } }),
      'a.ts': 'let x = ;\n',
    },
    [['--listFilesOnly'], ['--listFilesOnly', '--pretty', 'false']],
  );
  add('symlinked-sources', {
    'tsconfig.json': json({ include: ['src', 'linked'] }),
    'src/a.ts': '',
    'real/b.ts': '',
  });
  fixtures[fixtures.length - 1].symlinks = { linked: 'real', 'src/loop': '.' };

  add('include-of-numbers', {
    'tsconfig.json': '{ "include": [-0, 1.50, "nothing"], "exclude": [1e21] }\n',
    'a.ts': 'export {};\n',
  });

  // ---- content mappers
  // No file here has an extension a mapper registers, so no mapper runs with --runExternalCode.
  const mapperArgs = [
    ['--listFilesOnly'],
    ['--listFilesOnly', '--runExternalCode'],
    ['--explainFiles', '--listFilesOnly', '--runExternalCode'],
    ['--showConfig', '--runExternalCode'],
  ];
  const mapperPackage = (name, contentMapper = { exec: ['no-such-mapper'] }) =>
    json({ name, version: '1.0.0', typescript: { contentMapper } });
  add(
    'content-mappers-without-flag',
    {
      'tsconfig.json': json({
        compilerOptions: { strict: true },
        contentMappers: [{ package: 'mapper', extensions: ['.box'], options: { list: [1, null, { deep: 'x' }] } }],
      }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.ts': 'export {};\n',
    },
    mapperArgs,
  );
  add(
    'content-mappers-flag-in-config',
    {
      'tsconfig.json': json({
        compilerOptions: { runExternalCode: true },
        contentMappers: [{ package: 'mapper', extensions: ['.box'] }],
      }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.ts': 'export {};\n',
    },
    mapperArgs,
  );
  add(
    'content-mappers-not-a-list',
    {
      'tsconfig.json': json({ contentMappers: { package: 'mapper', extensions: ['.box'] } }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.ts': 'export {};\n',
    },
    mapperArgs,
  );
  add('content-mappers-empty', { 'tsconfig.json': json({ contentMappers: [] }), 'a.ts': 'export {};\n' }, mapperArgs);
  add(
    'content-mappers-malformed-entries',
    {
      // A `null` entry is dropped from the list, and the entries after it are reported one entry early.
      'tsconfig.json': json({
        contentMappers: [
          'mapper',
          {},
          { package: '', extensions: ['.a'] },
          { package: 1, extensions: '.a' },
          null,
          { package: 'mapper', extensions: ['.b', 1] },
          { package: 'mapper', extensions: [null] },
          { package: 'mapper', extensions: ['.c'], outputExtensions: [] },
          { package: 'mapper', extensions: ['.d'], outputExtensions: { '.d': 1 } },
          { package: 'mapper', extensions: ['.e'], outputExtensions: { '.e': null } },
          { package: 'mapper', extensions: ['.f'], outputExtensions: null, options: null },
          { package: 'mapper', extensions: ['.g'], options: [] },
          { package: 'mapper', extensions: ['.h'], options: 'x' },
          { package: 'mapper', extensions: ['.i'], options: {} },
        ],
      }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.ts': 'export {};\n',
    },
    mapperArgs,
  );
  add(
    'content-mappers-extensions',
    {
      'tsconfig.json': json({
        contentMappers: [
          {
            package: 'one',
            extensions: ['vue', '', '.', '.a/b', '.a\\b', '.ts', '.D.TS', '.x.json', '.mjs', '.vue', '.vue', '.Vue'],
            outputExtensions: {
              '.vue': '.js',
              astro: 'js',
              '.a/b': '.c\\d',
              '.missing': '.js',
              '': '',
              '.': '.',
              '.Vue': '.mjs',
            },
          },
          { package: 'two', extensions: ['.vue', '.svelte', '.y.svelte'], outputExtensions: {} },
        ],
      }),
      'node_modules/one/package.json': mapperPackage('one'),
      'node_modules/two/package.json': mapperPackage('two'),
      'a.ts': 'export {};\n',
    },
    mapperArgs,
  );
  add(
    'content-mappers-packages',
    {
      'project/tsconfig.json': json({
        contentMappers: [
          { package: 'missing', extensions: ['.a'] },
          { package: 'not-json', extensions: ['.b'] },
          { package: 'not-an-object', extensions: ['.c'] },
          { package: 'no-name', extensions: ['.d'] },
          { package: 'no-manifest', extensions: ['.e'] },
          { package: 'manifest-not-an-object', extensions: ['.f'] },
          { package: 'no-exec', extensions: ['.g'] },
          { package: 'exec-not-a-list', extensions: ['.h'] },
          { package: 'exec-empty', extensions: ['.i'] },
          { package: 'exec-of-numbers', extensions: ['.j'] },
          { package: 'outputs-not-an-object', extensions: ['.k'] },
          { package: 'outputs-of-numbers', extensions: ['.l'] },
          { package: 'outputs-without-dot', extensions: ['.m'] },
          { package: 'outputs-with-separator', extensions: ['.n'] },
          { package: '@scope/above', extensions: ['.o'] },
          { package: 'no-version', extensions: ['.p'] },
          { package: './relative', extensions: ['.q'] },
          { package: 'with-exports/sub', extensions: ['.r'] },
        ],
      }),
      'project/a.ts': 'export {};\n',
      'project/node_modules/not-json/package.json': '{ "name": ',
      'project/node_modules/not-an-object/package.json': '[]',
      'project/node_modules/no-name/package.json': json({ version: '1.0.0' }),
      'project/node_modules/no-manifest/package.json': json({ name: 'no-manifest' }),
      'project/node_modules/manifest-not-an-object/package.json': json({
        name: 'manifest-not-an-object',
        typescript: { contentMapper: ['run'] },
      }),
      'project/node_modules/no-exec/package.json': mapperPackage('no-exec', {}),
      'project/node_modules/exec-not-a-list/package.json': mapperPackage('exec-not-a-list', { exec: 'run' }),
      'project/node_modules/exec-empty/package.json': mapperPackage('exec-empty', { exec: [] }),
      'project/node_modules/exec-of-numbers/package.json': mapperPackage('exec-of-numbers', { exec: [1] }),
      'project/node_modules/outputs-not-an-object/package.json': mapperPackage('outputs-not-an-object', {
        exec: ['run'],
        outputExtensions: [],
      }),
      'project/node_modules/outputs-of-numbers/package.json': mapperPackage('outputs-of-numbers', {
        exec: ['run'],
        outputExtensions: { '.l': 1 },
      }),
      'project/node_modules/outputs-without-dot/package.json': mapperPackage('outputs-without-dot', {
        exec: ['run'],
        outputExtensions: { '.m': 'js' },
      }),
      'project/node_modules/outputs-with-separator/package.json': mapperPackage('outputs-with-separator', {
        exec: ['run'],
        outputExtensions: { '.m/n': '.js' },
      }),
      'node_modules/@scope/above/package.json': mapperPackage('@scope/above'),
      'project/node_modules/no-version/package.json': json({
        name: 'no-version',
        typescript: { contentMapper: { exec: ['run'] } },
      }),
      'project/relative/package.json': mapperPackage('relative'),
      'project/node_modules/with-exports/package.json': json({
        name: 'with-exports',
        exports: { './sub': './sub.js' },
      }),
      'project/node_modules/with-exports/sub/package.json': mapperPackage('with-exports-sub'),
    },
    mapperArgs.map((args) => ['-p', 'project', ...args]),
  );
  for (const rewriteRelativeImportExtensions of [false, true])
    add(
      `content-mappers-output-extensions${rewriteRelativeImportExtensions ? '-rewritten' : ''}`,
      {
        'tsconfig.json': json({
          compilerOptions: { rewriteRelativeImportExtensions },
          contentMappers: [
            { package: 'to-js', extensions: ['.a', '.b'] },
            { package: 'to-js', extensions: ['.c'], outputExtensions: null },
            { package: 'to-js', extensions: ['.d'], outputExtensions: {} },
            { package: 'to-js', extensions: ['.e'], outputExtensions: { '.e': '.e' } },
            { package: 'to-js', extensions: ['.f', '.g'], outputExtensions: { '.f': '.mjs', '.g': '.G' } },
            { package: 'plain', extensions: ['.h'] },
          ],
        }),
        'node_modules/to-js/package.json': mapperPackage('to-js', {
          exec: ['run'],
          outputExtensions: { '.a': '.js', '.b': '.b', '.c': '.js', '.d': '.js', '.e': '.js', '.f': '.js' },
        }),
        'node_modules/plain/package.json': mapperPackage('plain'),
        'a.ts': 'export {};\n',
      },
      mapperArgs,
    );
  add(
    'content-mappers-extended',
    {
      'tsconfig.json': json({ extends: './base.json' }),
      'base.json': json({
        contentMappers: [{ package: 'mapper', extensions: ['.box', 'vue'] }, { package: 'missing' }],
      }),
      'own/tsconfig.json': json({
        extends: '../base.json',
        contentMappers: [{ package: 'mapper', extensions: ['.ts'] }],
        files: ['../a.ts'],
      }),
      'last/tsconfig.json': json({ extends: ['../base.json', './reset.json', './empty.json'], files: ['../a.ts'] }),
      'last/reset.json': json({ contentMappers: 'none' }),
      'last/empty.json': json({ compilerOptions: { strict: true } }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.ts': 'export {};\n',
    },
    [
      ...mapperArgs,
      ...mapperArgs.map((args) => ['-p', 'own', ...args]),
      ...mapperArgs.map((args) => ['-p', 'last', ...args]),
    ],
  );

  // ---- content mapped files. The test puts the mappers of content-mappers.mjs on PATH, by the names of their
  // `exec`; a scripted mapper is run by its file name.
  const loadArgs = [
    ['--listFilesOnly', '--runExternalCode'],
    ['--explainFiles', '--listFilesOnly', '--runExternalCode'],
    ['--showConfig', '--runExternalCode'],
    ['--listFilesOnly', '--traceResolution', '--runExternalCode'],
  ];
  const boxMapper = mapperPackage('mapper', { exec: ['compiler-test-mapper'] });
  const scripted = (name, script, contentMapper = {}) =>
    mapperPackage(name, { exec: [process.execPath, scriptedMapper, JSON.stringify(script)], ...contentMapper });
  for (const compilerOptions of [
    { module: 'esnext', moduleResolution: 'bundler' },
    { module: 'esnext', moduleResolution: 'bundler', allowJs: true, resolveJsonModule: true },
  ])
    add(
      `content-mapper-files${compilerOptions.allowJs ? '-with-js-and-json' : ''}`,
      {
        'tsconfig.json': json({
          compilerOptions,
          contentMappers: [{ package: 'mapper', extensions: ['.box', '.module.box'] }],
          files: ['listed.box', 'notes.txt'],
          include: ['src', 'more/*.box', 'more/*.json'],
          exclude: ['src/excluded.box'],
        }),
        'node_modules/mapper/package.json': boxMapper,
        'node_modules/pkg/package.json': json({ name: 'pkg', version: '1.0.0', exports: './index.box' }),
        'node_modules/pkg/index.box': 'export const fromPackage = 1;\n',
        'listed.box': 'export const listed = 1;\n',
        'notes.txt': '',
        'src/a.box':
          'import { b } from "./b.module.box";\nimport { c } from "./c";\nimport "./excluded.box";\nexport const a = [b, c];\n',
        'src/b.module.box': 'export const b = 1;\n',
        'src/c.ts':
          'import "./a.box";\nimport "./a";\nimport "./b.module";\nimport "./missing.box";\nimport "./UPPER.box";\nimport "pkg";\nexport const c = 1;\n',
        'src/excluded.box': 'export const excluded = 1;\n',
        'src/UPPER.BOX': 'export const upper = 1;\n',
        'src/script.js': 'export const script = 1;\n',
        'more/e.box': 'export const e = 1;\n',
        'more/f.module.box': 'export const f = 1;\n',
        'more/g.ts': 'export const g = 1;\n',
        'more/data.json': '{}\n',
      },
      loadArgs,
    );
  add(
    'content-mapper-cannot-start',
    {
      'tsconfig.json': json({ contentMappers: [{ package: 'mapper', extensions: ['.box'] }] }),
      'node_modules/mapper/package.json': mapperPackage('mapper'),
      'a.box': 'export const a = 1;\n',
      'b.box': 'export const b = 1;\n',
      'main.ts': 'import { a } from "./a.box";\nimport { b } from "./b.box";\nexport const c = [a, b];\n',
    },
    loadArgs,
  );
  // A mapper may fail five transforms: the sixth and seventh file are in the program without a diagnostic.
  add(
    'content-mapper-failure-budget',
    {
      'tsconfig.json': json({ contentMappers: [{ package: 'mapper', extensions: ['.box'] }] }),
      'node_modules/mapper/package.json': mapperPackage('mapper', { exec: ['failing-mapper'] }),
      ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [`f${n}.box`, `export const f${n} = ${n};\n`])),
    },
    loadArgs,
  );
  // The offsets of an invalid span map are those of the output it came with, in UTF-8: here the supplemental
  // output, whose text has more bytes before the mapping than the canonical output's and the original's.
  add(
    'content-mapper-invalid-span-maps',
    {
      'tsconfig.json': json({
        contentMappers: [
          { package: 'mismatch', extensions: ['.mismatch'] },
          { package: 'overlap', extensions: ['.overlap'] },
          { package: 'bounds', extensions: ['.bounds'] },
          { package: 'unmapped', extensions: ['.unmapped'] },
        ],
      }),
      'node_modules/mismatch/package.json': scripted('mismatch', {
        transform: {
          text: 'a\u00e91234',
          extension: '.ts',
          mappings: [[0, 7, 0, 7, 0]],
          supplemental: [{ text: '\u00e9\u00e9\u00e99zz', extension: '.ts', mappings: [[6, 1, 3, 1, 0]] }],
        },
      }),
      'node_modules/overlap/package.json': scripted('overlap', {
        transform: {
          text: '\u00e9\u00e9 1234',
          extension: '.ts',
          mappings: [
            [5, 2, 3, 2, 1],
            [6, 1, 5, 1, 1],
          ],
        },
      }),
      'node_modules/bounds/package.json': scripted('bounds', {
        transform: { text: '\u00e9\u00e9 1234', extension: '.ts', mappings: [[5, 2, 6, 9, 1]] },
      }),
      'node_modules/unmapped/package.json': scripted('unmapped', {}),
      'a.mismatch': 'a\u00e91234',
      'a.overlap': 'a\u00e91234',
      'a.bounds': 'a\u00e91234',
      'a.unmapped': 'export {};\n',
    },
    loadArgs,
  );
  add(
    'content-mapper-project-errors',
    {
      'tsconfig.json': json({
        contentMappers: [
          { package: 'identity', extensions: ['.identity'] },
          { package: 'dynamic', extensions: ['.dynamic'] },
          { package: 'encoding', extensions: ['.encoding'] },
          { package: 'reserved', extensions: ['.reserved'] },
        ],
      }),
      'node_modules/identity/package.json': scripted('identity', { openProject: { configIdentity: 'x' } }),
      'node_modules/dynamic/package.json': scripted('dynamic', { openProject: {} }, { dynamicConfig: true }),
      'node_modules/encoding/package.json': scripted('encoding', { initialize: { positionEncoding: 'utf-32' } }),
      'node_modules/reserved/package.json': scripted('reserved', {
        initialize: { positionEncoding: 'utf-8', diagnosticSource: 'TS' },
      }),
      'a.identity': 'export {};\n',
      'a.dynamic': 'export {};\n',
      'a.encoding': 'export {};\n',
      'b.encoding': 'export {};\n',
      'a.reserved': 'export {};\n',
    },
    loadArgs,
  );
  // The test mappers report the name of a plugin that is not a string, at its value in the config file. A project
  // that transforms no file opens no mapper project and gets no such diagnostic. tsgo ends with a nil pointer
  // dereference where the mappers come from a config the project's config extends, which is not compared.
  add(
    'content-mapper-option-diagnostics',
    {
      'tsconfig.json': json({
        contentMappers: [{ package: 'mapper', extensions: ['.box'], options: { plugins: [{ name: 1 }] } }],
      }),
      'unused/tsconfig.json': json({ extends: '../tsconfig.json', files: ['../main.ts'] }),
      'node_modules/mapper/package.json': boxMapper,
      'a.box': 'export const a = 1;\n',
      'main.ts': 'export {};\n',
    },
    [...loadArgs, ...loadArgs.map((args) => ['-p', 'unused', ...args])],
  );
  // With TS_CONTENT_MAPPER_DEBUG the compilers write each message they exchange with a mapper to standard error:
  // the requests, with the project's compiler options, and the responses. One mapper and one file, since tsgo
  // writes the messages of several in no fixed order.
  add(
    'content-mapper-messages',
    {
      'tsconfig.json': json({
        compilerOptions: { strict: true, target: 'es2022', paths: { 'x/*': ['./x/*'] }, types: ['a', 'b'] },
        contentMappers: [{ package: 'mapper', extensions: ['.box'], options: { deep: [1, 'two', { three: null }] } }],
      }),
      'node_modules/mapper/package.json': boxMapper,
      'a.box': 'export const strict = #{strict};\nexport const open = #{target\n',
    },
    [['--listFilesOnly', '--runExternalCode']],
    { TS_CONTENT_MAPPER_DEBUG: '1' },
  );
  // The virtual extension a mapper gives a file decides its module format, and with it how its imports resolve.
  add(
    'content-mapper-module-formats',
    {
      'tsconfig.json': json({
        compilerOptions: { module: 'nodenext' },
        contentMappers: [{ package: 'mapper', extensions: ['.box'] }],
      }),
      'package.json': json({ name: 'app', type: 'module' }),
      'node_modules/mapper/package.json': boxMapper,
      'node_modules/dual/package.json': json({
        name: 'dual',
        version: '1.0.0',
        exports: { import: './esm.d.mts', require: './cjs.d.cts' },
      }),
      'node_modules/dual/esm.d.mts': 'export declare const esm: number;\n',
      'node_modules/dual/cjs.d.cts': 'export declare const cjs: number;\n',
      'plain.box': 'import "dual";\nexport const plain = 1;\n',
      'module.box': '// @box-extension: .mts\nimport "dual";\nexport const esm = 1;\n',
      'common.box': '// @box-extension: .cts\nimport "dual";\nexport const cjs = 1;\n',
      'script.box': '// @box-extension: .js\nimport "dual";\n',
      'cjs/package.json': json({ type: 'commonjs' }),
      'cjs/plain.box': 'import "dual";\nexport const plain = 1;\n',
    },
    loadArgs,
  );
  // A supplemental virtual file is listed in a composite project when its canonical file is.
  add(
    'content-mapper-composite',
    {
      'tsconfig.json': json({
        compilerOptions: { composite: true, module: 'esnext', moduleResolution: 'bundler' },
        contentMappers: [{ package: 'mapper', extensions: ['.astro'] }],
        files: ['listed.astro', 'main.ts'],
      }),
      'node_modules/mapper/package.json': mapperPackage('mapper', { exec: ['supplemental-mapper'] }),
      'listed.astro': 'export const listed = 1;\n',
      'unlisted.astro': 'export const unlisted = 1;\n',
      'main.ts': 'import "./listed.astro";\nimport "./unlisted.astro";\n',
    },
    loadArgs,
  );
  return fixtures;
}

// ---- TypeScript's test cases

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Harness options that are not compiler options, and options whose effects aren't comparable. */
const harnessOnly = new Set([
  'filename',
  'currentdirectory',
  'noimplicitreferences',
  'baselinefile',
  'includebuiltfile',
  'fullemitpaths',
  'reportdiagnostics',
  'captureSuggestions'.toLowerCase(),
  'usecasesensitivefilenames',
  'typescriptversion',
  'libfiles',
  'nocheck',
  'link',
  'symlink',
]);

function optionValue(declaration, raw) {
  const first = raw.split(',')[0].trim();
  switch (declaration.kind) {
    case 'boolean':
      return first.toLowerCase() === 'true';
    case 'number':
      return Number(first);
    case 'list':
      return raw
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '');
    default:
      return first;
  }
}

/**
 * Runs of test cases that tsc-ts answers differently from tsgo: the cases, the argument their differing runs
 * have, and what the differences the test finds must match. The comment of each entry gives the reason.
 */
const differingRuns = [
  // The name a content mapper's `outputExtensions` gives the output of a mapped file is one of the output paths
  // of mapped files, which tsc-ts does not compute yet: it does not report TS5056 where another file has that output.
  {
    name: /^compiler\/contentMapperOutputExtensionsCollision\.ts$/,
    arg: '--listFilesOnly',
    difference:
      /^stdout line 1: tsgo "error TS5056: Cannot write file '\/dist\/component\.js' because it would be overwritten by multiple input files\.", ours "[^"]*"\nstatus tsgo 1, ours 0$/,
  },
];

/**
 * Projects from TypeScript's multi-file test cases. Cases with a tsconfig.json are run with it; others get one with
 * their `@option` headers and every source file in `files`. A project with `differsFromTsgo` expects its runs with
 * that entry's argument to differ from tsgo's as the entry says (see `differingRuns`).
 */
export function testCaseProjects(testsRoot, declarations) {
  const byName = new Map();
  for (const declaration of declarations) byName.set(declaration.name.toLowerCase(), declaration);
  const projects = [];
  const testFiles = [...walk(join(testsRoot, 'compiler'), []), ...walk(join(testsRoot, 'conformance'), [])].sort();
  for (const testFile of testFiles) {
    const code = readFileSync(testFile, 'utf8');
    if (!/@filename\s*:/i.test(code)) continue;
    let parsed;
    try {
      parsed = parseTestCase(code, testFile);
    } catch {
      continue;
    }
    if (parsed.options.usecasesensitivefilenames === 'false') continue;
    const cwd = parsed.options.currentdirectory ?? '/.src';
    if (/^[a-zA-Z]:|\\/.test(cwd)) continue;
    const files = {};
    let configFile;
    let unusable = false;
    for (const file of parsed.files) {
      const name = toProjectPath(file.name, cwd);
      if (name === undefined || name in files) {
        unusable = true;
        break;
      }
      files[name] = file.content;
      const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
      if (configFile === undefined && (base === 'tsconfig.json' || base === 'jsconfig.json')) configFile = name;
    }
    if (unusable) continue;
    const symlinks = {};
    for (const [link, target] of Object.entries(parsed.symlinks)) {
      const from = toProjectPath(link, cwd);
      const to = toProjectPath(target, cwd);
      if (from === undefined || to === undefined) unusable = true;
      else symlinks[from] = to;
    }
    if (unusable) continue;
    const projectCwd = toProjectPath('.', cwd);
    const name = testFile.slice(testsRoot.length + 1);
    // A case that lets its content mappers run: the test puts the mappers of content-mappers.mjs on PATH.
    const external = parsed.options.runexternalcode === 'true' ? ['--runExternalCode'] : [];
    if (configFile !== undefined) {
      const project = ['-p', relativeTo(projectCwd, configFile), ...external];
      projects.push({
        name,
        files,
        symlinks,
        cwd: projectCwd,
        differsFromTsgo: differingRuns.find((differing) => differing.name.test(name)),
        args: [
          [...project, '--listFilesOnly'],
          [...project, '--explainFiles', '--listFilesOnly'],
          [...project, '--showConfig'],
          ...(/node_modules|package\.json|@trace/i.test(code)
            ? [[...project, '--listFilesOnly', '--traceResolution']]
            : []),
        ],
      });
      continue;
    }
    const compilerOptions = {};
    for (const [key, raw] of Object.entries(parsed.options)) {
      if (harnessOnly.has(key)) continue;
      const declaration = byName.get(key);
      if (declaration === undefined || declaration.isCommandLineOnly) continue;
      compilerOptions[declaration.name] = optionValue(declaration, raw);
    }
    const rootFiles = [];
    for (const fileName of Object.keys(files)) {
      if (!/\.(d\.)?[cm]?[tj]sx?$/.test(fileName) || fileName.includes('node_modules/')) continue;
      rootFiles.push(relativeTo(projectCwd, fileName));
    }
    const generatedConfig = join(projectCwd, 'tsconfig.json');
    if (generatedConfig in files) continue;
    files[generatedConfig] = JSON.stringify({ compilerOptions, files: rootFiles }, null, 2);
    projects.push({
      name,
      files,
      symlinks,
      cwd: projectCwd,
      args: [
        ['--explainFiles', '--listFilesOnly', ...external],
        ['--showConfig', ...external],
        ...(/node_modules|package\.json|@trace/i.test(code)
          ? [['--listFilesOnly', '--traceResolution', ...external]]
          : []),
      ],
    });
  }
  return projects;
}

/** A test file name as a path relative to the project directory, which stands for `/`. */
function toProjectPath(fileName, cwd) {
  if (/^[a-zA-Z]:|\\|^\w+:\/\//.test(fileName)) return undefined;
  const absolute = fileName.startsWith('/') ? fileName : cwd.replace(/\/$/, '') + '/' + fileName;
  const parts = [];
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length === 0 ? '.' : parts.join('/');
}

function relativeTo(from, to) {
  const a = from === '.' ? [] : from.split('/');
  const b = to.split('/');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
}
