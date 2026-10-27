import { z } from 'zod';

const topicSchema = z.string().trim().min(1).max(40);
const topicListSchema = z.array(topicSchema).max(10).transform((topics) => (
  [...new Set(topics.map((topic) => topic.toLocaleLowerCase()))]
));

export const feedPreferenceCommandSchema = z.object({
  algorithm: z.enum(['smart', 'chronological', 'friends_first']).optional(),
  more_topics: topicListSchema.optional(),
  less_topics: topicListSchema.optional(),
  hide_topics: topicListSchema.optional(),
  diversity_delta: z.number().int().min(-50).max(50).optional(),
  weights: z.object({
    friends_delta: z.number().int().min(-50).max(50).optional(),
    discovery_delta: z.number().int().min(-50).max(50).optional(),
    marketplace_delta: z.number().int().min(-50).max(50).optional(),
  }).strict().optional(),
}).strict().superRefine((command, context) => {
  const hasWeightChange = command.weights && Object.keys(command.weights).length > 0;
  const hasChange = Object.entries(command).some(([key, value]) => (
    key === 'weights' ? hasWeightChange : Array.isArray(value) ? value.length > 0 : value !== undefined
  ));
  if (!hasChange) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'La commande ne contient aucun changement.' });
  }
});

export const feedControlActionSchema = z.object({
  type: z.literal('update_feed_config'),
  summary: z.string().trim().min(1).max(180),
  command: feedPreferenceCommandSchema,
}).strict();

export type FeedPreferenceCommand = z.infer<typeof feedPreferenceCommandSchema>;
export type FeedControlAction = z.infer<typeof feedControlActionSchema>;

export function parseFeedControlAction(value: unknown): FeedControlAction | null {
  const result = feedControlActionSchema.safeParse(value);
  return result.success ? result.data : null;
}
