// Prints tsc-ts/api's answers for a project, one line each: its files and diagnostics, the symbol, types,
// signatures and children at every node of its files outside the default libraries, the tokens and comments of
// their texts, and the answers of the program with its last file updated and of a program that takes its files.
// Its host runs two content mappers, for `.box` and `.vue` files: the members and span maps of the files they
// produce are printed too, and what a mapped file's update, a mapper that throws and a result that is not valid
// give. The same answers are expected from a Node build and a native build of this file.
// Usage: api-probe <tsconfig.json> <default library directory>
import {
  type CommentRange,
  type ContentMapper,
  type ContentMapperDiagnostic,
  type ContentMapperDiagnosticDirective,
  type ContentMapperMapping,
  type ContentMapperResult,
  createProgram,
  createProgramFromConfigFile,
  createScanner,
  type Diagnostic,
  type Expression,
  getChildren,
  getFirstToken,
  getJSDocTags,
  getLastToken,
  getLeadingCommentRanges,
  getPreEmitDiagnostics,
  getSourceFileOfNode,
  getTextOfNode,
  getTrailingCommentRanges,
  hasInitializer,
  IndexKind,
  InternalCompilerError,
  isAssignmentOperator,
  isCallExpression,
  isClassLikeDeclaration,
  isExpression,
  isExpressionStatement,
  isFunctionLikeDeclaration,
  isIdentifier,
  isImportDeclaration,
  isModifier,
  isPropertyAccessExpression,
  isTokenKind,
  isTypeAliasDeclaration,
  isTypeNode,
  isVariableDeclaration,
  type Node,
  parseSourceFile,
  type Program,
  type ProgramHost,
  type Scanner,
  type Signature,
  type StringLiteralLike,
  SignatureKind,
  skipTrivia,
  type SourceFile,
  SpanMap,
  SpanMapFeature,
  SpanMapKind,
  type Statement,
  type Symbol,
  SymbolFlags,
  symbolName,
  SyntaxKind,
  type Type,
  type TupleTypeReference,
  type TypeNode,
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

/** The children of a node by kind and position, with the children of each list in brackets. */
function childrenText(node: Node): string {
  return getChildren(node)
    .map((child) =>
      child.kind === SyntaxKind.SyntaxList ? `[${childrenText(child)}]` : `${child.kind}:${child.pos}-${child.end}`,
    )
    .join(',');
}

function symbolText(symbol: Symbol | undefined): string {
  if (symbol === undefined) return '-';
  const declarations = symbol.declarations.map(nodeText).join(',');
  return `${symbolName(symbol)} ${symbol.flags >>> 0} ${symbol.checkFlags >>> 0} [${declarations}] ${nodeText(symbol.valueDeclaration)}`;
}

function diagnosticText(d: Diagnostic): string {
  const file = d.fileName === undefined ? '-' : d.fileName.substring(d.fileName.lastIndexOf('/') + 1);
  const chain = d.messageChain.map((entry) => ` | ${entry.code} ${entry.text}`).join('');
  return `${file}:${d.pos}-${d.end} ${d.source ?? 'TS'}${d.code} ${d.category} ${d.text}${chain}`;
}

function probe(program: Program, checker: TypeChecker): void {
  for (const name of program.getSourceFileNames()) print(`file ${name.substring(name.lastIndexOf('/') + 1)}`);
  for (const d of program.getSemanticDiagnostics()) print(`semantic ${diagnosticText(d)}`);
  for (const d of program.getSyntacticDiagnostics()) print(`syntactic ${diagnosticText(d)}`);
  for (const d of program.getGlobalDiagnostics()) print(`global ${diagnosticText(d)}`);
  for (const d of getPreEmitDiagnostics(program)) print(`pre-emit ${diagnosticText(d)}`);

  const types: Type[] = [];
  const seen = new Set<Type>();
  // The checker's answers are passed as a Type or a Signature where its methods always answer, so this file compiles
  // only while their return types leave out undefined.
  const keep = (type: Type): string => {
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
      print(`node ${nodeText(node)} in ${node.parent.kind} symbol ${symbolText(symbol)}`);
      print(`  text ${JSON.stringify(getTextOfNode(node).substring(0, 60))} ${getSourceFileOfNode(node) === file}`);
      if (node.kind === SyntaxKind.StringLiteral || node.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
        print(`  string ${JSON.stringify((node as StringLiteralLike).text)}`);
      if (isIdentifier(node)) print(`  identifier ${node.text}`);
      if (isCallExpression(node)) print(`  call ${nodeText(node.expression)} ${node.arguments.nodes.length}`);
      if (isPropertyAccessExpression(node)) print(`  property access ${nodeText(node.name)}`);
      if (isVariableDeclaration(node)) print(`  variable ${nodeText(node.name)} ${nodeText(node.initializer)}`);
      if (isImportDeclaration(node)) print(`  import ${nodeText(node.moduleSpecifier)}`);
      if (isClassLikeDeclaration(node)) print(`  class ${nodeText(node.name)} ${node.members.nodes.length}`);
      if (isFunctionLikeDeclaration(node)) print(`  function ${node.parameters.nodes.length} ${nodeText(node.body)}`);
      if (hasInitializer(node)) print(`  initializer ${nodeText(node.initializer)}`);
      print(
        `  guards ${kindGroup(node)} ${isModifier(node)} ${isTokenKind(node.kind)} ${isAssignmentOperator(node.kind)}`,
      );
      const tags = getJSDocTags(node);
      if (tags.length > 0) print(`  tags ${tags.map((tag) => `${tag.tagName.text}:${tag.pos}`).join(',')}`);
      print(`  children ${childrenText(node)}`);
      print(`  tokens ${nodeText(getFirstToken(node))} ${nodeText(getLastToken(node, file))}`);
      print(`  type ${keep(checker.getTypeAtLocation(node))}`);
      const contextual = checker.getContextualType(node as Expression);
      print(`  contextual ${contextual === undefined ? '-' : keep(contextual)}`);
      if (SyntaxKind.FirstTypeNode <= node.kind && node.kind <= SyntaxKind.LastTypeNode)
        print(`  type node ${keep(checker.getTypeFromTypeNode(node as TypeNode))}`);
      if (signatureDeclarationKinds.includes(node.kind))
        print(`  declared ${signatureText(checker, checker.getSignatureFromDeclaration(node))}`);
      if (node.kind === SyntaxKind.ExportSpecifier || node.kind === SyntaxKind.Identifier)
        print(`  export target ${symbolText(checker.getExportSpecifierLocalTargetSymbol(node))}`);
      if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression) {
        const signature = checker.getResolvedSignature(node);
        print(`  resolved ${nodeText(signature.declaration)} unknown ${checker.isUnknownSignature(signature)}`);
      }
    });
  }
  for (const file of program.getSourceFiles()) {
    if (program.isSourceFileDefaultLibrary(file)) continue;
    probeTokens(file);
    for (const statement of file.statements.nodes) {
      print(`group ${nodeGroup(statement)}`);
      if (isExpressionStatement(statement)) print(`group ${nodeGroup(statement.expression)}`);
      if (isTypeAliasDeclaration(statement)) print(`group ${nodeGroup(statement.type)}`);
    }
  }
  for (const symbol of symbols.slice(0, 400)) {
    print(`symbol ${symbolText(symbol)}`);
    print(`  type ${keep(checker.getTypeOfSymbol(symbol))}`);
    print(`  declared ${keep(checker.getDeclaredTypeOfSymbol(symbol))}`);
    for (const tag of checker.getJsDocTagsOfSymbol(symbol))
      print(`  tag ${tag.name} ${JSON.stringify(tag.text ?? '')}`);
    if ((symbol.flags & SymbolFlags.Alias) !== 0) {
      const aliased = checker.getAliasedSymbol(symbol);
      print(`  aliased ${symbolText(aliased)} unknown ${checker.isUnknownSymbol(aliased)}`);
    }
    print(`  parent ${symbolText(symbol.getParent())} merged ${symbolText(checker.getParentOfSymbol(symbol))}`);
    print(`  module exports ${checker.getExportsOfModule(symbol).map(symbolName).join(',')}`);
    print(`  members ${[...symbol.getMembers().keys()].sort().join(',')}`);
    print(`  exports ${[...symbol.getExports().keys()].sort().join(',')}`);
  }
  for (let i = 0; i < types.length && i < 300; i++) {
    const type = types[i]!;
    print(`type ${type.flags >>> 0} ${checker.typeToString(type)}`);
    print(`  symbol ${symbolText(type.getSymbol())} alias ${symbolText(type.getAliasSymbol())}`);
    print(`  group ${typeGroup(type)}`);
    print(`  properties ${checker.getPropertiesOfType(type).map(symbolName).join(',')}`);
    for (const kind of [SignatureKind.Call, SignatureKind.Construct])
      for (const signature of checker.getSignaturesOfType(type, kind))
        print(`  signature ${signatureText(checker, signature)}`);
    for (const info of checker.getIndexInfosOfType(type))
      print(`  index ${checker.typeToString(info.keyType)} ${checker.typeToString(info.type)} ${info.isReadonly}`);
    print(
      `  array ${checker.isArrayType(type)} tuple ${checker.isTupleType(type)} arrayLike ${checker.isArrayLikeType(type)}`,
    );
    print(
      `  literal base ${checker.typeToString(checker.getBaseTypeOfLiteralType(type))} non-nullable ${checker.typeToString(checker.getNonNullableType(type))}`,
    );
    const text = (answer: Type | undefined): string => (answer === undefined ? '-' : checker.typeToString(answer));
    print(
      `  apparent ${text(checker.getApparentType(type))} constraint ${text(checker.getBaseConstraintOfType(type))}`,
    );
    print(`  widened ${text(checker.getWidenedType(type))} awaited ${text(checker.getAwaitedType(type))}`);
    print(
      `  index types ${text(checker.getIndexTypeOfType(type, IndexKind.String))} ${text(checker.getIndexTypeOfType(type, IndexKind.Number))}`,
    );
    if (isTupleTypeReference(type)) {
      const target = type.getTarget();
      if (target.isTupleType())
        print(`  tuple target ${target.fixedLength} ${target.readonly} ${target.elementFlags.join(',')}`);
    }
  }
}

/** The kinds of declarations getSignatureFromDeclaration takes. */
const signatureDeclarationKinds: readonly SyntaxKind[] = [
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.FunctionExpression,
  SyntaxKind.ArrowFunction,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.Constructor,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.CallSignature,
  SyntaxKind.ConstructSignature,
  SyntaxKind.IndexSignature,
  SyntaxKind.FunctionType,
  SyntaxKind.ConstructorType,
];

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
    print(`  node ${nodeText(node)} ${checker.typeToString(checker.getTypeAtLocation(node))}`);
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

/**
 * What a statement, expression or type node is, by the guards. The three have the same members: this compiles
 * because the false branch of a guard leaves the other two.
 */
function nodeGroup(node: Statement | Expression | TypeNode): string {
  if (isExpression(node)) return 'expression';
  if (isTypeNode(node)) return 'type node';
  return `statement ${node.kind}`;
}

/** What any node is, by the same guards: the false branch of each leaves the node. */
function kindGroup(node: Node): string {
  if (isExpression(node)) return 'expression';
  if (isTypeNode(node)) return 'type node';
  return `other ${node.kind}`;
}

/** What a type is, by its guards, whose false branches leave the type. */
function typeGroup(type: Type): string {
  if (type.isUnionType()) return `union of ${type.getTypes().length}`;
  if (type.isIntersectionType()) return `intersection of ${type.getTypes().length}`;
  if (type.isObjectType()) return `object ${type.objectFlags >>> 0}`;
  return `other ${type.flags >>> 0}`;
}

function isTupleTypeReference(type: Type): type is TupleTypeReference {
  return type.isTypeReference() && type.getTarget().isTupleType();
}

function signatureText(checker: TypeChecker, signature: Signature): string {
  const parameters = signature.getParameters().map(symbolName).join(',');
  // The types of the parameters and of the position after them: a rest parameter's element type, or any.
  const parameterTypes: string[] = [];
  for (let index = 0; index <= signature.getParameters().length; index++)
    parameterTypes.push(checker.typeToString(checker.getParameterType(signature, index)));
  const returnType = checker.typeToString(checker.getReturnTypeOfSignature(signature));
  return `${signature.flags} ${nodeText(signature.declaration)} (${parameters}) [${parameterTypes.join('; ')}] ${returnType}`;
}

const boxPreamble = 'const __VERSION = "1.0.0";\n';

/**
 * The mapper of `.box` files: it writes a preamble, copies the text, and replaces each `#{name}` by `undefined`,
 * where one that does not close on its line is an error of the file. A `// @box-ignore` or `// @box-expect-error:`
 * line is a diagnostic directive for the line after it, and a `// @box-fail` line fails the transform.
 */
function transformBox(_fileName: string, text: string): ContentMapperResult {
  if (text.includes('// @box-fail')) throw new Error('the box mapper failed');
  let virtual = boxPreamble;
  const mappings: ContentMapperMapping[] = [];
  const diagnostics: ContentMapperDiagnostic[] = [];
  const write = (piece: string, from: number, to: number, kind: SpanMapKind): void => {
    if (kind === SpanMapKind.Verbatim && from === to) return;
    mappings.push([virtual.length, piece.length, from, to - from, kind]);
    virtual += piece;
  };
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf('#{', pos);
    if (start < 0) {
      write(text.substring(pos), pos, text.length, SpanMapKind.Verbatim);
      break;
    }
    const newLine = text.indexOf('\n', start);
    const lineEnd = newLine < 0 ? text.length : newLine;
    const close = text.indexOf('}', start);
    const closed = close >= 0 && close < lineEnd;
    const end = closed ? close + 1 : lineEnd;
    write(text.substring(pos, start), pos, start, SpanMapKind.Verbatim);
    write('undefined', start, end, SpanMapKind.Atom);
    if (!closed)
      diagnostics.push({ messageText: 'Unclosed interpolation.', start, length: lineEnd - start, code: 1000 });
    pos = end;
  }
  // The virtual range of the line after a directive, through the span map of what was written.
  const spanMap = new SpanMap(
    mappings.map((mapping) => ({
      virtualStart: mapping[0],
      virtualEnd: mapping[0] + mapping[1],
      originalStart: mapping[2],
      originalEnd: mapping[2] + mapping[3],
      kind: mapping[4],
    })),
  );
  const directives: ContentMapperDiagnosticDirective[] = [];
  const unused: { code: number; messageText: string }[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const newLine = text.indexOf('\n', lineStart);
    if (newLine < 0) break;
    const line = text.substring(lineStart, newLine).trim();
    const expect = line.startsWith('// @box-expect-error:');
    if (line === '// @box-ignore' || expect) {
      const nextNewLine = text.indexOf('\n', newLine + 1);
      const spans = spanMap.originalToVirtualSpans(
        { pos: newLine + 1, end: nextNewLine < 0 ? text.length : nextNewLine },
        SpanMapFeature.All,
      );
      if (expect) unused.push({ code: 2578, messageText: line.substring('// @box-expect-error:'.length).trim() });
      if (spans.length === 1) {
        const range = spans[0]!.range;
        if (expect) directives.push([lineStart, newLine - lineStart, range.pos, range.end, 1, unused.length - 1]);
        else directives.push([lineStart, newLine - lineStart, range.pos, range.end, 0]);
      }
    }
    lineStart = newLine + 1;
  }
  return {
    text: virtual,
    extension: '.ts',
    mappings,
    diagnosticDirectives: { unusedExpectDirectiveDiagnostics: unused, directives },
    diagnostics,
  };
}

const vuePrefix = 'missingSupplementalGlobal;\n';

/**
 * The mapper of `.vue` files: an empty module, with a supplemental file that is a line without an original and
 * then the text.
 */
function transformVue(_fileName: string, text: string): ContentMapperResult {
  return {
    text: 'export {};',
    extension: '.ts',
    supplemental: [
      { text: vuePrefix + text, extension: '.ts', mappings: [[vuePrefix.length, text.length, 0, text.length, 0]] },
    ],
  };
}

/** The mapper of `.box` files with a transform and a diagnostic source. */
function boxMapperWith(
  transform: (fileName: string, text: string) => ContentMapperResult,
  diagnosticSource: string,
): ContentMapper {
  return { name: 'box-mapper', version: '1.0.0', diagnosticSource, extensions: ['.box'], transform };
}

const boxMapper = boxMapperWith(transformBox, 'box');
const vueMapper: ContentMapper = {
  name: 'vue-mapper',
  diagnosticSource: 'mapper',
  extensions: ['.vue'],
  transform: transformVue,
};

/**
 * The members of the files a content mapper produced, what their span maps answer at the ends of each segment,
 * and the program with one more line in the first of them, which has an error.
 */
function probeMappedFiles(program: Program): void {
  let first: SourceFile | undefined;
  for (const file of program.getSourceFiles()) {
    if (file.contentMapper === undefined) continue;
    if (first === undefined && file.canonicalSourceFileName === undefined) first = file;
    print(`mapped ${nodeText(file)} by ${file.contentMapper} as ${file.virtualFileName ?? '-'}`);
    print(`  texts ${file.text.length} ${file.originalText.length} ${file.text === file.originalText}`);
    print(`  canonical ${file.canonicalSourceFileName ?? '-'}`);
    print(`  supplemental ${(file.supplementalSourceFileNames ?? []).join(',')}`);
    for (const directive of file.diagnosticDirectives ?? [])
      print(
        `  directive ${directive.originalRange.pos}-${directive.originalRange.end} ` +
          `${directive.virtualRange.pos}-${directive.virtualRange.end} ${directive.policy} ${directive.unusedCode}`,
      );
    const spanMap = file.spanMap;
    if (spanMap === undefined) continue;
    for (const segment of spanMap.segments) {
      print(
        `  segment ${segment.virtualStart}-${segment.virtualEnd} ${segment.originalStart}-${segment.originalEnd} ` +
          `${segment.kind} ${segment.features}`,
      );
      for (const position of [segment.virtualStart - 1, segment.virtualStart, segment.virtualEnd]) {
        const mapped = spanMap.virtualToOriginalPosition(position);
        const span = spanMap.virtualToOriginalSpan({ pos: position, end: position + 2 });
        const hover = spanMap.virtualToOriginalSpanForFeature(
          { pos: position, end: position + 2 },
          SpanMapFeature.Hover,
        );
        print(
          `    virtual ${position} to ${mapped.position} ${mapped.fidelity} ${span.range.pos}-${span.range.end} ` +
            `${span.fidelity} ${SpanMap.isExact(span.fidelity)} ${SpanMap.isNone(hover.fidelity)}`,
        );
      }
      for (const position of [segment.originalStart, segment.originalEnd]) {
        const positions = spanMap
          .originalToVirtualPositions(position, SpanMapFeature.All)
          .map((mapped) => `${mapped.position}:${mapped.fidelity}`);
        const spans = spanMap
          .originalToVirtualSpans({ pos: position - 1, end: position + 1 }, SpanMapFeature.All)
          .map((mapped) => `${mapped.range.pos}-${mapped.range.end}:${mapped.fidelity}`);
        print(`    original ${position} to ${positions.join(',')} spans ${spans.join(',')}`);
      }
    }
  }
  if (first === undefined) return;
  for (const d of program.getSyntacticDiagnostics(first)) print(`  mapped syntactic ${diagnosticText(d)}`);
  const text = first.originalText + 'const probeMapped: number = "text";\n';
  const updated = program.updateFile(first.fileName, text);
  print(`mapped update ${nodeText(first)} ${updated !== undefined}`);
  if (updated === undefined) return;
  const updatedFile = updated.getSourceFile(first.fileName)!;
  print(`  texts ${updatedFile.text.length} ${updatedFile.originalText.length} ${first.originalText.length}`);
  for (const d of updated.getSemanticDiagnostics(updatedFile)) print(`  semantic ${diagnosticText(d)}`);
  // A transform that fails leaves the program to be created again, which reports the failure.
  print(`mapped update that fails ${updated.updateFile(first.fileName, text + '// @box-fail\n') !== undefined}`);
  updated.dispose();
}

/**
 * The diagnostics of a program whose only file is a `.box` file that the host has in memory, for a mapper that
 * throws, results that are not valid, and a mapper whose diagnostic source is reserved.
 */
function probeMapperFailures(directory: string, libDir: string): void {
  const fileName = directory + '/probe-mapper-failure.box';
  const results: [string, ContentMapper][] = [
    ['throws', boxMapper],
    ['extension', boxMapperWith(() => ({ text: '', extension: '.vue' }), 'box')],
    ['mappings', boxMapperWith(() => ({ text: 'let a;', extension: '.ts', mappings: [[0, 9, 0, 9, 0]] }), 'box')],
    ['verbatim', boxMapperWith(() => ({ text: 'let a;', extension: '.ts', mappings: [[0, 3, 0, 3, 0]] }), 'box')],
    ['source', boxMapperWith(transformBox, 'ts')],
    ['synthesized', boxMapperWith(() => ({ text: 'let a: string = 1;', extension: '.ts' }), 'box')],
  ];
  for (const [name, mapper] of results) {
    const failing = createProgram({
      rootNames: [fileName],
      options: { noEmit: true, types: [] },
      host: {
        getCurrentDirectory: () => directory,
        useCaseSensitiveFileNames: () => true,
        getDefaultLibraryDirectory: () => libDir,
        contentMappers: [mapper],
        readFile: (path: string) => (path === fileName ? '// @box-fail\n' : undefined),
        fileExists: (path: string) => (path === fileName ? true : undefined),
      },
    });
    const file = failing.getSourceFile(fileName)!;
    print(`mapper ${name} ${file.text.length} ${file.originalText.length} ${file.spanMap === undefined}`);
    for (const d of getPreEmitDiagnostics(failing)) print(`  pre-emit ${diagnosticText(d)}`);
    failing.dispose();
  }
}

const args = process.argv.slice(2);
const configFileName = args[0]!;
const libDir = args[1]!;
const directory = configFileName.substring(0, configFileName.lastIndexOf('/'));
print('start');
const host: ProgramHost = {
  getCurrentDirectory: () => directory,
  useCaseSensitiveFileNames: () => true,
  getDefaultLibraryDirectory: () => libDir,
  contentMappers: [boxMapper, vueMapper],
};
const program = createProgramFromConfigFile(configFileName, host);
probe(program, program.getTypeChecker());
probeUpdate(program);
probeOldProgram(program, createProgramFromConfigFile(configFileName, host, program));
probeMappedFiles(program);
probeMapperFailures(directory, libDir);
const parsed = parseSourceFile(directory + '/parsed.ts', 'export const parsed = 1;\n');
print(`parsed ${parsed.statements.nodes.length} ${parsed.statements.nodes[0]!.kind}`);
try {
  const checker = program.getTypeChecker();
  checker.getAliasedSymbol(checker.resolveName('Math', SymbolFlags.Value)!);
} catch (e) {
  print(`error ${e instanceof InternalCompilerError ? 'InternalCompilerError' : 'other'}`);
}
program.dispose();
