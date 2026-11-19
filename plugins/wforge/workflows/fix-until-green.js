export const meta = {
  name: 'fix-until-green',
  description: 'Run a check command, fix the reported errors file by file on sonnet, repeat until it passes or progress stalls',
  whenToUse: 'A typecheck, lint or test command fails with many errors across files',
  phases: [
    { title: 'Run', detail: 'one runner per round (haiku)' },
    { title: 'Fix', detail: 'one builder per failing file (sonnet, medium)' },
  ],
}

// args: "command" or { check: "npx tsc --noEmit", maxRounds?: number (<= 6), maxFiles?: number (<= 8) }
const check = typeof args === 'string' ? args : (args && args.check)
if (!check) throw new Error('fix-until-green needs args.check')
const MAX_ROUNDS = Math.max(1, Math.min(6, (args && args.maxRounds) || 4))
const MAX_FILES = Math.max(1, Math.min(8, (args && args.maxFiles) || 6))

const RUN = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, message: { type: 'string' } },
        required: ['file', 'message'],
      },
    },
    total_errors: { type: 'number' },
    tail: { type: 'string' },
  },
  required: ['passed', 'errors'],
}
const FIX = {
  type: 'object',
  properties: { fixed: { type: 'number' }, notes: { type: 'string' }, blocked: { type: 'string' } },
  required: ['fixed'],
}

let previous = Infinity
let stalls = 0
const history = []
for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Run')
  const run = await agent(
    `Run this command from the repository root and report the result:\n\n${check}\n\n` +
    `Return passed=true only on exit code 0. Otherwise list every error with file, line and message ` +
    `(deduplicate identical lines; cap at 60 and put the true count in total_errors). Do not fix anything.`,
    { agentType: 'wforge:checker', model: 'haiku', effort: 'low', schema: RUN, label: `run ${round}` },
  )
  if (!run) throw new Error('runner returned nothing')
  const count = run.total_errors || run.errors.length
  history.push({ round, errors: count })
  if (run.passed) {
    log(`round ${round}: green`)
    return { check, passed: true, rounds: history }
  }
  if (count >= previous) {
    stalls++
    log(`round ${round}: ${count} errors, no progress (${stalls}/2)`)
    if (stalls >= 2) return { check, passed: false, rounds: history, note: 'stalled: two rounds without progress', remaining: run.errors }
  } else {
    stalls = 0
    log(`round ${round}: ${count} errors`)
  }
  previous = count

  const byFile = {}
  for (const e of run.errors) (byFile[e.file] = byFile[e.file] || []).push(e)
  const files = Object.keys(byFile).sort((a, b) => byFile[b].length - byFile[a].length)
  const batch = files.slice(0, MAX_FILES)
  if (files.length > batch.length) log(`fixing ${batch.length} of ${files.length} files this round`)

  await pipeline(batch, (file) => agent(
    `Fix the errors below in ${file} only. Do not edit any other file and do not run the full check; ` +
    `a runner will. Keep the fix minimal and consistent with the surrounding code.\n\nERRORS:\n` +
    byFile[file].map((e) => `- line ${e.line || '?'}: ${e.message}`).join('\n'),
    { agentType: 'wforge:builder', model: 'sonnet', effort: 'medium', schema: FIX, phase: 'Fix', label: `fix ${file}` },
  ))
}
return { check, passed: false, rounds: history, note: `gave up after ${MAX_ROUNDS} rounds` }
