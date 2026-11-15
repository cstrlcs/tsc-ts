// A ContentMapperHost (src/compiler/content-mapper.ts) whose mappers are objects in this process, as tsgo's
// tests run theirs over a pipe. It speaks the protocol of content-mapper-protocol.ts with them: it writes each
// request's parameters as JSON and decodes each response from JSON, so a mapper sees what a process would.

/**
 * The host. `compiled` holds the exports of the compiled content-mapper.js, content-mapper-protocol.js and
 * package-json.js. `spawn(command)` returns the mapper for the `exec` of a manifest: an object whose
 * `handleRequest(method, params)` returns the result of a request, or throws to fail it. The host starts a
 * mapper with its first request, once per mapper identity. `host.requests` lists the requests sent, each as
 * `[method, parameters as JSON text]`.
 */
export function createInProcessHost(compiled, spawn) {
  const {
    combinedIdentity,
    ContentMapperProjectSpec,
    ContentMapperTimings,
    decodeInitializeResult,
    decodeOpenProjectResult,
    decodeTransformResult,
    InitializeError,
    marshalCloseProjectParams,
    marshalInitializeParams,
    marshalOpenProjectParams,
    marshalTransformParams,
    parseJson,
    ProjectError,
    RequestError,
    TransformError,
  } = compiled;
  // The kinds of TransformError and InitializeError used here; const enums leave no object to import.
  const TransformErrorKind = { Unknown: 0, Initialize: 1, Project: 2, Request: 3 };
  const InitializeErrorKind = { ProcessStart: 0, Request: 4 };

  const host = {
    requests: [],
    locale: '',
    /** By mapper identity: `{ mapper, initialized }` for a mapper that runs, or the error that it does not. */
    connections: new Map(),
    nextProjectId: 0,

    timings() {
      return new ContentMapperTimings(new Map(), 0);
    },
    project(spec) {
      return createProject(spec);
    },
    acquire() {
      return () => {};
    },
    setLocale(locale) {
      host.locale = locale;
      host.connections.clear();
    },
    transform(mapper, request) {
      const project = createProject(new ContentMapperProjectSpec('', [mapper], {}));
      const result = project.transform(mapper, request);
      project.close();
      return result;
    },
    close() {
      host.connections.clear();
    },
  };

  /** Sends a request and returns its result as parsed JSON, or a RequestError with tsgo's text for a failed call. */
  function call(connection, method, params) {
    host.requests.push([method, params]);
    let result;
    try {
      result = connection.mapper.handleRequest(method, JSON.parse(params));
    } catch (error) {
      return new RequestError(`ipc: remote error [-32603]: ${error.message}`);
    }
    return parseJson(JSON.stringify(result ?? null));
  }

  function connect(mapper) {
    const exec = mapper.manifest.exec ?? [];
    if (exec.length === 0)
      return new RequestError(`content mapper ${JSON.stringify(mapper.definition.package)} declares no command to run`);
    const connection = { mapper: undefined, initialized: undefined };
    const fail = (kind, detail) => {
      const error = new InitializeError(kind);
      error.detail = detail;
      return error;
    };
    let failure;
    try {
      connection.mapper = spawn(exec);
    } catch (error) {
      failure = fail(InitializeErrorKind.ProcessStart, error.message);
      failure.command = exec[0];
    }
    if (failure === undefined) {
      const response = call(connection, 'initialize', marshalInitializeParams(host.locale));
      if (response instanceof RequestError) failure = fail(InitializeErrorKind.Request, response.message);
      else {
        const initialized = decodeInitializeResult(response);
        if (initialized instanceof InitializeError) failure = initialized;
        else connection.initialized = initialized;
      }
    }
    if (failure === undefined) return connection;
    failure.mapperName = mapper.diagnosticName();
    return failure;
  }

  /** The connection of a mapper, started on first use; a mapper that failed to start is not started again. */
  function connectionFor(mapper) {
    const identity = mapper.identity();
    let connection = host.connections.get(identity);
    if (connection === undefined) {
      connection = connect(mapper);
      host.connections.set(identity, connection);
    }
    return connection;
  }

  function createProject(spec) {
    const entries = new Map();
    for (const mapper of spec.mappers)
      entries.set(mapper, {
        projectHandle: `${mapper.identity()}:${host.nextProjectId++}`,
        opened: undefined,
      });

    /** Opens the mapper's project if it is not open. Returns the failure, if any. */
    function open(mapper, entry) {
      if (entry.opened !== undefined) return undefined;
      const connection = connectionFor(mapper);
      if (connection.mapper === undefined) return connection;
      const params = marshalOpenProjectParams(spec.configFileName, entry.projectHandle, mapper, spec.compilerOptions);
      const response = call(connection, 'openProject', params);
      if (response instanceof RequestError) return response;
      const opened = decodeOpenProjectResult(response, mapper, connection.initialized.diagnosticSource);
      if (opened instanceof ProjectError) return opened;
      entry.opened = opened;
      return undefined;
    }

    function closeOpened() {
      let failure;
      for (const [mapper, entry] of entries) {
        if (entry.opened === undefined) continue;
        entry.opened = undefined;
        const connection = host.connections.get(mapper.identity());
        if (connection === undefined || connection.mapper === undefined) continue;
        const response = call(connection, 'closeProject', marshalCloseProjectParams(entry.projectHandle));
        if (response instanceof RequestError) failure ??= response;
      }
      return failure;
    }

    return {
      refresh: closeOpened,
      identities() {
        const identities = [];
        for (const mapper of spec.mappers) {
          const identity = this.identity(mapper);
          if (typeof identity !== 'string') return identity;
          identities.push(identity);
        }
        return identities;
      },
      identity(mapper) {
        const entry = entries.get(mapper);
        if (entry === undefined) return '';
        if (!mapper.manifest.dynamicConfig) return combinedIdentity(mapper, undefined, spec.compilerOptions);
        const failure = open(mapper, entry);
        if (failure !== undefined) return failure;
        return combinedIdentity(mapper, entry.opened.configIdentity, spec.compilerOptions);
      },
      watchedFiles() {
        const files = new Set();
        for (const [mapper, entry] of entries) {
          if (mapper.manifest.dynamicConfig) {
            const failure = open(mapper, entry);
            if (failure !== undefined) return failure;
          }
          for (const file of entry.opened?.watchedFiles ?? []) files.add(file);
        }
        return Array.from(files).sort();
      },
      diagnostics() {
        const diagnostics = [];
        for (const mapper of spec.mappers) diagnostics.push(...(entries.get(mapper)?.opened?.optionDiagnostics ?? []));
        return diagnostics;
      },
      transform(mapper, request) {
        const entry = entries.get(mapper);
        if (entry === undefined)
          return new TransformError(TransformErrorKind.Unknown, new RequestError('content mapper project is closed'));
        const failure = open(mapper, entry);
        if (failure !== undefined)
          return new TransformError(
            failure instanceof InitializeError ? TransformErrorKind.Initialize : TransformErrorKind.Project,
            failure,
          );
        const connection = connectionFor(mapper);
        const params = marshalTransformParams(request.fileName, request.content, entry.projectHandle);
        const response = call(connection, 'transform', params);
        if (response instanceof RequestError) return new TransformError(TransformErrorKind.Request, response);
        const { positionEncoding, diagnosticSource } = connection.initialized;
        return decodeTransformResult(response, request.content, positionEncoding, diagnosticSource);
      },
      close() {
        const failure = closeOpened();
        entries.clear();
        return failure;
      },
    };
  }

  return host;
}
