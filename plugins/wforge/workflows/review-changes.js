export const meta = {
  name: 'review-changes',
  description: 'Review every changed file for correctness, refute each finding adversarially, then rank what survives',
  whenToUse: 'Before merging a branch with more than a handful of changed files',
  phases: [
    { title: 'Scope', detail: 'list changed files (haiku)' },
    { title: 'Review', detail: 'one reviewer per file (sonnet)' },
    { title: 'Refute', detail: 'one skeptic per finding (sonnet, low)' },
    { title: 'Rank', detail: 'one synthesizer (sonnet)' },
  ],
}

// args: { base?: "main", maxFiles?: number (<= 20) }
const base = (args && args.base) || 'main'
const MAX_FILES = Math.max(1, Math.min(20, (args && args.maxFiles) || 12))

const FILES = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string' },
          title: { type: 'string' }, why: { type: 'string' },
        },
        required: ['file', 'title', 'why', 'severity'],
      },
    },
  },
  required: ['findings'],
}
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' }, reason: { type: 'string' } }, required: ['real'] }
const RANKED = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string' }, title: { type: 'string' }, why: { type: 'string' } },
        required: ['file', 'title', 'severity'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
}

phase('Scope')
const scope = await agent(
  `List the files changed on this branch relative to ${base}: run \`git diff --name-only ${base}...HEAD\` and ` +
  `\`git status --porcelain\` (for uncommitted work) and merge the two lists. Skip lockfiles, generated files and binaries.`,
  { agentType: 'wforge:scout', model: 'haiku', effort: 'low', schema: FILES, label: 'changed files' },
)
if (!scope) throw new Error('scout returned nothing')
let files = scope.files
if (!files.length) { log('no changed files'); return { base, findings: [], summary: 'nothing to review' } }
if (files.length > MAX_FILES) {
  log(`cap: reviewing ${MAX_FILES} of ${files.length} files; dropped: ${files.slice(MAX_FILES).join(', ')}`)
  files = files.slice(0, MAX_FILES)
}

const perFile = await pipeline(
  files,
  (file) => agent(
    `Review the changes to ${file} relative to ${base} (git diff ${base}...HEAD -- ${file}, plus uncommitted changes). ` +
    `Report correctness problems only: wrong behaviour, unhandled cases, broken contracts, security. No style. ` +
    `Each finding needs file, line, severity (high|medium|low), a one-line title and why it is wrong.`,
    { agentType: 'wforge:skeptic', model: 'sonnet', effort: 'medium', schema: FINDINGS, phase: 'Review', label: `review ${file}` },
  ),
  (res, file) => {
    if (!res || !res.findings.length) return []
    return parallel(res.findings.map((f) => () => agent(
      `Try to refute this review finding by reading the code. Finding: ${f.title} at ${f.file}:${f.line || '?'}. ` +
      `Claim: ${f.why}. Default to real=false unless the code clearly has the problem.`,
      { agentType: 'wforge:skeptic', model: 'sonnet', effort: 'low', schema: VERDICT, phase: 'Refute', label: `refute ${file}:${f.line || '?'}` },
    ).then((v) => (v && v.real ? f : null)))).then((kept) => kept.filter(Boolean))
  },
)
const survivors = perFile.filter(Boolean).flat()
log(`${survivors.length} findings survived refutation`)
if (!survivors.length) return { base, findings: [], summary: 'no confirmed problems' }

phase('Rank')
const ranked = await agent(
  `Deduplicate and rank these confirmed review findings, highest consequence first, and write a three-sentence summary.\n\n` +
  survivors.map((f) => `- [${f.severity}] ${f.file}:${f.line || '?'} ${f.title}: ${f.why}`).join('\n'),
  { agentType: 'wforge:skeptic', model: 'sonnet', effort: 'low', schema: RANKED, label: 'rank' },
)
return { base, findings: ranked ? ranked.findings : survivors, summary: ranked ? ranked.summary : '' }
