import { z } from "zod";

// The activity format. The AI writes activities in exactly this shape
// (structured outputs), and teachers can edit the JSON before publishing.
// Fields are nullable rather than optional so the shape works with
// structured outputs.

export const ExpressionSchema = z.object({
  latex: z.string().describe("A Desmos expression in LaTeX, e.g. y=2x+1 or a=3"),
  hidden: z.boolean().describe("true to load it hidden from the graph"),
});

export const CalculatorSchema = z.object({
  expressions: z.array(ExpressionSchema),
  bounds: z
    .object({ left: z.number(), right: z.number(), bottom: z.number(), top: z.number() })
    .nullable()
    .describe("The starting viewing window, or null for the Desmos default"),
});

export const QuestionSchema = z.object({
  type: z
    .enum(["none", "text", "numeric", "multiple_choice"])
    .describe("none = no question on this screen"),
  prompt: z.string(),
  choices: z.array(z.string()).describe("Answer choices for multiple_choice; empty otherwise"),
  answerKey: z
    .string()
    .describe("The correct answer or what a strong answer includes. Shown only to the teacher and the hint tutor, never to students."),
});

export const ScreenSchema = z.object({
  title: z.string(),
  instructions: z.string().describe("What the student reads on this screen. Plain text."),
  calculator: CalculatorSchema.nullable().describe("null if this screen has no calculator"),
  question: QuestionSchema,
  teacherNotes: z.string().describe("Notes for the teacher only"),
});

export const ActivitySchema = z.object({
  title: z.string(),
  screens: z.array(ScreenSchema),
});

export type Activity = z.infer<typeof ActivitySchema>;
export type Screen = z.infer<typeof ScreenSchema>;

/** The activity as students see it: no answer keys or teacher notes. */
export function studentView(activity: Activity) {
  return {
    title: activity.title,
    screens: activity.screens.map((s) => ({
      title: s.title,
      instructions: s.instructions,
      calculator: s.calculator,
      question: { type: s.question.type, prompt: s.question.prompt, choices: s.question.choices },
    })),
  };
}
