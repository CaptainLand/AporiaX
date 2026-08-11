import assert from "node:assert/strict";
import {
  APORIAX_DEMO_ACCOUNT,
  authenticateDemoAccount,
  createLocalAccountProfile,
  validateLocalRegistration,
} from "../src/account/local-account-model.js";

assert.equal(authenticateDemoAccount("landx", "111111"), true);
assert.equal(authenticateDemoAccount("LandX", "111111"), true);
assert.equal(authenticateDemoAccount("landx", "wrong"), false);
assert.equal(validateLocalRegistration({ username: "new_user", password: "123456", confirmPassword: "123456" }), "");
assert.equal(validateLocalRegistration({ username: "x", password: "123456", confirmPassword: "123456" }), "username");
assert.equal(validateLocalRegistration({ username: "valid", password: "123", confirmPassword: "123" }), "password");
assert.equal(validateLocalRegistration({ username: "valid", password: "123456", confirmPassword: "654321" }), "confirm");

const profile = createLocalAccountProfile(APORIAX_DEMO_ACCOUNT);
assert.equal(profile.username, "landx");
assert.equal(profile.displayName, "Landx");
assert.equal(profile.localPrototype, true);
assert(!Object.hasOwn(profile, "password"), "the local session must never persist a password");

console.log("local account UI smoke: PASS");
