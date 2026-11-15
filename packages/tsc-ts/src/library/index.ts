// tsc-ts's public API (`tsc-ts/api`): the types of programs, checkers, nodes, symbols, types and
// signatures, and the enums that number their kinds and flags as TypeScript 7's API does.

export * from './ast.js';
export * from './enums.generated.js';
export * from './is.generated.js';
export { hasInitializer, isExpression, isTypeNode } from './is.js';
export type { CompilerOptions } from './compiler-options.generated.js';
export { symbolName } from './symbols.js';
export { createProgram, createProgramFromConfigFile, getPreEmitDiagnostics, parseConfigFile } from './program.js';
export { DisposedProgramError, InternalCompilerError } from './errors.js';
export { parseSourceFile, type ParseSourceFileOptions } from './parse.js';
export { getJSDocTags } from './jsdoc.js';
export { type MappedPosition, type MappedRange, SpanMap, type SpanMapSegment } from './span-map.js';
export {
  type CommentKind,
  type CommentRange,
  createScanner,
  getLeadingCommentRanges,
  getTrailingCommentRanges,
  type Scanner,
  skipTrivia,
} from './scanner.js';
export {
  canHaveModifiers,
  flattenDiagnosticMessageText,
  forEachChild,
  getChildren,
  getCombinedModifierFlags,
  getCombinedNodeFlags,
  getFirstToken,
  getJSDoc,
  getLastToken,
  getLineAndCharacterOfPosition,
  getLineStarts,
  getModifiers,
  getPositionOfLineAndCharacter,
  getSourceFileOfNode,
  getTextOfNode,
  tokenStartOfNode,
  tokenToString,
  walkPreorder,
} from './nodes.js';
export type {
  __String,
  BigIntLiteralType,
  BooleanLiteralType,
  ConditionalType,
  ContentMapper,
  ContentMapperDiagnostic,
  ContentMapperDiagnosticDirective,
  ContentMapperDiagnosticDirectives,
  ContentMapperMapping,
  ContentMapperOutput,
  ContentMapperResult,
  CreateProgramOptions,
  Diagnostic,
  FileSystemEntries,
  FreshableType,
  IndexedAccessType,
  IndexInfo,
  IndexType,
  InterfaceType,
  IntersectionType,
  IntrinsicType,
  JSDocTagInfo,
  LiteralType,
  NumberLiteralType,
  ObjectType,
  ParsedConfigFile,
  Program,
  ProgramHost,
  Signature,
  SourceFileMetadata,
  StringLiteralType,
  StringMappingType,
  SubstitutionType,
  Symbol,
  TemplateLiteralType,
  TupleType,
  TupleTypeReference,
  Type,
  TypeChecker,
  TypeParameter,
  TypePredicate,
  TypeReference,
  UnionOrIntersectionType,
  UnionType,
} from './types.js';
