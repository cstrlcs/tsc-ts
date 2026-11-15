/**
 * Content mappers: plugins that turn a file the compiler cannot read, such as `App.vue`, into virtual
 * TypeScript while the program is built.
 *
 * A config file declares a mapper in `contentMappers` (`ContentMapperDefinition`), the `package.json` of the
 * mapper's package says how to run it (`ContentMapperManifest`), and the two together are a `ContentMapper`.
 * A `ContentMapperHost` runs the mappers and a `ContentMapperProject` is its view for one project, which the
 * file loader asks to transform a file. The answer (`ContentMapperResult`) is the virtual text, the extension
 * that says how to parse it, the span map back to the original and any supplemental virtual files.
 *
 * ```ts
 * const manifest = readContentMapperManifest('vue-mapper', packageJsonText); // a manifest or a diagnostic
 * const result = project.transform(mapper, new ContentMapperRequest('/src/App.vue', text));
 * if (!(result instanceof TransformError)) getVirtualFileName('/src/App.vue', result.virtualExtension);
 * ```
 *
 * The protocol a mapper process speaks is in content-mapper-protocol.ts.
 */
import {
  compareCodePoints,
  createCompilerDiagnostic,
  Diagnostics,
  type Diagnostic,
  type DiagnosticMessage,
} from './diagnostics.js';
import type { SourceFile } from './ast.js';
import { compilerOptionNames, getCompilerOption, type CompilerOptions } from './options.js';
import { parseJson, type JsonValue } from './package-json.js';
import {
  getCanonicalFileName,
  removeTrailingDirectorySeparator,
  supportedJSExtensionsFlat,
  supportedTSExtensionsWithJsonFlat,
} from './path.js';
import type { MappingError, SpanMap } from './span-map.js';
import { hash128, hash128String, toHex } from './xxh3.js';

// ---- Mappers

/** A content mapper as an entry of a config file's `contentMappers` declares it. */
export class ContentMapperDefinition {
  /** The npm package that implements the mapper. */
  package = '';
  /** The file extensions the mapper registers, which the compiler does not read itself. */
  extensions: string[] | undefined = undefined;
  /**
   * The extension of the file a mapped file is emitted as, by source extension: the entry's own
   * `outputExtensions`, or the manifest's when the entry has none.
   */
  outputExtensions: Map<string, string> | undefined = undefined;
  /** The entry's `options` object as JSON text, passed to the mapper as it is. */
  options: string | undefined = undefined;
}

/** What the `package.json` of a mapper's package says about it: `name`, `version` and `typescript.contentMapper`. */
export class ContentMapperManifest {
  constructor(
    readonly name: string,
    readonly version: string,
    /** The command that runs the mapper and its arguments. */
    readonly exec: readonly string[] | undefined,
    /** The compiler options the mapper's output depends on. */
    readonly compilerOptions: readonly string[] | undefined,
    /** Whether the mapper reads configuration of its own, which it reports when a project opens. */
    readonly dynamicConfig: boolean,
    readonly defaultOutputExtensions: Map<string, string> | undefined,
  ) {}
}

const noManifest = new ContentMapperManifest('', '', undefined, undefined, false, undefined);

/** A mapper of a project: its definition and, once its package is found, its manifest and directory. */
export class ContentMapper {
  readonly definition: ContentMapperDefinition;
  manifest: ContentMapperManifest = noManifest;
  /** The real path of the package's directory, which is the mapper's working directory. */
  packageDirectory = '';
  /** The name an editor extension contributes a mapper under, for projects without a config file. */
  contributionId = '';

  constructor(definition: ContentMapperDefinition) {
    this.definition = definition;
  }

  /** The best name to show for the mapper, which exists even when its manifest could not be read. */
  diagnosticName(): string {
    if (this.manifest.name !== '') return this.manifest.name;
    if (this.definition.package !== '') return this.definition.package;
    return this.contributionId;
  }

  /** `name@version`, the name alone without a version, or `''` for a mapper without a manifest. */
  identity(): string {
    const identity = this.manifestIdentity();
    return this.contributionId === '' ? identity : `${this.contributionId} (${identity})`;
  }

  private manifestIdentity(): string {
    const { name, version } = this.manifest;
    return name === '' || version === '' ? name : `${name}@${version}`;
  }

  /** Whether `other` is configured in every respect as this mapper, not only named the same. */
  equals(other: ContentMapper): boolean {
    if (this === other) return true;
    const a = this.definition;
    const b = other.definition;
    const m = this.manifest;
    const n = other.manifest;
    return (
      a.package === b.package &&
      equalLists(a.extensions, b.extensions) &&
      equalMaps(a.outputExtensions, b.outputExtensions) &&
      a.options === b.options &&
      m.name === n.name &&
      m.version === n.version &&
      equalLists(m.exec, n.exec) &&
      equalLists(m.compilerOptions, n.compilerOptions) &&
      m.dynamicConfig === n.dynamicConfig &&
      equalMaps(m.defaultOutputExtensions, n.defaultOutputExtensions) &&
      this.packageDirectory === other.packageDirectory &&
      this.contributionId === other.contributionId
    );
  }

  /**
   * A 16-byte XXH3 digest of everything about the mapper and the project that its output depends on: its
   * identity, its options, the compiler options it declares and its output extensions. Caches of transformed
   * files and incremental builds compare it. Computing it never starts the mapper.
   */
  transformIdentity(options: CompilerOptions): Uint8Array {
    let text = `${this.identity()}\0${this.definition.options ?? ''}\0${this.marshalDeclaredOptions(options)}`;
    const outputExtensions = this.definition.outputExtensions;
    if (outputExtensions !== undefined && outputExtensions.size > 0) {
      const entries: string[] = [];
      for (const source of Array.from(outputExtensions.keys()).sort(compareCodePoints))
        entries.push(`${JSON.stringify(source)}:${JSON.stringify(outputExtensions.get(source))}`);
      text += `\0{${entries.join(',')}}`;
    }
    return hash128String(text);
  }

  /**
   * The compiler options this mapper declares, as a JSON object in the declared order. An option that is
   * not set, and a name that is no compiler option, is left out.
   */
  marshalDeclaredOptions(options: CompilerOptions): string {
    const declared = new Map<string, string>();
    for (const name of this.manifest.compilerOptions ?? []) {
      const value = marshalCompilerOption(options, name);
      if (value !== undefined) declared.set(name, value);
    }
    const entries: string[] = [];
    for (const [name, value] of declared) entries.push(`${JSON.stringify(name)}:${value}`);
    return `{${entries.join(',')}}`;
  }
}

function equalLists(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

function equalMaps(a: Map<string, string> | undefined, b: Map<string, string> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * The identity of `mapper` in a project, which names the transforms of its files: the mapper's identity and
 * a digest of its transform identity, joined for a mapper with `dynamicConfig` by the configuration identity
 * it reported when the project opened.
 */
export function combinedIdentity(
  mapper: ContentMapper,
  configIdentity: string | undefined,
  options: CompilerOptions,
): string {
  const transformIdentity = mapper.transformIdentity(options);
  const identity = mapper.identity();
  if (configIdentity === undefined) return `${identity}:${toHex(transformIdentity)}`;
  const prefix = new TextEncoder().encode(`${identity}\0${mapper.definition.options ?? ''}\0${configIdentity}\0`);
  const bytes = new Uint8Array(prefix.length + 16);
  bytes.set(prefix);
  // The digest's bytes, most significant first, as `toHex` prints them.
  for (let i = 0; i < 16; i++) bytes[prefix.length + i] = transformIdentity[15 - i];
  return `${identity}:${toHex(hash128(bytes))}`;
}

// ---- Compiler options as JSON

/** The compiler options whose value 0 is a count and not an unset enum. */
const countOptions: readonly string[] = ['maxNodeModuleJsDepth', 'checkers'];

/** The JSON of one compiler option as tsgo writes it, or `undefined` for an option that is not set. */
function marshalCompilerOption(options: CompilerOptions, name: string): string | undefined {
  if (name === 'paths') {
    if (options.paths === undefined) return undefined;
    const entries: string[] = [];
    for (const [pattern, substitutions] of options.paths)
      entries.push(`${JSON.stringify(pattern)}:${marshalStrings(substitutions ?? [])}`);
    return `{${entries.join(',')}}`;
  }
  if (name === 'plugins') {
    if (options.plugins === undefined) return undefined;
    const plugins: string[] = [];
    for (const plugin of options.plugins) plugins.push(`{"name":${JSON.stringify(plugin.name)}}`);
    return `[${plugins.join(',')}]`;
  }
  const value = getCompilerOption(options, name);
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return value === 0 && !countOptions.includes(name) ? undefined : String(value);
  if (typeof value === 'string') return value === '' ? undefined : JSON.stringify(value);
  return marshalStrings(value);
}

function marshalStrings(values: readonly string[]): string {
  const items: string[] = [];
  for (const value of values) items.push(JSON.stringify(value));
  return `[${items.join(',')}]`;
}

/**
 * Compiler options as the JSON object tsgo sends to a mapper when a project opens: the options that are set,
 * in tsgo's field order, with enums as numbers.
 */
export function marshalCompilerOptions(options: CompilerOptions): string {
  const entries: string[] = [];
  for (const name of compilerOptionNames) {
    const value = marshalCompilerOption(options, name);
    if (value !== undefined) entries.push(`${JSON.stringify(name)}:${value}`);
  }
  return `{${entries.join(',')}}`;
}

// ---- Extensions

/** The extensions a virtual file may have, which say how its text is parsed. */
const supportedVirtualExtensions: readonly string[] = [
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
];

/** Whether a mapper may give a virtual file this extension. */
export function isSupportedVirtualExtension(extension: string): boolean {
  return supportedVirtualExtensions.includes(extension);
}

/** Whether `extension` is a `.` followed by at least one character, with no path separator. */
export function isValidExtension(extension: string): boolean {
  return extension.length > 1 && extension.startsWith('.') && !containsPathSeparator(extension);
}

function containsPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\');
}

/**
 * Whether `extension` ends, in any letter case, with an extension the compiler reads itself (`.ts`, `.d.ts`,
 * `.mjs`, `.json` and the others), so that no mapper may register it.
 */
export function hasReservedSourceExtension(extension: string): boolean {
  const endsWith = (native: string): boolean =>
    extension.length >= native.length && equalFold(extension.slice(extension.length - native.length), native);
  return supportedTSExtensionsWithJsonFlat.some(endsWith) || supportedJSExtensionsFlat.some(endsWith);
}

/**
 * Whether two strings are equal under Unicode simple case folding, as Go's `strings.EqualFold` tests it: code
 * point by code point, two being equal when one's lower-case or upper-case form is the other's.
 */
export function equalFold(a: string, b: string): boolean {
  if (a === b) return true;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = String.fromCodePoint(a.codePointAt(i) ?? 0);
    const y = String.fromCodePoint(b.codePointAt(j) ?? 0);
    i += x.length;
    j += y.length;
    if (x !== y && x.toLowerCase() !== y.toLowerCase() && x.toUpperCase() !== y.toUpperCase()) return false;
  }
  return i === a.length && j === b.length;
}

/** A problem with the extensions of an entry of `contentMappers`, and where in the entry it is. */
export class ContentMapperExtensionProblem {
  constructor(
    readonly message: DiagnosticMessage,
    /** The extension the message names. */
    readonly extension: string,
    /** The index of the mapper among those validated. */
    readonly mapper: number,
    /** Whether the extension is in the entry's `outputExtensions` rather than an element of its `extensions`. */
    readonly inOutputExtensions: boolean,
  ) {}
}

/**
 * Checks the extensions the mappers of a config file register, in order: each begins with `.`, has no path
 * separator, is not one the compiler reads itself and is registered once, where a file system that ignores
 * case ignores it here too. Each key and value of `outputExtensions` is a valid extension, and each key is
 * one of the mapper's valid extensions. An extension that fails is removed from its mapper's `extensions`.
 */
export function validateContentMapperExtensions(
  mappers: readonly ContentMapper[],
  useCaseSensitiveFileNames: boolean,
): ContentMapperExtensionProblem[] {
  const problems: ContentMapperExtensionProblem[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < mappers.length; index++) {
    const definition = mappers[index].definition;
    const valid: string[] = [];
    for (const extension of definition.extensions ?? []) {
      const canonical = getCanonicalFileName(extension, useCaseSensitiveFileNames);
      let message: DiagnosticMessage | undefined;
      if (!extension.startsWith('.')) message = Diagnostics.Content_mapper_file_extension_0_must_begin_with_a;
      else if (containsPathSeparator(extension))
        message = Diagnostics.Content_mapper_extension_0_must_not_contain_path_separators;
      else if (hasReservedSourceExtension(extension))
        message =
          Diagnostics.Content_mapper_file_extension_0_is_a_built_in_extension_and_cannot_be_registered_by_a_content_mapper;
      else if (seen.has(canonical))
        message = Diagnostics.Content_mapper_file_extension_0_is_registered_by_more_than_one_content_mapper;
      if (message !== undefined) {
        problems.push(new ContentMapperExtensionProblem(message, extension, index, false));
        continue;
      }
      seen.add(canonical);
      valid.push(extension);
    }
    definition.extensions = valid;
    const outputExtensions = definition.outputExtensions;
    if (outputExtensions === undefined) continue;
    for (const source of Array.from(outputExtensions.keys()).sort(compareCodePoints)) {
      for (const extension of [source, outputExtensions.get(source) ?? '']) {
        if (containsPathSeparator(extension))
          problems.push(
            new ContentMapperExtensionProblem(
              Diagnostics.Content_mapper_extension_0_must_not_contain_path_separators,
              extension,
              index,
              true,
            ),
          );
        else if (!isValidExtension(extension))
          problems.push(
            new ContentMapperExtensionProblem(
              Diagnostics.Content_mapper_output_extension_0_must_be_non_empty_and_begin_with_a,
              extension,
              index,
              true,
            ),
          );
      }
      const canonical = getCanonicalFileName(source, useCaseSensitiveFileNames);
      if (!valid.some((extension) => getCanonicalFileName(extension, useCaseSensitiveFileNames) === canonical))
        problems.push(
          new ContentMapperExtensionProblem(
            Diagnostics.Content_mapper_output_extension_mapping_source_0_is_not_registered_by_this_content_mapper,
            source,
            index,
            true,
          ),
        );
    }
  }
  return problems;
}

/**
 * The extension `outputExtensions` gives for a source extension, which with `ignoreCase` may be written in
 * another letter case there, or `undefined`.
 */
export function getContentMapperOutputExtension(
  outputExtensions: ReadonlyMap<string, string> | undefined,
  sourceExtension: string,
  ignoreCase: boolean,
): string | undefined {
  if (outputExtensions === undefined) return undefined;
  const output = outputExtensions.get(sourceExtension);
  if (output !== undefined || !ignoreCase) return output;
  for (const [source, candidate] of outputExtensions) if (equalFold(source, sourceExtension)) return candidate;
  return undefined;
}

/**
 * The mapper that registers the extension of `fileName`, or `undefined`. Of two registered extensions a file
 * name ends with, such as `.z` and `.y.z`, the longer decides.
 */
export function getContentMapperForFileName(
  mappers: readonly ContentMapper[],
  fileName: string,
  useCaseSensitiveFileNames: boolean,
): ContentMapper | undefined {
  const path = removeTrailingDirectorySeparator(fileName);
  const matches = (ending: string, extension: string): boolean =>
    ending === extension || (!useCaseSensitiveFileNames && equalFold(ending, extension));
  let longest = '';
  for (const mapper of mappers)
    for (const extension of mapper.definition.extensions ?? []) {
      if (extension.length <= longest.length || path.length < extension.length) continue;
      const ending = path.slice(path.length - extension.length);
      if (matches(ending, extension)) longest = ending;
    }
  if (longest === '') return undefined;
  for (const mapper of mappers)
    if (mapper.definition.extensions?.some((extension) => matches(longest, extension))) return mapper;
  return undefined;
}

// ---- The manifest

/** An array of strings, where `null` reads as `''` as it does into a Go string. */
function stringList(value: JsonValue | undefined): string[] | undefined {
  if (value === undefined || value.type !== 'array') return undefined;
  const result: string[] = [];
  for (const item of value.items) {
    if (item.type === 'string') result.push(item.value);
    else if (item.type === 'null') result.push('');
    else return undefined;
  }
  return result;
}

/**
 * The `compilerOptions` of a manifest. A list that is not all strings is kept up to its first other element,
 * which reads as `''`, as tsgo's decoder leaves it.
 */
function declaredCompilerOptions(value: JsonValue | undefined): string[] | undefined {
  if (value === undefined || value.type !== 'array') return undefined;
  const result: string[] = [];
  for (const item of value.items) {
    result.push(item.type === 'string' ? item.value : '');
    if (item.type !== 'string' && item.type !== 'null') break;
  }
  return result;
}

/** An object whose values are strings, where `null` reads as `''` as it does into a Go string. */
function stringMap(value: JsonValue): Map<string, string> | undefined {
  if (value.type !== 'object') return undefined;
  const result = new Map<string, string>();
  for (const [key, entry] of value.entries) {
    if (entry.type === 'string') result.set(key, entry.value);
    else if (entry.type === 'null') result.set(key, '');
    else return undefined;
  }
  return result;
}

/**
 * Reads the manifest of the mapper package `packageName` from the text of its `package.json`, or `undefined`
 * when the package or the file was not found. The package must have a `name` and a `typescript.contentMapper`
 * object whose `exec` is a non-empty array of strings; `compilerOptions`, `dynamicConfig` and
 * `outputExtensions` are optional. Nothing of the package runs. Returns the manifest, or the diagnostic that
 * says why there is none.
 */
export function readContentMapperManifest(
  packageName: string,
  packageJson: string | undefined,
): ContentMapperManifest | Diagnostic {
  if (packageJson === undefined)
    return createCompilerDiagnostic(Diagnostics.The_content_mapper_package_0_could_not_be_resolved, packageName);
  const parsed = parseJson(packageJson);
  if (parsed === undefined || (parsed.type !== 'object' && parsed.type !== 'null'))
    return createCompilerDiagnostic(
      Diagnostics.The_package_json_of_the_content_mapper_package_0_could_not_be_parsed,
      packageName,
    );
  const fields = parsed.type === 'object' ? parsed.entries : new Map<string, JsonValue>();
  const name = fields.get('name');
  if (name === undefined || name.type !== 'string' || name.value === '')
    return createCompilerDiagnostic(
      Diagnostics.The_package_json_of_the_content_mapper_package_0_does_not_specify_a_name,
      packageName,
    );
  const version = fields.get('version');
  const typeScript = fields.get('typescript');
  const contentMapper = typeScript?.type === 'object' ? typeScript.entries.get('contentMapper') : undefined;
  if (contentMapper === undefined || contentMapper.type !== 'object')
    return createCompilerDiagnostic(
      Diagnostics.The_package_json_of_the_content_mapper_package_0_does_not_declare_a_typescript_contentMapper_object,
      packageName,
    );
  const exec = stringList(contentMapper.entries.get('exec'));
  if (exec === undefined || exec.length === 0)
    return createCompilerDiagnostic(
      Diagnostics.The_typescript_contentMapper_exec_of_the_content_mapper_package_0_must_be_a_non_empty_array_of_strings,
      packageName,
    );
  const dynamicConfig = contentMapper.entries.get('dynamicConfig');
  let outputExtensions: Map<string, string> | undefined;
  const declared = contentMapper.entries.get('outputExtensions');
  if (declared !== undefined) {
    outputExtensions = stringMap(declared);
    if (outputExtensions === undefined)
      return createCompilerDiagnostic(
        Diagnostics.The_typescript_contentMapper_outputExtensions_of_the_content_mapper_package_0_must_be_an_object_with_string_values,
        packageName,
      );
    for (const source of Array.from(outputExtensions.keys()).sort(compareCodePoints)) {
      const output = outputExtensions.get(source) ?? '';
      for (const extension of [source, output])
        if (containsPathSeparator(extension))
          return createCompilerDiagnostic(
            Diagnostics.Content_mapper_extension_0_must_not_contain_path_separators,
            extension,
          );
      if (!isValidExtension(source) || !isValidExtension(output))
        return createCompilerDiagnostic(
          Diagnostics.The_typescript_contentMapper_outputExtensions_of_the_content_mapper_package_0_contains_an_invalid_mapping_from_1_to_2_Extensions_must_be_non_empty_and_begin_with_a,
          packageName,
          source,
          output,
        );
    }
  }
  return new ContentMapperManifest(
    name.value,
    version?.type === 'string' ? version.value : '',
    exec,
    declaredCompilerOptions(contentMapper.entries.get('compilerOptions')),
    dynamicConfig?.type === 'boolean' && dynamicConfig.value,
    outputExtensions,
  );
}

// ---- Transforms

/** The file a mapper is asked to transform. */
export class ContentMapperRequest {
  constructor(
    /** The absolute name of the file. */
    readonly fileName: string,
    /** The file's text. */
    readonly content: string,
  ) {}
}

/** What a diagnostic directive does with the TypeScript diagnostics in its virtual range. */
export const enum MappedDiagnosticDirectivePolicy {
  /** The diagnostics are not reported. */
  Ignore,
  /** The diagnostics are not reported, and the directive is an error when there are none. */
  Expect,
}

/**
 * A directive of the original file, such as a framework's `@ts-expect-error`, applied to a range of the
 * virtual text. Positions are UTF-16 offsets.
 */
export class MappedDiagnosticDirective {
  constructor(
    /** Where the directive is in the original text; 0 to 0 for an `Ignore` directive that named no valid range. */
    readonly originalPos: number,
    readonly originalEnd: number,
    /** The range of the virtual text whose diagnostics the directive governs. */
    readonly virtualPos: number,
    readonly virtualEnd: number,
    readonly policy: MappedDiagnosticDirectivePolicy,
    /** The code and message of the error reported for an `Expect` directive that suppressed nothing. */
    readonly unusedCode: number,
    readonly unusedMessageText: string,
    /** The mapper's diagnostic source, which prefixes `unusedCode`. */
    readonly source: string,
  ) {}
}

/** An error a mapper found in the original file, at UTF-16 offsets of the original text. */
export class MapperDiagnostic {
  constructor(
    readonly pos: number,
    readonly end: number,
    /** The prefix shown before the code, in place of `TS`. */
    readonly source: string,
    readonly code: number,
    /** The message, in the locale the mapper was started with. */
    readonly messageText: string,
  ) {}
}

/** One virtual source file and how it maps to the original file. */
export class MappedResult {
  constructor(
    /** The virtual source text the compiler parses. */
    readonly text: string,
    /** The extension that says how `text` is parsed. */
    readonly virtualExtension: string,
    /**
     * The map from `text` back to the original. A successful transform has one; an empty map describes text
     * that is synthesized as a whole.
     */
    readonly mappings: SpanMap | undefined,
    readonly diagnosticDirectives: readonly MappedDiagnosticDirective[],
  ) {}
}

/** The outcome of transforming one file: its canonical virtual file, and what else the mapper reported. */
export class ContentMapperResult extends MappedResult {
  constructor(
    text: string,
    virtualExtension: string,
    mappings: SpanMap | undefined,
    diagnosticDirectives: readonly MappedDiagnosticDirective[],
    /** Syntax errors of the original file. */
    readonly diagnostics: readonly MapperDiagnostic[],
    /** Further virtual files the program gets with this file, which have no name of their own. */
    readonly supplemental: readonly MappedResult[],
  ) {
    super(text, virtualExtension, mappings, diagnosticDirectives);
  }
}

/**
 * What a source file keeps of the transform that produced it: the file has the virtual text, parsed as its
 * virtual extension says, under the name of the original file. A supplemental virtual file has a name of its
 * own (`getSupplementalFileName`).
 */
export class ContentMapperSourceFileInfo {
  constructor(
    /** The identity of the mapper. */
    readonly contentMapper: string,
    /**
     * The identity of the mapper as the file's project configures it (`ContentMapperProject.identity`), or
     * the digest of its transform identity where the project cannot tell.
     */
    readonly transformIdentity: string,
    /** The file's name with its virtual extension, which decides its script kind and module format. */
    readonly virtualFileName: string,
    /** The text of the original file. */
    readonly originalText: string,
    /**
     * The map from the file's text back to `originalText`; `undefined` for the empty file that stands in for a
     * transform that failed.
     */
    readonly spanMap: SpanMap | undefined,
    readonly diagnosticDirectives: readonly MappedDiagnosticDirective[],
    /** The supplemental virtual files of a canonical file. */
    readonly supplementalSourceFiles: readonly SourceFile[],
    /** The canonical file of a supplemental virtual file. */
    readonly canonicalSourceFile: SourceFile | undefined,
  ) {}
}

// ---- Errors

/** The stage at which a transform failed. */
export const enum TransformErrorKind {
  Unknown,
  /** The mapper could not be started or did not complete `initialize`. */
  Initialize,
  /** The mapper's project could not be opened. */
  Project,
  /** The `transform` request failed. */
  Request,
  /** The response was malformed, or broke a rule of the protocol. */
  Response,
  /** The response had no position mappings. */
  Mappings,
}

/** A plain failure that has only a message: a request the mapper rejected, or a response that did not decode. */
export class RequestError {
  constructor(readonly message: string) {}

  error(): string {
    return this.message;
  }
}

/** Why a diagnostic directive of a transform response was rejected. */
export const enum DiagnosticDirectiveErrorKind {
  InvalidRange,
  InvalidPolicy,
  ExpectMissingUnusedDiagnostic,
  InvalidUnusedDiagnosticIndex,
  Overlap,
}

/** An invalid diagnostic directive of a transform response. */
export class DiagnosticDirectiveError {
  constructor(
    readonly kind: DiagnosticDirectiveErrorKind,
    /** The index of the directive in its output. */
    readonly index: number,
    /** The index of the supplemental output the directive is in, or `-1` for the canonical output. */
    readonly supplementalIndex: number,
    /** The policy of a directive rejected for it. */
    readonly policy: number,
  ) {}

  error(): string {
    return `invalid content mapper diagnostic directive ${this.index}`;
  }
}

/** A mapped output whose extension is missing or not one a virtual file may have. */
export class InvalidVirtualExtensionError {
  constructor(readonly extension: string) {}

  error(): string {
    return `invalid virtual extension ${JSON.stringify(this.extension)}`;
  }
}

/** Why a mapper's `openProject` response was rejected. */
export const enum ProjectErrorKind {
  MalformedResponse,
  MissingConfigIdentity,
  NonAbsoluteWatchedFile,
  UnexpectedConfigIdentity,
  UnexpectedWatchedFiles,
}

/** An invalid `openProject` response. */
export class ProjectError {
  constructor(readonly kind: ProjectErrorKind) {}

  error(): string {
    switch (this.kind) {
      case ProjectErrorKind.MalformedResponse:
        return 'content mapper returned a malformed project response';
      case ProjectErrorKind.MissingConfigIdentity:
        return 'content mapper did not return configIdentity for dynamic configuration';
      case ProjectErrorKind.NonAbsoluteWatchedFile:
        return 'content mapper returned a non-absolute path in watchedFiles';
      case ProjectErrorKind.UnexpectedConfigIdentity:
        return 'content mapper returned configIdentity without declaring dynamicConfig';
      case ProjectErrorKind.UnexpectedWatchedFiles:
        return 'content mapper returned watchedFiles without declaring dynamicConfig';
    }
  }
}

/** Why a mapper could not be started, or why its `initialize` response was rejected. */
export const enum InitializeErrorKind {
  ProcessStart,
  ProcessExit,
  NoResponse,
  InvalidResponse,
  Request,
  PositionEncoding,
  EmptyDiagnosticSource,
  ReservedDiagnosticSource,
}

/** A mapper that could not be started or initialized. A kind uses the fields its message names. */
export class InitializeError {
  /** The mapper's diagnostic name, which the host fills in. */
  mapperName = '';
  /** The command that could not be started. */
  command = '';
  /** What the system or the decoder said. */
  detail = '';
  exitCode = 0;
  timeoutSeconds = 0;
  /** The position encoding the mapper selected, or the diagnostic source it gave. */
  positionEncoding = '';
  diagnosticSource = '';

  constructor(readonly kind: InitializeErrorKind) {}

  error(): string {
    switch (this.kind) {
      case InitializeErrorKind.ProcessStart:
        return `could not start content mapper command ${JSON.stringify(this.command)}: ${this.detail}`;
      case InitializeErrorKind.ProcessExit:
        return `content mapper process exited before initialization with code ${this.exitCode}`;
      case InitializeErrorKind.NoResponse:
        return 'content mapper did not respond to the initialize request';
      case InitializeErrorKind.InvalidResponse:
        return `content mapper returned an invalid initialize response: ${this.detail}`;
      case InitializeErrorKind.Request:
        return `content mapper initialize request failed: ${this.detail}`;
      case InitializeErrorKind.PositionEncoding:
        return `unsupported position encoding ${JSON.stringify(this.positionEncoding)}`;
      case InitializeErrorKind.EmptyDiagnosticSource:
        return 'diagnostic source must not be empty';
      case InitializeErrorKind.ReservedDiagnosticSource:
        return `diagnostic source ${JSON.stringify(this.diagnosticSource)} is reserved by TypeScript`;
    }
  }
}

/** What a project of mappers can fail with outside a transform. */
export type ProjectFailure = InitializeError | ProjectError | RequestError;

/** What a `TransformError` can wrap. */
export type TransformErrorCause =
  | InitializeError
  | ProjectError
  | RequestError
  | InvalidVirtualExtensionError
  | DiagnosticDirectiveError;

/** A failure while preparing, requesting or decoding a transform. */
export class TransformError {
  constructor(
    readonly kind: TransformErrorKind,
    readonly cause: TransformErrorCause | undefined,
  ) {}

  error(): string {
    return `content mapper transform failed: ${this.cause === undefined ? '<nil>' : this.cause.error()}`;
  }
}

/** A supplemental virtual file whose name, which the compiler assigns, is that of a file on disk. */
export class SupplementalFileCollisionError {
  constructor(readonly fileName: string) {}

  error(): string {
    return `content mapper supplemental output file ${JSON.stringify(this.fileName)} already exists`;
  }
}

// ---- Virtual files

/**
 * The name the canonical virtual file of `fileName` has for its script kind and its emit: the file's name
 * with the virtual extension after it, `App.vue.tsx`. In the program the file keeps the name `fileName`.
 */
export function getVirtualFileName(fileName: string, virtualExtension: string): string {
  return fileName + virtualExtension;
}

/**
 * The name of the supplemental virtual file `index` of `fileName`, `App.vue.0.ts`. Its path is the path of
 * `fileName` with the same ending.
 */
export function getSupplementalFileName(fileName: string, index: number, virtualExtension: string): string {
  return `${fileName}.${index}${virtualExtension}`;
}

/** Whether a virtual file with this extension is a module whatever it contains: `.mts`, `.cts`, `.mjs`, `.cjs`. */
export function isModuleVirtualExtension(extension: string): boolean {
  return extension === '.mts' || extension === '.cts' || extension === '.mjs' || extension === '.cjs';
}

/**
 * Checks what a mapper returned for a file with the text `content` before it is parsed: the canonical output
 * and then each supplemental one has position mappings, which are valid for its text and `content`, and an
 * extension a virtual file may have. Returns the first violation, or `undefined`.
 */
export function validateResult(
  result: ContentMapperResult,
  content: string,
): TransformError | MappingError | undefined {
  for (const output of [result, ...result.supplemental]) {
    const problem = validateOutput(output, content);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/** `validateResult` for one output of a result. */
export function validateOutput(output: MappedResult, content: string): TransformError | MappingError | undefined {
  if (output.mappings === undefined) return new TransformError(TransformErrorKind.Mappings, undefined);
  const problem = output.mappings.validate(output.text, content);
  if (problem !== undefined) return problem;
  if (!isSupportedVirtualExtension(output.virtualExtension))
    return new TransformError(TransformErrorKind.Response, undefined);
  return undefined;
}

/**
 * Rejects a result of `fileName` when the name of one of its supplemental virtual files is that of a file
 * that exists.
 */
export function checkSupplementalFileNameCollisions(
  fileName: string,
  result: ContentMapperResult,
  fileExists: (fileName: string) => boolean,
): SupplementalFileCollisionError | undefined {
  for (let i = 0; i < result.supplemental.length; i++) {
    const name = getSupplementalFileName(fileName, i, result.supplemental[i].virtualExtension);
    if (fileExists(name)) return new SupplementalFileCollisionError(name);
  }
  return undefined;
}

// ---- The host

/** The configuration of a project that its mappers see. */
export class ContentMapperProjectSpec {
  constructor(
    /** The absolute name of the project's config file, or `''` for a project without one. */
    readonly configFileName: string,
    /** The project's mappers. */
    readonly mappers: readonly ContentMapper[],
    /** The project's compiler options. */
    readonly compilerOptions: CompilerOptions,
  ) {}
}

/** A step of the path to a value inside a mapper entry's `options`: a property name or an array index. */
export class OptionPathSegment {
  constructor(
    readonly property: string,
    readonly index: number,
    readonly isIndex: boolean,
  ) {}
}

/** A problem a mapper found in its entry's `options` when the project opened. */
export class ContentMapperOptionDiagnostic {
  constructor(
    readonly mapper: ContentMapper,
    /** The path from the `options` object to the value at fault. */
    readonly path: readonly OptionPathSegment[],
    /** The mapper's diagnostic source, which prefixes `code`. */
    readonly source: string,
    readonly code: number,
    readonly messageText: string,
  ) {}
}

/** How often one operation of a mapper ran and how long it took in all, in milliseconds. */
export class OperationTiming {
  constructor(
    readonly count: number,
    readonly duration: number,
  ) {}

  /** The part of this timing that came after `previous`, never negative. */
  since(previous: OperationTiming | undefined): OperationTiming {
    if (previous === undefined) return this;
    return new OperationTiming(
      this.count - Math.min(this.count, previous.count),
      Math.max(this.duration - previous.duration, 0),
    );
  }
}

/** The activity of one mapper, by identity: its process and each request of the protocol. */
export class MapperTimings {
  constructor(
    readonly spawn: OperationTiming,
    readonly initialize: OperationTiming,
    readonly openProject: OperationTiming,
    readonly closeProject: OperationTiming,
    readonly transform: OperationTiming,
  ) {}
}

/** A snapshot of what a host's mappers have done since it was created. */
export class ContentMapperTimings {
  constructor(
    readonly mappers: ReadonlyMap<string, MapperTimings>,
    /** The time, in milliseconds, during which some request was waiting for a mapper. */
    readonly requestWait: number,
  ) {}

  /** What happened after the snapshot `previous`. */
  since(previous: ContentMapperTimings): ContentMapperTimings {
    const mappers = new Map<string, MapperTimings>();
    for (const [identity, current] of this.mappers) {
      const before = previous.mappers.get(identity);
      mappers.set(
        identity,
        new MapperTimings(
          current.spawn.since(before?.spawn),
          current.initialize.since(before?.initialize),
          current.openProject.since(before?.openProject),
          current.closeProject.since(before?.closeProject),
          current.transform.since(before?.transform),
        ),
      );
    }
    return new ContentMapperTimings(mappers, Math.max(this.requestWait - previous.requestWait, 0));
  }
}

/**
 * A host's mappers as one project configures them. It gives the identities and the watched files that caches
 * and incremental builds need. A mapper's project is opened when a transform first needs it, or earlier for a
 * mapper with `dynamicConfig` whose identity or watched files are asked for.
 */
export interface ContentMapperProject {
  /** Closes the mapper projects that are open, so the next transform or identity query opens them again. */
  refresh(): ProjectFailure | undefined;
  /** The identities (`combinedIdentity`) of the project's mappers, in the order of its spec. */
  identities(): string[] | ProjectFailure;
  /** The identity of `mapper` in this project, or `''` for a mapper that is not one of the project's. */
  identity(mapper: ContentMapper): string | ProjectFailure;
  /** The absolute names, sorted, of the files that mappers with `dynamicConfig` asked to have watched. */
  watchedFiles(): string[] | ProjectFailure;
  /** The option diagnostics of the mapper projects that have been opened. */
  diagnostics(): ContentMapperOptionDiagnostic[];
  /** Transforms one file with `mapper` as this project configures it. */
  transform(mapper: ContentMapper, request: ContentMapperRequest): ContentMapperResult | TransformError;
  /** Gives this reference to the project back; the mapper projects close with the last one. */
  close(): ProjectFailure | undefined;
}

/**
 * Runs the mappers that projects configure. A mapper runs once for all the projects that use the same
 * identity of it. Closing the host stops every mapper it started.
 */
export interface ContentMapperHost {
  /** What the mappers have done so far. */
  timings(): ContentMapperTimings;
  /**
   * The view of this host for a project. Equal specs share the state of their mappers. The caller closes the
   * project it gets.
   */
  project(spec: ContentMapperProjectSpec): ContentMapperProject;
  /**
   * Keeps the mappers with the identities of `mappers` running until the function this returns is called. It
   * starts none: a mapper starts with its first transform.
   */
  acquire(mappers: readonly ContentMapper[]): () => void;
  /**
   * Sets the locale mappers write their messages in. Mappers that run are stopped, and start again with their
   * next transform.
   */
  setLocale(locale: string): void;
  /** Transforms one file with `mapper` in a project of its own that has no compiler options set. */
  transform(mapper: ContentMapper, request: ContentMapperRequest): ContentMapperResult | TransformError;
  /** Stops every mapper the host started. */
  close(): void;
}
