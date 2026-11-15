// Prints tsc-ts/api's answers for a project, one line each: its files and diagnostics, the symbol, types and
// signatures at every node of its files outside the default libraries, the tokens and comments of their texts, and
// the answers of the program with its last file updated and of a program that takes its files. The same answers are
// expected from a Node build and a native build of this file.
// Usage: api-probe <tsconfig.json> <default library directory>
import {
  type CommentRange,
  createProgramFromConfigFile,
  createScanner,
  type Diagnostic,
  type Expression,
  getLeadingCommentRanges,
  getPreEmitDiagnostics,
  getSourceFileOfNode,
  getTextOfNode,
  getTrailingCommentRanges,
  InternalCompilerError,
  type Node,
  parseSourceFile,
  type Program,
  type Scanner,
  type Signature,
  type StringLiteralLike,
  SignatureKind,
  skipTrivia,
  type SourceFile,
  type Symbol,
  SymbolFlags,
  symbolName,
  SyntaxKind,
  type Type,
  type TupleTypeReference,
  type TypeChecker,
  walkPreorder,
} from '../../src/library/index.js';

const print = (line: string): void => {
  console.log(line);
};

function sourceFileOf(node: Node): SourceFile {
  let current = node;
  while (current.parent !== undefined) current = current.parent;
  return current as SourceFile;
}

/** A node by file, kind and position, which identifies it in both builds. */
function nodeText(node: Node | undefined): string {
  if (node === undefined) return '-';
  const file = sourceFileOf(node);
  const name = file.fileName.substring(file.fileName.lastIndexOf('/') + 1);
  return `${name}:${node.kind}:${node.pos}-${node.end}`;
}

function symbolText(symbol: Symbol | undefined): string {
  if (symbol === undefined) return '-';
  const declarations = symbol.declarations.map(nodeText).join(',');
  return `${symbolName(symbol)} ${symbol.flags >>> 0} ${symbol.checkFlags >>> 0} [${declarations}] ${nodeText(symbol.valueDeclaration)}`;
}

function diagnosticText(d: Diagnostic): string {
  const file = d.fileName === undefined ? '-' : d.fileName.substring(d.fileName.lastIndexOf('/') + 1);
  return `${file}:${d.pos}-${d.end} TS${d.code} ${d.category} ${d.text}`;
}

function probe(program: Program, checker: TypeChecker): void {
  for (const name of program.getSourceFileNames()) print(`file ${name.substring(name.lastIndexOf('/') + 1)}`);
  for (const d of program.getSemanticDiagnostics()) print(`semantic ${diagnosticText(d)}`);
  for (const d of program.getSyntacticDiagnostics()) print(`syntactic ${diagnosticText(d)}`);
  for (const d of program.getGlobalDiagnostics()) print(`global ${diagnosticText(d)}`);
  for (const d of getPreEmitDiagnostics(program)) print(`pre-emit ${diagnosticText(d)}`);

  const types: Type[] = [];
  const seen = new Set<Type>();
  const keep = (type: Type | undefined): string => {
    if (type === undefined) return '-';
    if (!seen.has(type)) {
      seen.add(type);
      types.push(type);
    }
    return `${type.flags >>> 0} ${checker.typeToString(type)}`;
  };

  const symbols: Symbol[] = [];
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    walkPreorder(file, (node) => {
      if (node === file) return;
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol !== undefined) symbols.push(symbol);
      print(`node ${nodeText(node)} symbol ${symbolText(symbol)}`);
      print(`  text ${JSON.stringify(getTextOfNode(node).substring(0, 60))} ${getSourceFileOfNode(node) === file}`);
      if (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
        print(`  string ${JSON.stringify((node as StringLiteralLike).text)}`);
      print(`  type ${keep(checker.getTypeAtLocation(node))}`);
      print(`  contextual ${keep(checker.getContextualType(node as Expression))}`);
      if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression) {
        const signature = checker.getResolvedSignature(node);
        print(`  resolved ${signature === undefined ? '-' : nodeText(signature.declaration)}`);
      }
    });
  }
  for (const file of program.getSourceFiles()) if (!program.isSourceFileDefaultLibrary(file)) probeTokens(file);
  for (const symbol of symbols.slice(0, 400)) {
    print(`symbol ${symbolText(symbol)}`);
    print(`  type ${keep(checker.getTypeOfSymbol(symbol))}`);
    print(`  declared ${keep(checker.getDeclaredTypeOfSymbol(symbol))}`);
    if ((symbol.flags & SymbolFlags.Alias) !== 0) print(`  aliased ${symbolText(checker.getAliasedSymbol(symbol))}`);
    print(`  parent ${symbolText(symbol.getParent())}`);
    print(`  members ${[...symbol.getMembers().keys()].sort().join(',')}`);
    print(`  exports ${[...symbol.getExports().keys()].sort().join(',')}`);
  }
  for (let i = 0; i < types.length && i < 300; i++) {
    const type = types[i]!;
    print(`type ${type.flags >>> 0} ${checker.typeToString(type)}`);
    print(`  symbol ${symbolText(type.getSymbol())} alias ${symbolText(type.getAliasSymbol())}`);
    print(`  properties ${checker.getPropertiesOfType(type).map(symbolName).join(',')}`);
    for (const kind of [SignatureKind.Call, SignatureKind.Construct])
      for (const signature of checker.getSignaturesOfType(type, kind))
        print(`  signature ${signatureText(checker, signature)}`);
    for (const info of checker.getIndexInfosOfType(type))
      print(`  index ${checker.typeToString(info.keyType)} ${checker.typeToString(info.type)} ${info.isReadonly}`);
    print(
      `  array ${checker.isArrayType(type)} tuple ${checker.isTupleType(type)} arrayLike ${checker.isArrayLikeType(type)}`,
    );
    if (isTupleTypeReference(type)) {
      const target = type.getTarget();
      if (target.isTupleType())
        print(`  tuple target ${target.fixedLength} ${target.readonly} ${target.elementFlags.join(',')}`);
    }
  }
}

/**
 * The answers of the program with new text for its last file: one more declaration, which has an error, and then one
 * more import, which `updateFile` refuses.
 */
function probeUpdate(program: Program): void {
  const files = program.getSourceFiles();
  const file = files[files.length - 1]!;
  const text = file.text + '\nexport const probeUpdated: number = "text";\n';
  const updated = program.updateFile(file.fileName, text);
  print(`update ${nodeText(file)} ${updated !== undefined}`);
  print(
    `update with import ${program.updateFile(file.fileName, 'import "./probe-missing.js";\n' + text) !== undefined}`,
  );
  if (updated === undefined) return;
  const updatedFile = updated.getSourceFile(file.fileName)!;
  print(`  text ${updatedFile.text.length} ${program.getSourceFile(file.fileName)!.text.length}`);
  for (const d of updated.getSemanticDiagnostics(updatedFile)) print(`  semantic ${diagnosticText(d)}`);
  const checker = updated.getTypeChecker();
  walkPreorder(updatedFile, (node) => {
    if (node.pos < file.text.length) return;
    const type = checker.getTypeAtLocation(node);
    print(`  node ${nodeText(node)} ${type === undefined ? '-' : checker.typeToString(type)}`);
  });
  updated.dispose();
}

/** How many files `next`, a program created with `program` as its old program, took from it, and its diagnostics. */
function probeOldProgram(program: Program, next: Program): void {
  let taken = 0;
  for (const file of next.getSourceFiles()) if (program.getSourceFile(file.fileName) === file) taken += 1;
  print(`old program ${next.getSourceFiles().length} files ${taken} taken`);
  for (const d of next.getSemanticDiagnostics()) print(`  semantic ${diagnosticText(d)}`);
  next.dispose();
}

function commentsText(comments: readonly CommentRange[] | undefined): string {
  if (comments === undefined) return '-';
  return comments.map((c) => `${c.kind}:${c.pos}-${c.end}:${c.hasTrailingNewLine}`).join(',');
}

function tokenText(scanner: Scanner): string {
  return `${scanner.getToken()} ${scanner.getTokenStart()}-${scanner.getTokenEnd()} ${JSON.stringify(scanner.getTokenValue())}`;
}

/** The tokens of a file with their trivia, each read again as the parser may read it, and the comments around them. */
function probeTokens(file: SourceFile): void {
  const text = file.text;
  const scanner = createScanner(false, file.languageVariant, text);
  const again = createScanner(true);
  again.setText(scanner.getText());
  again.setLanguageVariant(file.languageVariant);
  for (;;) {
    const kind = scanner.scan();
    const start = scanner.getTokenFullStart();
    print(
      `token ${kind} ${start}-${scanner.getTokenStart()}-${scanner.getTokenEnd()} ${scanner.getTokenFlags()} ${JSON.stringify(scanner.getTokenText())} ${scanner.hasPrecedingLineBreak()} ${scanner.isUnterminated()}`,
    );
    print(
      `  trivia ${skipTrivia(text, start)} ${skipTrivia(text, start, true)} ${skipTrivia(text, start, false, true)}`,
    );
    print(`  leading ${commentsText(getLeadingCommentRanges(text, start))}`);
    print(`  trailing ${commentsText(getTrailingCommentRanges(text, scanner.getTokenEnd()))}`);
    again.resetTokenState(start);
    again.scan();
    if (kind === SyntaxKind.GreaterThanToken) print(`  greater ${again.reScanGreaterToken()} ${tokenText(again)}`);
    if (kind === SyntaxKind.SlashToken) print(`  slash ${again.reScanSlashToken()} ${tokenText(again)}`);
    if (kind === SyntaxKind.CloseBraceToken)
      print(`  template ${again.reScanTemplateToken(false)} ${tokenText(again)}`);
    if (kind === SyntaxKind.OpenBraceToken) {
      print(`  jsx ${again.scanJsxToken()} ${tokenText(again)}`);
      print(`  jsx again ${again.reScanJsxToken()} ${tokenText(again)}`);
    }
    if (kind === SyntaxKind.EndOfFile) break;
  }
}

function isTupleTypeReference(type: Type): type is TupleTypeReference {
  return type.isTypeReference() && type.getTarget().isTupleType();
}

function signatureText(checker: TypeChecker, signature: Signature): string {
  const parameters = signature.getParameters().map(symbolName).join(',');
  const returnType = checker.getReturnTypeOfSignature(signature);
  return `${signature.flags} ${nodeText(signature.declaration)} (${parameters}) ${returnType === undefined ? '-' : checker.typeToString(returnType)}`;
}

const args = process.argv.slice(2);
const configFileName = args[0]!;
const libDir = args[1]!;
const directory = configFileName.substring(0, configFileName.lastIndexOf('/'));
print('start');
const host = {
  getCurrentDirectory: () => directory,
  useCaseSensitiveFileNames: () => true,
  getDefaultLibraryDirectory: () => libDir,
};
const program = createProgramFromConfigFile(configFileName, host);
probe(program, program.getTypeChecker());
probeUpdate(program);
probeOldProgram(program, createProgramFromConfigFile(configFileName, host, program));
const parsed = parseSourceFile(directory + '/parsed.ts', 'export const parsed = 1;\n');
print(`parsed ${parsed.statements.nodes.length} ${parsed.statements.nodes[0]!.kind}`);
try {
  const checker = program.getTypeChecker();
  checker.getAliasedSymbol(checker.resolveName('Math', SymbolFlags.Value)!);
} catch (e) {
  print(`error ${e instanceof InternalCompilerError ? 'InternalCompilerError' : 'other'}`);
}
program.dispose();
