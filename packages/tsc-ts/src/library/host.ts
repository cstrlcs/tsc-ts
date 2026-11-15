// The file system a program of tsc-ts's public API reads through its host.

import { diskEntries, diskReadFile, diskRealpath, diskStat } from './disk.js';
import { ParseOptions, ScriptKind, type ExternalModuleIndicatorOptions, type SourceFile } from '../compiler/ast.js';
import type { ContentMapper, ContentMapperProject } from '../compiler/content-mapper.js';
import { CompilerHost, ContentMappedSourceFiles, type ContentMapperFailure } from '../compiler/file-loader.js';
import { DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import { takePreparedFile } from '../compiler/parallel-parse.js';
import { parseSourceFile } from '../compiler/parser.js';
import type { Program as CompilerProgram } from '../compiler/program.js';
import type { DiagnosticDirectivePolicy } from './enums.generated.js';
import { SpanMap, type SpanMapSegment } from './span-map.js';
import type { ProgramHost } from './types.js';

/**
 * The host's answers, and the disk's where a callback is missing or answers undefined, as `tsc-ts --api`
 * reads through its client's callbacks. `readFile` answering null means the file doesn't exist.
 */
export class HostFileSystem extends FileSystem {
  constructor(private readonly host: ProgramHost) {
    super(host.useCaseSensitiveFileNames());
  }

  fileExists(path: string): boolean {
    const answer = this.host.fileExists?.(path);
    return answer ?? diskStat(path)?.isDirectory === false;
  }

  directoryExists(path: string): boolean {
    const answer = this.host.directoryExists?.(path);
    return answer ?? diskStat(path)?.isDirectory === true;
  }

  readFile(path: string): string | undefined {
    const answer = this.host.readFile?.(path);
    if (answer === null) return undefined;
    return answer ?? diskReadFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    const entries = this.host.getAccessibleEntries?.(path) ?? diskEntries(path);
    return new DirectoryEntries(entries.files.slice(), entries.directories.slice(), undefined);
  }

  realpath(path: string): string {
    return this.host.realpath?.(path) ?? diskRealpath(path);
  }
}

/**
 * `fs` with the text of `fileName` replaced by `text`, as a program updated with `Program.updateFile` reads it.
 * Replacing a file of a ReplacedFileSystem keeps its replaced texts and wraps its inner file system, so that a
 * program updated many times reads through one wrapper, which holds the last text of each replaced file.
 */
export class ReplacedFileSystem extends FileSystem {
  private readonly inner: FileSystem;
  /** The replaced texts, by file name as the program names the file. */
  private readonly texts: Map<string, string>;

  constructor(fs: FileSystem, fileName: string, text: string) {
    super(fs.useCaseSensitiveFileNames);
    if (fs instanceof ReplacedFileSystem) {
      this.inner = fs.inner;
      this.texts = new Map(fs.texts);
    } else {
      this.inner = fs;
      this.texts = new Map();
    }
    this.texts.set(fileName, text);
  }

  fileExists(path: string): boolean {
    return this.texts.has(path) || this.inner.fileExists(path);
  }

  directoryExists(path: string): boolean {
    return this.inner.directoryExists(path);
  }

  readFile(path: string): string | undefined {
    return this.texts.get(path) ?? this.inner.readFile(path);
  }

  getAccessibleEntries(path: string): DirectoryEntries {
    return this.inner.getAccessibleEntries(path);
  }

  realpath(path: string): string {
    return this.inner.realpath(path);
  }
}

/**
 * The compiler host of a program of tsc-ts's public API. A file that parse threads prepared, reading the disk, is
 * taken only when the host gives the same text for it; the program parses the host's text otherwise. With an old
 * program, the parsed and bound file of that program is taken when the file has the same name, path, module
 * detection options and text, for which it parses the same, until `releaseOldProgram`.
 *
 * The files a content mapper produces get the members of the API's SourceFile that are objects of the API
 * (`setMappedFileMembers`). With an old program, the file of that program and its supplemental files are taken
 * when the mapper, as the project configures it, produced them from the same text.
 */
export class LibraryCompilerHost extends CompilerHost {
  constructor(
    fs: FileSystem,
    currentDirectory: string,
    defaultLibraryPath: string,
    /** The program whose files this host takes where they are unchanged. */
    private oldProgram: CompilerProgram | undefined = undefined,
    contentMapperProject: ContentMapperProject | undefined = undefined,
  ) {
    super(fs, currentDirectory, defaultLibraryPath, contentMapperProject);
  }

  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const text = this.readFile(fileName);
    if (text === undefined) return undefined;
    const old = this.oldProgram?.getSourceFileByPath(path);
    if (
      old !== undefined &&
      old.fileName === fileName &&
      old.text === text &&
      old.externalModuleIndicatorOptions.jsx === externalModuleIndicatorOptions.jsx &&
      old.externalModuleIndicatorOptions.force === externalModuleIndicatorOptions.force
    )
      return old;
    return (
      takePreparedFile(fileName, path, externalModuleIndicatorOptions, text) ??
      parseSourceFile(fileName, text, new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions))
    );
  }

  getContentMappedSourceFiles(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
    mapper: ContentMapper,
  ): ContentMappedSourceFiles | ContentMapperFailure | undefined {
    const old = this.oldProgram?.getSourceFileByPath(path);
    // A file parsed with other options than these, as one whose virtual extension makes it a module is, is
    // transformed again, and so is one with a supplemental file whose name is now that of a file on disk, which
    // the transform reports.
    const parsedAlike = (file: SourceFile): boolean =>
      file.externalModuleIndicatorOptions.jsx === externalModuleIndicatorOptions.jsx &&
      file.externalModuleIndicatorOptions.force === externalModuleIndicatorOptions.force;
    if (
      old !== undefined &&
      old.fileName === fileName &&
      old.contentMapperSpanMap() !== undefined &&
      old.contentMapperIdentity() === mapper.identity() &&
      old.contentMapperTransformIdentity() === this.contentMapperProject?.identity(mapper) &&
      parsedAlike(old) &&
      old.supplementalSourceFiles().every((file) => parsedAlike(file) && !this.fileExists(file.fileName)) &&
      old.originalText === this.readFile(fileName)
    )
      return new ContentMappedSourceFiles(old, old.supplementalSourceFiles());
    const files = super.getContentMappedSourceFiles(fileName, path, externalModuleIndicatorOptions, mapper);
    if (files instanceof ContentMappedSourceFiles) {
      setMappedFileMembers(files.canonical);
      for (const file of files.supplemental) setMappedFileMembers(file);
    }
    return files;
  }

  /** Stops taking files from the old program, once the new program has loaded, so that it doesn't keep the old one. */
  releaseOldProgram(): void {
    this.oldProgram = undefined;
  }
}

/**
 * Sets the members of the API's SourceFile that are objects of the API on a file a content mapper produced:
 * its span map, its diagnostic directives and the names of its supplemental files, each undefined where the
 * file has none, as TypeScript 7's API gives them.
 */
function setMappedFileMembers(file: SourceFile): void {
  const spanMap = file.contentMapperSpanMap();
  if (spanMap !== undefined) file.spanMap = new SpanMap(spanMap.segments as unknown as readonly SpanMapSegment[]);
  const directives = file.contentMapperDiagnosticDirectives();
  if (directives.length > 0)
    file.diagnosticDirectives = directives.map((directive) => ({
      originalRange: { pos: directive.originalPos, end: directive.originalEnd },
      virtualRange: { pos: directive.virtualPos, end: directive.virtualEnd },
      policy: directive.policy as number as DiagnosticDirectivePolicy,
      unusedCode: directive.unusedCode,
    }));
  const supplemental = file.supplementalSourceFiles();
  if (supplemental.length > 0) file.supplementalSourceFileNames = supplemental.map((other) => other.fileName);
}
