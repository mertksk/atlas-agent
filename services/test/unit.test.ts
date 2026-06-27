import { test } from "node:test";
import assert from "node:assert/strict";
import nacl from "tweetnacl";
import { authorizationBytes } from "../src/x402.js";

test("authorizationBytes is canonical (key order independent)", () => {
  const a = authorizationBytes({ from: "x", to: "y", value: "1", nonce: "n" });
  const b = authorizationBytes({ nonce: "n", value: "1", to: "y", from: "x" });
  assert.deepEqual(a, b);
});

test("mock settlement crypto: a valid ed25519 signature over the canonical bytes verifies", () => {
  const kp = nacl.sign.keyPair();
  const auth = {
    from: Buffer.from(kp.publicKey).toString("hex"),
    to: "payee",
    value: "500000000",
    validAfter: 0,
    validBefore: Math.floor(Date.now() / 1000) + 60,
    nonce: Buffer.from(nacl.randomBytes(16)).toString("hex"),
  };
  const bytes = authorizationBytes(auth);
  const sig = nacl.sign.detached(bytes, kp.secretKey);

  assert.equal(nacl.sign.detached.verify(bytes, sig, Buffer.from(auth.from, "hex")), true);
  // tampered amount must NOT verify against the original signature
  const tampered = authorizationBytes({ ...auth, value: "999999999" });
  assert.equal(nacl.sign.detached.verify(tampered, sig, Buffer.from(auth.from, "hex")), false);
});
