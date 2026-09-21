import { z } from 'zod/v4'
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
  multiple: z.boolean().nullish().describe('Allow selecting multiple choices'),
  custom: z
    .boolean()
    .nullish()
    .describe('Allow typing a custom answer (default: true)'),
})

// @clack/prompts renders its menu and then waits for a keypress that will
// never arrive when stdin isn't interactive (a piped one-shot run, CI), so
// the tool promise never settles. runTool's deadline would only abandon it
// after toolTimeout (it can't cancel the prompt itself — see withDeadline),
// so the call would stall until then. Refuse up front instead, and tell the
// model to decide for itself.
function interactive(): boolean {
  return Boolean(process.stdin.isTTY)
}

function toClackOptions(q: z.infer<typeof questionSchema>) {
  return q.options.map((o) => ({
    value: o.label,
    label: o.label,
    hint: o.description,
  }))
}

async function askSingle(q: z.infer<typeof questionSchema>): Promise<string[]> {
  const options = toClackOptions(q)
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
  const options = toClackOptions(q)

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
    category: 'plan',
    parallel: false,
    description: `Ask the user multiple-choice questions when you need a decision or requirement you can't determine yourself. Give each option a short label and an explanation. A "Type your own answer" option is added automatically, so don't add "Other". Put your recommended option first and end its label with "(Recommended)". Set multiple: true to allow several answers. Answers come back as the chosen labels. Without an interactive terminal the call is refused; proceed on your best judgement and state your assumptions.`,
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
