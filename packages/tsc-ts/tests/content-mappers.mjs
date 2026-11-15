// The content mappers of tsgo's compiler tests (its testutil/contentmappertest package), which the upstream
// cases named contentMapper*.ts select by the `exec` of their mapper's package.json. Each answers the
// requests of the protocol with what tsgo's mapper answers, as plain JSON values. They count positions in
// UTF-8 bytes, as tsgo's do, so they work on the bytes of a file.

/** The names of the mappers, which are the commands their manifests declare. */
export const transformingMapper = 'compiler-test-mapper';
export const failingMapper = 'failing-mapper';
export const lispMapper = 'lisp-mapper';
export const supplementalMapper = 'supplemental-mapper';
export const supplementalDiagnosticsMapper = 'supplemental-diagnostics-mapper';
export const supplementalGlobalsMapper = 'supplemental-globals-mapper';
export const supplementalModuleMapper = 'supplemental-module-mapper';

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const initializeResult = (diagnosticSource) => ({ positionEncoding: 'utf-8', diagnosticSource });
const unexpectedMethod = (method) => new Error(`contentmappertest: unexpected method ${JSON.stringify(method)}`);

/** An output that is the content itself, mapped verbatim. */
function identityMappedOutput(content) {
  const length = byteLength(content);
  return { text: content, extension: '.ts', mappings: [[0, length, 0, length, 0]] };
}

/** A mapper that answers `initialize` with a diagnostic source and `transform` with `transform(params)`. */
function mapper(diagnosticSource, transform) {
  return {
    handleRequest(method, params) {
      if (method === 'initialize') return initializeResult(diagnosticSource);
      if (method === 'transform') return transform(params);
      throw unexpectedMethod(method);
    },
  };
}

// ---- The transforming mapper

const preamble = 'const __VERSION = "1.0.0";\n';
const newLine = 0x0a;

/**
 * The `.box` mapper. It writes a preamble, copies the content, and replaces each `#{name}` by the project's
 * compiler option `name` as JSON, or by `undefined`; an interpolation that does not close on its line is an
 * error of the file. `// @box-extension: .tsx` on the first line selects the virtual extension, and
 * `// @box-ignore` and `// @box-expect-error: message` lines are diagnostic directives for the next line.
 * `SpanMap` and `SpanMapSegment` are the compiled span map's, which finds the virtual range of a line.
 */
function transformingHandler({ SpanMap, SpanMapSegment }) {
  /** Each open project's compiler options, by project handle. */
  const compilerOptions = new Map();

  function transform(content, options) {
    const bytes = Buffer.from(content, 'utf8');
    const virtual = [Buffer.from(preamble, 'utf8')];
    let virtualLength = virtual[0].length;
    const tuples = [];
    const diagnostics = [];
    const write = (piece, from, to, kind) => {
      tuples.push([virtualLength, piece.length, from, to - from, kind]);
      virtual.push(piece);
      virtualLength += piece.length;
    };
    const writeVerbatim = (from, to) => {
      if (to > from) write(bytes.subarray(from, to), from, to, 0);
    };
    const writeAtom = (value, from, to) => write(Buffer.from(value, 'utf8'), from, to, 1);

    let pos = 0;
    while (pos < bytes.length) {
      const tokenStart = bytes.indexOf('#{', pos);
      if (tokenStart < 0) {
        writeVerbatim(pos, bytes.length);
        break;
      }
      let lineEnd = bytes.indexOf(newLine, tokenStart);
      if (lineEnd < 0) lineEnd = bytes.length;
      const close = bytes.subarray(tokenStart, lineEnd).indexOf('}');
      writeVerbatim(pos, tokenStart);
      if (close < 0) {
        writeAtom('undefined', tokenStart, lineEnd);
        diagnostics.push({
          messageText: 'Unclosed interpolation.',
          start: tokenStart,
          length: lineEnd - tokenStart,
          code: 1000,
        });
        pos = lineEnd;
        continue;
      }
      const tokenEnd = tokenStart + close + 1;
      const name = bytes.subarray(tokenStart + 2, tokenEnd - 1).toString('utf8');
      writeAtom(Object.hasOwn(options, name) ? JSON.stringify(options[name]) : 'undefined', tokenStart, tokenEnd);
      pos = tokenEnd;
    }
    const result = { text: Buffer.concat(virtual).toString('utf8'), extension: mappedExtension(content) };
    // The response leaves out an empty list, as tsgo's JSON encoding of it does.
    if (tuples.length > 0) result.mappings = tuples;
    const directives = diagnosticDirectives(bytes, tuples);
    if (directives !== undefined) result.diagnosticDirectives = directives;
    if (diagnostics.length > 0) result.diagnostics = diagnostics;
    return result;
  }

  function mappedExtension(content) {
    const prefix = '// @box-extension:';
    const end = content.indexOf('\n');
    return end >= 0 && content.startsWith(prefix) ? content.slice(prefix.length, end).trim() : '.ts';
  }

  function diagnosticDirectives(bytes, tuples) {
    const wrap = (directives, ...unused) => ({ unusedExpectDirectiveDiagnostics: unused, directives });
    const line = (start) => {
      const end = bytes.indexOf(newLine, start);
      return end < 0 ? bytes.length : end;
    };
    const text = (start, end) => bytes.subarray(start, end).toString('utf8');
    const invalidPrefix = '// @box-invalid-directive:';
    if (text(0, invalidPrefix.length) === invalidPrefix)
      switch (text(invalidPrefix.length, line(0)).trim()) {
        case 'invalid-range':
          return wrap([[0, 0, -1, 0, 0]]);
        case 'original-range-out-of-bounds':
          return wrap([[bytes.length + 1, 0, 0, 0, 0]]);
        case 'virtual-range-out-of-bounds':
          return wrap([[0, 0, 1 << 20, 1 << 20, 0]]);
        case 'invalid-policy':
          return wrap([[0, 0, 0, 0, 2]]);
        case 'ignore-with-unused-diagnostic':
          return wrap([[0, 0, 0, 0, 0]], { code: 0, messageText: '' });
        case 'expect-without-unused-diagnostic':
          return wrap([[0, 0, 0, 0, 1]]);
        case 'invalid-unused-diagnostic-index':
          return wrap([[0, 0, 0, 0, 1, 1]], { code: 0, messageText: '' });
        case 'overlap':
          return wrap([
            [0, 0, 0, 2, 0],
            [0, 0, 1, 3, 0],
          ]);
      }
    const segments = tuples.map(
      ([virtualStart, virtualLength, originalStart, originalLength, kind]) =>
        new SpanMapSegment(
          virtualStart,
          virtualStart + virtualLength,
          originalStart,
          originalStart + originalLength,
          kind,
          (1 << 20) - 1,
        ),
    );
    const mappings = new SpanMap(segments);
    const expectPrefix = '// @box-expect-error:';
    const directives = [];
    const unused = [];
    for (let lineStart = 0; lineStart < bytes.length;) {
      const lineEnd = line(lineStart);
      const trimmed = text(lineStart, lineEnd).trim();
      let policy;
      if (trimmed === '// @box-ignore') policy = 0;
      else if (trimmed.startsWith(expectPrefix)) {
        policy = 1;
        unused.push({ code: 2578, messageText: trimmed.slice(expectPrefix.length).trim() });
      }
      if (policy !== undefined && lineEnd < bytes.length) {
        const affectedStart = lineEnd + 1;
        const spans = mappings.originalToVirtualSpans(affectedStart, line(affectedStart), (1 << 20) - 1);
        if (spans.length === 1) {
          const directive = [lineStart, lineEnd - lineStart, spans[0].pos, spans[0].end, policy];
          if (policy === 1) directive.push(unused.length - 1);
          directives.push(directive);
        }
      }
      if (lineEnd === bytes.length) break;
      lineStart = lineEnd + 1;
    }
    // One unused diagnostic is the default of every directive, which then leaves the index out.
    if (unused.length === 1) for (const directive of directives) directive.length = 5;
    return directives.length === 0 && unused.length === 0 ? undefined : wrap(directives, ...unused);
  }

  return {
    openProject(params) {
      compilerOptions.set(params.projectHandle, params.compilerOptions);
    },
    closeProject(params) {
      compilerOptions.delete(params.projectHandle);
    },
    handleRequest(method, params) {
      if (method === 'initialize') return initializeResult('box');
      if (method !== 'transform') throw unexpectedMethod(method);
      const options = compilerOptions.get(params.projectHandle);
      if (options == null)
        throw new Error(`contentmappertest: project ${JSON.stringify(params.projectHandle)} is not open`);
      return transform(params.content, options);
    },
  };
}

// ---- The other mappers

/** A mapper that fails every transform. */
const failingHandler = () =>
  mapper('mapper', () => {
    throw new Error('content mapper failed to transform the file');
  });

/** A mapper of one Lisp expression, whose `+` is an alias of the virtual `add`. */
const lispHandler = () =>
  mapper('lisp', ({ content }) => {
    const expression = content.endsWith('\n') ? content.slice(0, -1) : content;
    if (expression !== '(+ 1 2 "oops")')
      throw new Error(`contentmappertest: unsupported Lisp expression ${JSON.stringify(content)}`);
    return {
      text: 'add(1, 2, "oops");',
      extension: '.ts',
      mappings: [
        [0, 3, 1, 1, 2],
        [4, 1, 3, 1, 0],
        [7, 1, 5, 1, 0],
        [10, 6, 7, 6, 0],
      ],
    };
  });

/** A mapper whose canonical output is an empty module and whose supplemental output is the content. */
const supplementalHandler = () =>
  mapper('mapper', ({ content }) => ({
    text: 'export {};',
    extension: '.ts',
    supplemental: [identityMappedOutput(content)],
  }));

/** As `supplementalHandler`, with a line before the content that has a type error and no original. */
const supplementalDiagnosticsHandler = () =>
  mapper('mapper', ({ content }) => {
    const prefix = 'missingSupplementalGlobal;\n';
    const length = byteLength(content);
    return {
      text: 'export {};',
      extension: '.ts',
      supplemental: [
        { text: prefix + content, extension: '.ts', mappings: [[byteLength(prefix), length, 0, length, 0]] },
      ],
    };
  });

/** A mapper whose supplemental outputs are scripts that declare globals for each other's canonical output. */
const supplementalGlobalsHandler = () =>
  mapper('mapper', ({ fileName }) => {
    let supplemental;
    if (fileName.endsWith('/a.vue'))
      supplemental = '/// <reference path="./extra.d.ts" />\ninterface Shared extends Extra { value: string }';
    else if (fileName.endsWith('/b.vue')) supplemental = 'declare const shared: Shared;';
    else throw new Error(`contentmappertest: unexpected supplemental global input ${JSON.stringify(fileName)}`);
    return {
      text: 'export default shared.value;',
      extension: '.ts',
      supplemental: [{ text: supplemental, extension: '.ts' }],
    };
  });

/** A mapper whose supplemental output is a module with a type error. */
const supplementalModuleHandler = () =>
  mapper('mapper', () => ({
    text: 'export default 1;',
    extension: '.ts',
    supplemental: [{ text: 'export const privateValue: number = "wrong";', extension: '.ts' }],
  }));

const handlers = new Map([
  [transformingMapper, transformingHandler],
  [failingMapper, failingHandler],
  [lispMapper, lispHandler],
  [supplementalMapper, supplementalHandler],
  [supplementalDiagnosticsMapper, supplementalDiagnosticsHandler],
  [supplementalGlobalsMapper, supplementalGlobalsHandler],
  [supplementalModuleMapper, supplementalModuleHandler],
]);

/**
 * Answers `openProject` and `closeProject` for a mapper without configuration of its own, telling the mapper
 * when it wants to know. A project whose mapper options are `{"plugins":[{"name":1}]}` gets an option
 * diagnostic for the name.
 */
function staticProjectHandler(handler) {
  return {
    handleRequest(method, params) {
      if (method === 'openProject') {
        handler.openProject?.(params);
        const result = { configIdentity: '' };
        if (JSON.stringify(params.options) === '{"plugins":[{"name":1}]}')
          result.optionDiagnostics = [
            { path: ['plugins', 0, 'name'], messageText: "Option 'name' requires a string.", code: 123 },
          ];
        return result;
      }
      if (method === 'closeProject') {
        handler.closeProject?.(params);
        return null;
      }
      return handler.handleRequest(method, params);
    },
  };
}

/**
 * The `spawn` of an in-process host (content-mapper-host.mjs) for these mappers: it starts the mapper that
 * the first word of a command names. `spanMap` holds the exports of the compiled span-map.js.
 */
export function createTestMapperSpawner(spanMap) {
  return (command) => {
    const create = handlers.get(command[0]);
    if (create === undefined) throw new Error(`contentmappertest: unknown mapper command [${command.join(' ')}]`);
    return staticProjectHandler(create(spanMap));
  };
}
