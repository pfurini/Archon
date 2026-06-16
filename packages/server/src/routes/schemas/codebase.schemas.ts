/**
 * Zod schemas for codebase API endpoints.
 */
import { z } from '@hono/zod-openapi';
import { codebaseRowSchema } from '@archon/core/schemas/codebase';
import { ENV_VAR_NAME_PATTERN } from '@archon/paths';

/** A codebase record (wire shape with ISO string dates). */
export const codebaseSchema = codebaseRowSchema
  .extend({
    created_at: z.string().datetime(),
    updated_at: z.string().datetime(),
  })
  .openapi('Codebase');

/** GET /api/codebases response. */
export const codebaseListResponseSchema = z.array(codebaseSchema).openapi('CodebaseListResponse');

/** Path params for routes with :id (codebase ID). */
export const codebaseIdParamsSchema = z.object({ id: z.string() });

/** POST /api/codebases request body. Exactly one of url or path must be provided. */
export const addCodebaseBodySchema = z
  .object({
    url: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
  })
  .refine(b => (b.url !== undefined) !== (b.path !== undefined), {
    message: 'Provide either "url" or "path", not both and not neither',
  })
  .openapi('AddCodebaseBody');

/** DELETE /api/codebases/:id response. */
export const deleteCodebaseResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('DeleteCodebaseResponse');

/** Response for GET /api/codebases/:id/env — returns only keys, never values */
export const codebaseEnvVarsResponseSchema = z
  .object({
    keys: z.array(z.string()),
  })
  .openapi('CodebaseEnvVarsResponse');

/** Body for PUT /api/codebases/:id/env — upsert one key-value pair */
export const setEnvVarBodySchema = z
  .object({
    // Constrained to POSIX shell identifiers: names reach a `bash -c` launch
    // string in the claude-terminal provider, so a name with shell metacharacters
    // would be an injection vector (issue #8). Reject at the boundary (400, not 500).
    key: z
      .string()
      .min(1)
      .max(255)
      .regex(ENV_VAR_NAME_PATTERN, 'Must be a POSIX env var name: ^[A-Za-z_][A-Za-z0-9_]*$'),
    value: z.string(),
  })
  .openapi('SetEnvVarBody');

/** Path params for routes with :id/:key */
export const codebaseEnvVarParamsSchema = z.object({
  id: z.string(),
  key: z.string(),
});

/** Response for PUT/DELETE /api/codebases/:id/env */
export const envVarMutationResponseSchema = z
  .object({ success: z.boolean() })
  .openapi('EnvVarMutationResponse');
