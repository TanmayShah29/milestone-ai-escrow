import type { Role } from "@/lib/auth";

// Which side may trigger each POST /api/milestones/:id/:action. The route and the OpenAPI spec
// (platform/openapi.ts) both read this, so the spec can't list an action the server doesn't have.
export const ACTION_ROLES: Record<string, Role[]> = {
  "draft-terms": ["client"],
  "attack-terms": ["client"],
  "edit-terms": ["client"],
  "sign-terms": ["client", "worker"],
  "passkey-options": ["client", "worker"],
  "passkey-register": ["client", "worker"],
  submit: ["worker"],
  check: ["client", "worker"],
  approve: ["client"],
  "request-changes": ["client"],
  object: ["client"],
  fund: ["client"],
  "fund-card": ["client"],
  cancel: ["client"],
  release: ["client"],
  "refresh-hold": ["client"],
  schedule: ["client"],
  sync: ["client", "worker"],
  "rotate-link": ["client", "worker"],
  erase: ["client"],
  lock: ["client", "worker"],
  "match-lock": ["client", "worker"],
};
