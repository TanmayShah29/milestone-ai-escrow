import { json } from "@/lib/http";
import { handleWebhookEvent } from "@/lib/money/webhooks";
import { verifyWebhookSignature, type WebhookEvent } from "@/lib/paypal/webhooks";

export const runtime = "nodejs";

// PayPal webhook receiver. Verify first, act second (money rule 6). A non-2xx makes PayPal retry,
// which is what we want when processing fails; a bad signature gets 400 and is never acted on.
export async function POST(req: Request) {
  let event: WebhookEvent;
  try {
    event = JSON.parse(await req.text()) as WebhookEvent;
    if (typeof event?.id !== "string" || typeof event?.event_type !== "string") throw new Error("not a webhook event");
  } catch {
    return json(400, { error: "invalid body" });
  }

  let verified: boolean;
  try {
    verified = await verifyWebhookSignature(req.headers, event);
  } catch (err) {
    console.error("webhook verification failed to run", err);
    return json(500, { error: "could not verify" });
  }
  if (!verified) {
    console.warn("webhook signature rejected", event.id, event.event_type);
    return json(400, { error: "signature verification failed" });
  }

  try {
    const outcome = await handleWebhookEvent(event);
    return json(200, outcome);
  } catch (err) {
    console.error("webhook processing failed", event.id, event.event_type, err);
    return json(500, { error: "processing failed" });
  }
}
