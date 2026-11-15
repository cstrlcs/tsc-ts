// Node functions of tsc-ts's public API, with TypeScript 7's behavior.

import {
  getModifiers as compilerGetModifiers,
  type Node as CompilerNode,
  type ModifierList as CompilerModifierList,
  type NodeList as CompilerNodeList,
  NodeFlags as CompilerNodeFlags,
  NodeVisitor,
  type SourceFile as CompilerSourceFile,
  SyntaxList,
  Token,
} from '../compiler/ast.js';
import { getTokenPosOfNode } from '../compiler/astnav.js';
import {
  getCombinedModifierFlags as compilerModifierFlags,
  getCombinedNodeFlags as compilerNodeFlags,
  getSourceFileOfNode as compilerSourceFileOfNode,
} from '../compiler/binder-utilities.js';
import { getJSDoc as compilerGetJSDoc } from '../compiler/parser.js';
import { computeLineOfPosition, Scanner, tokenToString as compilerTokenToString } from '../compiler/scanner.js';
import { SyntaxKind as CompilerSyntaxKind } from '../compiler/syntax-kind.js';
import type { JSDoc, LineAndCharacter, ModifierList, Node, NodeList, SourceFile } from './ast.js';
import type { ModifierFlags, NodeFlags, SyntaxKind } from './enums.generated.js';
import type { Diagnostic } from './types.js';

const compilerNode = (node: Node): CompilerNode => node as unknown as CompilerNode;

/** Visits the children of a node; stops at the first callback that answers a truthy value. */
class CallbackVisitor extends NodeVisitor {
  result: unknown = undefined;

  constructor(
    private readonly cbNode: (node: Node) => unknown,
    private readonly cbNodes: ((nodes: NodeList) => unknown) | undefined,
  ) {
    super();
  }

  visitNode(node: CompilerNode): boolean {
    const result = this.cbNode(node as unknown as Node);
    if (!result) return false;
    this.result = result;
    return true;
  }

  visitList(list: CompilerNodeList): boolean {
    if (this.cbNodes === undefined) return super.visitList(list);
    const result = this.cbNodes(list as unknown as NodeList);
    if (!result) return false;
    this.result = result;
    return true;
  }

  visitModifiers(list: CompilerModifierList): boolean {
    return this.visitList(list);
  }
}

/**
 * Calls `cbNode` for each child of `node`, in source order, or `cbNodes` for each list of children when it
 * is given; returns the first truthy value a callback answers. JSDoc is not visited (`getJSDoc`).
 */
export function forEachChild<T>(
  node: Node,
  cbNode: (node: Node) => T | undefined,
  cbNodes?: (nodes: NodeList) => T | undefined,
): T | undefined {
  const visitor = new CallbackVisitor(cbNode, cbNodes);
  compilerNode(node).forEachChild(visitor);
  return visitor.result as T | undefined;
}

/** Collects the children of a node, in source order. */
class ChildCollector extends NodeVisitor {
  readonly children: CompilerNode[] = [];

  visitNode(node: CompilerNode): boolean {
    this.children.push(node);
    return false;
  }
}

/**
 * Visits `root` and its descendants in preorder, with `depth` the number of levels below `root`, without
 * recursion. The callback may answer 'skip' to leave a node's children unvisited, or 'stop' to end the walk.
 */
export function walkPreorder(root: Node, cb: (node: Node, depth: number) => void | 'skip' | 'stop'): void {
  const stack: CompilerNode[] = [compilerNode(root)];
  const depths: number[] = [0];
  const collector = new ChildCollector();
  // Declared outside the loop: scriptc compiles the node's conversion to the public Node from a variable there.
  let node: CompilerNode;
  while (stack.length > 0) {
    node = stack.pop()!;
    const depth = depths.pop()!;
    const verdict = cb(node as unknown as Node, depth);
    if (verdict === 'stop') return;
    if (verdict === 'skip') continue;
    collector.children.length = 0;
    node.forEachChild(collector);
    const children = collector.children;
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push(children[i]!);
      depths.push(depth + 1);
    }
  }
}

// The children getChildren made for each node, so that a node's tokens are made once.
const childrenOfNodes = new WeakMap<CompilerNode, readonly CompilerNode[]>();
// The scanner that reads the tokens between children, kept with the text of the file it scanned last.
let childScanner: Scanner | undefined;
// The children of a token.
const noChildren: readonly Node[] = [];

function childScannerOf(file: CompilerSourceFile): Scanner {
  let scanner = childScanner;
  if (scanner === undefined) {
    scanner = new Scanner();
    childScanner = scanner;
  }
  if (scanner.getText() !== file.text) scanner.setText(file.text);
  scanner.setLanguageVariant(file.languageVariant);
  return scanner;
}

function isReparsed(node: CompilerNode): boolean {
  return (node.flags & CompilerNodeFlags.Reparsed) !== 0;
}

function isTokenKind(kind: CompilerSyntaxKind): boolean {
  return kind >= CompilerSyntaxKind.FirstToken && kind <= CompilerSyntaxKind.LastToken;
}

/** Whether a node is part of a JSDoc comment, where there are no tokens to make between children. */
function shouldSkipChild(node: CompilerNode): boolean {
  switch (node.kind) {
    case CompilerSyntaxKind.JSDoc:
    case CompilerSyntaxKind.JSDocText:
    case CompilerSyntaxKind.JSDocTypeLiteral:
    case CompilerSyntaxKind.JSDocSignature:
    case CompilerSyntaxKind.JSDocLink:
    case CompilerSyntaxKind.JSDocLinkCode:
    case CompilerSyntaxKind.JSDocLinkPlain:
      return true;
  }
  return node.kind >= CompilerSyntaxKind.FirstJSDocTagNode && node.kind <= CompilerSyntaxKind.LastJSDocTagNode;
}

/** Adds the tokens of `parent` in [pos, end) to `children`, made from the scanner. */
function addSyntheticNodes(
  children: CompilerNode[],
  pos: number,
  end: number,
  parent: CompilerNode,
  scanner: Scanner,
): void {
  if (pos >= end) return;
  scanner.resetTokenState(pos);
  scanner.scan();
  while (pos < end) {
    const kind = scanner.getToken();
    const tokenEnd = scanner.getTokenEnd();
    // An identifier is a child node, never a token between children.
    if (tokenEnd <= end && kind !== CompilerSyntaxKind.Identifier) {
      const token = new Token(kind);
      token.pos = pos | 0;
      token.end = tokenEnd | 0;
      token.parent = parent;
      children.push(token);
    }
    pos = tokenEnd;
    if (kind === CompilerSyntaxKind.EndOfFile) break;
    scanner.scan();
  }
}

/** Collects the children of a node with the tokens between them; each list of children becomes one SyntaxList. */
class ChildrenWithTokens extends NodeVisitor {
  readonly children: CompilerNode[] = [];
  /** Where the tokens before the next child start: the end of the child visited last. */
  pos: number;

  constructor(
    private readonly node: CompilerNode,
    private readonly scanner: Scanner,
  ) {
    super();
    this.pos = node.pos;
  }

  visitNode(child: CompilerNode): boolean {
    // Reparsed nodes (JSDoc types placed in the tree) lie inside a comment, outside the node's tokens.
    if (isReparsed(child)) return false;
    addSyntheticNodes(this.children, this.pos, child.pos, this.node, this.scanner);
    this.children.push(child);
    this.pos = child.end;
    return false;
  }

  visitList(list: CompilerNodeList): boolean {
    const nodes = list.nodes;
    if (nodes.length > 0 && nodes.every(isReparsed)) return false;
    addSyntheticNodes(this.children, this.pos, list.pos, this.node, this.scanner);
    const listChildren: CompilerNode[] = [];
    let pos = list.pos;
    for (const child of nodes) {
      if (isReparsed(child)) continue;
      addSyntheticNodes(listChildren, pos, child.pos, this.node, this.scanner);
      listChildren.push(child);
      pos = child.end;
    }
    addSyntheticNodes(listChildren, pos, list.end, this.node, this.scanner);
    const syntaxList = new SyntaxList(listChildren);
    syntaxList.pos = list.pos | 0;
    syntaxList.end = list.end | 0;
    syntaxList.parent = this.node;
    this.children.push(syntaxList);
    this.pos = list.end;
    return false;
  }

  visitModifiers(list: CompilerModifierList): boolean {
    return this.visitList(list);
  }

  /** Adds the tokens after the last child, to the end of the node. */
  finish(): void {
    addSyntheticNodes(this.children, this.pos, this.node.end, this.node, this.scanner);
  }
}

function createChildren(node: CompilerNode, file: CompilerSourceFile): readonly CompilerNode[] {
  if (shouldSkipChild(node)) {
    const collector = new ChildCollector();
    node.forEachChild(collector);
    return collector.children;
  }
  const collector = new ChildrenWithTokens(node, childScannerOf(file));
  // The node's JSDoc comments come first: they are in its leading trivia.
  for (const jsDoc of compilerGetJSDoc(file, node)) collector.visitNode(jsDoc);
  collector.pos = node.pos;
  node.forEachChild(collector);
  collector.finish();
  return collector.children;
}

/**
 * The children of `node` with the tokens the parser doesn't keep, as TypeScript 7's `node.getChildren()`
 * gives them: the node's JSDoc comments, then its child nodes and the tokens between them in source order,
 * with each list of children as one SyntaxList node that holds the list's nodes and the tokens that
 * separate them. The tokens are made from the scanner, with `node` as their parent. A token has no
 * children, except the end of file token, which has its JSDoc comments; a node of a JSDoc comment has its
 * child nodes only. The children of a node are made once: every call answers the same nodes.
 */
export function getChildren(node: Node, sourceFile: SourceFile = getSourceFileOfNode(node)): readonly Node[] {
  const compiler = compilerNode(node);
  if (compiler.kind === CompilerSyntaxKind.SyntaxList)
    return (compiler as SyntaxList).children as unknown as readonly Node[];
  if (isTokenKind(compiler.kind) && compiler.kind !== CompilerSyntaxKind.EndOfFile) return noChildren;
  let children = childrenOfNodes.get(compiler);
  if (children === undefined) {
    const file = sourceFile as unknown as CompilerSourceFile;
    children =
      compiler.kind === CompilerSyntaxKind.EndOfFile
        ? compilerGetJSDoc(file, compiler)
        : createChildren(compiler, file);
    childrenOfNodes.set(compiler, children);
  }
  return children as unknown as readonly Node[];
}

/**
 * The first token of `node`, as TypeScript 7's `node.getFirstToken()` gives it: the first of its children
 * (`getChildren`) outside its JSDoc comments, or that child's first token when it is not a token itself.
 * Undefined for a token and for a node without children.
 */
export function getFirstToken(node: Node, sourceFile: SourceFile = getSourceFileOfNode(node)): Node | undefined {
  if (isTokenKind(compilerNode(node).kind)) return undefined;
  for (const child of getChildren(node, sourceFile)) {
    const kind = compilerNode(child).kind;
    if (kind >= CompilerSyntaxKind.FirstJSDocNode && kind <= CompilerSyntaxKind.LastJSDocNode) continue;
    return kind < CompilerSyntaxKind.FirstNode ? child : getFirstToken(child, sourceFile);
  }
  return undefined;
}

/**
 * The last token of `node`, as TypeScript 7's `node.getLastToken()` gives it: the last of its children
 * (`getChildren`), or that child's last token when it is not a token itself. Undefined for a token and
 * for a node without children.
 */
export function getLastToken(node: Node, sourceFile: SourceFile = getSourceFileOfNode(node)): Node | undefined {
  if (isTokenKind(compilerNode(node).kind)) return undefined;
  const children = getChildren(node, sourceFile);
  if (children.length === 0) return undefined;
  const child = children[children.length - 1]!;
  return compilerNode(child).kind < CompilerSyntaxKind.FirstNode ? child : getLastToken(child, sourceFile);
}

/**
 * The start of the first token of `node`, after its leading trivia; with `includeJSDoc`, the start of its
 * first JSDoc comment where it has one.
 */
export function tokenStartOfNode(node: Node, includeJSDoc = false): number {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return getTokenPosOfNode(compilerNode(node), file, includeJSDoc);
}

/** The source file `node` is in: the root of its parents. */
export function getSourceFileOfNode(node: Node): SourceFile {
  let current = node;
  while (current.parent !== undefined) current = current.parent;
  return current as SourceFile;
}

/**
 * The text of `node` in its source file, from the start of its first token (`tokenStartOfNode`) to its end:
 * TypeScript's `node.getText()`.
 */
export function getTextOfNode(node: Node): string {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return file.text.substring(getTokenPosOfNode(compilerNode(node), file, false), node.end);
}

/** The JSDoc comments of `node`, as the JSDoc nodes TypeScript 7 attaches to it (parsed on first use). */
export function getJSDoc(node: Node): readonly JSDoc[] {
  const file = compilerSourceFileOfNode(compilerNode(node));
  return compilerGetJSDoc(file, compilerNode(node)) as unknown as readonly JSDoc[];
}

/** The modifiers of a declaration, decorators included, as TypeScript 7 keeps them. */
export function getModifiers(node: Node): ModifierList | undefined {
  return compilerGetModifiers(compilerNode(node)) as unknown as ModifierList | undefined;
}

/** Whether a node of this kind can have modifiers (TypeScript 7's CanHaveModifiers). */
export function canHaveModifiers(node: Node): boolean {
  switch (compilerNode(node).kind) {
    case CompilerSyntaxKind.TypeParameter:
    case CompilerSyntaxKind.Parameter:
    case CompilerSyntaxKind.PropertySignature:
    case CompilerSyntaxKind.PropertyDeclaration:
    case CompilerSyntaxKind.MethodSignature:
    case CompilerSyntaxKind.MethodDeclaration:
    case CompilerSyntaxKind.Constructor:
    case CompilerSyntaxKind.GetAccessor:
    case CompilerSyntaxKind.SetAccessor:
    case CompilerSyntaxKind.IndexSignature:
    case CompilerSyntaxKind.ConstructorType:
    case CompilerSyntaxKind.FunctionExpression:
    case CompilerSyntaxKind.ArrowFunction:
    case CompilerSyntaxKind.ClassExpression:
    case CompilerSyntaxKind.VariableStatement:
    case CompilerSyntaxKind.FunctionDeclaration:
    case CompilerSyntaxKind.ClassDeclaration:
    case CompilerSyntaxKind.InterfaceDeclaration:
    case CompilerSyntaxKind.TypeAliasDeclaration:
    case CompilerSyntaxKind.EnumDeclaration:
    case CompilerSyntaxKind.ModuleDeclaration:
    case CompilerSyntaxKind.ImportEqualsDeclaration:
    case CompilerSyntaxKind.ImportDeclaration:
    case CompilerSyntaxKind.JSImportDeclaration:
    case CompilerSyntaxKind.ExportAssignment:
    case CompilerSyntaxKind.ExportDeclaration:
      return true;
  }
  return false;
}

/**
 * The modifier flags of a declaration with those of the declarations it is part of: for a binding element,
 * of the declaration of its outermost pattern; for a variable declaration, of its list and statement.
 */
export function getCombinedModifierFlags(node: Node): ModifierFlags {
  return compilerModifierFlags(compilerNode(node)) as number as ModifierFlags;
}

/** The node flags of a declaration with those of the declarations it is part of, as getCombinedModifierFlags. */
export function getCombinedNodeFlags(node: Node): NodeFlags {
  return compilerNodeFlags(compilerNode(node)) as number as NodeFlags;
}

/** The UTF-16 offset at which each line of the file starts. */
export function getLineStarts(file: SourceFile): readonly number[] {
  return (file as unknown as CompilerSourceFile).lineStarts();
}

/** The 0-based line and character of a UTF-16 position in the file. */
export function getLineAndCharacterOfPosition(file: SourceFile, position: number): LineAndCharacter {
  const lineStarts = getLineStarts(file);
  const line = computeLineOfPosition(lineStarts, position);
  return { line, character: position - lineStarts[line]! };
}

/** The UTF-16 position of a 0-based line and character in the file. */
export function getPositionOfLineAndCharacter(file: SourceFile, line: number, character: number): number {
  return getLineStarts(file)[line]! + character;
}

/** The text of a punctuation or keyword token kind, or undefined for other kinds. */
export function tokenToString(kind: SyntaxKind): string | undefined {
  const text = compilerTokenToString(kind as number as CompilerSyntaxKind);
  return text === '' ? undefined : text;
}

/**
 * A diagnostic's text with its chain of messages, each on its own line, indented two spaces per level of
 * the chain, as TypeScript prints them.
 */
export function flattenDiagnosticMessageText(
  diagnostic: Diagnostic | string | undefined,
  newLine: string,
  indent = 0,
): string {
  if (diagnostic === undefined) return '';
  if (typeof diagnostic === 'string') return diagnostic;
  let result = '';
  if (indent > 0) {
    result += newLine;
    for (let i = 0; i < indent; i++) result += '  ';
  }
  result += diagnostic.text;
  for (const child of diagnostic.messageChain) result += flattenDiagnosticMessageText(child, newLine, indent + 1);
  return result;
}
