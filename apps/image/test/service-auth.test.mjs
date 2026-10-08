import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createGoogleCallerVerifier } from "../dist/service-auth.js";
const { Response, ReadableStream } = globalThis;
const config = {
  audience: "https://koko-image-example.run.app",
  callerEmail: "koko-worker@koko-example.iam.gserviceaccount.com",
  callerSubject: "123456789012345678901",
};
const { publicKey, privateKey } = await generateKeyPair("RS256");
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "fixture",
  use: "sig",
  alg: "RS256",
};
const now = () => Math.floor(Date.now() / 1000);
const claims = () => ({
  iss: "https://accounts.google.com",
  aud: config.audience,
  sub: config.callerSubject,
  iat: now(),
  exp: now() + 3600,
  email: config.callerEmail,
  email_verified: true,
});
const token = (
  payload = claims(),
  header = { alg: "RS256", kid: "fixture", typ: "JWT" },
  key = privateKey,
) =>
  new SignJWT(payload)
    .setProtectedHeader(header)
    .sign(key)
    .then((t) => `Bearer ${t}`);
function verifier(response) {
  let calls = 0;
  const verify = createGoogleCallerVerifier(config, async (url, init) => {
    calls++;
    assert.equal(url, "https://www.googleapis.com/oauth2/v3/certs");
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.deepEqual(init.headers, { accept: "application/json" });
    return response ? response(init) : Response.json({ keys: [jwk] });
  });
  return { verify, calls: () => calls };
}
test("Google service signature, exact audience/email/subject and public key cache", async () => {
  const h = verifier();
  assert.equal(await h.verify(await token()), true);
  assert.equal(await h.verify(await token()), true);
  assert.equal(h.calls(), 1);
});
for (const audience of [
  "https://koko-image-123456789012.asia-northeast1.run.app",
  "https://koko-image-abcdefghij-an.a.run.app",
])
  test(`Cloud Run supported service origin ${audience}`, async () => {
    const verify = createGoogleCallerVerifier(
      { ...config, audience },
      async () => Response.json({ keys: [jwk] }),
    );
    assert.equal(
      await verify(await token({ ...claims(), aud: audience })),
      true,
    );
    assert.equal(await verify(await token()), false);
  });
for (const audience of [
  "http://service.run.app",
  "https://service.run.app/",
  "https://service.run.app:443",
  "https://service.run.app?x=1",
  "https://service.run.app#x",
  "https://user@service.run.app",
  "https://service.run.app.evil.example",
  "https://-service.run.app",
  "https://service-.run.app",
  "https://service..run.app",
])
  test(`reject non-origin audience ${audience}`, () =>
    assert.throws(
      () => createGoogleCallerVerifier({ ...config, audience }),
      /INVALID_SERVICE_AUTH_CONFIG/,
    ));
for (const [name, value] of Object.entries({
  audience: "https://attacker.example",
  callerEmail: "person@gmail.com",
  callerSubject: "abc",
}))
  test(`reject invalid service configuration ${name}`, () => {
    assert.throws(
      () => createGoogleCallerVerifier({ ...config, [name]: value }),
      /INVALID_SERVICE_AUTH_CONFIG/,
    );
  });
for (const authorization of [
  null,
  "",
  "Basic x",
  "Bearer",
  "bearer a.b.c",
  "Bearer a.b.c, a.b.c",
  "Bearer a.b.",
  "Bearer " + "a".repeat(8193) + ".b.c",
])
  test(`invalid authorization framing ${String(authorization).slice(0, 20)}`, async () => {
    const h = verifier();
    assert.equal(await h.verify(authorization), false);
    assert.equal(h.calls(), 0);
  });
for (const [name, update] of Object.entries({
  issuer: { iss: "https://evil.example" },
  audience: { aud: "https://another.run.app" },
  audienceArray: { aud: [config.audience] },
  subject: { sub: "999999999999999999999" },
  email: { email: "other@koko-example.iam.gserviceaccount.com" },
  unverified: { email_verified: false },
  stringVerified: { email_verified: "true" },
  expired: { exp: now() - 1 },
  future: { iat: now() + 60 },
  tooLong: { exp: now() + 7200 },
  futureNotBefore: { nbf: now() + 60 },
  floatTime: { iat: now() + 0.5 },
}))
  test(`signed but untrusted claims ${name}`, async () =>
    assert.equal(
      await verifier().verify(await token({ ...claims(), ...update })),
      false,
    ));
for (const name of [
  "iss",
  "aud",
  "sub",
  "iat",
  "exp",
  "email",
  "email_verified",
])
  test(`missing required claim ${name}`, async () => {
    const p = claims();
    delete p[name];
    assert.equal(await verifier().verify(await token(p)), false);
  });
test("reject tampered signature and foreign keys", async () => {
  const signed = await token();
  const [a, b, c] = signed.split(".");
  assert.equal(
    await verifier().verify(
      `${a}.${b}.${c[0] === "A" ? "B" : "A"}${c.slice(1)}`,
    ),
    false,
  );
  const foreign = await generateKeyPair("RS256");
  assert.equal(
    await verifier().verify(
      await token(claims(), undefined, foreign.privateKey),
    ),
    false,
  );
});
test("ignore attacker key URLs and reject unapproved JOSE headers", async () => {
  assert.equal(
    await verifier().verify(
      await token(claims(), {
        alg: "RS256",
        kid: "fixture",
        jku: "https://evil.example",
      }),
    ),
    false,
  );
  assert.equal(
    await verifier().verify(
      await token(claims(), { alg: "RS256", kid: "unknown" }),
    ),
    false,
  );
});
for (const [name, response] of Object.entries({
  redirect: () =>
    new Response("secret", {
      status: 302,
      headers: { location: "https://evil.example" },
    }),
  error: () => new Response("secret", { status: 500 }),
  html: () =>
    new Response("not json", { headers: { "content-type": "text/html" } }),
  invalid: () => Response.json({ keys: ["invalid"] }),
  duplicate: () => Response.json({ keys: [jwk, jwk] }),
  excessive: () =>
    new Response("a".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
  length: () =>
    new Response('{"keys":[]}', {
      headers: { "content-type": "application/json", "content-length": "999" },
    }),
  thrown: () => {
    throw new Error("secret");
  },
}))
  test(`JWKS fail-closed ${name}`, async () =>
    assert.equal(await verifier(response).verify(await token()), false));
test("unavailable JWKS timeout fails closed and cancels stream", async () => {
  let cancelled = false;
  const h = verifier(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  );
  assert.equal(await h.verify(await token()), false);
  assert.equal(cancelled, true);
});
