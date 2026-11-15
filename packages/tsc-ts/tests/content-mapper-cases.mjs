// Cases for tsgo's content mapper host (packages/tsgo/oracles/contentmapper-oracle): a mapper, compiler options,
// a file and the mapper's responses. This module answers a case with what tsc-ts makes of it, in the shape of
// the oracle's answer, and compares the two.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInProcessHost } from './content-mapper-host.mjs';

/** tsgo's answers to `cases`, which are written to a file in `directory` for the oracle to read. */
export function runOracle(oracle, directory, cases) {
  const file = join(directory, 'content-mapper-cases.json');
  writeFileSync(file, JSON.stringify(cases));
  return JSON.parse(execFileSync(oracle, [file], { encoding: 'utf8', maxBuffer: 1 << 30 }));
}

/**
 * `compiled` holds the exports of the compiled content-mapper.js and content-mapper-protocol.js, and
 * `parseJson`, `MappingError`, `getScriptKindFromFileName` and `toHex` of the modules that define them.
 */
export function createCases(compiled) {
  const {
    ContentMapper,
    ContentMapperDefinition,
    ContentMapperManifest,
    ContentMapperProjectSpec,
    ContentMapperRequest,
    DiagnosticDirectiveError,
    getScriptKindFromFileName,
    getSupplementalFileName,
    getVirtualFileName,
    InitializeError,
    InvalidVirtualExtensionError,
    isModuleVirtualExtension,
    MappingError,
    marshalCompilerOptions,
    ProjectError,
    toHex,
    TransformError,
    validateResult,
  } = compiled;

  /** A mapper from the fields of tsgo's `Mapper`: the definition's, the manifest's and `contributionId`. */
  function mapper(fields) {
    const definition = new ContentMapperDefinition();
    definition.package = fields.package ?? '';
    definition.extensions = fields.extensions;
    if (fields.outputExtensions != null) definition.outputExtensions = new Map(Object.entries(fields.outputExtensions));
    if (fields.options !== undefined) definition.options = JSON.stringify(fields.options);
    const result = new ContentMapper(definition);
    result.manifest = new ContentMapperManifest(
      fields.name ?? '',
      fields.version ?? '',
      fields.exec,
      fields.compilerOptions,
      fields.dynamicConfig ?? false,
      fields.defaultOutputExtensions == null ? undefined : new Map(Object.entries(fields.defaultOutputExtensions)),
    );
    result.contributionId = fields.contributionId ?? '';
    return result;
  }

  /** tsc-ts compiler options from the JSON tsgo reads its own from. */
  function compilerOptions(value = {}) {
    const options = { ...value };
    if (value.paths !== undefined)
      options.paths = new Map(Object.entries(value.paths).map(([pattern, list]) => [pattern, list ?? undefined]));
    return options;
  }

  function describeError(error) {
    const out = { message: error.error() };
    let cause = error;
    if (error instanceof TransformError) {
      out.kind = error.kind;
      cause = error.cause;
    }
    if (cause instanceof InitializeError) out.initialize = [cause.kind, cause.positionEncoding, cause.diagnosticSource];
    if (cause instanceof ProjectError) out.project = cause.kind;
    if (cause instanceof InvalidVirtualExtensionError) out.extension = cause.extension;
    if (cause instanceof DiagnosticDirectiveError)
      out.directive = [cause.kind, cause.index, cause.supplementalIndex, cause.policy];
    if (cause instanceof MappingError) out.mapping = [cause.kind, cause.virtualPos, cause.originalPos];
    return out;
  }

  function describeOutput(output) {
    return {
      text: output.text,
      extension: output.virtualExtension,
      segments: output.mappings.segments.map((s) => [
        s.virtualStart,
        s.virtualEnd,
        s.originalStart,
        s.originalEnd,
        s.kind,
        s.features,
      ]),
      directives: output.diagnosticDirectives.map((d) => [
        d.originalPos,
        d.originalEnd,
        d.virtualPos,
        d.virtualEnd,
        d.policy,
        d.unusedCode,
        d.unusedMessageText,
        d.source,
      ]),
    };
  }

  /**
   * What tsc-ts makes of a case whose mapper `spawn` starts (as for `createInProcessHost`): the mapper's
   * identities, the compiler options as JSON, the parameters of each request, the decoded result of
   * transforming the case's file or its error, and the virtual files of the result.
   */
  function answer(item, spawn) {
    const m = mapper(item.mapper);
    const options = compilerOptions(item.compilerOptions);
    const host = createInProcessHost(compiled, spawn);
    const result = {
      identity: m.identity(),
      diagnosticName: m.diagnosticName(),
      compilerOptions: marshalCompilerOptions(options),
      declaredOptions: m.marshalDeclaredOptions(options),
      transformIdentity: toHex(m.transformIdentity(options)),
      parse: null,
    };
    const project = host.project(new ContentMapperProjectSpec(item.configFileName ?? '', [m], options));
    const transformed = project.transform(m, new ContentMapperRequest(item.fileName, item.content));
    if (transformed instanceof TransformError) result.transform = { error: describeError(transformed) };
    else {
      result.transform = {
        result: {
          ...describeOutput(transformed),
          diagnostics: transformed.diagnostics.map((d) => [d.pos, d.end, d.source, d.code, d.messageText]),
          supplemental: transformed.supplemental.map(describeOutput),
        },
      };
      const problem = validateResult(transformed, item.content);
      const file = (name, extension) => [name, getScriptKindFromFileName(name), isModuleVirtualExtension(extension)];
      if (problem !== undefined) result.parse = { error: describeError(problem) };
      else
        result.parse = {
          files: [
            file(getVirtualFileName(item.fileName, transformed.virtualExtension), transformed.virtualExtension),
            ...transformed.supplemental.map((output, i) =>
              file(getSupplementalFileName(item.fileName, i, output.virtualExtension), output.virtualExtension),
            ),
          ],
        };
    }
    const identity = project.identity(m);
    result.projectIdentity = typeof identity === 'string' ? identity : { error: describeError(identity) };
    const watched = project.watchedFiles();
    result.watchedFiles = Array.isArray(watched) ? watched : { error: describeError(watched) };
    result.optionDiagnostics = project
      .diagnostics()
      .map((d) => [
        d.path.map((segment) => (segment.isIndex ? segment.index : segment.property)),
        d.source,
        d.code,
        d.messageText,
      ]);
    project.close();
    result.params = Object.fromEntries(host.requests);
    return result;
  }

  /**
   * Asserts that the answers of tsc-ts to `cases` are tsgo's (`expected`). Returns the kinds of failure the
   * cases reached, one per stage and cause.
   */
  function assertSameAnswers(cases, answers, expected) {
    assert.equal(expected.length, cases.length);
    const outcomes = new Set();
    for (let i = 0; i < cases.length; i++) {
      const text = JSON.stringify(cases[i]);
      for (const part of [answers[i], expected[i]])
        for (const key of ['transform', 'parse', 'projectIdentity', 'watchedFiles']) {
          const error = part[key]?.error;
          if (error === undefined) continue;
          outcomes.add(`${key} ${error.kind ?? ''} ${Object.keys(error).sort().join(' ')}`);
          // Go's JSON decoder says `cannot` or `unable to`, chosen at random once per process.
          error.message = error.message.replace('json: unable to', 'json: cannot');
          // tsgo decodes the JSON text of a transform response and words a malformed one after its own types.
          if (
            error.initialize === undefined &&
            /json: |span map segment|malformed (transform response|position mappings)/.test(error.message)
          )
            error.message = 'malformed';
          // tsgo counts the offsets of a mapping error in bytes.
          if (error.mapping !== undefined && !/^[\0-\x7f]*$/.test(text)) error.mapping.length = 1;
        }
      assert.deepEqual(answers[i], expected[i], `case ${i}: ${text.slice(0, 400)}`);
    }
    return outcomes;
  }

  return { mapper, compilerOptions, answer, assertSameAnswers };
}
