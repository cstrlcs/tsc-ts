// A content mapper process for tests: it answers the requests of the content mapper protocol on standard input
// and output, as JSON-RPC 2.0 messages framed by `Content-Length` headers, which is what tsgo speaks to the
// command a mapper's package.json declares.
//
//   node content-mapper-server.mjs <mapper name> <compiled span-map.js>
//
// runs one of the mappers of content-mappers.mjs. `writeMapperLaunchers` writes an executable per mapper name
// that runs this file, so that a compiler given their directory on PATH finds the mappers that tsgo's compiler
// cases name by the `exec` of their package.json.
//
// With the environment variable CONTENT_MAPPER_LOG naming a file, the process appends a line to it for each
// request it gets (the mapper's name and the method): what a compiler asks of its mappers, for tests that
// compare two compilers.
import { appendFileSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createTestMapperSpawner,
  dynamicVerbatimMapper,
  failingMapper,
  lispMapper,
  supplementalDiagnosticsMapper,
  supplementalGlobalsMapper,
  supplementalMapper,
  supplementalModuleMapper,
  transformingMapper,
  verbatimMapper,
} from './content-mappers.mjs';

const serverFile = fileURLToPath(import.meta.url);

/** The names of the mappers a launcher is written for. */
export const mapperNames = [
  transformingMapper,
  verbatimMapper,
  dynamicVerbatimMapper,
  failingMapper,
  lispMapper,
  supplementalMapper,
  supplementalDiagnosticsMapper,
  supplementalGlobalsMapper,
  supplementalModuleMapper,
];

/** `message` as the bytes of a framed JSON-RPC message. */
export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'latin1'), body]);
}

/**
 * Splits the bytes of a stream into framed messages: `push(chunk)` returns the messages that `chunk` completes,
 * parsed.
 */
export function createFrameReader() {
  let buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffer = Buffer.concat([buffer, chunk]);
      const messages = [];
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) return messages;
        const length = Number(/^Content-Length: *(\d+)\r?$/m.exec(buffer.toString('latin1', 0, headerEnd))?.[1]);
        if (!Number.isInteger(length)) throw new Error('message without a Content-Length header');
        const end = headerEnd + 4 + length;
        if (buffer.length < end) return messages;
        messages.push(JSON.parse(buffer.toString('utf8', headerEnd + 4, end)));
        buffer = buffer.subarray(end);
      }
    },
  };
}

/**
 * Serves a mapper on `input` and `output`. `handler.handleRequest(method, params)` returns the result of a
 * request, or throws to fail it, which the client sees as tsgo's own test mappers fail a request: an internal
 * error with the message. The process ends when `input` does, after the answers it owes are written.
 */
export function serve(handler, input = process.stdin, output = process.stdout) {
  const reader = createFrameReader();
  input.on('data', (chunk) => {
    for (const { id, method, params } of reader.push(chunk)) {
      // Only a message with an id and a method is a request: a notification and a response get no answer.
      if (id == null || method === undefined) continue;
      let response;
      try {
        response = { jsonrpc: '2.0', id, result: handler.handleRequest(method, params) ?? null };
      } catch (error) {
        response = { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
      }
      output.write(frame(response));
    }
  });
}

/**
 * Writes a launcher for each mapper of content-mappers.mjs into `directory` and returns the directory, which
 * goes first on the PATH of a compiler. `spanMapModule` is the compiled span-map.js the mappers use.
 */
export function writeMapperLaunchers(directory, spanMapModule) {
  for (const name of mapperNames) {
    const command = [process.execPath, serverFile, name, spanMapModule];
    if (process.platform === 'win32') {
      writeFileSync(join(directory, `${name}.cmd`), `@${command.map((word) => `"${word}"`).join(' ')}\r\n`);
      continue;
    }
    const launcher = join(directory, name);
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${command.map((word) => `'${word.replaceAll("'", "'\\''")}'`).join(' ')}\n`,
    );
    chmodSync(launcher, 0o755);
  }
  return directory;
}

if (process.argv[1] === serverFile) {
  const [name, spanMapModule] = process.argv.slice(2);
  const handler = createTestMapperSpawner(await import(pathToFileURL(spanMapModule).href))([name]);
  // A mapper ends with its input. Node.js on macOS does not see the end of a named pipe, which is what tsc-ts
  // under Node.js gives a mapper, when a compiler that watches is killed: the process is then no longer the
  // compiler's child, and ends for that.
  const compiler = process.ppid;
  setInterval(() => {
    if (process.ppid !== compiler) process.exit(0);
  }, 500).unref();
  const log = process.env.CONTENT_MAPPER_LOG;
  if (log === undefined) serve(handler);
  else {
    const note = (event) => appendFileSync(log, `${name} ${event}\n`);
    serve({
      handleRequest(method, params) {
        note(method);
        return handler.handleRequest(method, params);
      },
    });
  }
}
