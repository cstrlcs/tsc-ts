// `tsc-ts --api --listen`: on Linux and macOS the server listens on the Unix socket it is given and serves one client
// at a time on it. Each client gets the responses a new server over standard input and output gives, and the server
// reads every file through the client again; it exits after an idle time or above its memory limit, removing the
// socket file. native/listen-posix.test.c checks how it treats a socket file that exists.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { callbacks, Client } from './client.mjs';
import { tempDir } from './temp.mjs';
import { tscTs, tscTsMissing } from './toolchain.mjs';

const native = process.env.TSC_TS_BIN !== undefined;
const posix = process.platform === 'linux' || process.platform === 'darwin';
const skip = !posix || !native ? 'needs the native tsc-ts on Linux or macOS' : tscTsMissing;

function copyProject() {
  const dir = tempDir('tsc-ts-api-listen-');
  cpSync(resolve('tests/fixtures/project'), dir, { recursive: true });
  return dir;
}

// A server listening on a socket in a new directory; `ready` resolves once the socket exists.
function listen(dir, args = [], env = {}) {
  const socket = join(tempDir('tsc-ts-socket-'), 's');
  const child = spawn(
    tscTs[0],
    [...tscTs.slice(1), '--api', '--cwd', dir, `--callbacks=${callbacks.join(',')}`, '--listen', socket, ...args],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env } },
  );
  const server = { socket, child, stderr: '' };
  child.stderr.on('data', (chunk) => (server.stderr += chunk));
  server.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  server.ready = (async () => {
    const deadline = Date.now() + 60_000;
    while (!existsSync(socket)) {
      if (child.exitCode !== null || Date.now() > deadline)
        throw new Error(`the server did not listen: ${server.stderr}`);
      await delay(20);
    }
  })();
  return server;
}

// The responses to one session, the requests a compile makes in its order, and the client's file system calls.
async function session(client, dir) {
  const replies = [];
  const call = async (method, params) => {
    const reply = await client.request(method, params);
    replies.push(`${method} ${reply.type} ${reply.payload.toString('base64')}`);
    return reply.type === 'response' && method !== 'getSourceFile' ? JSON.parse(reply.payload.toString()) : undefined;
  };
  await call('initialize');
  await call('ping');
  const config = join(dir, 'tsconfig.json');
  await call('parseConfigFile', { file: config });
  const update = await call('createSnapshot', { openProjects: [config], ensurePrograms: true });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  const files = await call('getSourceFileNames', base);
  for (const file of files) if (file.startsWith(dir)) await call('getSourceFile', { ...base, file });
  for (const method of ['getProgramDiagnostics', 'getGlobalDiagnostics', 'getSemanticDiagnostics'])
    await call(method, base);
  // The symbols in main.ts, and their types. Symbol ids number the symbols of the whole process, so they continue
  // from earlier clients; they are compared in the order they first appear.
  const order = new Map();
  const symbolId = (id) => (id === undefined ? undefined : (order.get(id) ?? order.set(id, order.size).get(id)));
  const file = join(dir, 'src/main.ts');
  const positions = Array.from({ length: readFileSync(file, 'utf8').length }, (_, i) => i);
  for (const symbol of await client.json('getSymbolsAtPositions', { ...base, file, positions })) {
    if (symbol === null || symbol.valueDeclaration === undefined) continue;
    const renumbered = {
      ...symbol,
      parent: symbolId(symbol.parent?.id),
      exportSymbol: symbolId(symbol.exportSymbol?.id),
    };
    replies.push(
      `symbol ${symbolId(symbol.reference.id)} ${JSON.stringify(renumbered, (key, value) => (key === 'id' ? undefined : value))}`,
    );
    const type = await client.json('getTypeOfSymbol', { ...base, symbol: symbol.reference });
    if (type === null) continue;
    replies.push(
      `type ${JSON.stringify({ ...type, symbol: symbolId(type.symbol?.id), aliasSymbol: symbolId(type.aliasSymbol?.id) })}`,
    );
    await call('typeToString', { ...base, type: type.id, location: symbol.valueDeclaration });
  }
  return { replies, calls: client.calls };
}

async function freshSession(dir) {
  const client = new Client(tscTs, dir);
  const result = await session(client, dir);
  assert.equal(await client.close(), 0, client.stderr);
  return result;
}

async function socketSession(server, dir) {
  const client = server.client ?? Client.connect(server.socket);
  const result = await session(client, dir);
  assert.equal(await client.close(), 0, client.stderr);
  return result;
}

test('clients in sequence get the responses of new servers, after edits too', { skip, timeout: 300_000 }, async () => {
  const dir = copyProject();
  const expected = await freshSession(dir);
  assert.ok(expected.calls.length > 0, 'the session reads files through the client');
  assert.ok(expected.replies.filter((reply) => reply.startsWith('symbol ')).length >= 10, 'the session reads symbols');
  const server = listen(dir);
  await server.ready;
  try {
    assert.deepEqual(await socketSession(server, dir), expected);
    assert.deepEqual(await socketSession(server, dir), expected);
    // An edit that adds an error, which the next client sees as a new server does.
    appendFileSync(join(dir, 'src/main.ts'), '\nexport const broken: number = "text";\n');
    const edited = await freshSession(dir);
    assert.notDeepEqual(edited.replies, expected.replies);
    assert.deepEqual(await socketSession(server, dir), edited);
  } finally {
    server.child.kill();
  }
});

// The encodings of the project's files after the checker has run, as getSourceFile replies.
async function encodingsAfterChecking(client, dir) {
  await client.json('initialize');
  const update = await client.snapshot({ openProjects: [join(dir, 'tsconfig.json')] });
  const base = { snapshot: update.snapshot, project: update.projects[0].id };
  await client.json('getSemanticDiagnostics', base);
  const replies = [];
  for (const file of await client.json('getSourceFileNames', base)) {
    if (!file.startsWith(dir)) continue;
    const reply = await client.request('getSourceFile', { ...base, file });
    replies.push(`getSourceFile ${reply.type} ${reply.payload.toString('base64')}`);
  }
  return replies;
}

test('the server encodes each source file once, as a new server does', { skip, timeout: 300_000 }, async () => {
  const dir = copyProject();
  const expected = await freshSession(dir);
  const encodings = expected.replies.filter((reply) => reply.startsWith('getSourceFile '));
  assert.ok(encodings.length > 0);
  const server = listen(dir);
  await server.ready;
  try {
    // The first client encodes the files after checking them (which parses their JSDoc), and the server keeps
    // those encodings for the next client.
    const client = Client.connect(server.socket);
    assert.deepEqual(await encodingsAfterChecking(client, dir), encodings);
    assert.equal(await client.close(), 0);
    assert.deepEqual(await socketSession(server, dir), expected);
  } finally {
    server.child.kill();
  }
});

test(
  'a client that closes its end during a call leaves the server serving the next client',
  { skip, timeout: 300_000 },
  async () => {
    const dir = copyProject();
    const expected = await freshSession(dir);
    const server = listen(dir);
    await server.ready;
    try {
      const client = Client.connect(server.socket);
      // The client closes the connection instead of answering the server's first file system call.
      client.write = function (type, method, payload) {
        if (type === 2) this.socket.destroy();
        else Client.prototype.write.call(this, type, method, payload);
      };
      await client.json('initialize');
      await assert.rejects(
        client.request('createSnapshot', { openProjects: [join(dir, 'tsconfig.json')], ensurePrograms: true }),
      );
      assert.deepEqual(await socketSession(server, dir), expected);
    } finally {
      server.child.kill();
    }
  },
);

test('the server exits when no client connects for the idle time', { skip, timeout: 120_000 }, async () => {
  const dir = copyProject();
  const server = listen(dir, ['--idle-exit', '1']);
  await server.ready;
  const client = Client.connect(server.socket);
  assert.equal(await client.json('ping'), 'pong');
  assert.equal(await client.close(), 0);
  assert.equal(await server.exited, 0, server.stderr);
  assert.equal(existsSync(server.socket), false, 'the server removes its socket file');
});

test(
  'the server exits after a client when its memory is above the limit, serving the clients that connected before',
  { skip, timeout: 300_000 },
  async () => {
    const dir = copyProject();
    const expected = await freshSession(dir);
    const server = listen(dir, [], { TSC_TS_LISTEN_MEMORY: '1' });
    await server.ready;
    const first = Client.connect(server.socket);
    assert.equal(await first.json('ping'), 'pong');
    // The second client connects while the server serves the first one.
    const second = Client.connect(server.socket);
    await new Promise((resolve) => second.socket.once('connect', resolve));
    assert.equal(await first.close(), 0);
    assert.deepEqual(await socketSession({ socket: server.socket, client: second }, dir), expected);
    assert.equal(await server.exited, 0, server.stderr);
    assert.equal(existsSync(server.socket), false, 'the server removes its socket file');
  },
);

test(
  'a socket another server listens on is refused, and a socket file left by a server is replaced',
  { skip, timeout: 120_000 },
  async () => {
    const dir = copyProject();
    const first = listen(dir);
    await first.ready;
    const second = spawnSync(
      tscTs[0],
      [...tscTs.slice(1), '--api', '--cwd', dir, '--listen', first.socket, '--idle-exit', '1'],
      { encoding: 'utf8', timeout: 60_000 },
    );
    assert.equal(second.status, 1, second.stderr);
    assert.match(second.stderr, /cannot listen on socket/);
    // A server that is killed leaves its socket file behind.
    first.child.kill('SIGKILL');
    await first.exited;
    assert.equal(existsSync(first.socket), true);
    const child = spawn(tscTs[0], [...tscTs.slice(1), '--api', '--cwd', dir, '--listen', first.socket], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    try {
      // Connections to the stale socket fail until the new server has replaced it.
      const deadline = Date.now() + 60_000;
      for (;;) {
        const client = Client.connect(first.socket);
        const pong = await client.json('ping').catch(() => undefined);
        await client.close();
        if (pong === 'pong') break;
        assert.ok(Date.now() < deadline && child.exitCode === null, 'the new server answers');
        await delay(20);
      }
    } finally {
      child.kill();
    }
  },
);

// With --runExternalCode the content mappers of a client's projects stop when the client leaves. The next client
// gets the files of a transform the server kept, as it gets parsed files, and a file whose text changed is
// transformed by a mapper that is started again.
test(
  'the content mappers of a client stop when it leaves, and run again for the next',
  { skip, timeout: 120_000 },
  async () => {
    const dir = tempDir('tsc-ts-api-listen-');
    const log = join(dir, 'mapper.log');
    // A mapper that maps a file to itself, reports an error at its start, and logs each message it receives.
    const mapper = [
      process.execPath,
      fileURLToPath(new URL('./content-mapper-scripted.mjs', import.meta.url)),
      JSON.stringify({ verbatim: true, log }),
    ];
    const config = join(dir, 'tsconfig.json');
    const mapped = join(dir, 'a.map');
    writeFileSync(
      config,
      JSON.stringify({
        compilerOptions: { noEmit: true, types: [] },
        contentMappers: [{ package: 'mapper', extensions: ['.map'] }],
      }),
    );
    mkdirSync(join(dir, 'node_modules/mapper'), { recursive: true });
    writeFileSync(
      join(dir, 'node_modules/mapper/package.json'),
      JSON.stringify({ name: 'mapper', version: '1.0.0', typescript: { contentMapper: { exec: mapper } } }),
    );
    writeFileSync(mapped, 'export const a = 1;\n');
    // What a client sees of the mapped file: its encoding, and the mapper's error.
    const answers = async (client) => {
      await client.json('initialize');
      const update = await client.snapshot({ openProjects: [config] });
      const base = { snapshot: update.snapshot, project: update.projects[0].id };
      const file = await client.request('getSourceFile', { ...base, file: mapped });
      const errors = await client.json('getSyntacticDiagnostics', base);
      assert.equal(await client.close(), 0, client.stderr);
      return [file.payload.toString('base64'), errors.map((error) => [error.source, error.code, error.text])];
    };
    const received = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line))
        .map((message) => message.method ?? message[0]);
    const once = ['start', 'initialize', 'openProject', 'transform', 'closeProject'];
    const server = listen(dir, ['--idle-exit', '1', '--runExternalCode']);
    await server.ready;
    try {
      const first = await answers(Client.connect(server.socket));
      assert.deepEqual(first[1], [['mapper', 9999, 'boom']]);
      assert.deepEqual(await answers(Client.connect(server.socket)), first);
      assert.deepEqual(received(), once);
      writeFileSync(mapped, 'export const a = 2;\n');
      const edited = await answers(Client.connect(server.socket));
      assert.notEqual(edited[0], first[0]);
      assert.deepEqual(edited[1], first[1]);
      assert.equal(await server.exited, 0, server.stderr);
      assert.deepEqual(received(), [...once, ...once]);
    } finally {
      server.child.kill();
    }
  },
);

test('-idle-exit needs -listen', { skip }, () => {
  const result = spawnSync(tscTs[0], [...tscTs.slice(1), '--api', '--idle-exit', '5'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /-idle-exit needs -listen/);
});

test(
  'the socket server refuses a socket a server listens on without waiting, and replaces a socket file left behind',
  { skip: !posix && 'needs Linux or macOS', timeout: 120_000 },
  () => {
    const binary = join(tempDir('tsc-ts-listen-test-'), 'listen-posix-test');
    const sources = ['native/listen-posix.test.c', 'native/listen-posix.c'];
    execFileSync('clang', ['-std=c11', '-Wall', '-Wextra', '-Werror', ...sources, '-o', binary]);
    const result = spawnSync(binary, [], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /refuses a socket a server listens on/);
  },
);
