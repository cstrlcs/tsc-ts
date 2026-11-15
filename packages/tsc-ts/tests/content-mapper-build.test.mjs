// What `tsc --build` knows of content mappers without running one: which paths of a build info are those of
// supplemental virtual files, with the cases of tsgo's build task test, which outputs a project has for a mapped
// file, and when two readings of a config tell a project's mappers the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileSources } from './temp.mjs';

const out = compileSources('tsc-ts-content-mapper-build-', ['compiler/tsc-build.ts']);
const load = (path) => import(pathToFileURL(join(out, path)).href);
const { getOutputFileNames, isContentMapperSupplementalBuildInfoPath, sameContentMapperProject } =
  await load('compiler/tsc-build.js');
const { ContentMapper, ContentMapperDefinition, ContentMapperManifest } = await load('compiler/content-mapper.js');
const { ParsedCommandLine } = await load('compiler/tsconfig.js');

test('the supplemental virtual files of root files are told from other paths', () => {
  const roots = ['/src/app.vue', '/src/index.ts'];
  const supplemental = (path) => isContentMapperSupplementalBuildInfoPath(path, roots);
  // The cases of tsgo's TestIsContentMapperSupplementalBuildInfoPath.
  assert.equal(supplemental('/src/app.vue.0.ts'), true);
  assert.equal(supplemental('/src/app.vue.12.mts'), true);
  assert.equal(supplemental('/src/app.vue.ts'), false);
  assert.equal(supplemental('/src/app.vue.0.txt'), false);
  assert.equal(supplemental('/src/other.vue.0.ts'), false);
  // The number is one Go's strconv.Atoi reads, and the extension all that follows it.
  assert.equal(supplemental('/src/index.ts.+3.tsx'), true);
  assert.equal(supplemental('/src/app.vue.-1.json'), true);
  assert.equal(supplemental('/src/app.vue.0.d.ts'), false);
  for (const path of ['/src/app.vue', '/src/app.vue.', '/src/app.vue.0', '/src/app.vue.0.', '/src/app.vue..ts'])
    assert.equal(supplemental(path), false, path);
  for (const path of ['/src/app.vue.1e1.ts', '/src/app.vue.0x1.ts', '/src/app.vue.+.ts', '/src/app.vue.1_0.ts'])
    assert.equal(supplemental(path), false, path);
  assert.equal(isContentMapperSupplementalBuildInfoPath('/src/app.vue.0.ts', []), false);
});

test('the declaration map of a mapped file is no output of its project', () => {
  // As tsgo's GetOutputFileNames, which leaves out the map of a file a content mapper transforms.
  const definition = new ContentMapperDefinition();
  definition.package = 'mapper';
  definition.extensions = ['.vue'];
  const options = { outDir: '/dist', rootDir: '/src', declaration: true, declarationMap: true };
  const config = new ParsedCommandLine(
    options,
    undefined,
    ['/src/Component.vue', '/src/a.ts'],
    [],
    undefined,
    [],
    '/',
    true,
    2,
  );
  const maps = () => getOutputFileNames(config).filter((name) => name.endsWith('.map'));
  assert.equal(maps().length, 2);
  config.contentMappers = [new ContentMapper(definition)];
  assert.deepEqual(maps(), ['/dist/a.d.ts.map']);
});

test('two readings of a config tell its content mappers the same of the project or not', () => {
  const mapper = (version = '1.0.0', options = undefined) => {
    const definition = new ContentMapperDefinition();
    definition.package = 'mapper';
    definition.extensions = ['.vue'];
    definition.options = options;
    const result = new ContentMapper(definition);
    result.manifest = new ContentMapperManifest('mapper', version, ['run'], undefined, false, undefined);
    result.packageDirectory = '/project/node_modules/mapper';
    return result;
  };
  const config = (options, mappers, fileNames = ['/project/a.ts'], configName = '/project/tsconfig.json') => {
    // Of a config file, only its name is read here.
    const configFile = { sourceFile: { fileName: configName } };
    const parsed = new ParsedCommandLine(options, undefined, fileNames, [], configFile, [], '/project', true, 0);
    parsed.contentMappers = mappers;
    return parsed;
  };
  const base = config({ strict: true }, [mapper()]);
  // The files of the config are not told to a mapper, and an equal mapper is the same one.
  assert.equal(sameContentMapperProject(base, config({ strict: true }, [mapper()], ['/project/b.ts'])), true);
  assert.equal(sameContentMapperProject(base, base), true);
  for (const other of [
    config({ strict: true }, []),
    config({ strict: true }, [mapper(), mapper()]),
    config({ strict: true }, [mapper('2.0.0')]),
    config({ strict: true }, [mapper('1.0.0', '{"a":1}')]),
    config({ strict: false }, [mapper()]),
    config({ strict: true, target: 9 }, [mapper()]),
    config({ strict: true }, [mapper()], ['/project/a.ts'], '/project/tsconfig.app.json'),
  ])
    assert.equal(sameContentMapperProject(base, other), false);
});
