import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createProjectStore } from '../storage.mjs';

test('projects survive reopening and concurrent changes detect conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-project-'));
  const store = createProjectStore(directory);
  const project = { id: randomUUID(), name: '测试场景', revision: 0, assets: [], jobs: [], cameras: [], scene: { objects: [] } };
  const first = await store.save(project);
  assert.equal(first.revision, 1);
  const results = await Promise.allSettled(['A','B'].map(name => store.save({...first, name})));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.status, 409);
  const [restored] = await createProjectStore(directory).list();
  assert.equal(restored.revision, 2);
  await assert.rejects(store.save({...first, id: '../outside'}), {status: 400});
});
