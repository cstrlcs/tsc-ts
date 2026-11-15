// What the tests of tsc-ts/api with content mappers share: the mappers of content-mappers.mjs as the callbacks of
// a host and as the packages of a project, which name the processes of content-mapper-server.mjs, and the
// members of a source file that TypeScript's `tsc --api` encodes for a mapped file.
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createTestMapperSpawner } from './content-mappers.mjs';

/**
 * The mapper that the first word of `command` names, as a content mapper of a host with the name `name` and
 * the version 1.0.0: it answers what the process answers for a project with `compilerOptions`. The mappers
 * count positions in UTF-8 bytes, which are the UTF-16 offsets of a host's mapper in the ASCII files the tests
 * give them.
 */
export function hostMapper(spanMap, command, name, diagnosticSource, extensions, compilerOptions = {}) {
  const mapper = createTestMapperSpawner(spanMap)([command]);
  mapper.handleRequest('openProject', { projectHandle: 'host', compilerOptions });
  return {
    name,
    version: '1.0.0',
    diagnosticSource,
    extensions,
    transform: (fileName, content) => mapper.handleRequest('transform', { fileName, content, projectHandle: 'host' }),
  };
}

/** Links each package of `dir`/mappers into `dir`/node_modules, where a config file's `contentMappers` find it. */
export function linkMapperPackages(dir, names) {
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  for (const name of names) symlinkSync(join(dir, 'mappers', name), join(dir, 'node_modules', name));
}

const none = 0xffffffff;

/**
 * The members of the source file in `bytes`, a `getSourceFile` response of `tsc --api`, that describe a mapped
 * file, read as TypeScript 7's client reads them (packages/typescript/src/api/node/node.ts): the texts and
 * names from the string table, and the span map, the diagnostic directives and the supplemental file names
 * from the structured data.
 */
export function mappedFileMembers(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (at) => view.getUint32(at, true);
  const [stringOffsets, strings, extendedData, structuredData, nodes] = [24, 28, 32, 36, 40].map(u32);
  // The source file is the node at index 1; its data word holds the offset of its extended data.
  const extended = extendedData + (u32(nodes + 28 + 20) & 0x00ffffff);
  const string = (index) =>
    index === none
      ? undefined
      : Buffer.from(
          bytes.subarray(strings + u32(stringOffsets + index * 4), strings + u32(stringOffsets + (index + 1) * 4)),
        ).toString('utf8');
  /** A MessagePack reader of the arrays, unsigned integers and strings of the structured data. */
  const reader = (offset) => {
    let at = structuredData + offset;
    const big = (size) => {
      let value = 0;
      for (let i = 0; i < size; i++) value = value * 256 + bytes[at++];
      return value;
    };
    return {
      array() {
        const byte = bytes[at++];
        if ((byte & 0xf0) === 0x90) return byte & 0x0f;
        return big(byte === 0xdc ? 2 : 4);
      },
      uint() {
        const byte = bytes[at++];
        if (byte <= 0x7f) return byte;
        return big(byte === 0xcc ? 1 : byte === 0xcd ? 2 : 4);
      },
      string() {
        const byte = bytes[at++];
        const length = (byte & 0xe0) === 0xa0 ? byte & 0x1f : big(byte === 0xd9 ? 1 : byte === 0xda ? 2 : 4);
        at += length;
        return Buffer.from(bytes.subarray(at - length, at)).toString('utf8');
      },
    };
  };
  const list = (offset, item) => {
    if (offset === none) return undefined;
    const r = reader(offset);
    return Array.from({ length: r.array() }, () => item(r));
  };
  return {
    text: string(u32(extended)),
    originalText: string(u32(extended + 48)),
    spanMap: list(u32(extended + 52), (r) => {
      const length = r.array();
      const [virtualStart, virtualLength, originalStart, originalLength, kind] = [0, 1, 2, 3, 4].map(() => r.uint());
      return {
        virtualStart,
        virtualEnd: virtualStart + virtualLength,
        originalStart,
        originalEnd: originalStart + originalLength,
        kind,
        features: length === 6 ? r.uint() : (1 << 20) - 1,
      };
    }),
    supplementalSourceFileNames: list(u32(extended + 56), (r) => r.string()),
    canonicalSourceFileName: string(u32(extended + 60)),
    contentMapper: string(u32(extended + 64)),
    virtualFileName: string(u32(extended + 68)),
    diagnosticDirectives: list(u32(extended + 72), (r) => {
      r.array();
      const [originalStart, originalLength, virtualStart, virtualLength, policy, unusedCode] = [0, 1, 2, 3, 4, 5].map(
        () => r.uint(),
      );
      return {
        originalRange: { pos: originalStart, end: originalStart + originalLength },
        virtualRange: { pos: virtualStart, end: virtualStart + virtualLength },
        policy,
        unusedCode,
      };
    }),
  };
}

/** The same members of a source file of tsc-ts/api, as plain data. */
export function libraryFileMembers(file) {
  return {
    text: file.text,
    originalText: file.originalText,
    spanMap: file.spanMap?.segments.map((segment) => ({ ...segment })),
    supplementalSourceFileNames: file.supplementalSourceFileNames,
    canonicalSourceFileName: file.canonicalSourceFileName,
    contentMapper: file.contentMapper,
    virtualFileName: file.virtualFileName,
    diagnosticDirectives: file.diagnosticDirectives,
  };
}
