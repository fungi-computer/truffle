import { decodeJwt, UnsecuredJWT } from "jose";
import { expect, it } from "vitest";
import { readOpenAIPerson } from "../src/private-openai-claims.js";

it("an unexpected decoder fault is not mistaken for a malformed token", () => {
  const fault = new Error("fixture decoder fault");
  const failing: typeof decodeJwt = () => {
    throw fault;
  };
  expect(() => readOpenAIPerson("fixture-token", failing)).toThrow(fault);
});

it("a person without a subject reports claim names only, never claim values", () => {
  const values = {
    iss: "https://fixture-issuer.example.test",
    email: "fixture-person@example.test",
    elsewhere: "fixture-account-elsewhere",
    salt: "fixture-user-salt-value",
  };
  const access = new UnsecuredJWT({
    iss: values.iss,
    email: values.email,
    chatgpt_account_id: values.elsewhere,
    "https://api.openai.com/auth": { per_user_salt: values.salt },
  }).encode();
  const read = readOpenAIPerson(access);
  expect(read).toEqual({
    kind: "unproven",
    detail: {
      claim: "access_token.sub",
      problem: "absent",
      claimNames: [
        "iss",
        "email",
        "chatgpt_account_id",
        "https://api.openai.com/auth",
      ],
      authClaimNames: ["per_user_salt"],
    },
  });
  const serialized = JSON.stringify(read);
  for (const value of [...Object.values(values), access])
    expect(serialized.includes(value)).toBe(false);
});

it("claim names are bounded in count and length", () => {
  const claims = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      "x".repeat(80) + String(index),
      1,
    ]),
  );
  const read = readOpenAIPerson(new UnsecuredJWT(claims).encode());
  if (read.kind !== "unproven") throw new Error("Unexpected person");
  expect(read.detail.claimNames).toHaveLength(32);
  expect(read.detail.claimNames.every((name) => name.length <= 64)).toBe(true);
});

it("issuer and subject identify the person", () => {
  const access = new UnsecuredJWT({
    iss: "https://auth.openai.com",
    sub: "fixture-person",
  }).encode();
  expect(readOpenAIPerson(access)).toEqual({
    kind: "person",
    iss: "https://auth.openai.com",
    sub: "fixture-person",
  });
});
