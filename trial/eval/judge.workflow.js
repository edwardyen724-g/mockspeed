export const meta = {
  name: 'trial-judge',
  description: 'Judge a through-the-app run of the trial: build substance per app, and a verdict on every follow-up step',
  whenToUse: 'After trial/eval/run.mjs and trial/eval/gallery.mjs, to say whether each Jev decision and change was right. args: { run: "<abs run dir>", gallery: "<abs gallery dir>" }. Save the result as <run>/verdicts.json and rebuild the gallery.',
  phases: [
    { title: 'Judge', detail: 'two apps per judge: build substance, and a verdict on every follow-up' },
  ],
}

// Run with the Workflow tool: { scriptPath: "<repo>/trial/eval/judge.workflow.js", args: { run, gallery } }.
// `run` is a trial/eval/run.mjs output folder; `gallery` the folder trial/eval/gallery.mjs wrote for it
// (its shots/ are named <run folder name>-<app>-build.png / -final.png). Five agents, two apps each.
const RUN = args?.run
const GALLERY = args?.gallery
if (!RUN || !GALLERY) throw new Error('args: { run: "<abs run dir>", gallery: "<abs gallery dir>" }')
const NAME = RUN.replace(/\/+$/, '').split('/').pop()
const REPO = RUN.replace(/\/trial\/eval\/.*$/, '')
const PAIRS = [['orchestration', 'kanban'], ['rent', 'rideshare'], ['support', 'email'], ['daw', 'extension'], ['crm', 'recipes']]

const VERDICT = {
  type: 'object',
  properties: {
    apps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          app: { type: 'string' },
          substance: { type: 'integer', minimum: 0, maximum: 3, description: 'the build (step 1): 0 generic dashboard/list that could be any app · 1 recognisable but shallow · 2 shows the core object/interaction · 3 shows it convincingly' },
          substanceWhy: { type: 'string' },
          composedWell: { type: 'array', items: { type: 'string' } },
          issues: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                category: { type: 'string', enum: ['primitive', 'prop', 'writer', 'render', 'edit', 'jev'] },
                what: { type: 'string' }, evidence: { type: 'string' }, composable: { type: 'string' },
              },
              required: ['category', 'what', 'evidence', 'composable'],
            },
          },
          steps: {
            type: 'array',
            description: 'one verdict per follow-up step (steps 2 and up; step 1 is the build, judged by substance)',
            items: {
              type: 'object',
              properties: {
                step: { type: 'integer', description: "1-based index into the app's steps array" },
                verdict: {
                  type: 'string',
                  enum: ['right', 'partly', 'wrong', 'fair_ask', 'needless_ask', 'correctly_nothing', 'missed'],
                  description: 'right: did what was asked, to the right element / in a sensible place · partly: related but off (right element, odd spot; did half) · wrong: changed the wrong thing or did something not asked · fair_ask: asked the person and the sentence really was ambiguous on this canvas · needless_ask: asked, but the sentence and canvas made the answer clear · correctly_nothing: nothing changed and nothing should have · missed: nothing changed but something should have',
                },
                why: { type: 'string', description: 'one sentence, with the element or place involved' },
              },
              required: ['step', 'verdict', 'why'],
            },
          },
        },
        required: ['app', 'substance', 'substanceWhy', 'composedWell', 'issues', 'steps'],
      },
    },
  },
  required: ['apps'],
}

phase('Judge')
const judged = await parallel(PAIRS.map((pair) => () => agent(`You are judging a test of a mockup app. A person types a sentence; Jev (a fast classifier) decides what it means — route (direct edit / writer / nothing), what kind of change, which screen, which element, where a new piece goes — and a writer model (Claude Haiku 4.5) writes only the words and outline pieces. Questions the app cannot settle are put to the person. In this test a script played the person: it answered "start a new app" and "yes, remove it", and left every other question ("which one?", "where should it go?") unanswered. The format of the mocks is in ${REPO}/trial/FORMAT.md.

Judge these two apps: ${pair.join(' and ')}. For each app X:
- ${RUN}/results.json — find the entry with key X. Its \`steps\` array is everything the person said, in order: step 1 builds the app, the rest are follow-ups. Each step has the sentence, its kind (what the test meant it to exercise), \`log\` (every Jev decision — entries with op "route" and "place", their \`source\` shows Jev's answers and confidences — plus what changed: op "piece", "move", edits with a target, "split", "choice" = a question to the person), \`asked\` (questions put to the person), \`human\` (the answers the script gave) and \`reply\`.
- ${RUN}/X.build.outline — the app right after step 1; ${RUN}/X.final.outline — after every step.
- ${GALLERY}/shots/${NAME}-X-build.png and ${GALLERY}/shots/${NAME}-X-final.png — the renders; open them with the Read tool and look.
- ${GALLERY}/renders/${NAME}-X-final.html if you need to check how something was drawn.

For the build (step 1), score substance 0-3 exactly as defined, list what was composed well, and list issues (category jev = a decision Jev got wrong). For every follow-up (steps 2 onwards) give one verdict from the enum with a one-sentence reason naming the element or place. Judge against what a reasonable person meant by the sentence on that canvas — for example "make the title bigger" when every screen has its own title copy makes a "which one?" a fair_ask; "remove the last button" with an obvious last button makes it a needless_ask. You only have the outlines after step 1 and after the last step plus each step's log; reconstruct intermediate states from the log notes where needed, and say so in the reason if you are unsure. Be strict and specific. Do not modify any files.`,
  { label: `judge:${pair.join('+')}`, phase: 'Judge', schema: VERDICT })))

const apps = judged.filter(Boolean).flatMap((j) => j.apps)
log(`${apps.length} of 10 apps judged — save the returned object as ${RUN}/verdicts.json`)
return Object.fromEntries(apps.map((a) => [a.app, a]))
