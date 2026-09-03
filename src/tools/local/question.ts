import { z } from 'zod'
import { select, multiselect, text, isCancel } from '@clack/prompts'
import type { ToolDefinition } from '../../agent/types.ts'

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

  if (isCancel(result)) return []
  if (result === '__custom__') {
    const custom = await text({ message: q.question })
    if (isCancel(custom) || !custom) return []
    return [custom]
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

  if (isCancel(result)) return []
  return result as string[]
}

export function askUserTool(): ToolDefinition {
  return {
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
      const answers: string[][] = []
      for (const q of questions) {
        const answer = q.multiple ? await askMultiple(q) : await askSingle(q)
        answers.push(answer)
      }
      const formatted = questions
        .map(
          (q: z.infer<typeof questionSchema>, i: number) =>
            `"${q.question}"="${answers[i]?.length ? answers[i].join(', ') : 'Unanswered'}"`,
        )
        .join(', ')
      return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
    },
  }
}
