// A content mapper process that does what its argument says, for the tests of the process host
// (content-mapper-process-host.test.mjs):
//
//   node content-mapper-scripted.mjs '<script as JSON>'
//
// Without a script it answers `initialize` with UTF-8 positions and the diagnostic source `mapper`,
// `openProject` with no configuration of its own, and `transform` with the content as TypeScript. The members of
// the script change that:
//
//   log             a file that gets a line `["start"]` and then each message received, as JSON
//   stderr          text written to standard error before anything is read
//   stderrBytes     that many more bytes written to standard error
//   exit            the exit code to end with before anything is read
//   garbage         text written to standard output before anything is read
//   silent          true to read requests and answer none
//   initialize      the result of `initialize`
//   afterInitialize text written to standard output after the response to `initialize`
//   dynamic         true to answer `openProject` as a mapper with `dynamicConfig`: an identity made of the
//                   project's mapper options, and a watched file `mapper.config.js` beside the config file
//   openProject     the result of `openProject`
//   verbatim        true to map the content verbatim and report the diagnostic 9999 `boom` on its start
//   transform       the result of `transform`
//   ask             true to send the compiler a request and a notification before each `transform` response
//   omitResult      the method whose responses have no result
//   stderrDuringRequest
//                   that many bytes written to standard error when the first part of a long request has
//                   arrived, which this process waits to be read before it reads the rest
import { appendFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { createFrameReader, frame } from './content-mapper-server.mjs';

const script = JSON.parse(process.argv[2] ?? '{}');
const log = (entry) => {
  if (script.log !== undefined) appendFileSync(script.log, `${JSON.stringify(entry)}\n`);
};
log(['start']);
if (script.stderr !== undefined) process.stderr.write(script.stderr);
if (script.stderrBytes !== undefined) process.stderr.write('x'.repeat(script.stderrBytes));
if (script.exit !== undefined) process.exit(script.exit);
if (script.garbage !== undefined) process.stdout.write(script.garbage);

function handleRequest(method, params) {
  if (method === 'initialize') return script.initialize ?? { positionEncoding: 'utf-8', diagnosticSource: 'mapper' };
  if (method === 'openProject') {
    if (script.openProject !== undefined) return script.openProject;
    if (!script.dynamic) return {};
    return {
      configIdentity: `config:${JSON.stringify(params.options)}`,
      watchedFiles: [`${dirname(params.configFileName)}/mapper.config.js`],
    };
  }
  if (method === 'closeProject') return null;
  if (method !== 'transform') throw new Error(`unexpected method ${method}`);
  if (script.transform !== undefined) return script.transform;
  if (!script.verbatim) return { text: params.content, extension: '.ts' };
  const length = Buffer.byteLength(params.content, 'utf8');
  return {
    text: params.content,
    extension: '.ts',
    mappings: [[0, length, 0, length, 0]],
    diagnostics: [{ messageText: 'boom', start: 0, length: Math.min(3, length), code: 9999 }],
  };
}

/** Writes all of `text` to a descriptor, waiting while its pipe is full. */
function writeAll(fd, text) {
  const bytes = Buffer.from(text);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written);
    } catch (error) {
      if (error.code !== 'EAGAIN') throw error;
    }
  }
}

const reader = createFrameReader();
let interrupted = false;
process.stdin.on('data', (chunk) => {
  const messages = reader.push(chunk);
  if (script.stderrDuringRequest !== undefined && messages.length === 0 && !interrupted) {
    interrupted = true;
    writeAll(2, 'x'.repeat(script.stderrDuringRequest));
  }
  for (const message of messages) {
    log(message);
    const { id, method, params } = message;
    if (script.silent || id == null || method === undefined) continue;
    if (script.ask && method === 'transform') {
      process.stdout.write(frame({ jsonrpc: '2.0', id: 7, method: 'readFile', params: {} }));
      process.stdout.write(frame({ jsonrpc: '2.0', method: 'progress', params: {} }));
    }
    let response;
    try {
      response = { jsonrpc: '2.0', id, result: handleRequest(method, params) };
    } catch (error) {
      response = { jsonrpc: '2.0', id, error: { code: -32603, message: error.message } };
    }
    if (script.omitResult === method) delete response.result;
    process.stdout.write(frame(response));
    if (method === 'initialize' && script.afterInitialize !== undefined) process.stdout.write(script.afterInitialize);
  }
});
