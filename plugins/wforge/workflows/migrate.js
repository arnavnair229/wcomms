export const meta = {
  name: 'migrate',
  description: 'Apply one instruction to many files, each in its own worktree on sonnet, with a haiku check per file',
  whenToUse: 'The same mechanical change across many files: an API rename, an import swap, a pattern migration',
  phases: [
    { title: 'Discover', detail: 'find the files (haiku)' },
    { title: 'Transform', detail: 'one builder per file (sonnet, worktree)' },
    { title: 'Check', detail: 'one checker per file (haiku)' },
  ],
}

// args: { instruction, files?: string[], glob?: string, maxFiles?: number (<= 30), isolate?: boolean }
const instruction = args && args.instruction
if (!instruction) throw new Error('migrate needs args.instruction')
const MAX_FILES = Math.max(1, Math.min(30, (args && args.maxFiles) || 15))
const isolate = !(args && args.isolate === false)

const FILES = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
const DONE = {
  type: 'object',
  properties: { done: { type: 'boolean' }, summary: { type: 'string' }, branch: { type: 'string' }, blocked: { type: 'string' } },
  required: ['done', 'summary'],
}
const CHECK = { type: 'object', properties: { ok: { type: 'boolean' }, problems: { type: 'array', items: { type: 'string' } } }, required: ['ok', 'problems'] }

let files = (args && args.files) || []
if (!files.length) {
  phase('Discover')
  const found = await agent(
    `Find every file this instruction applies to${args.glob ? ` under the glob ${args.glob}` : ''}. ` +
    `INSTRUCTION: ${instruction}\nReturn the paths only. Skip generated files, vendored code and lockfiles.`,
    { agentType: 'wforge:scout', model: 'haiku', effort: 'low', schema: FILES, label: 'discover' },
  )
  files = found ? found.files : []
}
if (!files.length) { log('nothing to migrate'); return { instruction, results: [] } }
if (files.length > MAX_FILES) {
  log(`cap: migrating ${MAX_FILES} of ${files.length} files; rerun with args.files for the rest: ${files.slice(MAX_FILES).join(', ')}`)
  files = files.slice(0, MAX_FILES)
}

const results = await pipeline(
  files,
  (file) => agent(
    `Apply this instruction to ${file} and to no other file.\nINSTRUCTION: ${instruction}\n` +
    (isolate ? 'You are in a worktree: commit with a message naming the file and report the branch.' : 'Do not commit.'),
    { agentType: 'wforge:builder', model: 'sonnet', effort: 'medium', schema: DONE, isolation: isolate ? 'worktree' : undefined, phase: 'Transform', label: `transform ${file}` },
  ),
  (res, file) => {
    if (!res) return null
    if (!res.done) return { file, result: res, check: { ok: false, problems: [res.blocked || 'not done'] } }
    return agent(
      `Check that ${file} now satisfies this instruction and nothing else changed.\nINSTRUCTION: ${instruction}\n` +
      (res.branch ? `Work is on branch ${res.branch}; diff it against the current branch.` : 'Work is uncommitted; use git diff.'),
      { agentType: 'wforge:checker', model: 'haiku', effort: 'low', schema: CHECK, phase: 'Check', label: `check ${file}` },
    ).then((check) => ({ file, result: res, check: check || { ok: false, problems: ['checker returned nothing'] } }))
  },
)
const out = results.filter(Boolean)
const bad = out.filter((r) => !r.check.ok)
log(`${out.length - bad.length} ok, ${bad.length} need attention`)
return { instruction, results: out, branches: out.map((r) => r.result.branch).filter(Boolean) }
