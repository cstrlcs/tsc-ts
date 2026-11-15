// Usage: diagnostics <request.json>
// Prints the message table, translations, locale matches, formatted messages, diagnostic output
// and span map problems for a request, as JSON in the format of packages/tsgo/oracles/diag-oracle.
import { readFileSync } from 'node:fs';
import { messageCount, messageFlags } from '../compiler/diagnostic-messages.js';
import {
  Diagnostic,
  DiagnosticCategory,
  DiagnosticFile,
  Diagnostics,
  MappedFileInfo,
  categoryName,
  contentMapperMappingDiagnostic,
  createExternalDiagnostic,
  equalDiagnostics,
  flattenDiagnosticMessage,
  formatDiagnostics,
  formatDiagnosticStatus,
  formatDiagnosticStatusWithColor,
  formatDiagnosticsWithColorAndContext,
  formatErrorSummary,
  localizeMessage,
  messageCategory,
  messageCode,
  messageForKey,
  messageKey,
  messageText,
  parseLocale,
  sortDiagnostics,
  type DiagnosticFormatOptions,
  type DiagnosticMessage,
} from '../compiler/diagnostics.js';
import { parseJson, type JsonObject, type JsonValue } from '../compiler/package-json.js';
import { SpanMap } from '../compiler/span-map.js';
import { items, num, object, quote, quoteList, str, strings } from './json.js';

function lookup(key: string): DiagnosticMessage {
  const message = messageForKey(key);
  if (message === undefined) throw new Error('unknown key ' + key);
  return message;
}

/** The span map of the tuples a content mapper sends. */
function spanMap(mappings: JsonValue): SpanMap {
  const map = SpanMap.unmarshal(mappings);
  if (map === undefined) throw new Error('malformed mappings');
  return map;
}

/** A file of a render: one a content mapper produced when it has `mapped`. */
function sourceFile(o: JsonObject, files: readonly DiagnosticFile[]): DiagnosticFile {
  const entry = o.entries.get('mapped');
  if (entry === undefined) return new DiagnosticFile(str(o, 'name'), str(o, 'text'));
  const mapped = object(entry);
  const mappings = mapped.entries.get('mappings');
  const canonical = mapped.entries.get('canonical');
  return new DiagnosticFile(
    str(o, 'name'),
    str(o, 'text'),
    new MappedFileInfo(
      str(mapped, 'mapper'),
      str(mapped, 'original'),
      mappings === undefined ? undefined : spanMap(mappings),
      canonical === undefined ? '' : files[num(mapped, 'canonical')].fileName,
    ),
  );
}

function build(o: JsonObject, files: readonly DiagnosticFile[]): Diagnostic {
  const index = num(o, 'file');
  const file = index >= 0 ? files[index] : undefined;
  const source = str(o, 'source');
  const diagnostic =
    source !== ''
      ? createExternalDiagnostic(
          file,
          num(o, 'pos'),
          num(o, 'end'),
          source,
          DiagnosticCategory.Error,
          num(o, 'code'),
          str(o, 'text'),
        )
      : new Diagnostic(file, num(o, 'pos'), num(o, 'end'), lookup(str(o, 'key')), strings(o, 'args') ?? []);
  for (const chain of items(o, 'chain')) diagnostic.addMessageChain(build(object(chain), files));
  for (const related of items(o, 'related')) diagnostic.addRelatedInfo(build(object(related), files));
  return diagnostic;
}

function safely(locale: string, key: string, args: readonly string[]): string {
  try {
    return localizeMessage(parseLocale(locale), lookup(key), args);
  } catch (e) {
    return 'panic: ' + (e instanceof Error ? e.message : '');
  }
}

function render(o: JsonObject): string {
  const files: DiagnosticFile[] = [];
  for (const f of items(o, 'files')) files.push(sourceFile(object(f), files));
  const diagnostics: Diagnostic[] = [];
  for (const d of items(o, 'diagnostics')) diagnostics.push(build(object(d), files));
  const newLine = str(o, 'newLine');
  const useCaseSensitiveFileNames = o.entries.get('useCaseSensitiveFileNames');
  const options: DiagnosticFormatOptions = {
    locale: parseLocale(str(o, 'locale')),
    currentDirectory: str(o, 'currentDirectory'),
    useCaseSensitiveFileNames:
      useCaseSensitiveFileNames !== undefined &&
      useCaseSensitiveFileNames.type === 'boolean' &&
      useCaseSensitiveFileNames.value,
    newLine,
  };
  const flattened: string[] = [];
  const status: string[] = [];
  for (const d of diagnostics) {
    flattened.push(flattenDiagnosticMessage(d, newLine, options.locale));
    status.push(formatDiagnosticStatus('12:34:56 PM', d, options));
    status.push(formatDiagnosticStatusWithColor('12:34:56 PM', d, options));
  }
  // The diagnostics in the order they are reported in, and whether each is the same as the one before.
  const sorted = sortDiagnostics(diagnostics);
  const order: number[] = [];
  const equal: boolean[] = [];
  for (let i = 0; i < sorted.length; i++) {
    order.push(diagnostics.indexOf(sorted[i]));
    if (i > 0) equal.push(equalDiagnostics(sorted[i - 1], sorted[i]));
  }
  return (
    `{"plain":${quote(formatDiagnostics(diagnostics, options))},` +
    `"pretty":${quote(formatDiagnosticsWithColorAndContext(diagnostics, options))},` +
    `"summary":${quote(formatErrorSummary(diagnostics, options))},` +
    `"flattened":${quoteList(flattened)},"status":${quoteList(status)},` +
    `"order":[${order.join(',')}],"equal":[${equal.join(',')}]}`
  );
}

const request = object(parseJson(readFileSync(process.argv[2], 'utf8')));
const out: string[] = [];

const messages: string[] = [];
for (let i = 0; i < messageCount; i++) {
  const m = i as DiagnosticMessage;
  messages.push(
    `{"code":${messageCode(m)},"category":${quote(categoryName(messageCategory(m)))},"key":${quote(messageKey(m))},` +
      `"text":${quote(messageText(m))},"flags":${messageFlags[m]}}`,
  );
}
out.push(`"messages":[${messages.join(',')}]`);

const localized: string[] = [];
for (const tag of strings(request, 'locales') ?? []) {
  const locale = parseLocale(tag);
  const texts: string[] = [];
  for (let i = 0; i < messageCount; i++) texts.push(localizeMessage(locale, i as DiagnosticMessage, []));
  localized.push(`${quote(tag)}:${quoteList(texts)}`);
}
out.push(`"localized":{${localized.join(',')}}`);

const matches: string[] = [];
for (const tag of strings(request, 'matches') ?? []) {
  matches.push(localizeMessage(parseLocale(tag), Diagnostics.Identifier_expected, []));
}
out.push(`"matches":${quoteList(matches)}`);

const formats: string[] = [];
for (const f of items(request, 'formats')) {
  const o = object(f);
  formats.push(safely(str(o, 'locale'), str(o, 'key'), strings(o, 'args') ?? []));
}
out.push(`"formats":${quoteList(formats)}`);

const renders: string[] = [];
for (const r of items(request, 'renders')) renders.push(render(object(r)));
out.push(`"renders":[${renders.join(',')}]`);

const problems: string[] = [];
for (const p of items(request, 'problems')) {
  const o = object(p);
  const virtual = str(o, 'virtual');
  const original = str(o, 'original');
  const invalid = spanMap(o.entries.get('mappings')!).validate(virtual, original);
  if (invalid === undefined) {
    problems.push('');
    continue;
  }
  const d = contentMapperMappingDiagnostic(undefined, str(o, 'label'), invalid, virtual, original);
  problems.push(`TS${d.code}: ${d.localize(parseLocale('en'))}`);
}
out.push(`"problems":${quoteList(problems)}`);

process.stdout.write(`{${out.join(',')}}\n`);
