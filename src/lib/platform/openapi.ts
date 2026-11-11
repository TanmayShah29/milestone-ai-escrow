import { STATES } from "@/lib/milestones/states";
import { ACTION_ROLES } from "./actions";

// The OpenAPI 3.1 description of the public API (served at GET /api/openapi). Hand-written, with the action
// list read from the route's own table (actions.ts). A typed SDK can be generated from it; none ships yet.

const auth = [{ milestoneToken: [] }, { platformKey: [] }];
const errorBody = { type: "object", properties: { error: { type: "string" } }, required: ["error"] };
const err = (description: string) => ({ description, content: { "application/json": { schema: errorBody } } });
const idemHeader = { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", maxLength: 100 }, description: "Retries with the same key and body return the first response (header Idempotent-Replayed: true) for 24 hours. The same key with a different body: 422." };
const milestoneId = { name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } };
const milestoneResponse = { description: "The milestone", content: { "application/json": { schema: { type: "object", properties: { milestone: { $ref: "#/components/schemas/Milestone" } } } } } };

export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Milestone API",
    version: "2.0.0",
    summary: "Pay-on-proof payments on PayPal: a hold released only when the work is proven.",
    description:
      "The AI never moves money: funding, capture, void and payout run only through fixed rules. Authorize with a milestone's client or worker link token (`x-milestone-token`, or `Authorization: Bearer mct_…/mwt_…`), or a platform's API key (`Authorization: Bearer msk_…`).",
    license: { name: "MIT", identifier: "MIT" },
  },
  servers: [{ url: "https://milestone-ai-escrow.onrender.com" }],
  components: {
    securitySchemes: {
      milestoneToken: { type: "apiKey", in: "header", name: "x-milestone-token" },
      platformKey: { type: "http", scheme: "bearer", description: "A platform's msk_ API key" },
    },
    schemas: {
      Milestone: {
        type: "object",
        description: "A milestone as either side sees it (link-token hashes are never included).",
        properties: {
          id: { type: "string", format: "uuid" },
          title: { type: "string" },
          state: { type: "string", enum: [...STATES] },
          amount_cents: { type: "integer" },
          criteria_hash: { type: ["string", "null"], description: "SHA-256 fingerprint of the signed terms" },
          share_bps: { type: ["integer", "null"], description: "Earned share a PASSED decision captures" },
          paypal_order_id: { type: ["string", "null"] },
          paypal_authorization_id: { type: ["string", "null"] },
          paypal_capture_id: { type: ["string", "null"] },
          paypal_payout_batch_id: { type: ["string", "null"] },
        },
        additionalProperties: true,
      },
      Event: {
        type: "object",
        description: "A webhook event: one per audit row of the platform's milestones. Non-personal, like the public proof chain.",
        properties: {
          id: { type: "string", examples: ["evt_1234"] },
          type: { type: "string", examples: ["review:passed", "hold:captured", "payout:succeeded", "lock:matched", "award:signed"] },
          milestoneId: { type: "string", format: "uuid" },
          from: { type: ["string", "null"] },
          to: { type: ["string", "null"] },
          at: { type: "string", format: "date-time" },
          paypalId: { type: ["string", "null"] },
          facts: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        },
        required: ["id", "type", "milestoneId", "at", "facts"],
      },
    },
  },
  paths: {
    "/api/milestones": {
      post: {
        summary: "Open a milestone",
        parameters: [idemHeader],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["title", "amount", "freelancerEmail"], properties: { title: { type: "string" }, brief: { type: "string" }, amount: { type: "string", examples: ["300.00"] }, freelancerEmail: { type: "string", format: "email" }, clientEmail: { type: "string", format: "email" }, dueDate: { type: "string", format: "date-time" }, verifier: { type: "string", enum: ["code_pr", "rubric_text"] } } } } } },
        responses: {
          "201": { description: "Created. The two link tokens are returned once.", content: { "application/json": { schema: { type: "object", properties: { milestone: { $ref: "#/components/schemas/Milestone" }, clientToken: { type: "string" }, workerToken: { type: "string" } } } } } },
          "400": err("Invalid input"),
          "429": err("Too many from this address"),
        },
      },
    },
    "/api/milestones/{id}": { get: { summary: "Read a milestone, its audit trail and latest review", security: auth, parameters: [milestoneId], responses: { "200": milestoneResponse, "401": err("No token"), "403": err("Wrong token") } } },
    "/api/milestones/{id}/{action}": {
      post: {
        summary: "Act on a milestone",
        description: `Which side may call each action: ${Object.entries(ACTION_ROLES)
          .map(([a, r]) => `\`${a}\` (${r.join(", ")})`)
          .join(", ")}.`,
        security: auth,
        parameters: [milestoneId, { name: "action", in: "path", required: true, schema: { type: "string", enum: Object.keys(ACTION_ROLES) } }, idemHeader],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: true } } } },
        responses: { "200": milestoneResponse, "400": err("Not allowed in this state"), "401": err("No token"), "403": err("This side can't do that"), "404": err("Unknown action"), "409": err("Already in progress") },
      },
    },
    "/api/milestones/{id}/court": {
      get: { summary: "The resolution desk's case: lock, fee holds, evidence pack, AI draft, award", security: auth, parameters: [milestoneId], responses: { "200": { description: "The case" }, "401": err("No token") } },
      post: { summary: "The arbitrator's signed award (the signature is the authorization)", parameters: [milestoneId], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["shareBps", "reasons", "signature"], properties: { shareBps: { type: "integer", minimum: 0, maximum: 10000 }, reasons: { type: "string" }, signature: { type: "string", description: "ES256 over milestone-award:v1|<id>|<terms hash>|<pack hash>|<share>|<sha256(reasons)>, base64url" } } } } } }, responses: { "200": { description: "Settling" }, "400": err("Invalid or wrong signature") } },
    },
    "/api/milestones/{id}/timeline": { get: { summary: "The milestone as Gantt tasks", security: auth, parameters: [milestoneId], responses: { "200": { description: "Tasks and dependencies" } } } },
    "/api/contracts/{hash}": { get: { summary: "The signed contract by fingerprint (public; CI and the runner fetch it)", parameters: [{ name: "hash", in: "path", required: true, schema: { type: "string", pattern: "^[0-9a-f]{64}$" } }], responses: { "200": { description: "{ hash, document }: document is the canonical JSON whose SHA-256 is the hash" }, "404": err("No agreed contract") } } },
    "/api/proof/{id}": { get: { summary: "A milestone's signed proof chain (public, checkable with the published keys)", parameters: [milestoneId], responses: { "200": { description: "The chain" } } } },
    "/.well-known/milestone-proof-keys.json": { get: { summary: "The proof chain's public signing keys", responses: { "200": { description: "JWKS-like key list" } } } },
    "/api/platform": {
      get: { summary: "Your platform's webhook URL and policy hooks", security: [{ platformKey: [] }], responses: { "200": { description: "Settings" }, "401": err("No platform key") } },
      post: {
        summary: "Set the webhook URL (returns the signing secret once), rotate it, or set policy hooks",
        security: [{ platformKey: [] }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { webhookUrl: { type: ["string", "null"], format: "uri" }, rotateSecret: { type: "boolean" }, hooks: { type: "object", properties: { maxAmountCents: { type: "integer" }, allowedRepos: { type: "array", items: { type: "string" } }, workerEmailDomains: { type: "array", items: { type: "string" } } }, additionalProperties: false } } } } } },
        responses: { "200": { description: "Settings, plus webhookSecret when it was just set" }, "400": err("Invalid URL or hooks") },
      },
    },
    "/api/tick": { get: { summary: "Move every milestone forward (public; any clock may call it)", responses: { "200": { description: "What moved" } } } },
    "/api/health": { get: { summary: "Liveness and the deployed commit", responses: { "200": { description: "{ ok, commit }" } } } },
  },
  webhooks: {
    milestoneEvent: {
      post: {
        summary: "Sent to your webhook URL for every audit event of your milestones, retried with backoff (up to 12 tries)",
        parameters: [
          { name: "Milestone-Signature", in: "header", required: true, schema: { type: "string" }, description: "t=<unix seconds>,v1=<hex HMAC-SHA256 of '<t>.<raw body>' with your webhook secret>. Reject a t older than 5 minutes." },
          { name: "Milestone-Event", in: "header", required: true, schema: { type: "string" } },
          { name: "Milestone-Delivery", in: "header", required: true, schema: { type: "string" }, description: "The event id; deliveries are at least once, so dedupe on it" },
        ],
        requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Event" } } } },
        responses: { "2XX": { description: "Received" } },
      },
    },
  },
} as const;
