import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../lib/memory/store.js';
import { sessionScopeIds } from '../lib/memory/adapter.js';
import { apply, options, Config } from '../lib/memory/index.js';

const SETTINGS_ID = 'include:dafeiyu-memory';

test('empty database config selects the DSH_HOME default file path', () => {
  const home = temporaryDirectory();
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const expected = resolve(home, 'dafeiyu-memory', 'memory.sqlite3');
    assert.equal(options({ database: '' }).database, expected);
    assert.equal(options({}).database, expected);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('options reads volatile references as plain values', () => {
  // Host settings.update only accepts fields beneath a volatile node, so the editable
  // binding fields resolve to references. options() must unwrap them like a runtime Config.
  const reference = value => ({ get: () => value });
  const resolved = options({
    bindingMode: reference('workspace'),
    bindingWorkspaceId: reference('workspace-1'),
    bindingSessionIds: reference(['session-a']),
    database: reference(''),
  });
  assert.equal(resolved.bindingMode, 'workspace');
  assert.equal(resolved.bindingWorkspaceId, 'workspace-1');
  assert.deepEqual(resolved.bindingSessionIds, ['session-a']);
  assert.ok(resolved.database.endsWith('memory.sqlite3'));
});

test('editable binding fields are declared volatile for settings writes', () => {
  // Host settings.write() rejects any path not beneath a volatile node, so assert the
  // schema itself marks these fields volatile (the JSON projection nests them under meta).
  const dict = Config.dict ?? {};
  for (const field of ['database', 'bindingMode', 'bindingSessionIds', 'bindingWorkspaceId', 'pendingMigrationFrom', 'pendingMigrationTarget', 'pendingMigrationId', 'pendingMigrationSourceIdentity']) {
    assert.equal(dict[field]?.meta?.volatile, true, `${field} must be volatile so settings.update accepts it`);
  }
  for (const field of ['bank', 'recallChars', 'toolChars', 'maintenanceMinutes']) {
    assert.notEqual(dict[field]?.meta?.volatile, true, `${field} stays ordinary configuration`);
  }
});

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'dafeiyu-memory-test-'));
}

function addMessage(store, sessionId, text, eventKey = '1') {
  const messageId = store.capture({
    session: `${sessionId}@1000`, eventKey, role: 'user', content: text, sourceTime: 1000,
  });
  const chunk = store.db.prepare('SELECT id FROM chunks WHERE message=? ORDER BY id LIMIT 1').get(messageId);
  assert.ok(chunk, 'captured text should have one indexed chunk');
  return Number(chunk.id);
}

function makeSession(id, events = []) {
  return {
    id,
    header: { id, createdAt: 1000, origin: 'user', cwd: `C:/work/${id}` },
    inheritedEventCount: 0,
    events,
  };
}

function userEvent(sessionId, text, seq = 1) {
  return {
    seq, type: 'user/message', surfaceOp: 'append', time: 1000 + seq,
    data: { source: { kind: 'user' }, id: `message-${sessionId}-${seq}`, role: 'user', content: text, interrupted: false },
  };
}

function createHostFixture(initialConfig, options = {}) {
  const routes = new Map();
  const disposers = [];
  const sessions = options.sessions ?? [];
  const workspaces = options.workspaces ?? [];
  const logs = new Map(sessions.map(session => [session.id, session.events ?? []]));
  let revision = 1;
  let unversionedWrites = 0;
  const omitSettingsDescriptor = options.omitSettingsDescriptor === true;
  let updateFailure = 'none';
  let readSessionError = options.readSessionError ?? null;
  let closed = false;
  const useConfigEditor = options.useConfigEditor === true;
  const editorWrites = [];
  const editor = {
    async edit(entry, change) {
      editorWrites.push(entry.options.id);
      const next = change({ ...config }, { ...config });
      for (const key of Object.keys(config)) if (!Object.hasOwn(next, key)) delete config[key];
      Object.assign(config, next);
      revision++;
    },
  };
  const config = {
    bank: 'dafeiyu', bindingMode: 'session', bindingWorkspaceId: '', maintenanceMinutes: 0,
    ...initialConfig,
  };
  const settings = {
    describe() {
      return omitSettingsDescriptor ? [] : [{ ns: SETTINGS_ID, revision, applies: 'live', value: { ...config } }];
    },
    async update(ns, patch, expectedRevision) {
      assert.equal(ns, SETTINGS_ID);
      assert.equal(arguments.length, expectedRevision === undefined ? 2 : 3, 'omit the optional revision argument when unavailable');
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('stale settings revision');
      if (expectedRevision === undefined) unversionedWrites++;
      if (updateFailure === 'before') {
        updateFailure = 'none';
        throw new Error('simulated settings rejection');
      }
      Object.assign(config, patch);
      revision++;
      if (updateFailure === 'after') {
        updateFailure = 'none';
        throw new Error('simulated response loss after commit');
      }
    },
    async mutate(ns, operations, expectedRevision) {
      assert.equal(ns, SETTINGS_ID);
      assert.equal(arguments.length, expectedRevision === undefined ? 2 : 3, 'omit the optional revision argument when unavailable');
      if (expectedRevision !== undefined && expectedRevision !== revision) throw new Error('stale settings revision');
      if (expectedRevision === undefined) unversionedWrites++;
      for (const operation of operations) {
        if (operation.op !== 'unset' || !Array.isArray(operation.path)) throw new Error('unsupported mutation');
        delete config[operation.path[0]];
      }
      revision++;
    },
  };
  const ctx = {
    connection: {
      fetch: {
        register(definition) {
          routes.set(definition.path, definition);
          return () => routes.delete(definition.path);
        },
      },
    },
    // The owning Loader entry plus configEditor is the write path a live plugin uses;
    // settings.update cannot address this row because it publishes the namespaced id.
    fiber: useConfigEditor ? { entry: { options: { id: 'dafeiyu-memory', name: 'dsh-dafeiyu-memory' } } } : undefined,
    settings,
    get(key) { return key === 'configEditor' ? editor : undefined; },
    sessions: { list: () => sessions, get: () => undefined },
    sessionQuery: {
      listSessions: async () => sessions.map(session => ({ header: session.header, live: true, persisted: true })),
      readTitleSnapshots: async ids => ids.map(sessionId => ({
        sessionId, status: 'fulfilled',
        value: { session: { id: sessionId }, title: { title: `Title ${sessionId}` } },
      })),
      readSession: async sessionId => {
        if (readSessionError) throw readSessionError;
        return { events: logs.get(sessionId) ?? [] };
      },
    },
    workspaceRegistry: {
      list: () => workspaces,
      get: id => workspaces.find(workspace => workspace.id === id) ?? null,
    },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, context: () => () => {} },
    on: () => () => {},
    effect(effect) {
      const dispose = effect();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
  };
  apply(ctx, config);
  return {
    routes,
    config,
    get revision() { return revision; },
    get unversionedWrites() { return unversionedWrites; },
    get editorWrites() { return editorWrites; },
    setUpdateFailure(value) { updateFailure = value; },
    setReadSessionError(error) { readSessionError = error; },
    async close() {
      if (closed) return;
      closed = true;
      for (const dispose of disposers.splice(0).reverse()) await dispose();
    },
  };
}

async function sendSettings(route, payload) {
  return route.fetch(new Request('http://localhost/api/dafeiyu-memory/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: randomUUID(), method: 'dafeiyu-memory/settings', payload,
    }),
  }));
}

async function invokeSettings(fixture, payload) {
  const route = fixture.routes.get('/api/dafeiyu-memory/settings');
  assert.ok(route, 'settings route should be registered');
  const response = await sendSettings(route, payload);
  return response.json();
}

test('session and workspace scopes isolate or share only the selected sessions', t => {
  const directory = temporaryDirectory();
  const store = new MemoryStore(join(directory, 'scope.sqlite3'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  addMessage(store, 's1', 'The shared orchard map is beside the blue postcard.');
  addMessage(store, 's10', 'The shared orchard map is in the neighboring session.');
  addMessage(store, 's2', 'The shared orchard map belongs to another workspace.');

  const oneSession = store.search('orchard map', { sessionIds: ['s1'] });
  assert.equal(oneSession.length, 1);
  assert.equal(oneSession[0].session, 's1@1000');
  const sharedSessions = store.search('orchard map', { sessionIds: ['s1', 's2'] });
  assert.deepEqual(new Set(sharedSessions.map(hit => hit.session)), new Set(['s1@1000', 's2@1000']));
  assert.deepEqual(store.search('orchard map', { sessionIds: [] }), []);
  assert.equal(store.integrityCheck().ok, true);
});

test('storage statistics inspection does not mutate message rows', t => {
  const directory = temporaryDirectory();
  const store = new MemoryStore(join(directory, 'stats.sqlite3'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  addMessage(store, 'stats-session', 'Reading stats should not add messages');
  const before = store.stats();
  const view = store.storageStats();
  assert.equal(view.messages, before.messages);
  assert.equal(view.chunks, before.chunks);
  assert.equal(view.lastCapture, before.lastCapture);
  assert.deepEqual(store.stats(), before);
});

test('replaying the same source event is idempotent', t => {
  const directory = temporaryDirectory();
  const store = new MemoryStore(join(directory, 'idempotent.sqlite3'));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  const event = {
    session: 'stable-session@1000', eventKey: '42', sourceMessageId: 'message-42',
    role: 'assistant', content: 'One source event is captured once.', sourceTime: 1000,
  };
  assert.ok(store.capture(event));
  assert.equal(store.capture({ ...event, content: 'A duplicate must not replace the original.' }), null);
  assert.equal(store.stats().messages, 1);
  assert.equal(store.stats().chunks, 1);
});

test('settings writes go through the owning Loader entry when configEditor is available', async t => {
  const directory = temporaryDirectory();
  const fixture = createHostFixture({ database: join(directory, 'memory.sqlite3') }, {
    useConfigEditor: true,
    workspaces: [{ id: 'workspace-1', title: 'Project One', sessionIds: [] }],
  });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  const mode = await invokeSettings(fixture, { action: 'set-binding-mode', bindingMode: 'workspace' });
  assert.equal(mode.result.ok, true, mode.result.error?.message);
  assert.equal(fixture.config.bindingMode, 'workspace');
  const target = await invokeSettings(fixture, { action: 'set-workspace-target', workspaceId: 'workspace-1' });
  assert.equal(target.result.ok, true, target.result.error?.message);
  assert.equal(fixture.config.bindingWorkspaceId, 'workspace-1');
  assert.deepEqual(fixture.editorWrites, ['dafeiyu-memory', 'dafeiyu-memory']);
  assert.equal(fixture.unversionedWrites, 0, 'the settings fallback must not run when configEditor succeeds');
});

test('sessionScopeIds applies explicit multi-session and single-workspace targets', () => {
  const active = { id: 'session-a' };
  const workspaces = [
    { id: 'workspace-1', sessionIds: ['session-a', 'session-b', 'session-a'] },
    { id: 'workspace-2', sessionIds: ['session-c'] },
  ];
  assert.deepEqual(sessionScopeIds(active, 'session', workspaces), ['session-a']);
  assert.deepEqual(sessionScopeIds(active, 'session', workspaces, ['session-a', 'session-b']), ['session-a', 'session-b']);
  assert.deepEqual(sessionScopeIds(active, 'session', workspaces, ['session-b']), []);
  assert.deepEqual(sessionScopeIds({ id: 'session-b' }, 'session', workspaces, ['session-a', 'session-b']), ['session-a', 'session-b']);
  assert.deepEqual(sessionScopeIds(active, 'workspace', workspaces, undefined, 'workspace-1'), ['session-a', 'session-b']);
  assert.deepEqual(sessionScopeIds(active, 'workspace', workspaces, undefined, 'workspace-2'), []);
  assert.deepEqual(sessionScopeIds({ id: 'session-z' }, 'workspace', workspaces), ['session-z']);
});

test('settings route exposes metadata and preserves both binding selections across mode changes', async t => {
  const directory = temporaryDirectory();
  const sessions = [makeSession('session-a'), makeSession('session-b'), makeSession('session-c')];
  const workspaces = [
    { id: 'workspace-1', title: 'Project One', sessionIds: ['session-a', 'session-b'] },
    { id: 'workspace-2', title: 'Project Two', sessionIds: ['session-c'] },
  ];
  const fixture = createHostFixture({ database: join(directory, 'memory.sqlite3') }, { sessions, workspaces });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  const initial = await invokeSettings(fixture, { action: 'read' });
  assert.equal(initial.result.ok, true);
  assert.deepEqual(initial.result.value.sessionPage.items.map(item => item.id), ['session-a', 'session-b', 'session-c']);
  assert.equal(initial.result.value.sessionPage.items[0].title, 'Title session-a');
  assert.ok(!JSON.stringify(initial.result.value).includes('message-'));
  assert.deepEqual(initial.result.value.workspaces.map(item => item.id), ['workspace-1', 'workspace-2']);

  let response = await invokeSettings(fixture, { action: 'set-session-targets', sessionIds: ['session-a', 'session-b'] });
  assert.equal(response.result.ok, true);
  response = await invokeSettings(fixture, { action: 'set-binding-mode', bindingMode: 'workspace' });
  assert.equal(response.result.ok, true);
  response = await invokeSettings(fixture, { action: 'set-workspace-target', workspaceId: 'workspace-2' });
  assert.equal(response.result.ok, true);
  response = await invokeSettings(fixture, { action: 'set-binding-mode', bindingMode: 'session' });
  assert.equal(response.result.ok, true);
  assert.deepEqual(fixture.config.bindingSessionIds, ['session-a', 'session-b']);
  assert.equal(fixture.config.bindingWorkspaceId, 'workspace-2');

  fixture.config.bindingSessionIds = ['removed-session'];
  response = await invokeSettings(fixture, { action: 'set-session-targets', sessionIds: [] });
  assert.equal(response.result.ok, true, 'an existing stale selection can be removed');
  response = await invokeSettings(fixture, { action: 'set-session-targets', sessionIds: ['unknown-session'] });
  assert.equal(response.result.ok, false, 'new unknown targets are rejected');
});

test('settings route falls back to active config when describe omits the nested Include', async t => {
  const directory = temporaryDirectory();
  const fixture = createHostFixture({ database: join(directory, 'memory.sqlite3') }, {
    omitSettingsDescriptor: true,
    workspaces: [{ id: 'workspace-1', title: 'Project One', sessionIds: [] }],
  });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  const initial = await invokeSettings(fixture, { action: 'read' });
  assert.equal(initial.result.ok, true);
  assert.equal(initial.result.value.bindingMode, 'session');
  assert.equal(initial.result.value.databasePath, fixture.config.database);
  assert.equal(initial.result.value.revision, undefined);
  assert.deepEqual(initial.result.value.workspaces.map(item => item.id), ['workspace-1']);

  let response = await invokeSettings(fixture, { action: 'set-session-targets', sessionIds: null });
  assert.equal(response.result.ok, true, 'optional target removal uses the exact entry without a descriptor revision');
  response = await invokeSettings(fixture, { action: 'set-binding-mode', bindingMode: 'workspace' });
  assert.equal(response.result.ok, true, 'settings update accepts the exact entry id with optional revision omitted');
  assert.equal(fixture.config.bindingMode, 'workspace');
  response = await invokeSettings(fixture, { action: 'set-workspace-target', workspaceId: 'workspace-1' });
  assert.equal(response.result.ok, true, 'workspace target persists when describe omits the revision');
  assert.equal(fixture.config.bindingWorkspaceId, 'workspace-1');
  assert.equal(fixture.unversionedWrites, 3);
});

test('reading settings after a directory change reports the new database path', async t => {
  // Volatile config edits commit in place without reloading the plugin, so the closure that
  // serves `read` must refresh its own snapshot; otherwise the panel keeps showing the old path
  // even though the copy succeeded and the profile was written.
  const directory = temporaryDirectory();
  const sourcePath = join(directory, 'source.sqlite3');
  const targetDirectory = join(directory, 'chosen-target');
  mkdirSync(targetDirectory);
  const targetPath = join(targetDirectory, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  addMessage(source, 'source-session', 'The directory change must be visible to the panel.');
  source.close();

  const fixture = createHostFixture({ database: sourcePath });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });

  const before = await invokeSettings(fixture, { action: 'read' });
  assert.equal(before.result.value.databasePath, resolve(sourcePath));

  const changed = await invokeSettings(fixture, { action: 'change-database-directory', directory: targetDirectory, replaceTarget: true });
  assert.equal(changed.result.ok, true, changed.result.error?.message);

  const after = await invokeSettings(fixture, { action: 'read' });
  assert.equal(after.result.value.databasePath, resolve(targetPath), 'read must report the switched database');
  assert.equal(after.result.value.migration.targetPath, resolve(targetPath));
  assert.equal(after.result.value.migration.sourcePath, resolve(sourcePath));
  assert.equal(existsSync(targetPath), true);
  assert.equal(existsSync(sourcePath), true, 'the source stays until explicit cleanup');
});

test('settings revision conflicts are reported without changing the active binding', async t => {
  const directory = temporaryDirectory();
  const fixture = createHostFixture({ database: join(directory, 'memory.sqlite3') });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });
  fixture.setUpdateFailure('before');
  const response = await invokeSettings(fixture, { action: 'set-binding-mode', bindingMode: 'workspace' });
  assert.equal(response.result.ok, false);
  assert.equal(fixture.config.bindingMode, 'session');
});

test('migration refreshes only a compatible confirmed target and keeps source until post-reopen verification', async t => {
  const directory = temporaryDirectory();
  const sourcePath = join(directory, 'source.sqlite3');
  const targetDirectory = join(directory, 'selected-target');
  mkdirSync(targetDirectory);
  const targetPath = join(targetDirectory, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  addMessage(source, 'original-session', 'The source memory says the postcard is blue.');
  source.close();
  const oldTarget = new MemoryStore(targetPath, 'dafeiyu');
  addMessage(oldTarget, 'old-target-session', 'This stale destination copy must be refreshed.');
  oldTarget.close();
  for (const sidecar of [`${targetPath}-wal`, `${targetPath}-shm`]) if (existsSync(sidecar)) rmSync(sidecar);
  assert.equal(MemoryStore.inspectDatabase(targetPath, 'dafeiyu').ok, true);

  const active = makeSession('active-session', [userEvent('active-session', 'The active log is backfilled before switching.')]);
  const oldPlugin = createHostFixture({ database: sourcePath }, { sessions: [active] });
  const fixtures = [oldPlugin];
  t.after(async () => {
    for (const fixture of fixtures.reverse()) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const response = await invokeSettings(oldPlugin, { action: 'change-database-directory', directory: targetDirectory, replaceTarget: true });
  assert.equal(response.result.ok, true, response.result.error?.message);
  const migrationId = oldPlugin.config.pendingMigrationId;
  assert.ok(migrationId);
  assert.equal(oldPlugin.config.database, resolve(targetPath));
  assert.equal(existsSync(sourcePath), true, 'source survives the path switch');
  assert.equal(oldPlugin.config.pendingMigrationFrom, resolve(sourcePath));

  const copied = new MemoryStore(targetPath, 'dafeiyu');
  assert.equal(copied.integrityCheck().ok, true);
  assert.equal(copied.stats().messages, 2, 'source record and active-session backfill are both copied');
  assert.deepEqual(copied.search('postcard blue', { sessionIds: ['original-session'] }).length, 1);
  assert.deepEqual(copied.search('active log backfilled', { sessionIds: ['active-session'] }).length, 1);
  copied.close();
  await oldPlugin.close();

  const newPlugin = createHostFixture(oldPlugin.config, { sessions: [active] });
  fixtures.push(newPlugin);
  const verification = await invokeSettings(newPlugin, { action: 'retry-migration-verification', migrationId });
  assert.equal(verification.result.ok, true);
  assert.equal(verification.result.value.state, 'ready');
  assert.equal(existsSync(sourcePath), true, 'source remains until explicit final cleanup');
  const cleanup = await invokeSettings(newPlugin, { action: 'finalize-migration', migrationId });
  assert.equal(cleanup.result.ok, true, cleanup.result.error?.message);
  assert.equal(existsSync(sourcePath), false);
  assert.equal(existsSync(`${sourcePath}-wal`), false);
  assert.equal(existsSync(`${sourcePath}-shm`), false);
  assert.equal(newPlugin.config.pendingMigrationId, undefined);
  assert.equal(existsSync(targetPath), true);
});

test('failed post-switch backfill retains source and can be retried', async t => {
  const directory = temporaryDirectory();
  const sourcePath = join(directory, 'source.sqlite3');
  const targetDirectory = join(directory, 'destination');
  mkdirSync(targetDirectory);
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  addMessage(source, 'source-session', 'Keep this source record until verification succeeds.');
  source.close();
  const active = makeSession('active-session', [userEvent('active-session', 'Retryable backfill payload.')]);
  const first = createHostFixture({ database: sourcePath }, { sessions: [active] });
  const fixtures = [first];
  t.after(async () => {
    for (const fixture of fixtures.reverse()) await fixture.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const changed = await invokeSettings(first, { action: 'change-database-directory', directory: targetDirectory, replaceTarget: true });
  assert.equal(changed.result.ok, true, changed.result.error?.message);
  const migrationId = first.config.pendingMigrationId;
  await first.close();

  const second = createHostFixture(first.config, {
    sessions: [active], readSessionError: new Error('transient session reader failure'),
  });
  fixtures.push(second);
  const blocked = await invokeSettings(second, { action: 'retry-migration-verification', migrationId });
  assert.equal(blocked.result.ok, true);
  assert.equal(blocked.result.value.state, 'blocked');
  const refused = await invokeSettings(second, { action: 'finalize-migration', migrationId });
  assert.equal(refused.result.ok, false);
  assert.equal(existsSync(sourcePath), true);

  second.setReadSessionError(null);
  const retried = await invokeSettings(second, { action: 'retry-migration-verification', migrationId });
  assert.equal(retried.result.value.state, 'ready');
  const finalized = await invokeSettings(second, { action: 'finalize-migration', migrationId });
  assert.equal(finalized.result.ok, true, finalized.result.error?.message);
  assert.equal(existsSync(sourcePath), false);
});

test('ambiguous settings response leaves verified copy and source intact for reconciliation', async t => {
  const directory = temporaryDirectory();
  const sourcePath = join(directory, 'source.sqlite3');
  const targetDirectory = join(directory, 'destination');
  mkdirSync(targetDirectory);
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  addMessage(source, 'source-session', 'The original remains safe after an ambiguous response.');
  source.close();
  const first = createHostFixture({ database: sourcePath });
  t.after(async () => { await first.close(); rmSync(directory, { recursive: true, force: true }); });
  first.setUpdateFailure('after');
  const response = await invokeSettings(first, { action: 'change-database-directory', directory: targetDirectory, replaceTarget: true });
  assert.equal(response.result.ok, false);
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(join(targetDirectory, 'memory.sqlite3')), true);
  assert.equal(first.config.database, resolve(targetDirectory, 'memory.sqlite3'), 'the profile may already have committed despite a lost response');
  assert.ok(first.config.pendingMigrationId);
});

test('unrelated destination is never replaced even after its path was confirmed', async t => {
  const directory = temporaryDirectory();
  const sourcePath = join(directory, 'source.sqlite3');
  const targetDirectory = join(directory, 'destination');
  mkdirSync(targetDirectory);
  const targetPath = join(targetDirectory, 'memory.sqlite3');
  const source = new MemoryStore(sourcePath, 'dafeiyu');
  addMessage(source, 'source-session', 'Source remains unchanged.');
  source.close();
  const unrelated = 'not a dafeiyu-memory SQLite database';
  writeFileSync(targetPath, unrelated, 'utf8');
  const fixture = createHostFixture({ database: sourcePath });
  t.after(async () => { await fixture.close(); rmSync(directory, { recursive: true, force: true }); });
  const response = await invokeSettings(fixture, { action: 'change-database-directory', directory: targetDirectory, replaceTarget: true });
  assert.equal(response.result.ok, false);
  assert.equal(readFileSync(targetPath, 'utf8'), unrelated);
  assert.equal(existsSync(sourcePath), true);
  assert.equal(fixture.config.database, resolve(sourcePath));
});

test('manifest and lock advertise both rc.2 and rc.3 without shipping tests', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const en = JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

  // 版本号不再写死具体值（每次升版本都会红），改为校验格式合法，
  // 同时保留真正的契约：package-lock.json 必须与 manifest 同步。
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.match(manifest.engines.dsh, /0\.2\.1-rc\.2/);
  assert.match(manifest.engines.dsh, /0\.2\.1-rc\.3/);
  assert.equal(en.meta.title, 'Big Fish Memory');
  assert.equal(zh.meta.title, '大肥鱼记忆管理');
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-workspace'));
  assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-directory-picker-native'));
  assert.match(patch, /^- insert:\n    - id: bigfish\n      name: dsh-bigfish/m);
  assert.match(patch, /- settings\n/);
  assert.doesNotMatch(patch, /configEditor/);
  assert.doesNotMatch(patch, /dsh-host-directory-picker-native|dafeiyu-memory-directory-picker/);
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(!manifest.files.includes('scope-backup.test.js'));
  assert.ok(!manifest.files.includes('measure-token-budget.mjs'));
});
