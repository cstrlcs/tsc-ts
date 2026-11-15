// Module specifiers as module transforms write them.
import { type Node, StringLiteral } from '../ast.js';
import { getExternalModuleName } from '../ast-utilities.js';
import type { CompilerOptions } from '../options.js';
import { getOutputExtension } from '../output-paths.js';
import { type ExtensionRewrite, changeExtension, rewriteExtension, shouldRewriteExtension } from '../path.js';
import type { EmitContext } from '../printer/emit-context.js';
import { TokenFlags } from '../types.js';

/** The module name of an import, export or `import()` as written in output, or undefined. */
export function getExternalModuleNameLiteral(context: EmitContext, node: Node): StringLiteral | undefined {
  const name = getExternalModuleName(node);
  if (!(name instanceof StringLiteral)) return undefined;
  return context.factory.createStringLiteral(name.text, TokenFlags.None);
}

/**
 * The extensions `rewriteRelativeImportExtensions` rewrites besides TypeScript's: those of the files content
 * mappers produce, to the extensions of their outputs, in any letter case when file names are not case sensitive.
 */
export class ImportExtensionRewrites {
  constructor(
    readonly rewrites: readonly ExtensionRewrite[],
    readonly useCaseSensitiveFileNames: boolean,
  ) {}
}

/** The arguments of the `require` call for an import: its rewritten module name. */
export function createRequireCallArguments(
  context: EmitContext,
  node: Node,
  options: CompilerOptions,
  extensions: ImportExtensionRewrites,
): Node[] {
  const name = getExternalModuleNameLiteral(context, node);
  return name === undefined ? [] : [rewriteModuleSpecifier(context, name, options, extensions)];
}

/**
 * With `rewriteRelativeImportExtensions`, `./a.ts` becomes `./a.js`, and the extension of a content mapper's
 * file becomes the one of its output.
 */
export function rewriteModuleSpecifier(
  context: EmitContext,
  node: Node,
  options: CompilerOptions,
  extensions: ImportExtensionRewrites,
): Node {
  if (!(node instanceof StringLiteral) || options.rewriteRelativeImportExtensions !== true) return node;
  const text = node.text;
  if (!shouldRewriteExtension(text, extensions.rewrites, extensions.useCaseSensitiveFileNames)) return node;
  const updatedText =
    rewriteExtension(text, extensions.rewrites, extensions.useCaseSensitiveFileNames) ??
    changeExtension(text, getOutputExtension(text, options.jsx));
  if (updatedText === text) return node;
  const updated = context.factory.createStringLiteral(updatedText, node.tokenFlags);
  context.setOriginal(updated, node);
  context.assignCommentAndSourceMapRanges(updated, node);
  return updated;
}
