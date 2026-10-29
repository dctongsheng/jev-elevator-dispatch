import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { RequestInterpretation } from "../src/lib/jev/interpretRequest";
import { Column } from "../src/lib/sim/engine";
import type { Arrival } from "../src/lib/sim/types";

const arrival = (id: number, note: string, from = 7, to = 1): Arrival => ({
  id, note, at: 0, from, to, truth: { priority: "routine", load: "walking", units: 1 },
});
const reading = (overrides: Partial<RequestInterpretation> = {}): RequestInterpretation => ({
  priority: "routine", priorityConfidence: .9,
  priorityProbabilities: { routine: .9, stat: .03, urgent: .04, visitor: .03 },
  load: "walking", loadConfidence: .9,
  loadProbabilities: { walking: .9, bed: .03, wheelchair: .03, cart: .04 },
  exclusiveCar: 0, latencyMs: 400, inputTokens: 20, model: "trace-test-model",
  ...overrides,
});
function deferred() {
  let resolve!: (r: RequestInterpretation) => void;
  const promise = new Promise<RequestInterpretation>((yes) => { resolve = yes; });
  return { promise, resolve };
}

test("candidate trace records the actual winning minimum and survives subsequent car movement", () => {
  const column = new Column("jev");
  column.addArrival(arrival(1, "staff heading to break room"));
  column.step(.25);
  const p = column.passengers.get(1)!;
  const entry = p.trace!.assignments[0];
  assert.equal(entry.car, p.car);
  assert.equal(entry.car, 2, "the existing stable tie-break chooses C over D");
  assert.deepEqual(entry.candidates.map((c) => c.score?.eta), [12, 12, 4, 4]);
  assert.equal(entry.candidates.filter((c) => c.selected).length, 1);
  assert.equal(entry.candidates.find((c) => c.selected)?.score?.total,
    Math.min(...entry.candidates.filter((c) => c.eligible).map((c) => c.score!.total)));
  const snapshot = JSON.stringify(entry);
  column.step(1);
  p.profile!.tags.push("later annotation");
  assert.equal(JSON.stringify(entry), snapshot, "trace must not retain mutable live profile or car references");
  assert.ok(!p.trace!.initialProfile.tags.includes("later annotation"));
});

test("unavailable cars retain their actual rejection reasons without appending every tick", () => {
  const column = new Column("jev");
  column.addArrival(arrival(2, "staff heading downstairs", 0, 8));
  const other = column.passengers.get(2)!;
  other.car = 3;
  column.cars[3].assigned = [2];
  column.cars[0].exclusiveFor = 999;
  column.cars[1].avoided = true;
  column.cars[2].reservedFloor = 1;
  column.addArrival(arrival(1, "stable patient on bed", 8));
  for (let i = 0; i < 8; i++) column.step(.25);
  const trace = column.passengers.get(1)!.trace!;
  assert.equal(trace.assignments.length, 1);
  const entry = trace.assignments[0];
  assert.equal(entry.car, null);
  assert.deepEqual(entry.candidates.map((c) => c.rejection), [
    "exclusive_car", "faulty_for_priority", "reserved_for_emergency", "exclusive_trip_conflict",
  ]);
  assert.ok(entry.candidates.every((c) => !c.eligible && !c.selected && c.score === undefined));
});

test("late model trace separates proposed constraints from the profile that actually remained in use", async () => {
  const pending = deferred();
  const column = new Column("jev", () => pending.promise);
  column.addArrival(arrival(1, "staff heading upstairs", 1, 8));
  assert.equal(column.passengers.get(1)!.trace?.modelStatus, "pending");
  column.step(.25);
  const p = column.passengers.get(1)!;
  assert.equal(p.status, "riding");
  pending.resolve(reading({ priority: "stat", load: "bed", exclusiveCar: 1 }));
  await setImmediate();
  const trace = p.trace!;
  assert.equal(trace.modelStatus, "success");
  assert.equal(trace.modelCompletedAt, .25);
  assert.equal(trace.modelAppliedBeforePickup, false);
  assert.equal(trace.modelProfile?.units, 10);
  assert.equal(trace.profileAfterModel?.units, 1);
  assert.equal(trace.profileAfterModel?.exclusive, false);
  assert.equal(trace.assignments[0].basis, "provisional");
  assert.equal(trace.events[0].kind, "pickup");
});

test("pre-pickup model changes preserve original assignment evidence and record the actual reroute", async () => {
  const pending = deferred();
  const column = new Column("jev", (a) => a.id === 1 ? pending.promise : new Promise(() => {}));
  for (const car of column.cars.slice(1)) car.doorTimer = 1000;
  column.addArrival(arrival(1, "transport requested", 8));
  column.addArrival(arrival(2, "staff heading upstairs", 8, 9));
  column.step(.25);
  const p = column.passengers.get(1)!;
  assert.equal(p.car, 0);
  pending.resolve(reading({ load: "bed", exclusiveCar: 1 }));
  await setImmediate();
  assert.equal(p.car, undefined);
  const trace = p.trace!;
  assert.equal(trace.modelAppliedBeforePickup, true);
  assert.equal(trace.profileBeforeModel?.units, 1);
  assert.equal(trace.profileAfterModel?.units, 10);
  assert.equal(trace.assignments[0].profile.units, 1);
  assert.equal(trace.events[0].kind, "reroute");
  assert.equal(trace.events[0].car, 0);
  column.step(.25);
  assert.equal(trace.assignments[1].basis, "model");
  assert.equal(trace.assignments[1].car, p.car);
  assert.equal(trace.assignments[1].candidates[0].rejection, "exclusive_trip_conflict");
});

test("fallback is explicit and never appears as a successful model judgment", async () => {
  const column = new Column("jev", async () => { throw new Error("offline"); });
  column.addArrival(arrival(1, "staff heading upstairs"));
  await setImmediate();
  column.step(.25);
  const p = column.passengers.get(1)!;
  assert.equal(p.interp, undefined);
  assert.equal(p.trace?.modelStatus, "fallback");
  assert.equal(p.trace?.modelAppliedBeforePickup, false);
  assert.equal(p.trace?.modelProfile, undefined);
  assert.equal(p.trace?.assignments[0].basis, "fallback");
});
