import { z } from 'zod'
import { select, multiselect, text, isCancel, cancel } from '@clack/prompts'
import { defineTool } from '../registry.ts'

const optionSchema = z.object({
  label: z.string().describe('Display text (1-5 words, concise)'),
  description: z.string().describe('Explanation of choice'),
})

const questionSchema = z.object({
  question: z.string().describe('Complete question'),
  header: z.string().describe('Very short label (max 30 chars)'),
  options: z.array(optionSchema).describe('Available choices'),
  multiple: z.boolean().optional().describe('Allow selecting multiple choices'),
  custom: z
    .boolean()
    .optional()
    .describe('Allow typing a custom answer (default: true)'),
})

// @clack/prompts renders its menu and then waits for a keypress that will
// never arrive when stdin isn't interactive (a piped one-shot run, CI), so
// the tool promise never settles — and runTool's deadline awaits that
// promise rather than racing it, so nothing rescues the hang. Refuse up
// front instead, and tell the model to decide for itself.
function interactive(): boolean {
  return Boolean(process.stdin.isTTY)
}

async function askSingle(q: z.infer<typeof questionSchema>): Promise<string[]> {
  const options = q.options.map((o) => ({
    value: o.label,
    label: o.label,
    hint: o.description,
  }))
  const allowCustom = q.custom !== false

  if (allowCustom) {
    options.push({
      value: '__custom__',
      label: 'Type your own answer',
      hint: '',
    })
  }

  const result = await select({
    message: q.question,
    options,
  })

  if (isCancel(result)) return cancelled()
  if (result === '__custom__') {
    const custom = await text({ message: q.question })
    if (isCancel(custom)) return cancelled()
    if (!custom) return []
    // See the comment in cli/auth.ts's promptForApiKey: @clack/prompts@1.8.0's
    // return type and its own pinned @clack/core@1.5.0's isCancel guard don't
    // line up, so `custom` doesn't narrow to `string` here even though
    // isCancel already ruled out the only non-string case.
    return [custom as string]
  }
  return [result as string]
}

async function askMultiple(
  q: z.infer<typeof questionSchema>,
): Promise<string[]> {
  const options = q.options.map((o) => ({
    value: o.label,
    label: o.label,
    hint: o.description,
  }))

  const result = await multiselect({
    message: q.question,
    options,
    required: false,
  })

  if (isCancel(result)) return cancelled()
  return result as string[]
}

// A cancelled prompt (Esc/Ctrl-C) yields no answer; print a styled cancel line
// so the abort is visible rather than the prompt silently vanishing, and return
// the empty answer the caller records as "Unanswered".
function cancelled(): string[] {
  cancel('Cancelled.')
  return []
}

export const askUserTool = () =>
  defineTool({
    name: 'ask_user',
    parallel: false,
    description: `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`,
    parameters: z.object({
      questions: z.array(questionSchema).describe('Questions to ask the user'),
    }),
    async execute({ questions }) {
      if (!interactive()) {
        return 'Cannot ask the user questions: this session has no interactive terminal (stdin is not a TTY). Proceed with your best judgement and state the assumptions you made.'
      }
      const answers: string[][] = []
      for (const q of questions) {
        const answer = q.multiple ? await askMultiple(q) : await askSingle(q)
        answers.push(answer)
      }
      const formatted = questions
        .map((q, i) => {
          const answer = answers[i]
          const value = answer?.length ? answer.join(', ') : 'Unanswered'
          return `"${q.question}"="${value}"`
        })
        .join(', ')
      return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
    },
  })
