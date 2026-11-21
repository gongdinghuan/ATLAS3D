import { mkdir, readFile, readdir, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function fail(status, message) {
  return Object.assign(new Error(message), {status});
}
export async function atomicWrite(path, contents) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(tmp, contents, {mode: 0o600});
    await rename(tmp, path);
  } finally {
    await unlink(tmp).catch(() => {});
  }
}
export function createProjectStore(directory) {
  const saves = new Map();
  async function persist(project) {
    if (!Array.isArray(project.scene?.objects) || !Array.isArray(project.jobs) ||
        !Array.isArray(project.assets) || !Array.isArray(project.cameras) ||
        typeof project.name !== 'string' || !project.name.trim()) {
      throw fail(400, '项目格式不完整');
    }
    await mkdir(directory, {recursive: true});
    const path = join(directory, project.id + '.json');
    const previous = await readFile(path, 'utf8').then(JSON.parse).catch(e => {
      if (e.code === 'ENOENT') return null;
      throw e;
    });
    if ((previous?.revision ?? 0) !== project.revision) throw fail(409, '此项目已在另一个窗口修改，请将当前编辑另存为副本。');
    const next = {...project, revision: project.revision + 1, updatedAt: new Date().toISOString()};
    await atomicWrite(path, JSON.stringify(next));
    return next;
  }
  return {
    async list() {
      await mkdir(directory, {recursive: true});
      const names = (await readdir(directory)).filter(name => name.endsWith('.json'));
      const projects = await Promise.all(names.map(async name => JSON.parse(await readFile(join(directory,name),'utf8'))));
      return projects.sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async save(project) {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(project?.id)) throw fail(400, '无效项目编号');
      const prior = saves.get(project.id) || Promise.resolve();
      const pending = prior.catch(() => {}).then(() => persist(project));
      saves.set(project.id, pending);
      try { return await pending; }
      finally { if (saves.get(project.id) === pending) saves.delete(project.id); }
    }
  };
}
