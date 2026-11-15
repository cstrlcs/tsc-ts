// The JSDoc tags of a node, as TypeScript 7's API gives them (getJSDocTags): those of the node's own JSDoc
// comments, of the comments of its initializer and of the declarations and statements that document it, and,
// for a parameter or type parameter, the `@param` or `@template` tags of the declaration it belongs to.

import {
  getInitializer,
  getName,
  getParameters,
  getText,
  JSDoc as CompilerJSDoc,
  JSDocTemplateTag,
  type Node as CompilerNode,
  type SourceFile as CompilerSourceFile,
  VariableDeclarationList,
} from '../compiler/ast.js';
import { getSourceFileOfNode } from '../compiler/binder-utilities.js';
import { getJSDoc } from '../compiler/parser.js';
import { SyntaxKind } from '../compiler/syntax-kind.js';
import type { JSDocTag, Node } from './ast.js';

/** Whether a node is a variable-like declaration: the JSDoc comments of its initializer also document it. */
function isVariableLike(node: CompilerNode): boolean {
  switch (node.kind) {
    case SyntaxKind.BindingElement:
    case SyntaxKind.EnumMember:
    case SyntaxKind.Parameter:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
    case SyntaxKind.ShorthandPropertyAssignment:
    case SyntaxKind.VariableDeclaration:
      return true;
  }
  return false;
}

/** Whether `hostNode` owns a tag: a `@type` or `@satisfies` tag on a parenthesized expression is that expression's alone. */
function ownsJSDocTag(hostNode: CompilerNode, tag: CompilerNode): boolean {
  if (tag.kind !== SyntaxKind.JSDocTypeTag && tag.kind !== SyntaxKind.JSDocSatisfiesTag) return true;
  const comment = tag.parent;
  if (comment === undefined || comment.kind !== SyntaxKind.JSDoc) return true;
  const documented = comment.parent;
  return documented === undefined || documented.kind !== SyntaxKind.ParenthesizedExpression || documented === hostNode;
}

/**
 * Adds the tags of the JSDoc comments of `node` that apply to `hostNode`: those of the last comment that
 * `hostNode` owns, after the `@overload` tags of the comments before it.
 */
function addOwnedJSDocTags(
  hostNode: CompilerNode,
  node: CompilerNode,
  file: CompilerSourceFile,
  tags: CompilerNode[],
): void {
  const comments = getJSDoc(file, node);
  const last = comments.length - 1;
  for (let i = 0; i <= last; i++) {
    const comment = comments[i]!;
    if (!(comment instanceof CompilerJSDoc) || comment.tags === undefined) continue;
    for (const tag of comment.tags.nodes)
      if (i < last ? tag.kind === SyntaxKind.JSDocOverloadTag : ownsJSDocTag(hostNode, tag)) tags.push(tag);
  }
}

/**
 * Adds the `@param` tags of a parameter's declaration that name the parameter; for a binding pattern, the
 * tag at the parameter's position among them.
 */
function addJSDocParameterTags(parameter: CompilerNode, tags: CompilerNode[]): void {
  const declaration = parameter.parent!;
  const name = getName(parameter)!;
  const parameterTags = jsDocTagsOf(declaration).filter((tag) => tag.kind === SyntaxKind.JSDocParameterTag);
  if (name.kind === SyntaxKind.Identifier) {
    const text = getText(name);
    for (const tag of parameterTags) {
      const tagName = getName(tag)!;
      if (tagName.kind === SyntaxKind.Identifier && getText(tagName) === text) tags.push(tag);
    }
    return;
  }
  const parameters = getParameters(declaration);
  if (parameters === undefined) return;
  const index = parameters.nodes.indexOf(parameter);
  if (index >= 0 && index < parameterTags.length) tags.push(parameterTags[index]!);
}

/** Adds the `@template` tags of a type parameter's declaration that declare the type parameter. */
function addJSDocTypeParameterTags(typeParameter: CompilerNode, tags: CompilerNode[]): void {
  const text = getText(getName(typeParameter)!);
  for (const tag of jsDocTagsOf(typeParameter.parent!))
    if (
      tag instanceof JSDocTemplateTag &&
      tag.typeParameters.nodes.some((declared) => getText(getName(declared)!) === text)
    )
      tags.push(tag);
}

/** The declaration or statement whose JSDoc comments also document `node`, its child. */
function getNextJSDocCommentLocation(node: CompilerNode): CompilerNode | undefined {
  const parent = node.parent;
  if (parent === undefined) return undefined;
  switch (parent.kind) {
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.ExportAssignment:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.ReturnStatement:
    case SyntaxKind.VariableStatement:
    case SyntaxKind.ExpressionStatement:
      return parent;
    case SyntaxKind.VariableDeclarationList:
      // Only the first declaration of a list is documented by the list's statement.
      return parent instanceof VariableDeclarationList && parent.declarations.nodes[0] === node ? parent : undefined;
  }
  return undefined;
}

function jsDocTagsOf(hostNode: CompilerNode): CompilerNode[] {
  const tags: CompilerNode[] = [];
  const file = getSourceFileOfNode(hostNode);
  if (isVariableLike(hostNode)) {
    const initializer = getInitializer(hostNode);
    if (initializer !== undefined) addOwnedJSDocTags(hostNode, initializer, file, tags);
  }
  let node: CompilerNode | undefined = hostNode;
  while (node !== undefined && node.parent !== undefined) {
    addOwnedJSDocTags(hostNode, node, file, tags);
    if (node.kind === SyntaxKind.Parameter) {
      addJSDocParameterTags(node, tags);
      break;
    }
    if (node.kind === SyntaxKind.TypeParameter) {
      addJSDocTypeParameterTags(node, tags);
      break;
    }
    node = getNextJSDocCommentLocation(node);
  }
  return tags;
}

/**
 * The JSDoc tags that apply to `node`, in TypeScript 7's order: the tags of the last JSDoc comment of its
 * initializer, of the node and of each declaration or statement that documents it as its child (a variable
 * statement documents its first declaration, and a declaration its initializer), each after the `@overload`
 * tags of the comments before the last; for a parameter, also the `@param` tags of its declaration that
 * name it, and for a type parameter the `@template` tags that declare it.
 */
export function getJSDocTags(node: Node): readonly JSDocTag[] {
  return jsDocTagsOf(node as unknown as CompilerNode) as unknown as readonly JSDocTag[];
}
