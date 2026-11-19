export const meta = {
  name: 'plan-build-verify',
  description: 'Plan on opus, build each step on sonnet in its own worktree, check each step on haiku, then one skeptic pass',
  whenToUse: 'A multi-file build that would otherwise need more than two or three subagents',
  phases: [
    { title: 'Plan', detail: 'one planner (opus, high)' },
    { title: 'Build', detail: 'one builder per step (sonnet, medium, worktree)' },
    { title: 'Check', detail: 'one checker per step (haiku, low)' },
    { title: 'Verify', detail: 'one skeptic over the whole result (sonnet)' },
  ],
}

// args: "task string" or { task, maxSteps?: number (<= 8), isolate?: boolean }
const task = typeof args === 'string' ? args : (args && args.task)
if (!task) throw new Error('plan-build-verify needs args.task')
const MAX_STEPS = Math.max(1, Math.min(8, (args && args.maxSteps) || 6))
const isolate = !(args && args.isolate === false)

const PLAN = {
  type: 'object',
  properties: {
    inline: { type: 'boolean' },
    reason: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          instructions: { type: 'string' },
          check: { type: 'string' },
        },
        required: ['id', 'title', 'files', 'instructions'],
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['inline', 'steps'],
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
  properties: {
    ok: { type: 'boolean' },
    problems: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'problems'],
}
const VERDICT = {
  type: 'object',
  properties: {
    ship: { type: 'boolean' },
    confirmed_problems: { type: 'array', items: { type: 'string' } },
    unverified: { type: 'array', items: { type: 'string' } },
    merge_notes: { type: 'string' },
  },
  required: ['ship', 'confirmed_problems'],
}

phase('Plan')
const plan = await agent(
  `Plan this task for the repository you are in.\n\nTASK:\n${task}\n\n` +
  `Produce at most ${MAX_STEPS} steps. Each step owns a disjoint set of files. ` +
  `If the whole task is small enough for one person to do inline in a few minutes, set inline=true and explain in reason.`,
  { agentType: 'wforge:planner', model: 'opus', effort: 'high', schema: PLAN, label: 'plan' },
)
if (!plan) throw new Error('planner returned nothing')
if (plan.inline || plan.steps.length <= 1) {
  log(`planner says: do it inline (${plan.reason || 'one step'})`)
  return { task, plan, built: [], verdict: null, note: 'inline' }
}
let steps = plan.steps
if (steps.length > MAX_STEPS) {
  log(`cap: running ${MAX_STEPS} of ${steps.length} planned steps; dropped ${steps.length - MAX_STEPS}`)
  steps = steps.slice(0, MAX_STEPS)
}
log(`plan: ${steps.length} steps, ${(plan.risks || []).length} risks`)

const built = await pipeline(
  steps,
  (step) => agent(
    `Implement exactly this step.\n\nTASK CONTEXT:\n${task}\n\nSTEP ${step.id}: ${step.title}\n` +
    `FILES YOU OWN: ${step.files.join(', ')}\n\nINSTRUCTIONS:\n${step.instructions}\n` +
    (step.check ? `\nCHECK COMMAND: ${step.check}\n` : '') +
    `\nDo not touch other files. ${isolate ? 'You are in a worktree: commit and report the branch.' : 'You are in the main checkout: do not commit.'}`,
    {
      agentType: 'wforge:builder', model: 'sonnet', effort: 'medium', schema: BUILD,
      isolation: isolate ? 'worktree' : undefined, phase: 'Build', label: `build ${step.id}`,
    },
  ),
  (build, step) => {
    if (!build) return null
    if (!build.done) return { step, build, check: { ok: false, problems: [build.blocked || 'builder did not finish'] } }
    return agent(
      `Verify step ${step.id} (${step.title}).\nINSTRUCTIONS:\n${step.instructions}\n` +
      (step.check ? `CHECK COMMAND: ${step.check}\n` : '') +
      (build.branch ? `The work is on branch ${build.branch}; review it with git diff against the current branch.\n`
                    : `The work is uncommitted in this checkout; review it with git diff.\n`) +
      `Builder reported: ${build.summary}\nChanged files: ${build.changed_files.join(', ')}`,
      { agentType: 'wforge:checker', model: 'haiku', effort: 'low', schema: CHECK, phase: 'Check', label: `check ${step.id}` },
    ).then((check) => ({ step, build, check: check || { ok: false, problems: ['checker returned nothing'] } }))
  },
)
const results = built.filter(Boolean)
const failed = results.filter((r) => !r.check.ok)
log(`built ${results.length}/${steps.length}; ${failed.length} failed their check`)

phase('Verify')
const verdict = await agent(
  `A plan was built in steps. Try to break the result.\n\nTASK:\n${task}\n\nRISKS NAMED BY THE PLANNER:\n` +
  `${(plan.risks || []).map((r) => '- ' + r).join('\n') || '- none'}\n\nSTEPS AND RESULTS:\n` +
  results.map((r) =>
    `- ${r.step.id} ${r.step.title}: ${r.build.summary}` +
    (r.build.branch ? ` [branch ${r.build.branch}]` : '') +
    (r.check.ok ? ' (check ok)' : ` (check FAILED: ${r.check.problems.join('; ')})`)).join('\n') +
  `\n\nRead the actual diffs. Report confirmed problems only, and say whether the whole thing is ready to merge.`,
  { agentType: 'wforge:skeptic', model: 'sonnet', effort: 'medium', schema: VERDICT, label: 'skeptic' },
)
return { task, plan, results, verdict }
