/**
 * The protocol between the compiler and a content mapper: JSON-RPC requests the compiler sends (`initialize`,
 * `openProject`, `closeProject`, `transform`) and the responses it accepts.
 *
 * This module writes the parameters of each request and decodes each response as tsgo does, with tsgo's error
 * kinds. It does not start a mapper or carry the messages; a `ContentMapperHost` does.
 *
 * ```ts
 * const initialized = decodeInitializeResult(parseJson(response)); // an InitializeResult or an InitializeError
 * const result = decodeTransformResult(parseJson(response), text, initialized.positionEncoding, 'vue');
 * ```
 *
 * A mapper counts positions in the encoding it selected. The compiler's are UTF-16 offsets, so every position
 * of a response is checked and converted here, where tsgo converts to UTF-8 offsets.
 *
 * A response is decoded from its parsed JSON. An integer in it is written without a fraction and without an
 * exponent, as tsgo's decoder demands. tsgo also rejects a repeated name in an object, which the host that
 * parses a mapper's message does (`JsonParser.repeatedName`).
 */
import {
  ContentMapperOptionDiagnostic,
  ContentMapperResult,
  DiagnosticDirectiveError,
  DiagnosticDirectiveErrorKind,
  equalFold,
  InitializeError,
  InitializeErrorKind,
  InvalidVirtualExtensionError,
  isSupportedVirtualExtension,
  MappedDiagnosticDirective,
  MappedDiagnosticDirectivePolicy,
  MappedResult,
  MapperDiagnostic,
  marshalCompilerOptions,
  OptionPathSegment,
  ProjectError,
  ProjectErrorKind,
  RequestError,
  TransformError,
  TransformErrorKind,
  type ContentMapper,
  type TransformErrorCause,
} from './content-mapper.js';
import type { CompilerOptions } from './options.js';
import type { JsonValue } from './package-json.js';
import {
  getNormalizedAbsolutePath,
  isUrl,
  pathIsAbsolute,
  supportedJSExtensionsFlat,
  supportedTSExtensionsWithJsonFlat,
} from './path.js';
import { SpanMap, SpanMapSegment } from './span-map.js';

/** The methods of the protocol. */
export const methodInitialize = 'initialize';
export const methodOpenProject = 'openProject';
export const methodCloseProject = 'closeProject';
export const methodTransform = 'transform';

/** The seconds a mapper has to answer `initialize`. */
export const initializeTimeoutSeconds = 5;

/** The units a mapper counts positions in: UTF-8 bytes or UTF-16 code units. */
export type PositionEncoding = 'utf-8' | 'utf-16';

// ---- Requests

/**
 * The parameters of `initialize`: the locale for the mapper's messages, left out when it is `''`, and the
 * position encodings the mapper may select, in tsgo's order.
 */
export function marshalInitializeParams(locale: string): string {
  const localeMember = locale === '' ? '' : `"locale":${JSON.stringify(locale)},`;
  return `{${localeMember}"positionEncodings":["utf-8","utf-16"]}`;
}

/**
 * The parameters of `openProject`: the project's config file (`''` without one), the handle the host gives
 * the mapper's project, the `options` of the mapper's entry in `contentMappers`, and the project's compiler
 * options.
 */
export function marshalOpenProjectParams(
  configFileName: string,
  projectHandle: string,
  mapper: ContentMapper,
  compilerOptions: CompilerOptions,
): string {
  const options = mapper.definition.options;
  const optionsMember = options === undefined || options === '' ? '' : `"options":${options},`;
  return `{"configFileName":${JSON.stringify(configFileName)},"projectHandle":${JSON.stringify(projectHandle)},${optionsMember}"compilerOptions":${marshalCompilerOptions(compilerOptions)}}`;
}

/** The parameters of `closeProject`. */
export function marshalCloseProjectParams(projectHandle: string): string {
  return `{"projectHandle":${JSON.stringify(projectHandle)}}`;
}

/** The parameters of `transform`: the absolute name of the file, its text, and the project it belongs to. */
export function marshalTransformParams(fileName: string, content: string, projectHandle: string): string {
  return `{"fileName":${JSON.stringify(fileName)},"content":${JSON.stringify(content)},"projectHandle":${JSON.stringify(projectHandle)}}`;
}

// ---- Reading JSON

/** The member `name` of an object, where a member that is `null` reads as one that is absent. */
function member(object: ReadonlyMap<string, JsonValue>, name: string): JsonValue | undefined {
  const value = object.get(name);
  return value === undefined || value.type === 'null' ? undefined : value;
}

/** The members of a value that is an object, none for `null`, and `undefined` for any other value. */
function members(value: JsonValue | undefined): ReadonlyMap<string, JsonValue> | undefined {
  if (value === undefined || value.type === 'null') return new Map<string, JsonValue>();
  return value.type === 'object' ? value.entries : undefined;
}

/** The items of a value that is an array, none for `null` or an absent value, and `undefined` otherwise. */
function items(value: JsonValue | undefined): readonly JsonValue[] | undefined {
  if (value === undefined || value.type === 'null') return [];
  return value.type === 'array' ? value.items : undefined;
}

/** A member that is a string, `''` when it is absent, and `undefined` when it is anything else. */
function stringMember(object: ReadonlyMap<string, JsonValue>, name: string): string | undefined {
  const value = member(object, name);
  if (value === undefined) return '';
  return value.type === 'string' ? value.value : undefined;
}

/** A value that is an integer, 0 when it is absent, and `undefined` when it is anything else. */
function integer(value: JsonValue | undefined): number | undefined {
  if (value === undefined || value.type === 'null') return 0;
  if (value.type !== 'number' || !value.integer || !Number.isInteger(value.value)) return undefined;
  // The range of a 64-bit integer.
  return Math.abs(value.value) < 9223372036854775808 ? value.value : undefined;
}

/** Whether `text` is empty or all white space, as Go's `strings.TrimSpace` sees it. */
function isBlank(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const space =
      (c >= 0x09 && c <= 0x0d) ||
      c === 0x20 ||
      c === 0x85 ||
      c === 0xa0 ||
      c === 0x1680 ||
      (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 ||
      c === 0x2029 ||
      c === 0x202f ||
      c === 0x205f ||
      c === 0x3000;
    if (!space) return false;
  }
  return true;
}

/** `integer`, limited to 32 bits. */
function int32(value: JsonValue | undefined): number | undefined {
  const result = integer(value);
  return result === undefined || (result | 0) !== result ? undefined : result;
}

// ---- initialize

/** A mapper's answer to `initialize`. */
export class InitializeResult {
  constructor(
    /** The encoding of every position the mapper sends. */
    readonly positionEncoding: PositionEncoding,
    /** The prefix of the codes of the mapper's diagnostics, shown in place of `TS`. */
    readonly diagnosticSource: string,
  ) {}
}

/**
 * Decodes the response to `initialize`. The mapper selects `utf-8` or `utf-16`, and names a diagnostic source
 * that is not blank, not `typescript` or `tsc`, and not an extension the compiler reads (`ts`, `d.ts`, `json`
 * and the others), in any letter case.
 */
export function decodeInitializeResult(raw: JsonValue | undefined): InitializeResult | InitializeError {
  const invalid = (jsonType: string, goType: string): InitializeError => {
    const error = new InitializeError(InitializeErrorKind.InvalidResponse);
    // The message of tsgo's decoder, which the diagnostic for the failure quotes. Go words it with `cannot` or
    // with `unable to`, chosen at random once per process.
    error.detail = `json: cannot unmarshal JSON ${jsonType} into Go ${goType}`;
    return error;
  };
  let positionEncoding = '';
  let diagnosticSource = '';
  if (raw !== undefined && raw.type !== 'null') {
    if (raw.type !== 'object') return invalid(raw.type, 'contentmapper.InitializeResult');
    for (const [name, value] of raw.entries) {
      if (name !== 'positionEncoding' && name !== 'diagnosticSource') continue;
      const text = value.type === 'null' ? '' : value.type === 'string' ? value.value : undefined;
      if (text === undefined)
        return invalid(
          value.type,
          name === 'positionEncoding'
            ? 'contentmapper.PositionEncoding within "/positionEncoding"'
            : 'string within "/diagnosticSource"',
        );
      if (name === 'positionEncoding') positionEncoding = text;
      else diagnosticSource = text;
    }
  }
  if (positionEncoding !== 'utf-8' && positionEncoding !== 'utf-16') {
    const error = new InitializeError(InitializeErrorKind.PositionEncoding);
    error.positionEncoding = positionEncoding;
    return error;
  }
  if (isBlank(diagnosticSource)) return new InitializeError(InitializeErrorKind.EmptyDiagnosticSource);
  const names = (extension: string): boolean => equalFold(diagnosticSource, extension.slice(1));
  if (
    equalFold(diagnosticSource, 'typescript') ||
    equalFold(diagnosticSource, 'tsc') ||
    supportedTSExtensionsWithJsonFlat.some(names) ||
    supportedJSExtensionsFlat.some(names)
  ) {
    const error = new InitializeError(InitializeErrorKind.ReservedDiagnosticSource);
    error.diagnosticSource = diagnosticSource;
    return error;
  }
  return new InitializeResult(positionEncoding, diagnosticSource);
}

// ---- openProject

/** A mapper's answer to `openProject`. */
export class OpenProjectResult {
  constructor(
    /** A fingerprint of the configuration the mapper read itself; `''` for a mapper without `dynamicConfig`. */
    readonly configIdentity: string,
    /** The absolute, normalized names of the files whose changes may alter the mapper's output. */
    readonly watchedFiles: readonly string[],
    /** The problems the mapper found in its entry's `options`. */
    readonly optionDiagnostics: readonly ContentMapperOptionDiagnostic[],
  ) {}
}

/**
 * Decodes the response to `openProject` of `mapper`. Only a mapper that declares `dynamicConfig` may return
 * `configIdentity` and `watchedFiles`, and such a mapper must return `configIdentity`. A watched file is
 * absolute. The path of an option diagnostic consists of property names and indices that are not negative.
 */
export function decodeOpenProjectResult(
  raw: JsonValue | undefined,
  mapper: ContentMapper,
  diagnosticSource: string,
): OpenProjectResult | ProjectError {
  const malformed = new ProjectError(ProjectErrorKind.MalformedResponse);
  const object = members(raw);
  if (object === undefined) return malformed;
  const configIdentity = stringMember(object, 'configIdentity');
  const watched = items(object.get('watchedFiles'));
  const diagnostics = items(object.get('optionDiagnostics'));
  if (configIdentity === undefined || watched === undefined || diagnostics === undefined) return malformed;
  const fileNames: string[] = [];
  for (const item of watched) {
    if (item.type !== 'string' && item.type !== 'null') return malformed;
    fileNames.push(item.type === 'string' ? item.value : '');
  }
  const paths: (readonly JsonValue[])[] = [];
  const messageTexts: string[] = [];
  const codes: number[] = [];
  for (const item of diagnostics) {
    const diagnostic = members(item);
    const path = diagnostic === undefined ? undefined : items(diagnostic.get('path'));
    const messageText = diagnostic === undefined ? undefined : stringMember(diagnostic, 'messageText');
    const code = diagnostic === undefined ? undefined : int32(diagnostic.get('code'));
    if (path === undefined || messageText === undefined || code === undefined) return malformed;
    paths.push(path);
    messageTexts.push(messageText);
    codes.push(code);
  }
  const dynamicConfig = mapper.manifest.dynamicConfig;
  if (dynamicConfig && configIdentity === '') return new ProjectError(ProjectErrorKind.MissingConfigIdentity);
  if (!dynamicConfig && configIdentity !== '') return new ProjectError(ProjectErrorKind.UnexpectedConfigIdentity);
  if (!dynamicConfig && fileNames.length !== 0) return new ProjectError(ProjectErrorKind.UnexpectedWatchedFiles);
  const watchedFiles: string[] = [];
  for (const fileName of fileNames) {
    // A URL with a query or a fragment is no file name.
    const scheme = fileName.indexOf('://');
    const urlSuffix =
      isUrl(fileName) && scheme >= 0 && (fileName.includes('?', scheme) || fileName.includes('#', scheme));
    if (urlSuffix || !pathIsAbsolute(fileName)) return new ProjectError(ProjectErrorKind.NonAbsoluteWatchedFile);
    watchedFiles.push(getNormalizedAbsolutePath(fileName, ''));
  }
  const optionDiagnostics: ContentMapperOptionDiagnostic[] = [];
  for (let i = 0; i < paths.length; i++) {
    const segments: OptionPathSegment[] = [];
    for (const segment of paths[i]) {
      const index = segment.type === 'number' ? integer(segment) : undefined;
      if (segment.type === 'string') segments.push(new OptionPathSegment(segment.value, 0, false));
      else if (index !== undefined && index >= 0) segments.push(new OptionPathSegment('', index, true));
      else return malformed;
    }
    optionDiagnostics.push(
      new ContentMapperOptionDiagnostic(mapper, segments, diagnosticSource, codes[i], messageTexts[i]),
    );
  }
  return new OpenProjectResult(configIdentity, watchedFiles, optionDiagnostics);
}

// ---- transform

/** A diagnostic directive as a mapper sends it. */
class WireDirective {
  constructor(
    readonly originalStart: number,
    readonly originalLength: number,
    readonly virtualStart: number,
    readonly virtualEnd: number,
    readonly policy: number,
    /** The index of the directive's unused-expect diagnostic, when the tuple has one. */
    readonly unusedExpectDirectiveIndex: number | undefined,
  ) {}
}

/** The diagnostic directives of an output: the directives, and the diagnostics they share by index. */
class WireDirectives {
  constructor(
    readonly unusedCodes: readonly number[],
    readonly unusedMessageTexts: readonly string[],
    readonly directives: readonly WireDirective[],
  ) {}
}

/** A virtual source file as a mapper sends it. */
class WireOutput {
  constructor(
    readonly text: string,
    readonly extension: string,
    readonly mappings: JsonValue | undefined,
    readonly diagnosticDirectives: WireDirectives | undefined,
  ) {}
}

/** An error of the original file as a mapper sends it. */
class WireDiagnostic {
  constructor(
    readonly messageText: string,
    readonly start: number,
    readonly length: number,
    readonly code: number,
  ) {}
}

const malformedTransform = 'content mapper returned a malformed transform response';

/**
 * Reads `[originalStart, originalLength, virtualStart, virtualEnd, policy, unusedExpectDirectiveIndex?]`.
 * The policy is an unsigned byte.
 */
function readDirective(value: JsonValue): WireDirective | undefined {
  if (value.type !== 'array' || (value.items.length !== 5 && value.items.length !== 6)) return undefined;
  const numbers: number[] = [];
  for (const item of value.items) {
    const number = integer(item);
    if (number === undefined) return undefined;
    numbers.push(number);
  }
  if (numbers[4] < 0 || numbers[4] > 255) return undefined;
  return new WireDirective(
    numbers[0],
    numbers[1],
    numbers[2],
    numbers[3],
    numbers[4],
    numbers.length === 6 ? numbers[5] : undefined,
  );
}

function readDirectives(value: JsonValue | undefined): WireDirectives | undefined {
  const object = members(value);
  if (object === undefined) return undefined;
  const unused = items(object.get('unusedExpectDirectiveDiagnostics'));
  const tuples = items(object.get('directives'));
  if (unused === undefined || tuples === undefined) return undefined;
  const unusedCodes: number[] = [];
  const unusedMessageTexts: string[] = [];
  for (const item of unused) {
    const diagnostic = members(item);
    const code = diagnostic === undefined ? undefined : int32(diagnostic.get('code'));
    const messageText = diagnostic === undefined ? undefined : stringMember(diagnostic, 'messageText');
    if (code === undefined || messageText === undefined) return undefined;
    unusedCodes.push(code);
    unusedMessageTexts.push(messageText);
  }
  const directives: WireDirective[] = [];
  for (const tuple of tuples) {
    const directive = readDirective(tuple);
    if (directive === undefined) return undefined;
    directives.push(directive);
  }
  return new WireDirectives(unusedCodes, unusedMessageTexts, directives);
}

function readOutput(object: ReadonlyMap<string, JsonValue>): WireOutput | undefined {
  const text = stringMember(object, 'text');
  const extension = stringMember(object, 'extension');
  if (text === undefined || extension === undefined) return undefined;
  const directives = member(object, 'diagnosticDirectives');
  const diagnosticDirectives = directives === undefined ? undefined : readDirectives(directives);
  if (directives !== undefined && diagnosticDirectives === undefined) return undefined;
  return new WireOutput(text, extension, object.get('mappings'), diagnosticDirectives);
}

/**
 * Converts positions of one text from a mapper's encoding to UTF-16 offsets. A position is rejected when it
 * is negative, past the end of the text, or inside a character: between the bytes of one in UTF-8, between
 * the two code units of one in UTF-16.
 */
class PositionNormalizer {
  private readonly text: string;
  private readonly encoding: PositionEncoding;
  /** The length of the text in the encoding's units. */
  private readonly length: number;
  /** For UTF-8, the byte offset after each character that is not ASCII, in order. */
  private readonly byteEnds: number[] = [];
  /** For UTF-8, the number of bytes of each of those characters. */
  private readonly byteSizes: number[] = [];
  /** For UTF-8, how far each of those byte offsets is ahead of the UTF-16 offset of the same place. */
  private readonly deltas: number[] = [];

  constructor(text: string, encoding: PositionEncoding) {
    this.text = text;
    this.encoding = encoding;
    let delta = 0;
    if (encoding === 'utf-8')
      for (let i = 0; i < text.length;) {
        const codePoint = text.codePointAt(i) ?? 0;
        const units = codePoint > 0xffff ? 2 : 1;
        i += units;
        if (codePoint < 0x80) continue;
        const size = codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
        delta += size - units;
        this.byteEnds.push(i + delta);
        this.byteSizes.push(size);
        this.deltas.push(delta);
      }
    this.length = text.length + delta;
  }

  /** The UTF-16 offset of `position`, or the reason it is not a position of the text, in tsgo's words. */
  normalize(position: number): number | string {
    if (position < 0) return `position ${position} is negative`;
    if (position > this.length) return `position ${position} exceeds ${this.encoding} length ${this.length}`;
    if (this.encoding === 'utf-16') {
      const splits =
        position > 0 &&
        position < this.text.length &&
        (this.text.charCodeAt(position) & 0xfc00) === 0xdc00 &&
        (this.text.charCodeAt(position - 1) & 0xfc00) === 0xd800;
      return splits ? `position ${position} splits a Unicode code point` : position;
    }
    // The first character that is not ASCII and ends after `position`.
    const ends = this.byteEnds;
    let low = 0;
    let high = ends.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ends[middle] <= position) low = middle + 1;
      else high = middle;
    }
    if (low < ends.length && position > ends[low] - this.byteSizes[low])
      return `position ${position} splits a Unicode code point`;
    return low === 0 ? position : position - this.deltas[low - 1];
  }
}

/** Decodes the span map of an output and converts its positions, or says why it is not one. */
function normalizeMappings(
  raw: JsonValue,
  virtualPositions: PositionNormalizer,
  originalPositions: PositionNormalizer,
): SpanMap | string {
  const mappings = SpanMap.unmarshal(raw);
  if (mappings === undefined) return 'content mapper returned malformed position mappings';
  const segments: SpanMapSegment[] = [];
  for (let i = 0; i < mappings.segments.length; i++) {
    const segment = mappings.segments[i];
    const virtualStart = virtualPositions.normalize(segment.virtualStart);
    if (typeof virtualStart === 'string') return `invalid content mapper mapping ${i} virtual start: ${virtualStart}`;
    const virtualEnd = virtualPositions.normalize(segment.virtualEnd);
    if (typeof virtualEnd === 'string') return `invalid content mapper mapping ${i} virtual end: ${virtualEnd}`;
    const originalStart = originalPositions.normalize(segment.originalStart);
    if (typeof originalStart === 'string')
      return `invalid content mapper mapping ${i} original start: ${originalStart}`;
    const originalEnd = originalPositions.normalize(segment.originalEnd);
    if (typeof originalEnd === 'string') return `invalid content mapper mapping ${i} original end: ${originalEnd}`;
    segments.push(
      new SpanMapSegment(virtualStart, virtualEnd, originalStart, originalEnd, segment.kind, segment.features),
    );
  }
  return new SpanMap(segments);
}

/**
 * Checks the diagnostic directives of an output and converts their positions. An `Expect` directive names its
 * unused diagnostic by index, or leaves the index out when there is exactly one, and has a range in the
 * original text. Every directive has a range in the virtual text, and no two of those ranges overlap.
 */
function normalizeDiagnosticDirectives(
  wire: WireDirectives | undefined,
  virtualPositions: PositionNormalizer,
  originalPositions: PositionNormalizer,
  diagnosticSource: string,
): MappedDiagnosticDirective[] | DiagnosticDirectiveError {
  const result: MappedDiagnosticDirective[] = [];
  if (wire === undefined) return result;
  for (let i = 0; i < wire.directives.length; i++) {
    const directive = wire.directives[i];
    const directiveError = (kind: DiagnosticDirectiveErrorKind): DiagnosticDirectiveError =>
      new DiagnosticDirectiveError(
        kind,
        i,
        -1,
        kind === DiagnosticDirectiveErrorKind.InvalidPolicy ? directive.policy : 0,
      );
    let unusedCode = 0;
    let unusedMessageText = '';
    if (directive.policy === MappedDiagnosticDirectivePolicy.Expect) {
      const index = directive.unusedExpectDirectiveIndex ?? 0;
      if (directive.unusedExpectDirectiveIndex === undefined && wire.unusedCodes.length !== 1)
        return directiveError(DiagnosticDirectiveErrorKind.ExpectMissingUnusedDiagnostic);
      if (index < 0 || index >= wire.unusedCodes.length)
        return directiveError(DiagnosticDirectiveErrorKind.InvalidUnusedDiagnosticIndex);
      unusedCode = wire.unusedCodes[index];
      unusedMessageText = wire.unusedMessageTexts[index];
    } else if (directive.policy !== MappedDiagnosticDirectivePolicy.Ignore) {
      return directiveError(DiagnosticDirectiveErrorKind.InvalidPolicy);
    }
    if (directive.virtualStart < 0 || directive.virtualEnd < directive.virtualStart)
      return directiveError(DiagnosticDirectiveErrorKind.InvalidRange);
    const virtualPos = virtualPositions.normalize(directive.virtualStart);
    const virtualEnd = virtualPositions.normalize(directive.virtualEnd);
    if (typeof virtualPos === 'string' || typeof virtualEnd === 'string')
      return directiveError(DiagnosticDirectiveErrorKind.InvalidRange);
    let originalPos: number | string = 'no range';
    let originalEnd: number | string = 'no range';
    if (directive.originalStart >= 0 && directive.originalLength >= 0) {
      originalPos = originalPositions.normalize(directive.originalStart);
      originalEnd = originalPositions.normalize(directive.originalStart + directive.originalLength);
    }
    // An `Ignore` directive without a valid original range is kept, at the start of the original text.
    if (typeof originalPos === 'string' || typeof originalEnd === 'string') {
      if (directive.policy === MappedDiagnosticDirectivePolicy.Expect)
        return directiveError(DiagnosticDirectiveErrorKind.InvalidRange);
      originalPos = 0;
      originalEnd = 0;
    }
    result.push(
      new MappedDiagnosticDirective(
        originalPos,
        originalEnd,
        virtualPos,
        virtualEnd,
        directive.policy,
        unusedCode,
        unusedMessageText,
        diagnosticSource,
      ),
    );
  }
  const order: number[] = [];
  for (let i = 0; i < result.length; i++) order.push(i);
  order.sort((a, b) => result[a].virtualPos - result[b].virtualPos);
  for (let i = 1; i < order.length; i++)
    if (result[order[i]].virtualPos < result[order[i - 1]].virtualEnd)
      return new DiagnosticDirectiveError(DiagnosticDirectiveErrorKind.Overlap, order[i], -1, 0);
  return result;
}

/** Decodes one output, or says what is wrong with it. `supplementalIndex` is -1 for the canonical output. */
function decodeMappedOutput(
  output: WireOutput,
  originalPositions: PositionNormalizer,
  positionEncoding: PositionEncoding,
  diagnosticSource: string,
  supplementalIndex: number,
): MappedResult | TransformErrorCause {
  if (!isSupportedVirtualExtension(output.extension)) return new InvalidVirtualExtensionError(output.extension);
  const virtualPositions = new PositionNormalizer(output.text, positionEncoding);
  // An output without mappings, or with empty ones, is synthesized as a whole: it has an empty map, where no
  // map at all would mean a file that no mapper produced.
  let mappings = new SpanMap([]);
  if (output.mappings !== undefined) {
    const normalized = normalizeMappings(output.mappings, virtualPositions, originalPositions);
    if (typeof normalized === 'string') return new RequestError(normalized);
    mappings = normalized;
  }
  const directives = normalizeDiagnosticDirectives(
    output.diagnosticDirectives,
    virtualPositions,
    originalPositions,
    diagnosticSource,
  );
  if (directives instanceof DiagnosticDirectiveError)
    return new DiagnosticDirectiveError(directives.kind, directives.index, supplementalIndex, directives.policy);
  return new MappedResult(output.text, output.extension, mappings, directives);
}

/**
 * Decodes the response to `transform` for a file with the text `originalText`: the canonical output with its
 * `text`, `extension`, `mappings` and `diagnosticDirectives`, the `diagnostics` of the original file, and the
 * `supplemental` outputs. Every position is converted from `positionEncoding`, and the mapper's diagnostics
 * and directives get `diagnosticSource`. A response that does not decode, or that breaks a rule of the
 * protocol, is a `TransformError` of kind `Response` with the cause.
 */
export function decodeTransformResult(
  raw: JsonValue | undefined,
  originalText: string,
  positionEncoding: PositionEncoding,
  diagnosticSource: string,
): ContentMapperResult | TransformError {
  const fail = (cause: TransformErrorCause): TransformError => new TransformError(TransformErrorKind.Response, cause);
  const malformed = fail(new RequestError(malformedTransform));
  const object = members(raw);
  if (object === undefined) return malformed;
  const canonical = readOutput(object);
  const supplementalItems = items(object.get('supplemental'));
  const diagnosticItems = items(object.get('diagnostics'));
  if (canonical === undefined || supplementalItems === undefined || diagnosticItems === undefined) return malformed;
  const supplementalOutputs: WireOutput[] = [];
  for (const item of supplementalItems) {
    const supplementalObject = members(item);
    const output = supplementalObject === undefined ? undefined : readOutput(supplementalObject);
    if (output === undefined) return malformed;
    supplementalOutputs.push(output);
  }
  const wireDiagnostics: WireDiagnostic[] = [];
  for (const item of diagnosticItems) {
    const diagnostic = members(item);
    const messageText = diagnostic === undefined ? undefined : stringMember(diagnostic, 'messageText');
    const start = diagnostic === undefined ? undefined : integer(diagnostic.get('start'));
    const length = diagnostic === undefined ? undefined : integer(diagnostic.get('length'));
    const code = diagnostic === undefined ? undefined : int32(diagnostic.get('code'));
    if (messageText === undefined || start === undefined || length === undefined || code === undefined)
      return malformed;
    wireDiagnostics.push(new WireDiagnostic(messageText, start, length, code));
  }

  const originalPositions = new PositionNormalizer(originalText, positionEncoding);
  const mapped = decodeMappedOutput(canonical, originalPositions, positionEncoding, diagnosticSource, -1);
  if (!(mapped instanceof MappedResult)) return fail(mapped);
  const supplemental: MappedResult[] = [];
  for (let i = 0; i < supplementalOutputs.length; i++) {
    const output = decodeMappedOutput(supplementalOutputs[i], originalPositions, positionEncoding, diagnosticSource, i);
    if (!(output instanceof MappedResult)) return fail(output);
    supplemental.push(output);
  }
  const diagnostics: MapperDiagnostic[] = [];
  for (const diagnostic of wireDiagnostics) {
    const end = diagnostic.start + diagnostic.length;
    if (diagnostic.start < 0 || diagnostic.length < 0)
      return fail(new RequestError(`invalid content mapper diagnostic range [${diagnostic.start}, ${end})`));
    const startPosition = originalPositions.normalize(diagnostic.start);
    if (typeof startPosition === 'string')
      return fail(new RequestError(`invalid content mapper diagnostic start: ${startPosition}`));
    const endPosition = originalPositions.normalize(end);
    if (typeof endPosition === 'string')
      return fail(new RequestError(`invalid content mapper diagnostic end: ${endPosition}`));
    diagnostics.push(
      new MapperDiagnostic(startPosition, endPosition, diagnosticSource, diagnostic.code, diagnostic.messageText),
    );
  }
  return new ContentMapperResult(
    mapped.text,
    mapped.virtualExtension,
    mapped.mappings,
    mapped.diagnosticDirectives,
    diagnostics,
    supplemental,
  );
}
