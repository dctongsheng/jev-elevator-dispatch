import assert from "node:assert/strict";
import { test } from "node:test";
import { requestEvidence } from "../src/lib/jev/requestEvidence";
import { interpretRequest, type RequestModelInput } from "../src/lib/jev/interpretRequest";

test("direct evidence respects negation, ordinary staff, and equipment capacity", () => {
  assert.deepEqual(requestEvidence("resident going to pharmacy"), { priority: "routine", load: "walking", exclusive: false, people: 1 });
  assert.equal(requestEvidence("patient transfer, not an emergency").priority, "urgent");
  assert.equal(requestEvidence("patient cardiac arrest, no bed").priority, "stat");
  assert.equal(requestEvidence("patient cardiac arrest, no bed").load, undefined);
  assert.equal(requestEvidence("no trauma, nurse going to break").priority, "routine");
  assert.equal(requestEvidence("stroke ruled out, patient transfer to ward").priority, "urgent");
  assert.equal(requestEvidence("wheelchair training").load, undefined);
  assert.equal(requestEvidence("linen for the bed").load, undefined);
  assert.deepEqual(requestEvidence("empty bed return"), { priority: "routine", load: "bed", exclusive: true, exclusiveReason: "load" });
  assert.equal(requestEvidence("family of 4 going upstairs").people, 4);
  assert.equal(requestEvidence("meal cart delivery").exclusive, false);
  assert.equal(requestEvidence("visitor looking for a patient room").priority, "visitor");
  assert.equal(requestEvidence("a couple visiting a patient").priority, "visitor");
  assert.equal(requestEvidence("Facilities staff returning an empty hospital bed. No patient aboard.").priority, "routine");
  assert.equal(requestEvidence("The trauma transfer was cancelled; a receptionist is walking back.").priority, "routine");
  assert.equal(requestEvidence("Technician walking to repair a wheelchair, carrying only a screwdriver.").load, "walking");
  assert.equal(requestEvidence("droplet precautions pt to imaging, w/c").load, "wheelchair");
});

test("model adapter validates, guards, deduplicates, caches, and cancels unused calls", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  let upstreamAborts = 0;
  let malformed = false;
  let strong = false;
  let lastModelInput: RequestModelInput | undefined;
  globalThis.fetch = async (_url, init) => {
    requests++;
    assert.ok(!String(init?.body).includes("Floor 4: ICU"), "floor labels must not contaminate classification");
    const payload = JSON.parse(String(init?.body));
    lastModelInput = { state: payload.state, questions: payload.questions };
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 30);
      const cancel = () => { upstreamAborts++; clearTimeout(timer); reject(signal?.reason); };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
    return Response.json({
      model: "test-model",
      usage: { input_tokens: 100 },
      answers: {
        priority: { choice: malformed ? "invalid" : strong ? "routine" : "urgent", confidence: strong ? 0.9 : 0.2, probabilities: strong ? { stat: 0.02, urgent: 0.02, routine: 0.94, visitor: 0.02 } : { stat: 0.2, urgent: 0.4, routine: 0.3, visitor: 0.1 } },
        load: { choice: strong ? "walking" : "bed", confidence: strong ? 0.9 : 0.1, probabilities: strong ? { bed: 0.02, wheelchair: 0.02, cart: 0.02, walking: 0.94 } : { bed: 0.4, wheelchair: 0.2, cart: 0.1, walking: 0.3 } },
        exclusive_car: { noul: 0.6 },
      },
    });
  };
  try {
    const req = { from: 1, to: 4, note: "resident going to pharmacy after lunch" };
    const guarded = await interpretRequest(req);
    assert.equal(guarded.priority, "routine");
    assert.equal(guarded.load, "walking");
    assert.equal(guarded.exclusiveCar, 0);
    assert.equal(guarded.raw?.priority, "urgent");
    assert.equal(guarded.source, "model+guardrails");
    assert.equal(guarded.cache, "miss");
    assert.deepEqual(guarded.modelInput, lastModelInput, "trace contains the actual model state and questions");
    assert.deepEqual(Object.keys(guarded.modelInput!).sort(), ["questions", "state"], "trace does not expose transport configuration");
    assert.deepEqual(Object.keys(guarded.modelInput!.state), ["note"], "floors and scoring truth are not model input");
    const cached = await interpretRequest({ ...req, from: 2, to: 9 });
    assert.equal(cached.cache, "hit");
    assert.equal(cached.inputTokens, 0);
    assert.deepEqual(cached.modelInput, guarded.modelInput, "cached responses retain the original model input");
    assert.equal(cached.modelLatencyMs, guarded.modelLatencyMs, "cached responses retain cold-call model latency");
    cached.modelInput!.state.note = "client changed its own copy";
    const cachedAgain = await interpretRequest(req);
    assert.equal(cachedAgain.modelInput!.state.note, req.note, "client inspection cannot mutate stored trace provenance");
    assert.equal(requests, 1, "note-only semantics permits reuse across floor pairs");

    const controller = new AbortController();
    const sharedReq = { ...req, note: "nurse heading to cafeteria after lunch" };
    const first = interpretRequest(sharedReq, { signal: controller.signal });
    const surviving = interpretRequest(sharedReq);
    const abortAssertion = assert.rejects(first);
    controller.abort();
    await abortAssertion;
    const shared = await surviving;
    assert.equal(shared.cache, "shared");
    assert.deepEqual(shared.modelInput, lastModelInput, "shared subscribers see the actual original model input");
    assert.equal(requests, 2);
    assert.equal(upstreamAborts, 0, "one subscriber must not cancel another's request");

    const cancelled = new AbortController();
    const only = interpretRequest({ ...req, note: "staff going to break room before noon" }, { signal: cancelled.signal });
    const onlyAssertion = assert.rejects(only);
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancelled.abort();
    await onlyAssertion;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(upstreamAborts, 1, "the last subscriber cancels upstream inference");

    const queuedAbort = new AbortController();
    const beforeQueue = requests;
    const occupied = ["queue slot one", "queue slot two"].map((note) => interpretRequest({ ...req, note }));
    const queued = interpretRequest({ ...req, note: "cancelled queue entry" }, { signal: queuedAbort.signal });
    const queuedAssertion = assert.rejects(queued);
    queuedAbort.abort();
    await queuedAssertion;
    await Promise.all(occupied);
    assert.equal(requests - beforeQueue, 2, "cancelled queued calls must never reach the model");
    assert.equal(upstreamAborts, 1, "queue cancellation must not touch active calls");

    strong = true;
    const contextual = await interpretRequest({ ...req, note: "Discussing a patient trauma case while walking to lunch" });
    assert.equal(contextual.priority, "routine", "a clear model result outranks generic keyword evidence");
    assert.equal(contextual.load, "walking");
    assert.equal(contextual.exclusiveCar, 0, "stale lexical emergency evidence must not reserve a car");

    const normalized = await interpretRequest({ ...req, note: "w/c patient going for a scheduled check" });
    assert.equal(normalized.modelInput!.state.note, "wheelchair patient going for a scheduled check");
    assert.deepEqual(normalized.modelInput, lastModelInput, "displayed normalization exactly matches the outbound request");

    malformed = true;
    await assert.rejects(interpretRequest({ ...req, note: "an unfamiliar trip" }), /invalid choice/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
