export const meta = {
  name: 'crew',
  description: 'Run a small crew of backlog tasks: ship tasks build on sonnet in their own worktree and are checked on haiku; scout tasks investigate on haiku and are summarised on sonnet. Bounded parallelism, one structured result per task.',
  whenToUse: 'Two or more independent backlog tasks (from wforge-crew dispatch) that a solo developer wants done while they do something else',
  phases: [
    { title: 'Brief', detail: 'one planner on opus only for L-sized ship tasks' },
    { title: 'Work', detail: 'builder (sonnet, worktree) or scout (haiku) per task, at most maxParallel at once' },
    { title: 'Check', detail: 'checker (haiku) per ship task, skeptic (sonnet, low) per scout report' },
  ],
}

// args: { tasks: [{ id, title, shape: 'ship'|'scout', size: 'S'|'M'|'L', note? }], maxParallel?: 1..3, isolate?: boolean }
// Paste the output of `wforge-crew dispatch` straight in. Cap: 6 tasks per run.
if (!args || !Array.isArray(args.tasks) || args.tasks.length === 0) throw new Error('crew needs args.tasks from wforge-crew dispatch')
const MAX_TASKS = 6
let tasks = args.tasks
if (tasks.length > MAX_TASKS) {
  log(`cap: running ${MAX_TASKS} of ${tasks.length} tasks; leave the rest in the backlog`)
  tasks = tasks.slice(0, MAX_TASKS)
}
const PAR = Math.max(1, Math.min(3, args.maxParallel || 2))
const isolate = !(args.isolate === false)

const BRIEF = {
  type: 'object',
  properties: {
    instructions: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    check: { type: 'string' },
    too_big: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['instructions', 'files', 'too_big'],
}
const BUILD = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    summary: { type: 'string' },
    changed_files: { type: 'array', items: { type: 'string' } },
    branch: { type: 'string' },
    check_result: { type: 'string' },
    blocked: { type: 'string' },
  },
  required: ['done', 'summary', 'changed_files'],
}
const CHECK = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'problems'],
}
const REPORT = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    evidence: { type: 'array', items: { type: 'string' } },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['answer', 'evidence'],
}
const VERDICT = {
  type: 'object',
  properties: {
    sound: { type: 'boolean' },
    disputed: { type: 'array', items: { type: 'string' } },
    decision_needed: { type: 'string' },
  },
  required: ['sound', 'disputed'],
}

async function ship(t) {
  let brief = { instructions: t.note || t.title, files: [], check: '' }
  if (t.size === 'L') {
    const b = await agent(
      `Brief one builder for this task in the repository you are in. Name the files to touch and one cheap check command. ` +
      `If it genuinely needs more than one builder working in parallel, set too_big=true and say why; it will go back to the backlog for plan-build-verify.\n\nTASK ${t.id}: ${t.title}\n${t.note ? 'NOTES: ' + t.note : ''}`,
      { agentType: 'wforge:planner', model: 'opus', effort: 'medium', schema: BRIEF, phase: 'Brief', label: `brief ${t.id}` },
    )
    if (!b) return { id: t.id, shape: 'ship', ok: false, problems: ['planner returned nothing'] }
    if (b.too_big) return { id: t.id, shape: 'ship', ok: false, too_big: true, problems: [b.reason || 'needs plan-build-verify'] }
    brief = b
  }
  const build = await agent(
    `Implement this backlog task.\n\nTASK ${t.id}: ${t.title}\n${t.note ? 'NOTES: ' + t.note + '\n' : ''}` +
    `INSTRUCTIONS:\n${brief.instructions}\n` +
    (brief.files && brief.files.length ? `FILES: ${brief.files.join(', ')}\n` : '') +
    (brief.check ? `CHECK COMMAND: ${brief.check}\n` : '') +
    `\nKeep the change to what the task asks. ${isolate ? 'You are in a worktree: commit on a branch named wforge/' + t.id.toLowerCase() + '-<short-slug> and report the branch.' : 'You are in the main checkout: do not commit.'}`,
    {
      agentType: 'wforge:builder', model: 'sonnet', effort: t.size === 'L' ? 'high' : 'medium', schema: BUILD,
      isolation: isolate ? 'worktree' : undefined, phase: 'Work', label: `build ${t.id}`,
    },
  )
  if (!build) return { id: t.id, shape: 'ship', ok: false, problems: ['builder returned nothing'] }
  if (!build.done) return { id: t.id, shape: 'ship', ok: false, branch: build.branch, summary: build.summary, problems: [build.blocked || 'builder did not finish'] }
  const check = await agent(
    `Verify task ${t.id} (${t.title}).\nINSTRUCTIONS GIVEN:\n${brief.instructions}\n` +
    (brief.check ? `CHECK COMMAND: ${brief.check}\n` : '') +
    (build.branch ? `The work is on branch ${build.branch}; diff it against the current branch.\n` : `The work is uncommitted in this checkout; use git diff.\n`) +
    `Builder reported: ${build.summary}\nChanged files: ${build.changed_files.join(', ')}`,
    { agentType: 'wforge:checker', model: 'haiku', effort: 'low', schema: CHECK, phase: 'Check', label: `check ${t.id}` },
  )
  const c = check || { ok: false, problems: ['checker returned nothing'] }
  return { id: t.id, shape: 'ship', ok: c.ok, branch: build.branch, summary: build.summary, changed_files: build.changed_files, problems: c.problems }
}

async function scout(t) {
  const report = await agent(
    `Investigate and report; change nothing.\n\nQUESTION ${t.id}: ${t.title}\n${t.note ? 'NOTES: ' + t.note : ''}\n` +
    `Return a direct answer, the evidence (file paths with line numbers, commands and their output), and what you could not determine.`,
    { agentType: 'wforge:scout', model: 'haiku', effort: t.size === 'S' ? 'low' : 'medium', schema: REPORT, phase: 'Work', label: `scout ${t.id}` },
  )
  if (!report) return { id: t.id, shape: 'scout', ok: false, problems: ['scout returned nothing'] }
  const verdict = await agent(
    `A scout answered a question. Check the evidence actually supports the answer; open the cited files.\n\nQUESTION: ${t.title}\nANSWER: ${report.answer}\nEVIDENCE:\n` +
    report.evidence.map((e) => '- ' + e).join('\n') +
    `\n\nReport only disputes you confirmed. If the answer forces a choice the developer must make, state it in decision_needed.`,
    { agentType: 'wforge:skeptic', model: 'sonnet', effort: 'low', schema: VERDICT, phase: 'Check', label: `verify ${t.id}` },
  )
  const v = verdict || { sound: false, disputed: ['skeptic returned nothing'] }
  return { id: t.id, shape: 'scout', ok: v.sound, answer: report.answer, evidence: report.evidence, open_questions: report.open_questions || [], disputed: v.disputed, decision_needed: v.decision_needed || '' }
}

phase('Work')
const results = []
for (let i = 0; i < tasks.length; i += PAR) {
  const batch = tasks.slice(i, i + PAR)
  log(`batch ${Math.floor(i / PAR) + 1}: ${batch.map((t) => t.id).join(', ')}`)
  const out = await parallel(batch.map((t) => () => (t.shape === 'scout' ? scout(t) : ship(t)).catch((e) => ({ id: t.id, shape: t.shape, ok: false, problems: [String(e && e.message || e)] }))))
  results.push(...out)
}
const ok = results.filter((r) => r.ok).length
log(`crew finished: ${ok}/${results.length} ok`)
return {
  results,
  branches: results.filter((r) => r.branch).map((r) => ({ id: r.id, branch: r.branch })),
  decisions: results.filter((r) => r.decision_needed || r.too_big).map((r) => ({ id: r.id, why: r.decision_needed || r.problems.join('; ') })),
  next: 'For each result run wforge-crew done <id> --result "<summary>" --branch <branch>, or wforge-crew hold <id> "<decision>". Merge nothing on the user\'s behalf.',
}
