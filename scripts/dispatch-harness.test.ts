import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { RequestInterpretation } from "../src/lib/jev/interpretRequest";
import type { EventInterpretation } from "../src/lib/jev/interpretEvent";
import { Column } from "../src/lib/sim/engine";
import type { Arrival } from "../src/lib/sim/types";

const arrival = (id: number, note: string, from = 1, to = 5): Arrival => ({
  id, at: 0, note, from, to,
  truth: { priority: "routine", load: "walking", units: 1 },
});
const interpretation = (overrides: Partial<RequestInterpretation> = {}): RequestInterpretation => ({
  priority: "routine", priorityConfidence: 1,
  priorityProbabilities: { stat: 0, urgent: 0, routine: 1, visitor: 0 },
  load: "walking", loadConfidence: 1,
  loadProbabilities: { bed: 0, cart: 0, wheelchair: 0, walking: 1 },
  exclusiveCar: 0, latencyMs: 800, inputTokens: 20, model: "test-model",
  ...overrides,
});
function deferred() {
  let resolve!: (i: RequestInterpretation) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<RequestInterpretation>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("slow inference never blocks pickup and late results cannot change an onboard profile", async () => {
  const d = deferred();
  const c = new Column("jev", () => d.promise);
  c.addArrival(arrival(1, "staff heading to break room"));
  c.step(0.25);
  const p = c.passengers.get(1)!;
  assert.equal(p.status, "riding");
  assert.equal(p.pickedAt, 0.25);
  d.resolve(interpretation({ priority: "stat", load: "bed", exclusiveCar: 1 }));
  await setImmediate();
  assert.equal(p.profile?.priority, "routine");
  assert.equal(p.profile?.units, 1);
  assert.equal(c.cars[p.car!].exclusiveFor, undefined);
  assert.equal(c.metrics().lateInterpretations, 1);
  assert.equal(c.pendingInterps, 0);
});

test("an unavailable interpreter retains explicit emergency and bed evidence", async () => {
  const c = new Column("jev", () => Promise.reject(new Error("offline")));
  c.addArrival({ ...arrival(1, "trauma patient on stretcher", 9), truth: { priority: "stat", load: "bed", units: 10 } });
  await setImmediate();
  assert.equal(c.passengers.get(1)?.profile?.priority, "stat");
  assert.equal(c.passengers.get(1)?.profile?.units, 10);
  c.step(0.25);
  assert.equal(c.passengers.get(1)?.status, "riding");
  assert.equal(c.metrics().fallbacks, 1);
});

test("synchronous adapter failure is contained and leaves service running", async () => {
  const c = new Column("jev", () => { throw new Error("adapter unavailable"); });
  assert.doesNotThrow(() => c.addArrival(arrival(1, "routine trip")));
  c.step(0.25);
  await setImmediate();
  assert.equal(c.passengers.get(1)?.status, "riding");
  assert.equal(c.pendingInterps, 0);
  assert.equal(c.fallbacks, 1);
});

test("a bed refinement detaches an incompatible shared assignment before boarding", async () => {
  const d = deferred();
  const c = new Column("jev", (a) => a.id === 1 ? d.promise : new Promise(() => {}));
  for (const car of c.cars.slice(1)) car.doorTimer = 1000;
  c.addArrival(arrival(1, "transport requested", 8, 1));
  c.addArrival(arrival(2, "staff heading upstairs", 8, 9));
  c.step(0.25);
  assert.equal(c.passengers.get(1)?.car, 0);
  assert.equal(c.passengers.get(2)?.car, 0);
  d.resolve(interpretation({ load: "bed", exclusiveCar: 1 }));
  await setImmediate();
  assert.equal(c.passengers.get(1)?.car, undefined);
  assert.deepEqual(c.cars[0].assigned, [2]);
  assert.equal(c.cars[0].exclusiveFor, undefined);
  assert.equal(c.refinedBeforePickup, 1);
  assert.equal(c.changedBeforePickup, 1);
});

test("unchanged model confirmations are not counted as model changes", async () => {
  const c = new Column("jev", async () => interpretation());
  c.addArrival(arrival(1, "staff heading upstairs", 8, 9));
  await setImmediate();
  assert.equal(c.refinedBeforePickup, 1);
  assert.equal(c.changedBeforePickup, 0);
});

test("a model correction releases a provisional dedicated car inferred from an equipment keyword", async () => {
  const d = deferred();
  const c = new Column("jev", () => d.promise);
  c.addArrival(arrival(1, "staff heading to discuss bed availability", 8, 9));
  c.step(0.25);
  const p = c.passengers.get(1)!;
  assert.equal(p.profile?.exclusive, true);
  const assignedCar = p.car!;
  assert.equal(c.cars[assignedCar].exclusiveFor, 1);
  d.resolve(interpretation());
  await setImmediate();
  assert.equal(p.profile?.exclusive, false);
  assert.equal(p.profile?.units, 1);
  assert.equal(p.car, assignedCar);
  assert.equal(c.cars[assignedCar].exclusiveFor, undefined);
  assert.equal(c.changedBeforePickup, 1);
});

test("exclusive pickup planned on an occupied car occurs only after its riders leave", () => {
  const c = new Column("jev");
  c.addArrival(arrival(1, "staff heading upstairs", 1, 7));
  c.step(0.25);
  const first = c.passengers.get(1)!;
  assert.equal(first.car, 0);
  for (const car of c.cars.slice(1)) car.doorTimer = 1000;
  c.addArrival({ ...arrival(2, "patient on bed", 3, 8), at: c.now, truth: { priority: "urgent", load: "bed", units: 10 } });
  c.step(0.25);
  const bed = c.passengers.get(2)!;
  assert.equal(bed.car, 0);
  assert.equal(c.cars[0].exclusiveFor, 2);
  while (c.now < 90 && bed.status !== "done") {
    c.step(0.25);
    assert.ok(!(c.cars[0].riders.includes(1) && c.cars[0].riders.includes(2)));
  }
  assert.equal(bed.status, "done");
  assert.ok(bed.pickedAt! >= first.droppedAt!);
  assert.equal(c.wastedTrips, 0);
});

test("unused advance reservations expire instead of permanently consuming a car", () => {
  const c = new Column("jev");
  c.applyPolicy({ type: "priority_transport", floor: 1 } as EventInterpretation, "emergency incoming");
  assert.ok(c.cars.some((car) => car.reservedFloor === 1));
  c.step(91);
  assert.ok(c.cars.every((car) => car.reservedFloor === undefined && car.reservedUntil === undefined));
});

test("a reported fault reroutes unboarded critical passengers but never moves onboard riders", () => {
  const c = new Column("jev");
  for (const car of c.cars) car.pos = 0;
  c.addArrival(arrival(1, "trauma patient on stretcher", 9, 1));
  c.step(0.25);
  const p = c.passengers.get(1)!;
  assert.equal(p.car, 0);
  const fault = { type: "car_fault", car: 0 } as EventInterpretation;
  c.applyPhysicalEvent(fault);
  c.applyPolicy(fault, "Car A has sticking doors");
  assert.equal(p.car, undefined);
  assert.equal(c.cars[0].exclusiveFor, undefined);
  c.step(0.25);
  assert.notEqual(p.car, 0);

  const onboard = new Column("jev");
  onboard.addArrival(arrival(1, "trauma patient on stretcher"));
  onboard.step(0.25);
  assert.equal(onboard.passengers.get(1)?.status, "riding");
  onboard.applyPhysicalEvent(fault);
  onboard.applyPolicy(fault, "Car A has sticking doors");
  assert.equal(onboard.passengers.get(1)?.car, 0);
  assert.deepEqual(onboard.cars[0].riders, [1]);
});

test("request classification and initial assignment do not consult hidden truth", () => {
  const a = new Column("jev");
  const b = new Column("jev");
  for (const c of [a, b]) for (const car of c.cars) car.pos = 0;
  a.addArrival(arrival(1, "transport requested", 9, 1));
  b.addArrival({ ...arrival(1, "transport requested", 9, 1), truth: { priority: "stat", load: "bed", units: 10 } });
  a.step(0.25);
  b.step(0.25);
  assert.deepEqual(a.passengers.get(1)?.profile, b.passengers.get(1)?.profile);
  assert.equal(a.passengers.get(1)?.car, b.passengers.get(1)?.car);
  assert.deepEqual(a.cars, b.cars);
});
