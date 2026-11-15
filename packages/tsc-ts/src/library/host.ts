// The file system a program of tsc-ts's public API reads through its host.

import { diskEntries, diskReadFile, diskRealpath, diskStat } from './disk.js';
import { ParseOptions, ScriptKind, type ExternalModuleIndicatorOptions, type SourceFile } from '../compiler/ast.js';
import { CompilerHost } from '../compiler/file-loader.js';
import { DirectoryEntries, FileSystem } from '../compiler/file-system.js';
import { takePreparedFile } from '../compiler/parallel-parse.js';
import { parseSourceFile } from '../compiler/parser.js';
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
 * taken only when the host gives the same text for it; the program parses the host's text otherwise.
 */
export class LibraryCompilerHost extends CompilerHost {
  getSourceFile(
    fileName: string,
    path: string,
    externalModuleIndicatorOptions: ExternalModuleIndicatorOptions,
  ): SourceFile | undefined {
    const text = this.readFile(fileName);
    if (text === undefined) return undefined;
    return (
      takePreparedFile(fileName, path, externalModuleIndicatorOptions, text) ??
      parseSourceFile(fileName, text, new ParseOptions(path, ScriptKind.Unknown, externalModuleIndicatorOptions))
    );
  }
}
