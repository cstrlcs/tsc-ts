// The content mappers a host of tsc-ts's public API runs itself (`ProgramHost.contentMappers`), as the compiler
// runs the mappers of a project: each is a mapper of the program's config, and a project of them transforms
// files by calling the host.

import {
  combinedIdentity,
  ContentMapper as CompilerContentMapper,
  ContentMapperDefinition,
  ContentMapperManifest,
  type ContentMapperOptionDiagnostic,
  type ContentMapperProject,
  type ContentMapperRequest,
  type ContentMapperResult,
  InitializeError,
  type ProjectFailure,
  RequestError,
  TransformError,
  TransformErrorKind,
  validateContentMapperExtensions,
} from '../compiler/content-mapper.js';
import { decodeInitializeResult, decodeTransformResult } from '../compiler/content-mapper-protocol.js';
import { createCompilerDiagnostic, type Diagnostic } from '../compiler/diagnostics.js';
import type { CompilerOptions } from '../compiler/options.js';
import { parseJson } from '../compiler/package-json.js';
import type { ContentMapper, ProgramHost } from './types.js';

/** The JSON-RPC code of the error a mapper process answers a request it fails with. */
const internalError = -32603;

/**
 * The content mappers of a host, as mappers of a config: `mappers` are what the config of a program has
 * (`ParsedCommandLine.contentMappers`), and `problems` what is wrong with the extensions they register,
 * which the config reports as it does for the mappers a config file declares.
 */
export class HostContentMappers {
  readonly mappers: readonly CompilerContentMapper[];
  readonly problems: readonly Diagnostic[];
  private readonly byMapper = new Map<CompilerContentMapper, ContentMapper>();

  constructor(host: ProgramHost) {
    const mappers: CompilerContentMapper[] = [];
    for (const hostMapper of host.contentMappers ?? []) {
      // A file is one a content mapper produced when it has the identity of the mapper.
      if (hostMapper.name === '') throw new TypeError('a content mapper of the host must have a name');
      const definition = new ContentMapperDefinition();
      definition.extensions = hostMapper.extensions.slice();
      const mapper = new CompilerContentMapper(definition);
      mapper.manifest = new ContentMapperManifest(
        hostMapper.name,
        hostMapper.version ?? '',
        undefined,
        undefined,
        false,
        undefined,
      );
      mappers.push(mapper);
      this.byMapper.set(mapper, hostMapper);
    }
    this.mappers = mappers;
    this.problems = validateContentMapperExtensions(mappers, host.useCaseSensitiveFileNames()).map((problem) =>
      createCompilerDiagnostic(problem.message, problem.extension),
    );
  }

  /** The mappers as a program with `options` runs them, or `undefined` for a host without mappers. */
  project(options: CompilerOptions): ContentMapperProject | undefined {
    return this.mappers.length === 0 ? undefined : new HostContentMapperProject(this.byMapper, options);
  }
}

/**
 * A project whose mappers are callbacks of the host. Each answers what a mapper process answers to
 * `transform`, which is decoded and checked as a process's response is; its positions are UTF-16 offsets. What
 * it declares stands for a process's answer to `initialize`, and is checked the same way.
 */
class HostContentMapperProject implements ContentMapperProject {
  constructor(
    private readonly mappers: ReadonlyMap<CompilerContentMapper, ContentMapper>,
    private readonly options: CompilerOptions,
  ) {}

  refresh(): ProjectFailure | undefined {
    return undefined;
  }

  identities(): string[] {
    const identities: string[] = [];
    for (const mapper of this.mappers.keys()) identities.push(this.identity(mapper));
    return identities;
  }

  /**
   * The identity of the mapper with what the host declares for it besides its name and version, its
   * diagnostic source, in the place of the configuration a mapper process reports for a project.
   */
  identity(mapper: CompilerContentMapper): string {
    const hostMapper = this.mappers.get(mapper);
    return hostMapper === undefined ? '' : combinedIdentity(mapper, hostMapper.diagnosticSource, this.options);
  }

  watchedFiles(): string[] {
    return [];
  }

  diagnostics(): ContentMapperOptionDiagnostic[] {
    return [];
  }

  transform(mapper: CompilerContentMapper, request: ContentMapperRequest): ContentMapperResult | TransformError {
    const hostMapper = this.mappers.get(mapper);
    if (hostMapper === undefined)
      return new TransformError(TransformErrorKind.Unknown, new RequestError('content mapper project is closed'));
    const initialized = decodeInitializeResult(
      parseJson(JSON.stringify({ positionEncoding: 'utf-16', diagnosticSource: hostMapper.diagnosticSource })),
    );
    if (initialized instanceof InitializeError) {
      initialized.mapperName = mapper.diagnosticName();
      return new TransformError(TransformErrorKind.Initialize, initialized);
    }
    let response: string | undefined;
    try {
      response = JSON.stringify(hostMapper.transform(request.fileName, request.content));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return new TransformError(
        TransformErrorKind.Request,
        new RequestError(`ipc: remote error [${internalError}]: ${message}`),
      );
    }
    // A result JSON cannot hold, as a text with half of a surrogate pair, is no response.
    const result = parseJson(response ?? 'null');
    if (result === undefined)
      return new TransformError(
        TransformErrorKind.Response,
        new RequestError('content mapper returned a malformed transform response'),
      );
    return decodeTransformResult(result, request.content, initialized.positionEncoding, initialized.diagnosticSource);
  }

  close(): ProjectFailure | undefined {
    return undefined;
  }
}
