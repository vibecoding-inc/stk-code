import test from "node:test";
import assert from "node:assert/strict";
import { sign_jwt, verify_jwt } from "../../worker/jwt.mjs";

const TEST_SECRET = "super-secret-jwt-key-for-unit-tests-1234";

test("sign_jwt and verify_jwt round-trip a valid HS256 JWT", async () => {
  let token = await sign_jwt(
    {sub: "12345", scope_type: "guild", scope_id: "999"},
    TEST_SECRET,
    {ttl_seconds: 600, now_seconds: 1000}
  );
  assert.equal(token.split(".").length, 3);

  let claims = await verify_jwt(token, TEST_SECRET, {now_seconds: 1200});
  assert.ok(claims);
  assert.equal(claims.sub, "12345");
  assert.equal(claims.scope_type, "guild");
  assert.equal(claims.scope_id, "999");
  assert.equal(claims.iat, 1000);
  assert.equal(claims.exp, 1600);
});

test("verify_jwt rejects expired tokens", async () => {
  let token = await sign_jwt({sub: "123"}, TEST_SECRET, {ttl_seconds: 60, now_seconds: 1000});
  let claims = await verify_jwt(token, TEST_SECRET, {now_seconds: 1060});
  assert.equal(claims, null);
});

test("verify_jwt rejects tampered payload or wrong secret", async () => {
  let token = await sign_jwt({sub: "123"}, TEST_SECRET, {ttl_seconds: 600, now_seconds: 1000});
  let parts = token.split(".");
  let tampered = `${parts[0]}.${parts[1].slice(0, -1)}A.${parts[2]}`;
  assert.equal(await verify_jwt(tampered, TEST_SECRET, {now_seconds: 1100}), null);
  assert.equal(await verify_jwt(token, "wrong-secret-key-that-is-long-enough", {now_seconds: 1100}), null);
});
