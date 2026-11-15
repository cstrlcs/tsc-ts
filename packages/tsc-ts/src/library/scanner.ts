// The scanner of tsc-ts's public API, with the names of TypeScript 7's API: createScanner, the comment
// ranges before and after a position, and skipTrivia. Positions are UTF-16 offsets into the text.

import {
  getLeadingCommentRanges as compilerLeadingCommentRanges,
  getTrailingCommentRanges as compilerTrailingCommentRanges,
  Scanner as CompilerScanner,
  skipTrivia as compilerSkipTrivia,
} from '../compiler/scanner.js';
import type { LanguageVariant as CompilerLanguageVariant } from '../compiler/types.js';
import type { JsxTokenSyntaxKind } from './ast.js';
import { LanguageVariant, type SyntaxKind, type TokenFlags } from './enums.generated.js';

export type CommentKind = SyntaxKind.SingleLineCommentTrivia | SyntaxKind.MultiLineCommentTrivia;

/** A comment: its range, from its `//` or `/*` to its end, and whether a line break follows it. */
export interface CommentRange {
  readonly pos: number;
  readonly end: number;
  readonly kind: CommentKind;
  readonly hasTrailingNewLine: boolean;
}

/**
 * Scans a text into tokens, as TypeScript 7's scanner does. `scan()` reads the next token and the getters
 * describe the token read last. The rescan methods read that token again as the parser does where the
 * syntax calls for it: `>` as a longer operator, `/` as a regular expression, `}` as the continuation of
 * a template, and the text between JSX tags.
 */
export interface Scanner {
  getToken(): SyntaxKind;
  /** The start of the token's leading trivia. */
  getTokenFullStart(): number;
  getTokenStart(): number;
  getTokenEnd(): number;
  getTokenText(): string;
  /** The token's value: an identifier's name, or a literal's text with its escapes resolved. */
  getTokenValue(): string;
  getTokenFlags(): TokenFlags;
  hasPrecedingLineBreak(): boolean;
  /** Whether the token is a string, template or regular expression literal that the text ends inside. */
  isUnterminated(): boolean;
  getText(): string;
  scan(): SyntaxKind;
  reScanGreaterToken(): SyntaxKind;
  reScanSlashToken(): SyntaxKind;
  reScanTemplateToken(isTaggedTemplate: boolean): SyntaxKind;
  scanJsxToken(): JsxTokenSyntaxKind;
  reScanJsxToken(allowMultilineJsxText?: boolean): JsxTokenSyntaxKind;
  /** Sets the text to scan, from its start. */
  setText(text: string): void;
  setLanguageVariant(variant: LanguageVariant): void;
  /** Moves to `pos`, so that the next token is scanned from there with no token read. */
  resetTokenState(pos: number): void;
}

/** The compiler's scanner behind the Scanner interface. */
class LibraryScanner implements Scanner {
  private readonly scanner: CompilerScanner;

  constructor(skipTrivia: boolean, languageVariant: LanguageVariant, text: string) {
    this.scanner = new CompilerScanner(text);
    this.scanner.setSkipTrivia(skipTrivia);
    this.scanner.setLanguageVariant(languageVariant as number as CompilerLanguageVariant);
  }

  getToken(): SyntaxKind {
    return this.scanner.getToken() as number as SyntaxKind;
  }

  getTokenFullStart(): number {
    return this.scanner.getTokenFullStart();
  }

  getTokenStart(): number {
    return this.scanner.getTokenStart();
  }

  getTokenEnd(): number {
    return this.scanner.getTokenEnd();
  }

  getTokenText(): string {
    return this.scanner.getTokenText();
  }

  getTokenValue(): string {
    return this.scanner.getTokenValue();
  }

  getTokenFlags(): TokenFlags {
    return this.scanner.getTokenFlags() as number as TokenFlags;
  }

  hasPrecedingLineBreak(): boolean {
    return this.scanner.hasPrecedingLineBreak();
  }

  isUnterminated(): boolean {
    return this.scanner.isUnterminated();
  }

  getText(): string {
    return this.scanner.getText();
  }

  scan(): SyntaxKind {
    return this.scanner.scan() as number as SyntaxKind;
  }

  reScanGreaterToken(): SyntaxKind {
    return this.scanner.reScanGreaterThanToken() as number as SyntaxKind;
  }

  reScanSlashToken(): SyntaxKind {
    return this.scanner.reScanSlashToken() as number as SyntaxKind;
  }

  reScanTemplateToken(isTaggedTemplate: boolean): SyntaxKind {
    return this.scanner.reScanTemplateToken(isTaggedTemplate) as number as SyntaxKind;
  }

  scanJsxToken(): JsxTokenSyntaxKind {
    return this.scanner.scanJsxToken() as number as JsxTokenSyntaxKind;
  }

  reScanJsxToken(allowMultilineJsxText = true): JsxTokenSyntaxKind {
    return this.scanner.reScanJsxToken(allowMultilineJsxText) as number as JsxTokenSyntaxKind;
  }

  setText(text: string): void {
    this.scanner.setText(text);
  }

  setLanguageVariant(variant: LanguageVariant): void {
    this.scanner.setLanguageVariant(variant as number as CompilerLanguageVariant);
  }

  resetTokenState(pos: number): void {
    this.scanner.resetTokenState(pos);
  }
}

/**
 * A scanner of `text` (empty by default) in `languageVariant` (standard by default). With `skipTrivia`,
 * `scan()` passes over whitespace and comments; without it, it answers them as trivia tokens.
 */
export function createScanner(
  skipTrivia: boolean,
  languageVariant: LanguageVariant = LanguageVariant.Standard,
  text = '',
): Scanner {
  return new LibraryScanner(skipTrivia, languageVariant, text);
}

/**
 * The position after the whitespace, comments, conflict markers and leading shebang at `pos`: where the
 * next token starts. `stopAfterLineBreak` ends at the start of the next line, `stopAtComments` before a
 * comment, and `inJSDoc` also passes the `*` that starts a line of a JSDoc comment.
 */
export function skipTrivia(
  text: string,
  pos: number,
  stopAfterLineBreak?: boolean,
  stopAtComments?: boolean,
  inJSDoc?: boolean,
): number {
  return compilerSkipTrivia(text, pos, stopAfterLineBreak, stopAtComments, inJSDoc);
}

/** The comments before the next token at `pos`; those on the line `pos` is in are skipped unless `pos` is 0. */
export function getLeadingCommentRanges(text: string, pos: number): readonly CommentRange[] | undefined {
  return compilerLeadingCommentRanges(text, pos) as readonly CommentRange[] | undefined;
}

/** The comments after `pos`, up to the next line break. */
export function getTrailingCommentRanges(text: string, pos: number): readonly CommentRange[] | undefined {
  return compilerTrailingCommentRanges(text, pos) as readonly CommentRange[] | undefined;
}
