// Project jobs hold the full transcript. Build a bounded view for each inference request.
const clip = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
export const sessionTurns = project => (project.jobs || []).filter(job => job.task === 'threeModel');

export function currentTurn(project, group) {
  return project.scene?.objects?.find(part => part.type === 'three' && part.group === group)?.modelVersion || null;
}

export function resumeTarget(project) {
  const versions = new Set((project.scene?.objects || []).map(part => part.modelVersion).filter(Boolean));
  return sessionTurns(project).find(job => job.modelApplied && versions.has(job.id))?.modelApplied || 'new';
}

function requestText(job) {
  return job.prompt || job.input?.prompt || (job.referenceImage ? '按参考图建模' : '');
}

function summarize(job) {
  return {
    request: requestText(job),
    result: job.response?.threeModel?.name,
    reference: job.referenceImage?.name,
    partial: !!job.response?.meshIssues?.length
  };
}

export function buildSessionContext(project, target) {
  const applied = sessionTurns(project).filter(job => job.status === 'succeeded' && job.modelApplied).reverse();
  const byId = new Map(applied.map(job => [job.id, job]));
  const latestByGroup = new Map(), parents = new Map(), roots = new Map();
  for (const job of applied) {
    // Old projects have the source group but no explicit parent version.
    const parent = Object.hasOwn(job, 'parentTurnId') ? job.parentTurnId : latestByGroup.get(job.modelGroup);
    parents.set(job.id, parent);
    roots.set(job.id, roots.get(parent) || job);
    latestByGroup.set(job.modelApplied, job.id);
  }

  const branch = [], visited = new Set();
  for (let id = currentTurn(project, target); byId.has(id) && !visited.has(id); id = parents.get(id)) {
    visited.add(id);
    branch.push(byId.get(id));
  }
  branch.reverse();
  const turns = branch.length <= 8 ? branch : [branch[0], ...branch.slice(-7)];

  const groups = new Map();
  for (const part of project.scene?.objects || []) {
    if (part.type !== 'three' || !part.group || part.group === target) continue;
    if (!groups.has(part.group)) groups.set(part.group, {name: part.groupName, parts: 0, colors: new Set(), version: part.modelVersion});
    const group = groups.get(part.group);
    group.parts++;
    group.colors.add(part.color);
  }
  const models = Array.from(groups.values()).slice(-12).map(group => {
    const first = roots.get(group.version), last = byId.get(group.version);
    return {
      name: group.name, parts: group.parts, colors: [...group.colors].slice(0, 5),
      firstRequest: first && first !== last ? requestText(first) : '',
      lastRequest: last ? requestText(last) : ''
    };
  });
  return cleanSessionContext({project: project.name, requirements: project.modelSession?.requirements, models, turns: turns.map(summarize)});
}

export function cleanSessionContext(value) {
  if (!value || typeof value !== 'object') return undefined;
  const entries = (items, limit) => Array.isArray(items) ? items.slice(0, limit).filter(item => item && typeof item === 'object') : [];
  const requirements = clip(value.requirements, 3000);
  const models = entries(value.models, 12).map(model => ({
    name: clip(model.name, 100), parts: Number.isSafeInteger(model.parts) && model.parts > 0 ? model.parts : 0,
    colors: (Array.isArray(model.colors) ? model.colors : []).slice(0, 5).filter(color => typeof color === 'string' && /^#[a-f\d]{6}$/i.test(color)),
    firstRequest: clip(model.firstRequest, 240), lastRequest: clip(model.lastRequest, 240)
  }));
  const turns = entries(value.turns, 8).map(turn => ({
    request: clip(turn.request, 900), result: clip(turn.result, 100), reference: clip(turn.reference, 160), partial: turn.partial === true
  }));
  if (!requirements && !models.length && !turns.length) return undefined;
  return {project: clip(value.project, 100), requirements, models, turns};
}
