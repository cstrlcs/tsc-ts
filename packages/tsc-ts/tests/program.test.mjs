// Compares tsconfig.json handling and program construction with tsgo (packages/tsgo/dist/tsgo): fixture projects
// and projects from TypeScript's test cases, run with --listFilesOnly, --explainFiles, --showConfig and
// --traceResolution. stdout, stderr and exit status must match exactly, except in the runs program-cases.mjs lists as
// differing from tsgo, which must differ as listed. Both compilers find the content mappers of TypeScript's test
// cases on PATH, as processes (content-mapper-server.mjs); a case that lets them run is given --runExternalCode.
// Set TSC_TS_CLI to a native build of src/drivers/cli.ts to test it instead of the JS build, PROGRAM_FILTER to
// a substring of project names to run only those, and PROGRAM_SHARD to `i/n` to run every nth run starting at the ith.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeMapperLaunchers } from './content-mapper-server.mjs';
import { fixtureProjects, testCaseProjects } from './program-cases.mjs';
import { compileSources, tempDir } from './temp.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const tsgo = join(root, 'packages/tsgo/dist/tsgo');
const bundledLibs = join(root, 'upstream/TypeScript/tsc/internal/bundled/libs');
const testsRoot = join(root, 'upstream/TypeScript/tsc/testdata/tests/cases');
const workers = Number(process.env.TEST_WORKERS ?? 12);
// Lets the many Node processes share compiled code (https://nodejs.org/api/module.html#module-compile-cache).
const compileCache = process.env.NODE_COMPILE_CACHE ? { NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE } : {};

const out = compileSources('tsc-ts-program-', ['drivers/cli.ts']);
const ours = process.env.TSC_TS_CLI ? [process.env.TSC_TS_CLI] : [process.execPath, join(out, 'drivers/cli.js')];
const decls = await import(pathToFileURL(join(out, 'compiler/option-declarations.js')).href);
// A launcher for each content mapper of TypeScript's test cases, which a mapper's package.json names by its `exec`.
const launchers = writeMapperLaunchers(tempDir('tsc-ts-program-mappers-'), join(out, 'compiler/span-map.js'));

/** Writes a project into a fresh directory; returns the directory to run in. */
function setUp(project) {
  const dir = tempDir('tsc-ts-project-');
  for (const [path, content] of Object.entries(project.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  for (const [link, target] of Object.entries(project.symlinks ?? {})) {
    const from = join(dir, link);
    mkdirSync(dirname(from), { recursive: true });
    if (!existsSync(join(dir, target))) mkdirSync(join(dir, target), { recursive: true });
    try {
      symlinkSync(join(dir, target), from);
    } catch {
      // An existing file of the same name.
    }
  }
  const cwd = join(dir, project.cwd ?? '.');
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

function run(command, args, cwd, variables = {}) {
  const env = {
    PATH: `${launchers}${delimiter}${process.env.PATH ?? ''}`,
    TSC_TS_BUNDLED_LIBS: bundledLibs,
    NO_COLOR: '1',
    ...compileCache,
    ...variables,
  };
  return new Promise((done) => {
    execFile(
      command[0],
      [...command.slice(1), ...args],
      { cwd, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 60000 },
      (error, stdout, stderr) => {
        const status = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        done({ stdout, stderr, status });
      },
    );
  });
}

async function pool(items, limit, fn) {
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

function firstDifference(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  for (let i = 0; i < Math.max(al.length, bl.length); i++) {
    if (al[i] !== bl[i]) return `line ${i + 1}: tsgo ${JSON.stringify(al[i])}, ours ${JSON.stringify(bl[i])}`;
  }
  return 'none';
}

/** Runs every argument list of every project with both compilers. */
async function compare(projects) {
  const filter = process.env.PROGRAM_FILTER;
  if (filter !== undefined) projects = projects.filter((project) => project.name.includes(filter));
  let runs = [];
  for (const project of projects) for (const args of project.args) runs.push({ project, args });
  const shard = /^(\d+)\/(\d+)$/.exec(process.env.PROGRAM_SHARD ?? '');
  if (shard !== null) {
    const [index, count] = [Number(shard[1]), Number(shard[2])];
    runs = runs.filter((_, i) => i % count === index - 1);
    projects = [...new Set(runs.map((r) => r.project))];
  }
  const counts = { projects: projects.length, runs: runs.length, matched: 0, seam: 0, differing: 0 };
  const failures = [];
  const directories = new Map();
  await pool(runs, workers, async ({ project, args }) => {
    let cwd = directories.get(project);
    if (cwd === undefined) {
      cwd = setUp(project);
      directories.set(project, cwd);
    }
    // Threads make tsgo's traces depend on timing (package.json lookups may or may not be cached yet), so both run
    // single-threaded.
    const runArgs = [...args, '--singleThreaded'];
    const [expected, actual] = await Promise.all([
      run([tsgo], runArgs, cwd, project.env),
      run(ours, runArgs, cwd, project.env),
    ]);
    const problems = [];
    if (expected.stdout !== actual.stdout) problems.push('stdout ' + firstDifference(expected.stdout, actual.stdout));
    if (expected.stderr !== actual.stderr) problems.push('stderr ' + firstDifference(expected.stderr, actual.stderr));
    if (expected.status !== actual.status) problems.push(`status tsgo ${expected.status}, ours ${actual.status}`);
    const differing = project.differsFromTsgo;
    if (differing !== undefined && args.includes(differing.arg)) {
      if (differing.difference.test(problems.join('\n'))) counts.differing++;
      else if (problems.length === 0)
        failures.push(`${project.name} ${JSON.stringify(args)}:\n    matches tsgo and is listed as differing`);
      else
        failures.push(
          `${project.name} ${JSON.stringify(args)}:\n    differs from tsgo in another way than listed\n    ` +
            problems.join('\n    '),
        );
      return;
    }
    if (problems.length === 0) counts.matched++;
    else failures.push(`${project.name} ${JSON.stringify(args)}:\n    ${problems.join('\n    ')}`);
  });
  return { counts, failures };
}

async function check(t, name, projects) {
  const { counts, failures } = await compare(projects);
  t.diagnostic(
    `${name}: ${counts.matched}/${counts.runs - counts.differing} runs match (${counts.projects} projects), ` +
      `${counts.differing} differ from tsgo as listed`,
  );
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} mismatches`);
}

const skip = !existsSync(tsgo) && 'needs packages/tsgo/dist/tsgo';

test('fixture projects', { skip }, (t) => check(t, 'fixtures', fixtureProjects()));

test('TypeScript test cases', { skip: skip || (!existsSync(testsRoot) && 'needs upstream/TypeScript') }, (t) =>
  check(t, 'test cases', testCaseProjects(testsRoot, decls.optionDeclarations)),
);
