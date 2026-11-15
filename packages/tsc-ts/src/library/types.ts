// The program, checker, symbol, type and signature types of tsc-ts's public API. They follow TypeScript 7's
// API (`typescript/unstable/sync`): the same names, and the same answers for the same program. The objects
// are tsc-ts's own: one object per symbol, type and signature in a program, so they can be compared with
// `===` and used as Map keys. Everything here is read-only: nothing the API does changes what tsc-ts
// reports for the program.

import type { Expression, Identifier, Node, SourceFile, TypeNode } from './ast.js';
import type { CompilerOptions } from './compiler-options.generated.js';
import type {
  DiagnosticCategory,
  ElementFlags,
  IndexKind,
  ModuleKind,
  ObjectFlags,
  SignatureFlags,
  SignatureKind,
  SpanMapFeature,
  SpanMapKind,
  SymbolFlags,
  TypeFlags,
  TypeFormatFlags,
  TypePredicateKind,
} from './enums.generated.js';

/**
 * The escaped form of a symbol name, the key of member and export tables: internal names start with
 * `__` (`__call`, `__type`), and names that already start with `__` have one more `_`.
 */
export type __String = string & { readonly __escapedIdentifier: void };

/**
 * A symbol. Its name, as TypeScript 7's API gives it, is `symbolName(symbol)`; `escapedName` is the key
 * of the tables it is a member or export of.
 */
export interface Symbol {
  /** Unique in the process. */
  readonly id: number;
  readonly escapedName: __String;
  readonly flags: SymbolFlags;
  readonly checkFlags: number;
  readonly declarations: readonly Node[];
  readonly valueDeclaration: Node | undefined;
  getParent(): Symbol | undefined;
  /** The symbol's export symbol, or the symbol itself if it has none. */
  getExportSymbol(): Symbol;
  /** The members, by escaped name. */
  getMembers(): ReadonlyMap<__String, Symbol>;
  /** The exports, by escaped name. */
  getExports(): ReadonlyMap<__String, Symbol>;
}

/**
 * A type. Its flags give its kind; the accessors answer undefined, or an empty list, where a kind has no
 * such part. Type ids are unique within the program's checker.
 */
export interface Type {
  readonly flags: TypeFlags;
  /**
   * The object flags of an object type (TypeFlags.Object). Other types carry flags the checker keeps for
   * itself, such as ObjectFlags.PrimitiveUnion, where TypeScript 7's API gives 0. Flags the checker
   * caches, such as ObjectFlags.MembersResolved, are set as queries compute them.
   */
  readonly objectFlags: ObjectFlags;
  readonly id: number;
  getSymbol(): Symbol | undefined;
  getAliasSymbol(): Symbol | undefined;
  getAliasTypeArguments(): readonly Type[];
  /** The target of a type reference, index type (`keyof T`) or string mapping type. */
  getTarget(): Type | undefined;
  /** The members of a union or intersection, or the types of a template literal type. */
  getTypes(): readonly Type[];
  getFreshType(): Type | undefined;
  getRegularType(): Type | undefined;
  getObjectType(): Type | undefined;
  getIndexType(): Type | undefined;
  getCheckType(): Type | undefined;
  getExtendsType(): Type | undefined;
  getTrueType(): Type | undefined;
  getFalseType(): Type | undefined;
  /** The base type of a substitution type. */
  getBaseType(): Type | undefined;
  /** The constraint of a substitution type. */
  getConstraint(): Type | undefined;
  getTypeParameters(): readonly TypeParameter[];
  getOuterTypeParameters(): readonly TypeParameter[];
  getLocalTypeParameters(): readonly TypeParameter[];
  /** The base types of a class or interface type, or undefined for any other type. */
  getBaseTypes(): readonly Type[] | undefined;
  isClassOrInterface(): this is InterfaceType;
  isUnionType(): this is UnionType;
  isIntersectionType(): this is IntersectionType;
  isObjectType(): this is ObjectType;
  isIntrinsicType(): this is IntrinsicType;
  /** Whether this is the error type, which the checker gives where a type can't be determined. */
  isErrorType(): boolean;
  isLiteralType(): this is LiteralType;
  isStringLiteralType(): this is StringLiteralType;
  isNumberLiteralType(): this is NumberLiteralType;
  isBigIntLiteralType(): this is BigIntLiteralType;
  isBooleanLiteralType(): this is BooleanLiteralType;
  isTypeReference(): this is TypeReference;
  isTupleType(): this is TupleType;
  isIndexType(): this is IndexType;
  isIndexedAccessType(): this is IndexedAccessType;
  isConditionalType(): this is ConditionalType;
  isSubstitutionType(): this is SubstitutionType;
  isTemplateLiteralType(): this is TemplateLiteralType;
  isStringMappingType(): this is StringMappingType;
  isTypeParameter(): this is TypeParameter;
}

/** Literal types (TypeFlags.Literal) and computed enum types (TypeFlags.Enum). */
export interface FreshableType extends Type {
  getFreshType(): FreshableType | undefined;
  getRegularType(): FreshableType | undefined;
}

export interface LiteralType extends FreshableType {
  readonly value: string | number | boolean | bigint;
}

export interface StringLiteralType extends LiteralType {
  readonly value: string;
}

export interface NumberLiteralType extends LiteralType {
  readonly value: number;
}

export interface BigIntLiteralType extends LiteralType {
  readonly value: bigint;
}

export interface BooleanLiteralType extends LiteralType {
  readonly value: boolean;
}

// ObjectType, UnionType and IntersectionType have the members of every type. Each declares an optional brand
// member, which no type has, so that the checker takes them for different types: without it, the false branch
// of `type.isUnionType()` would leave no type.

export interface ObjectType extends Type {
  readonly _objectTypeBrand?: never;
}

export interface TypeReference extends ObjectType {
  getTarget(): Type;
}

/** Classes and interfaces (ObjectFlags.ClassOrInterface). */
export interface InterfaceType extends TypeReference {
  getBaseTypes(): readonly Type[];
}

/** Tuple targets (ObjectFlags.Tuple). */
export interface TupleType extends InterfaceType {
  readonly elementFlags: readonly ElementFlags[];
  /** The number of initial required or optional elements. */
  readonly fixedLength: number;
  readonly readonly: boolean;
}

/** A reference to a tuple type (`[string, number]`): `getTarget()` is the TupleType (`isTupleType()`). */
export interface TupleTypeReference extends TypeReference {}

export interface UnionOrIntersectionType extends Type {}

export interface UnionType extends UnionOrIntersectionType {
  readonly _unionTypeBrand?: never;
}

export interface IntersectionType extends UnionOrIntersectionType {
  readonly _intersectionTypeBrand?: never;
}

export interface TypeParameter extends Type {
  /** Whether this is the `this` type of a class, interface or tuple. */
  readonly isThisType: boolean;
}

export interface IndexType extends Type {
  getTarget(): Type;
}

export interface IndexedAccessType extends Type {
  getObjectType(): Type;
  getIndexType(): Type;
}

export interface ConditionalType extends Type {
  getCheckType(): Type;
  getExtendsType(): Type;
  getTrueType(): Type;
  getFalseType(): Type;
}

export interface SubstitutionType extends Type {
  getBaseType(): Type;
  getConstraint(): Type;
}

export interface TemplateLiteralType extends Type {
  /** The text segments, one more than the types between them. */
  readonly texts: readonly string[];
}

export interface StringMappingType extends Type {
  getTarget(): Type;
}

/** any, unknown, string, number, bigint, symbol, void, undefined, null, never, object and the error type. */
export interface IntrinsicType extends Type {
  readonly intrinsicName: string;
}

export interface Signature {
  /** Unique within the program's checker. */
  readonly id: number;
  /** Has a rest parameter, is a construct signature, is abstract (SignatureFlags). */
  readonly flags: SignatureFlags;
  readonly declaration: Node | undefined;
  getTypeParameters(): readonly TypeParameter[];
  getParameters(): readonly Symbol[];
  getThisParameter(): Symbol | undefined;
  /** The signature this one was instantiated from. */
  getTarget(): Signature | undefined;
}

export interface IndexInfo {
  readonly keyType: Type;
  readonly type: Type;
  readonly isReadonly: boolean;
  readonly declaration: Node | undefined;
}

export interface TypePredicate {
  readonly kind: TypePredicateKind;
  /** The parameter an identifier predicate names; undefined for a `this` predicate. */
  readonly parameterName: string | undefined;
  readonly parameterIndex: number | undefined;
  /** The asserted type; undefined for `asserts x`. */
  readonly type: Type | undefined;
}

/**
 * A diagnostic, with its text and positions as TypeScript 7's API returns them. `fileName` is undefined
 * for global and program diagnostics.
 *
 * A diagnostic of a file a content mapper produced is located in the file's original text, where its range
 * maps to it (`SourceFile.spanMap`); one of a supplemental file has the name of the file it was produced
 * with. A diagnostic that lies entirely in text the mapper synthesized has no place in the original: its
 * range is one of the file's text, and its `messageChain` ends with a message that says so (TS18074).
 */
export interface Diagnostic {
  readonly fileName: string | undefined;
  readonly pos: number;
  readonly end: number;
  readonly code: number;
  /**
   * For a diagnostic a content mapper reported, the prefix shown before `code` in place of `TS`; undefined for
   * a diagnostic of the compiler.
   */
  readonly source: string | undefined;
  readonly category: DiagnosticCategory;
  readonly text: string;
  readonly reportsUnnecessary: boolean;
  readonly reportsDeprecated: boolean;
  readonly messageChain: readonly Diagnostic[];
  readonly relatedInformation: readonly Diagnostic[];
}

export interface SourceFileMetadata {
  readonly isDefaultLibrary: boolean;
  readonly isFromExternalLibrary: boolean;
  /** The `type` field of the file's nearest package.json, or '' if it has none. */
  readonly packageJsonType: string;
  /** The directory of the file's nearest package.json, or ''. */
  readonly packageJsonDirectory: string;
  readonly impliedNodeFormat: ModuleKind;
}

export interface FileSystemEntries {
  readonly files: readonly string[];
  readonly directories: readonly string[];
}

/**
 * One mapping of a transformed text, as a content mapper sends it: `[virtualStart, virtualLength,
 * originalStart, originalLength, kind]`, with the features that use it as an optional sixth element (every
 * feature without it). Positions are UTF-16 offsets.
 */
export type ContentMapperMapping =
  | readonly [number, number, number, number, SpanMapKind]
  | readonly [number, number, number, number, SpanMapKind, SpanMapFeature];

/**
 * A diagnostic directive, as a content mapper sends it: `[originalStart, originalLength, virtualStart,
 * virtualEnd, policy]`, with the index of its diagnostic in `unusedExpectDirectiveDiagnostics` as an optional
 * sixth element, which a directive with the policy `Expect` needs unless there is exactly one.
 */
export type ContentMapperDiagnosticDirective =
  | readonly [number, number, number, number, number]
  | readonly [number, number, number, number, number, number];

/** The diagnostic directives of a transformed text, and the diagnostics reported for those that suppress nothing. */
export interface ContentMapperDiagnosticDirectives {
  readonly unusedExpectDirectiveDiagnostics: readonly { readonly code: number; readonly messageText: string }[];
  readonly directives: readonly ContentMapperDiagnosticDirective[];
}

/** A virtual file a content mapper returns: the text the compiler parses, and how it maps to the original text. */
export interface ContentMapperOutput {
  readonly text: string;
  /** How `text` is parsed: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` or `.json`. */
  readonly extension: string;
  /** Without mappings, or with none, the whole text is synthesized. */
  readonly mappings?: readonly ContentMapperMapping[] | null | undefined;
  readonly diagnosticDirectives?: ContentMapperDiagnosticDirectives | null | undefined;
}

/** An error a content mapper found in the original text, at UTF-16 offsets of it. */
export interface ContentMapperDiagnostic {
  readonly messageText: string;
  readonly start: number;
  readonly length: number;
  readonly code: number;
}

/**
 * What a content mapper answers for one file, as a mapper process answers a `transform` request of TypeScript
 * 7's content mapper protocol: the file's virtual text, the errors of the original text, and the supplemental
 * files the program gets with the file, each under a name the compiler gives it (`App.vue.0.ts`).
 */
export interface ContentMapperResult extends ContentMapperOutput {
  readonly diagnostics?: readonly ContentMapperDiagnostic[] | null | undefined;
  readonly supplemental?: readonly ContentMapperOutput[] | null | undefined;
}

/**
 * A content mapper the host runs itself, in place of the process TypeScript 7 starts for a mapper that a config
 * file's `contentMappers` name. tsc-ts/api only: TypeScript 7's API has no such member.
 */
export interface ContentMapper {
  /**
   * The mapper's name and version, as the `package.json` of a mapper's package has them. Diagnostics name the
   * mapper by `name`, and `SourceFile.contentMapper` of the files it produces is `name@version`, or `name`
   * without a version.
   */
  readonly name: string;
  readonly version?: string | undefined;
  /**
   * The prefix of the codes of the mapper's diagnostics, shown in place of `TS`: not blank, not `typescript`
   * or `tsc`, and not an extension the compiler reads.
   */
  readonly diagnosticSource: string;
  /** The file extensions the mapper transforms (`.vue`), none of which the compiler reads itself. */
  readonly extensions: readonly string[];
  /**
   * The transform of the file `fileName` with the text `text`. It must depend on nothing else: a program takes
   * the result of an `oldProgram` for a file with the same text. Throwing fails the transform of the file, as
   * a mapper process that answers the request with an error does.
   */
  transform(fileName: string, text: string): ContentMapperResult;
}

/**
 * Where a program reads files. Each callback may answer undefined to fall back to the real file system;
 * `readFile` answers null for a file that doesn't exist.
 */
export interface ProgramHost {
  readFile?(fileName: string): string | null | undefined;
  fileExists?(fileName: string): boolean | undefined;
  directoryExists?(directoryName: string): boolean | undefined;
  realpath?(path: string): string | undefined;
  getAccessibleEntries?(directoryName: string): FileSystemEntries | undefined;
  getCurrentDirectory(): string;
  useCaseSensitiveFileNames(): boolean;
  /** The directory with TypeScript 7's `lib.*.d.ts` files. */
  getDefaultLibraryDirectory(): string;
  /**
   * The content mappers the host runs. A program has the files with their extensions as the mappers transform
   * them: as root files, as files a config file's `include` matches, and as modules that imports name with
   * the extension. tsc-ts/api only; the mappers of a config file's `contentMappers` do not run.
   */
  readonly contentMappers?: readonly ContentMapper[] | undefined;
}

export interface CreateProgramOptions {
  readonly rootNames: readonly string[];
  readonly options: CompilerOptions;
  readonly host: ProgramHost;
  /**
   * A program created by tsc-ts/api whose parsed files the new program takes instead of parsing them again, where a
   * file has the same name, module detection options and text, as TypeScript 5's `oldProgram` with a host that keeps
   * unchanged files. A file a content mapper of the host produced is taken, with its supplemental files, where the
   * file has the same text and the mapper the same name, version and diagnostic source, without transforming it
   * again. The new program resolves its modules and checks anew, and the old one stays usable. A disposed old
   * program throws a DisposedProgramError.
   */
  readonly oldProgram?: Program | undefined;
}

/** A config file's options and files, as `tsc-ts --api`'s parseConfigFile returns them. */
export interface ParsedConfigFile {
  readonly options: CompilerOptions;
  readonly fileNames: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface Program {
  getCompilerOptions(): CompilerOptions;
  getSourceFile(fileName: string): SourceFile | undefined;
  getSourceFiles(): readonly SourceFile[];
  getSourceFileNames(): readonly string[];
  getSourceFileMetadata(fileName: string): SourceFileMetadata | undefined;
  isSourceFileDefaultLibrary(file: SourceFile): boolean;
  isSourceFileFromExternalLibrary(file: SourceFile): boolean;
  /** The program's checker for queries. Queries don't change the diagnostics the program reports. */
  getTypeChecker(): TypeChecker;
  getSyntacticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getBindDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSemanticDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getSuggestionDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getDeclarationDiagnostics(file?: SourceFile): readonly Diagnostic[];
  getProgramDiagnostics(): readonly Diagnostic[];
  getGlobalDiagnostics(): readonly Diagnostic[];
  getConfigFileParsingDiagnostics(): readonly Diagnostic[];
  /**
   * The program with the text of `fileName` replaced by `text`, as tsgo's UpdateProgram makes it: every other file,
   * and the options and module resolutions, are this program's. Undefined when the program must be created again
   * instead: the file is not in the program, is a package.json, belongs to a package installed more than once, or no
   * longer imports, references or needs the same modules. This program stays as it was, and each of the two is
   * disposed of on its own.
   *
   * A file a content mapper of the host produced is transformed again from `text`, its original text. Undefined
   * also when the transform fails, or returns other supplemental files than the program has for the file.
   */
  updateFile(fileName: string, text: string): Program | undefined;
  /** Frees the program's checkers. The program and its objects must not be used after. */
  dispose(): void;
}

/** A JSDoc tag of a symbol: its name, without the `@`, and its text, where it has one. */
export interface JSDocTagInfo {
  readonly name: string;
  readonly text?: string | undefined;
}

export interface TypeChecker {
  getSymbolAtLocation(node: Node): Symbol | undefined;
  /** The type of the expression, type node or declaration at `node`; the error type for a node without one. */
  getTypeAtLocation(node: Node): Type;
  /** The type of a symbol's value; the error type for a symbol without one. */
  getTypeOfSymbol(symbol: Symbol): Type;
  getDeclaredTypeOfSymbol(symbol: Symbol): Type;
  /** The type of a symbol as narrowed at `location`. */
  getTypeOfSymbolAtLocation(symbol: Symbol, location: Node): Type;
  getTypeArguments(type: TypeReference): readonly Type[];
  /** The target of an alias (SymbolFlags.Alias); throws an InternalCompilerError for any other symbol. */
  getAliasedSymbol(symbol: Symbol): Symbol;
  getPropertyOfType(type: Type, name: string): Symbol | undefined;
  getPropertiesOfType(type: Type): readonly Symbol[];
  getSignaturesOfType(type: Type, kind: SignatureKind): readonly Signature[];
  getIndexInfosOfType(type: Type): readonly IndexInfo[];
  /** The type a signature returns; `any` for a circular one and for a declaration with neither an annotation nor a body. */
  getReturnTypeOfSignature(signature: Signature): Type;
  /**
   * The type of the parameter at `index`: a rest parameter's element type at and after its index, `any` after the
   * last parameter without one. A negative index throws a RangeError.
   */
  getParameterType(signature: Signature, index: number): Type;
  getTypePredicateOfSignature(signature: Signature): TypePredicate | undefined;
  /** The signature of a function-like declaration; other nodes throw an InternalCompilerError, except a call the checker resolved. */
  getSignatureFromDeclaration(node: Node): Signature;
  /**
   * The signature a call-like expression resolves to, or the unknown signature (isUnknownSignature) when it doesn't
   * resolve; throws an InternalCompilerError for any other node.
   */
  getResolvedSignature(node: Node): Signature;
  getContextualType(node: Expression): Type | undefined;
  /** The symbols a module exports, `export *` ones included, without `export=` and other reserved names. */
  getExportsOfModule(symbol: Symbol): readonly Symbol[];
  /** The symbol `symbol` is a member or an export of, with its declarations merged; undefined without one. */
  getParentOfSymbol(symbol: Symbol): Symbol | undefined;
  /**
   * The symbol an export specifier exports: the member of the module it names, or what its name means where it
   * is. An identifier gives what it means where it is; any other node throws an InternalCompilerError.
   */
  getExportSpecifierLocalTargetSymbol(node: Node): Symbol | undefined;
  getShorthandAssignmentValueSymbol(node: Node): Symbol | undefined;
  /** The type a type node denotes; the error type for one that denotes none. */
  getTypeFromTypeNode(node: TypeNode): Type;
  /** The type literal types widen to (`number` for `42`), in each member of a union; any other type as it is. */
  getBaseTypeOfLiteralType(type: Type): Type;
  /** `type` without `null` and `undefined`; `type` itself without `strictNullChecks`. */
  getNonNullableType(type: Type): Type;
  /** The type whose members a value of `type` has: the global interface of a primitive, the constraint of a type parameter. */
  getApparentType(type: Type): Type;
  /**
   * The base constraint of a type that has one: of a type parameter, an indexed access, conditional, `keyof`,
   * template literal or string mapping type or a generic tuple, its constraint with the constraints in it
   * resolved; of a union or an intersection, the one of its members' constraints, itself when none is generic.
   * Undefined for any other type, without a constraint, and for a circular one.
   */
  getBaseConstraintOfType(type: Type): Type | undefined;
  /**
   * `type` as a declaration infers it from an initializer of that type: the object literal types of a union get
   * each other's missing properties as optional ones, and without `strictNullChecks` `null` and `undefined` become
   * `any`. Literal types stay as they are.
   */
  getWidenedType(type: Type): Type;
  /**
   * The type `await` gives for a value of `type`: the promised type of a promise, unwrapped to the end, or the type
   * itself. Undefined for a type `await` reports, as one whose `then` takes no callback.
   */
  getAwaitedType(type: Type): Type | undefined;
  /** The value type of the index signature of `type` whose key is `string` or `number`; undefined without one. */
  getIndexTypeOfType(type: Type, kind: IndexKind): Type | undefined;
  getBaseTypes(type: InterfaceType): readonly Type[];
  getConstantValue(node: Node): string | number | undefined;
  /** The JSDoc tags of a symbol's declarations, in source order, each with its text as a plain string. */
  getJsDocTagsOfSymbol(symbol: Symbol): readonly JSDocTagInfo[];
  isArrayType(type: Type): boolean;
  isTupleType(type: Type): boolean;
  isArrayLikeType(type: Type): boolean;
  isTypeAssignableTo(source: Type, target: Type): boolean;
  resolveName(name: string, meaning: SymbolFlags, location?: Node, excludeGlobals?: boolean): Symbol | undefined;
  /** The value `node` names where it is: `resolveName(node.text, SymbolFlags.Value | SymbolFlags.ExportValue, node)`. */
  getResolvedSymbol(node: Identifier): Symbol | undefined;
  /**
   * The text TypeScript 7's API gives for `type`, printed in `enclosingDeclaration` with `flags`; without
   * flags, or with 0, with TypeFormatFlags.AllowUniqueESSymbolType and UseAliasDefinedOutsideCurrentScope.
   */
  typeToString(type: Type, enclosingDeclaration?: Node, flags?: TypeFormatFlags): string;
  getAnyType(): Type;
  getUnknownType(): Type;
  getNeverType(): Type;
  getStringType(): Type;
  getNumberType(): Type;
  getBigIntType(): Type;
  getBooleanType(): Type;
  /** Whether `symbol` is the checker's unknown symbol, which getAliasedSymbol gives for an alias that doesn't resolve. */
  isUnknownSymbol(symbol: Symbol): boolean;
  /** Whether `signature` is the checker's unknown signature, which getResolvedSignature gives for a call that doesn't resolve. */
  isUnknownSignature(signature: Signature): boolean;
}
