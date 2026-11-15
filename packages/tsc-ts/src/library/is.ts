// Three of the type guards that TypeScript 7's API writes by hand, because ast.json does not list the kinds
// they answer for: isExpression, isTypeNode and hasInitializer. The generated guards are in is.generated.ts.

import type { Expression, HasInitializer, Node, TypeNode } from './ast.js';
import { SyntaxKind } from './enums.generated.js';

/** Whether a node of this kind is an expression, wherever it stands: an identifier is one also as a name. */
export function isExpression(node: Node): node is Expression {
  switch (node.kind) {
    case SyntaxKind.ConditionalExpression:
    case SyntaxKind.YieldExpression:
    case SyntaxKind.ArrowFunction:
    case SyntaxKind.BinaryExpression:
    case SyntaxKind.SpreadElement:
    case SyntaxKind.AsExpression:
    case SyntaxKind.OmittedExpression:
    case SyntaxKind.SatisfiesExpression:
    case SyntaxKind.PrefixUnaryExpression:
    case SyntaxKind.PostfixUnaryExpression:
    case SyntaxKind.DeleteExpression:
    case SyntaxKind.TypeOfExpression:
    case SyntaxKind.VoidExpression:
    case SyntaxKind.AwaitExpression:
    case SyntaxKind.TypeAssertionExpression:
    case SyntaxKind.CallExpression:
    case SyntaxKind.NewExpression:
    case SyntaxKind.TaggedTemplateExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.MetaProperty:
    case SyntaxKind.JsxExpression:
    case SyntaxKind.PropertyAccessExpression:
    case SyntaxKind.ElementAccessExpression:
    case SyntaxKind.FunctionExpression:
    case SyntaxKind.ClassExpression:
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.ArrayLiteralExpression:
    case SyntaxKind.ObjectLiteralExpression:
    case SyntaxKind.TemplateExpression:
    case SyntaxKind.Identifier:
    case SyntaxKind.PrivateIdentifier:
    case SyntaxKind.NumericLiteral:
    case SyntaxKind.BigIntLiteral:
    case SyntaxKind.StringLiteral:
    case SyntaxKind.RegularExpressionLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
    case SyntaxKind.JsxElement:
    case SyntaxKind.JsxSelfClosingElement:
    case SyntaxKind.JsxFragment:
    case SyntaxKind.NullKeyword:
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
    case SyntaxKind.ThisKeyword:
    case SyntaxKind.SuperKeyword:
    case SyntaxKind.ImportKeyword:
    case SyntaxKind.ExpressionWithTypeArguments:
      return true;
  }
  return false;
}

/** Whether a node of this kind is a type node: a type, a type keyword, or a JSDoc type. */
export function isTypeNode(node: Node): node is TypeNode {
  const kind = node.kind;
  if (kind >= SyntaxKind.FirstTypeNode && kind <= SyntaxKind.LastTypeNode) return true;
  switch (kind) {
    case SyntaxKind.AnyKeyword:
    case SyntaxKind.UnknownKeyword:
    case SyntaxKind.NumberKeyword:
    case SyntaxKind.BigIntKeyword:
    case SyntaxKind.ObjectKeyword:
    case SyntaxKind.BooleanKeyword:
    case SyntaxKind.StringKeyword:
    case SyntaxKind.SymbolKeyword:
    case SyntaxKind.VoidKeyword:
    case SyntaxKind.UndefinedKeyword:
    case SyntaxKind.NeverKeyword:
    case SyntaxKind.IntrinsicKeyword:
    case SyntaxKind.ExpressionWithTypeArguments:
    case SyntaxKind.JSDocAllType:
    case SyntaxKind.JSDocNullableType:
    case SyntaxKind.JSDocNonNullableType:
    case SyntaxKind.JSDocOptionalType:
    case SyntaxKind.JSDocVariadicType:
    case SyntaxKind.JSDocTypeExpression:
    case SyntaxKind.JSDocTypeLiteral:
    case SyntaxKind.JSDocSignature:
      return true;
  }
  return false;
}

/**
 * Whether a node is of a kind that has an `initializer` (`HasInitializer`), whether or not this node has
 * one: a variable declaration without an initializer is such a node.
 */
export function hasInitializer(node: Node): node is HasInitializer {
  switch (node.kind) {
    case SyntaxKind.VariableDeclaration:
    case SyntaxKind.Parameter:
    case SyntaxKind.BindingElement:
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertyAssignment:
    case SyntaxKind.EnumMember:
    case SyntaxKind.ForStatement:
    case SyntaxKind.ForInStatement:
    case SyntaxKind.ForOfStatement:
    case SyntaxKind.JsxAttribute:
      return true;
  }
  return false;
}
