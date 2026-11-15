// The hand-written node types of tsc-ts's public API; the node interfaces are generated in
// ast.generated.ts (scripts/generate-api.mjs). They describe tsc-ts's own nodes, which the API hands
// out as they are: every node has its kind, flags, position and parent, and its children in the fields
// TypeScript 7's AST names. Lists are NodeList objects.

import type {
  BindingElement,
  EndOfFile,
  EntityName,
  EnumMember,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Identifier,
  JsxAttribute,
  KeywordSyntaxKind,
  ModifierSyntaxKind,
  NoSubstitutionTemplateLiteral,
  ParameterDeclaration,
  PropertyAccessExpression,
  PropertyAssignment,
  PropertyDeclaration,
  PunctuationSyntaxKind,
  Statement,
  StringLiteral,
  ThisExpression,
  Token,
  VariableDeclaration,
} from './ast.generated.js';
import type {
  DiagnosticDirectivePolicy,
  LanguageVariant,
  ModifierFlags,
  NodeFlags,
  ScriptKind,
  SyntaxKind,
} from './enums.generated.js';
import type { SpanMap } from './span-map.js';

export interface TextRange {
  readonly pos: number;
  readonly end: number;
}

/** A range of a text, as UTF-16 offsets: TypeScript 7's name for a range that is only read. */
export interface ReadonlyTextRange {
  readonly pos: number;
  readonly end: number;
}

/**
 * A node. `pos` is where the node's leading trivia starts and `end` where the node ends, as UTF-16
 * offsets into the file's text; `tokenStartOfNode` gives the start of its first token. `parent` is the
 * enclosing node, and the source file for its statements. A source file is the root of its tree: its
 * `parent` is undefined, although it is typed as a node like every other, as in TypeScript 7's API.
 */
export interface Node extends TextRange {
  readonly kind: SyntaxKind;
  readonly flags: NodeFlags;
  readonly parent: Node;
}

/** The children of a node in one list: `nodes`, and the range from the list's opening to its closing token. */
export interface NodeList<T extends Node = Node> extends TextRange {
  readonly nodes: readonly T[];
  /** Whether a comma follows the last node before the list's end. */
  hasTrailingComma(): boolean;
}

/** The modifiers of a declaration, with the flags of all of them. */
export interface ModifierList<T extends Node = Node> extends NodeList<T> {
  readonly modifierFlags: ModifierFlags;
}

/** A `/// <reference path>`, `types` or `lib` directive. */
export interface FileReference extends TextRange {
  readonly fileName: string;
  /** The `resolution-mode` attribute: ModuleKind.ESNext, ModuleKind.CommonJS, or ModuleKind.None without one. */
  readonly resolutionMode: number;
  readonly preserve: boolean;
}

export interface LineAndCharacter {
  /** 0-based line number. */
  readonly line: number;
  /** 0-based character offset, in UTF-16 code units, from the start of the line. */
  readonly character: number;
}

/**
 * A directive of the original text of a file a content mapper produced, such as a framework's
 * `@ts-expect-error`: the TypeScript diagnostics that start in `virtualRange` of the file's text are not
 * reported, and a directive with the policy `Expect` that suppresses none is itself reported, at
 * `originalRange`, with the code `unusedCode`.
 */
export interface MappedDiagnosticDirective {
  readonly originalRange: ReadonlyTextRange;
  readonly virtualRange: ReadonlyTextRange;
  readonly policy: DiagnosticDirectivePolicy;
  readonly unusedCode: number;
}

export interface SourceFile extends Node {
  readonly kind: SyntaxKind.SourceFile;
  readonly statements: NodeList<Statement>;
  readonly endOfFileToken: EndOfFile;
  /** The text the file's nodes are positions of. For a file a content mapper produced it is the virtual text. */
  readonly text: string;
  /** The text a content mapper transformed into `text`; `text` itself for any other file. */
  readonly originalText: string;
  /**
   * How `text` corresponds to `originalText`; undefined for a file no content mapper produced, and for the
   * empty file that stands in for a transform that failed.
   */
  readonly spanMap: SpanMap | undefined;
  /** The identity of the content mapper that produced this file. */
  readonly contentMapper?: string | undefined;
  /** The file name that decides the syntax and module format of the transformed text (`App.vue.ts`). */
  readonly virtualFileName?: string | undefined;
  /** The directives of the original text that apply to diagnostics of the transformed text. */
  readonly diagnosticDirectives?: readonly MappedDiagnosticDirective[] | undefined;
  /** The names the compiler gave the supplemental files a content mapper produced with this file. */
  readonly supplementalSourceFileNames?: readonly string[] | undefined;
  /** For a supplemental file, the name of the file it was produced with. */
  readonly canonicalSourceFileName?: string | undefined;
  readonly fileName: string;
  /** The file's path: its absolute, normalized file name, lower-cased where file names are case-insensitive. */
  readonly path: string;
  readonly languageVariant: LanguageVariant;
  readonly scriptKind: ScriptKind;
  readonly isDeclarationFile: boolean;
  readonly referencedFiles: readonly FileReference[];
  readonly typeReferenceDirectives: readonly FileReference[];
  readonly libReferenceDirectives: readonly FileReference[];
  /** The module specifiers of the file's imports, exports, `require` calls and import types, in source order. */
  readonly imports: readonly Node[];
  readonly moduleAugmentations: readonly Node[];
  readonly ambientModuleNames: readonly string[];
  /** The first import or export that makes the file a module, or undefined for a script. */
  readonly externalModuleIndicator: Node | undefined;
}

export type PunctuationToken<TKind extends PunctuationSyntaxKind> = Token<TKind>;
export type KeywordToken<TKind extends KeywordSyntaxKind> = Token<TKind>;
export type ModifierToken<TKind extends ModifierSyntaxKind> = KeywordToken<TKind>;

export interface PropertyAccessEntityNameExpression extends PropertyAccessExpression {
  readonly expression: EntityNameExpression;
  readonly name: Identifier;
}

export type EntityNameExpression = Identifier | PropertyAccessEntityNameExpression;
export type StringLiteralLike = StringLiteral | NoSubstitutionTemplateLiteral;
export type EntityNameOrEntityNameExpression = EntityName | EntityNameExpression;

export interface JsxTagNamePropertyAccess extends PropertyAccessExpression {
  readonly expression: Identifier | ThisExpression | JsxTagNamePropertyAccess;
}

/** The nodes that have an `initializer` that is an expression. */
export type HasExpressionInitializer =
  | VariableDeclaration
  | ParameterDeclaration
  | BindingElement
  | PropertyDeclaration
  | PropertyAssignment
  | EnumMember;

/** The nodes that have an `initializer` (`hasInitializer`). */
export type HasInitializer = HasExpressionInitializer | ForStatement | ForInStatement | ForOfStatement | JsxAttribute;

export * from './ast.generated.js';
