import { PaypalError } from "paypal";
import type { Error as PaypalApiErrorBody } from "paypal";

// One translation from the SDK's error family (and our payouts REST calls) into what the money flow
// needs to know: did PayPal refuse, did the request never leave, or is the outcome unknown?

export type FailureKind =
  | "refused" // PayPal answered with an error status: nothing happened, release the claim
  | "never_sent" // credential or encoding failure: nothing left this process
  | "unknown"; // connection drop, timeout, or an unreadable 2xx: PayPal may have acted

export class PaypalFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly detail: { status?: number; reason?: string; issue?: string; debugId?: string } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function reasonFrom(body: unknown): { reason?: string; issue?: string; debugId?: string } {
  if (typeof body !== "object" || body === null) return {};
  const b = body as Partial<PaypalApiErrorBody> & { debug_id?: string };
  const d = b.details?.[0];
  return {
    reason: d?.description ?? d?.issue ?? b.message,
    issue: d?.issue ?? b.name,
    debugId: b.debugId ?? b.debug_id,
  };
}

function bodyFromRaw(raw: ArrayBuffer): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return undefined;
  }
}

/** Classify anything a PayPal SDK call rejected with. Rethrows what is outside the family (bugs, aborts). */
export function classify(err: unknown): PaypalFailure {
  if (err instanceof PaypalFailure) return err;
  if (!(err instanceof PaypalError)) throw err;
  switch (err.kind) {
    case "api": {
      // Every declared arm on our operations carries PayPal's Error body, or none (error500), or raw
      // bytes (undeclared), so read it structurally instead of switching on arm tags.
      const p = err.payload as { body?: unknown; rawBody?: ArrayBuffer };
      const body = p.rawBody ? bodyFromRaw(p.rawBody) : p.body;
      return new PaypalFailure("refused", `PayPal refused (${err.status})`, { status: err.status, ...reasonFrom(body) }, { cause: err });
    }
    case "decode":
      return err.status >= 200 && err.status < 300
        ? new PaypalFailure("unknown", "PayPal answered but the response was unreadable", { status: err.status }, { cause: err })
        : new PaypalFailure("refused", `PayPal refused (${err.status})`, { status: err.status }, { cause: err });
    case "connection":
    case "timeout":
      return new PaypalFailure("unknown", `No answer from PayPal (${err.kind})`, {}, { cause: err });
    case "encode":
    case "auth":
      return new PaypalFailure("never_sent", `Request not sent (${err.kind})`, {}, { cause: err });
  }
}

/** Shared mapper for REST responses we call without the SDK (payouts). */
export async function failureFromResponse(res: Response): Promise<PaypalFailure> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const b = body as { name?: string; message?: string; debug_id?: string; details?: { issue?: string; description?: string }[] } | undefined;
  return new PaypalFailure("refused", `PayPal refused (${res.status})`, {
    status: res.status,
    reason: b?.details?.[0]?.description ?? b?.details?.[0]?.issue ?? b?.message,
    issue: b?.details?.[0]?.issue ?? b?.name,
    debugId: b?.debug_id,
  });
}
