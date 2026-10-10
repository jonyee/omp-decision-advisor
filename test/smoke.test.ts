import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import { AzureDecisionClient, DecisionError } from "../src/decision.js";
import type { DecisionDependencies } from "../src/decision.js";
import type { DecisionOptions } from "../src/types.js";

const defaults: DecisionOptions = { endpoint: "https://example.invalid", deployment: "synthetic-decision", passThreshold: 1, timeoutMs: 1_000, credentialMode: "azure-cli" };
const credential = { getToken: async () => ({ token: "isolated-smoke-token" }) };
function answer(choice: "match" | "mismatch", probability = 0.9, confidence = 0.8) {
  return { type: "choice", choice, probabilities: { match: choice === "match" ? probability : 1 - probability, mismatch: choice === "mismatch" ? probability : 1 - probability }, confidence };
}
function payload() {
  return { answers: { matching: answer("match"), mismatching: answer("mismatch") } };
}
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
async function local(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>, run: (endpoint: string) => Promise<void>) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
function client(endpoint: string, options: Partial<DecisionOptions> = {}, dependencies: DecisionDependencies = {}) {
  return new AzureDecisionClient({ ...defaults, ...options, endpoint }, { credential, allowTestLoopback: true, ...dependencies });
}
function rejectsCode(code: string) {
  return (error: unknown) => error instanceof DecisionError && error.code === code;
}

test("smoke completes with only one charged inference", async () => {
  let requests = 0;
  await local((_request, response) => {
    requests++;
    json(response, payload());
  }, async endpoint => {
    assert.equal((await client(endpoint).smokeTest()).passed, true);
  });
  assert.equal(requests, 1);
});

for (const failed of ["matching", "mismatching"] as const) {
  test(`reachable service with wrong ${failed} classification reports failed smoke`, async () => {
    const value = payload();
    if (failed !== "mismatching") value.answers.matching = answer("mismatch");
    if (failed !== "matching") value.answers.mismatching = answer("match");
    await local((_request, response) => json(response, value), async endpoint => {
      const result = await client(endpoint).smokeTest();
      assert.equal(result.passed, false);
    });
  });
}

test("smoke has no primary pass or confidence threshold and accepts normalized ties", async () => {
  const value = { answers: { matching: answer("match", 0.5, 0), mismatching: answer("mismatch", 0.5, 1) } };
  await local((_request, response) => json(response, value), async endpoint => {
    for (const passThreshold of [0.5, 1]) {
      const result = await client(endpoint, { passThreshold }).smokeTest();
      assert.equal(result.passed, true);
    }
  });
});

test("smoke accepts ordinary rounded probability sums within the shared tolerance", async () => {
  const value = payload();
  value.answers.matching.probabilities = { match: 0.9, mismatch: 0.0999 };
  await local((_request, response) => json(response, value), async endpoint => {
    assert.equal((await client(endpoint).smokeTest()).passed, true);
  });
});

const malformed: Array<[string, (value: ReturnType<typeof payload>) => void]> = [
  ["missing matching check", value => { Reflect.deleteProperty(value.answers, "matching"); }],
  ["missing mismatching check", value => { Reflect.deleteProperty(value.answers, "mismatching"); }],
  ["null answer", value => { Object.assign(value.answers, { matching: null }); }],
  ["array answer", value => { Object.assign(value.answers, { matching: [] }); }],
  ["wrong answer type", value => { value.answers.matching.type = "bool"; }],
  ["missing answer type", value => { Reflect.deleteProperty(value.answers.matching, "type"); }],
  ["unsupported label", value => { Object.assign(value.answers.matching, { choice: "pass" }); }],
  ["numeric choice", value => { Object.assign(value.answers.matching, { choice: 1 }); }],
  ["null choice", value => { Object.assign(value.answers.matching, { choice: null }); }],
  ["missing choice", value => { Reflect.deleteProperty(value.answers.matching, "choice"); }],
  ["missing distribution", value => { Reflect.deleteProperty(value.answers.matching, "probabilities"); }],
  ["array distribution", value => { Object.assign(value.answers.matching, { probabilities: [0.9, 0.1] }); }],
  ["missing probability", value => { Reflect.deleteProperty(value.answers.matching.probabilities, "mismatch"); }],
  ["extra probability", value => { Object.assign(value.answers.matching.probabilities, { other: 0 }); }],
  ["negative probability", value => { value.answers.matching.probabilities.mismatch = -0.1; }],
  ["probability above one", value => { value.answers.matching.probabilities.match = 1.1; }],
  ["nonnumeric probability", value => { Object.assign(value.answers.matching.probabilities, { match: "0.9" }); }],
  ["null probability", value => { Object.assign(value.answers.matching.probabilities, { match: null }); }],
  ["unnormalized distribution", value => { value.answers.matching.probabilities = { match: 0.7, mismatch: 0.1 }; }],
  ["choice contradicts maximum", value => { value.answers.matching.choice = "mismatch"; }],
  ["missing confidence", value => { Reflect.deleteProperty(value.answers.matching, "confidence"); }],
  ["negative confidence", value => { value.answers.matching.confidence = -0.1; }],
  ["confidence above one", value => { value.answers.matching.confidence = 1.1; }],
  ["string confidence", value => { Object.assign(value.answers.matching, { confidence: "0.8" }); }],
  ["null confidence", value => { Object.assign(value.answers.matching, { confidence: null }); }],
];
for (const [name, mutate] of malformed) {
  test(`smoke rejects ${name} rather than returning a partial success`, async () => {
    const value = payload();
    mutate(value);
    await local((_request, response) => json(response, value), async endpoint => {
      await assert.rejects(client(endpoint).smokeTest(), rejectsCode("response"));
    });
  });
}
for (const value of [null, [], {}, { answers: null }, { answers: [] }]) {
  test(`smoke rejects incomplete response ${JSON.stringify(value)}`, async () => {
    await local((_request, response) => json(response, value), async endpoint => {
      await assert.rejects(client(endpoint).smokeTest(), rejectsCode("response"));
    });
  });
}
for (const field of ["probability", "confidence"]) {
  test(`smoke rejects nonfinite JSON ${field}`, async () => {
    await local((_request, response) => {
      const value = payload();
      if (field === "probability") value.answers.matching.probabilities.match = 123;
      else value.answers.matching.confidence = 123;
      response.end(JSON.stringify(value).replace("123", "1e309"));
    }, async endpoint => {
      await assert.rejects(client(endpoint).smokeTest(), rejectsCode("response"));
    });
  });
}

test("smoke errors redact upstream bodies, identity failures and network errors", async () => {
  const marker = "private-account-marker isolated-smoke-token";
  for (const status of [200, 401, 429, 500]) {
    await local((_request, response) => { response.writeHead(status); response.end(marker); }, async endpoint => {
      await assert.rejects(client(endpoint).smokeTest(), (error: unknown) => {
        assert.ok(error instanceof DecisionError);
        assert.equal(error.code, status === 200 ? "response" : "http");
        assert.equal(error.message.includes(marker), false);
        assert.equal(error.message.includes(endpoint), false);
        return true;
      });
    });
  }
  for (const dependencies of [
    { credential: { getToken: async () => { throw new Error(marker); } } },
    { credential: { getToken: async () => null } },
    { credential, fetch: async () => { throw new Error(marker); } },
  ]) {
    await assert.rejects(new AzureDecisionClient(defaults, dependencies).smokeTest(), (error: unknown) => {
      assert.ok(error instanceof DecisionError);
      assert.ok(error.code === "authentication" || error.code === "network");
      assert.equal(error.message.includes("private-account-marker"), false);
      assert.equal(error.message.includes("isolated-smoke-token"), false);
      return true;
    });
  }
});

test("smoke never follows redirects carrying bearer credentials", async () => {
  let targetRequests = 0;
  await local((_request, response) => { targetRequests++; json(response, payload()); }, async target => {
    await local((_request, response) => { response.writeHead(307, { Location: target }); response.end(); }, async endpoint => {
      await assert.rejects(client(endpoint).smokeTest(), rejectsCode("network"));
    });
  });
  assert.equal(targetRequests, 0);
});

test("pre-aborted smoke acquires no credential and makes no inference", async () => {
  let tokenCalls = 0;
  let requests = 0;
  const controller = new AbortController();
  controller.abort();
  await local((_request, response) => { requests++; json(response, payload()); }, async endpoint => {
    await assert.rejects(client(endpoint, {}, { credential: { getToken: async () => { tokenCalls++; return { token: "isolated-smoke-token" }; } } }).smokeTest(controller.signal), rejectsCode("cancelled"));
  });
  assert.equal(tokenCalls, 0);
  assert.equal(requests, 0);
});

for (const interruption of ["timeout", "cancelled"] as const) {
  test(`smoke ${interruption} during authentication cannot send a late inference`, async () => {
    let resolveToken!: (token: { token: string }) => void;
    let authenticationStarted!: () => void;
    const started = new Promise<void>(resolve => { authenticationStarted = resolve; });
    let requests = 0;
    await local((_request, response) => { requests++; json(response, payload()); }, async endpoint => {
      const controller = new AbortController();
      const instance = client(endpoint, { timeoutMs: 100 }, { credential: { getToken: () => {
        authenticationStarted();
        return new Promise(resolve => { resolveToken = resolve; });
      } } });
      const pending = instance.smokeTest(controller.signal);
      await started;
      if (interruption === "cancelled") controller.abort();
      await assert.rejects(pending, rejectsCode(interruption));
      resolveToken({ token: "isolated-smoke-token" });
      await new Promise(resolve => setImmediate(resolve));
    });
    assert.equal(requests, 0);
  });
}

for (const stage of ["headers", "body"] as const) {
  for (const interruption of ["timeout", "cancelled"] as const) {
    test(`smoke ${interruption} while waiting for response ${stage}`, async () => {
      let requestArrived!: () => void;
      const arrived = new Promise<void>(resolve => { requestArrived = resolve; });
      await local((_request, response) => {
        if (stage === "body") {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.write('{"answers":');
        }
        requestArrived();
      }, async endpoint => {
        const controller = new AbortController();
        const pending = client(endpoint, { timeoutMs: interruption === "timeout" ? 100 : 1_000 }).smokeTest(controller.signal);
        await arrived;
        if (interruption === "cancelled") controller.abort();
        await assert.rejects(pending, rejectsCode(interruption));
      });
    });
  }
}
