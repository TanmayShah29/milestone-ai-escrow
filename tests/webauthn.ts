import { createHash, generateKeyPairSync, randomBytes, sign as nodeSign, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR } from "@simplewebauthn/server/helpers";

// Shared by the passkey tests (terms signatures, mandates).

/** A software authenticator: what a phone or laptop does when it makes and uses a passkey (none attestation). */
export function softAuthenticator(rpId = "localhost", origin = "http://localhost:3000") {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credId = randomBytes(16);
  const rpHash = createHash("sha256").update(rpId).digest();
  let counter = 0;
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    id: isoBase64URL.fromBuffer(credId),
    register(challenge: string) {
      const coseKey = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]);
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(isoCBOR.encode(coseKey))]);
      const attestation = isoCBOR.encode(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]) as never);
      return {
        id: isoBase64URL.fromBuffer(credId),
        rawId: isoBase64URL.fromBuffer(credId),
        type: "public-key" as const,
        response: { clientDataJSON: isoBase64URL.fromBuffer(clientData("webauthn.create", challenge)), attestationObject: isoBase64URL.fromBuffer(attestation), transports: ["internal" as const] },
        clientExtensionResults: {},
      };
    },
    assert(challenge: string, key: KeyObject = privateKey) {
      counter += 1;
      const counterBytes = Buffer.alloc(4);
      counterBytes.writeUInt32BE(counter);
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), counterBytes]);
      const cd = clientData("webauthn.get", challenge);
      const sig = nodeSign("sha256", Buffer.concat([authData, createHash("sha256").update(cd).digest()]), { key, dsaEncoding: "der" });
      return {
        id: isoBase64URL.fromBuffer(credId),
        rawId: isoBase64URL.fromBuffer(credId),
        type: "public-key" as const,
        response: { clientDataJSON: isoBase64URL.fromBuffer(cd), authenticatorData: isoBase64URL.fromBuffer(authData), signature: isoBase64URL.fromBuffer(sig) },
        clientExtensionResults: {},
      };
    },
  };
}

