import { json, toHttp } from "@/lib/http";
import { publishedKeys } from "@/lib/proof/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Every key that has signed proof-chain events, public halves only. `source: "generated"` means the app
// made the key itself and the database holds it; "env" means it came from PROOF_SIGNING_KEY.
export async function GET() {
  try {
    return json(200, { alg: "ES256", keys: await publishedKeys() });
  } catch (err) {
    return toHttp(err);
  }
}
