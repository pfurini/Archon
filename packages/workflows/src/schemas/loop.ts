/**
 * Zod schema for loop node configuration.
 */
import { z } from '@hono/zod-openapi';

// Canonical effort levels, inlined to mirror `effortLevelSchema` in dag-node.ts.
// Not imported from dag-node.ts: that module imports `loopNodeConfigSchema` from
// here, so importing back would create an eval-time circular dependency (the enum
// is used during this module's schema construction and would be `undefined`).
const escalateEffortSchema = z.enum(['low', 'medium', 'high', 'max']);

export const loopNodeConfigSchema = z
  .object({
    /** Inline prompt text executed each iteration. */
    prompt: z.string().min(1, "loop node requires 'loop.prompt' (non-empty string)"),
    /** Completion signal string detected in AI output (e.g., "COMPLETE"). */
    until: z.string().min(1, "loop node requires 'loop.until' (completion signal string)"),
    /** Maximum iterations allowed; exceeding this fails the node. */
    max_iterations: z.number().int().positive("'loop.max_iterations' must be a positive integer"),
    /** Whether to start fresh session each iteration (default: false). */
    fresh_context: z.boolean().default(false),
    /** Optional bash script run after each iteration; exit 0 = complete. */
    until_bash: z.string().optional(),
    /** When true, pause between iterations for user input via /workflow approve. */
    interactive: z.boolean().optional(),
    /** Message shown to user when paused (required when interactive is true). */
    gate_message: z.string().optional(),
    /**
     * Escalate to a stronger model when the loop stalls (makes no progress) on
     * the primary model. Opt-in capability backstop: most iterations finish on
     * the cheap default; only genuinely-stuck loops pull in the strong model.
     * Intended for `fresh_context: true` loops (no session carried across the
     * provider swap). Progress is detected via new git commits in the loop cwd;
     * a non-git cwd disables stall detection (no crash).
     */
    escalate: z
      .object({
        /** Fallback model — a LITERAL id (e.g. "opus"), not a tier keyword. */
        model: z.string().min(1, "loop.escalate requires 'model'"),
        /** Fallback provider (e.g. "claude-terminal"). Default: the loop's current provider. */
        provider: z.string().trim().min(1).optional(),
        /** Provider effort hint applied to the fallback (e.g. "high"). */
        effort: escalateEffortSchema.optional(),
        /** Consecutive no-progress iterations that trigger escalation. Default: 3. */
        stall_after: z.number().int().positive().default(3),
      })
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (data.interactive === true && !data.gate_message) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "interactive loop requires 'loop.gate_message' (non-empty string)",
        path: ['gate_message'],
      });
    }
  });

export type LoopNodeConfig = z.infer<typeof loopNodeConfigSchema>;
