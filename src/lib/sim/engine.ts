import type { EventInterpretation } from "../jev/interpretEvent";
import type { RequestInterpretation } from "../jev/interpretRequest";
import { BASELINE_PROFILE, profileFrom, provisionalProfile } from "./policy";
import {
  CAR_CAPACITY,
  CAR_SPEED,
  DOOR_DWELL,
  FAULT_DWELL,
  PRIORITY_WEIGHT,
  type Arrival,
  type AssignmentTrace,
  type Car,
  type Decision,
  type DispatchCandidateTrace,
  type DispatchRejection,
  type DispatchScore,
  type Mode,
  type Passenger,
  type Profile,
  type TraceEvent,
} from "./types";

export const CAR_COUNT = 4;
const CAR_LETTERS = "ABCD";
const EPS = 1e-6;
const MAX_LOG = 60;
const MAX_ASSIGNMENT_TRACE = 8;
const MAX_EVENT_TRACE = 12;
const copyProfile = (profile: Profile): Profile => ({ ...profile, tags: [...profile.tags] });

export const carName = (id: number) => `Car ${CAR_LETTERS[id]}`;

export type RequestInterpreter = (a: Arrival) => Promise<RequestInterpretation>;

// One dispatcher running its own copy of the building. All columns receive the
// same arrivals and the same physical events; only what they understand differs.
export class Column {
  readonly mode: Mode;
  now = 0;
  cars: Car[];
  passengers = new Map<number, Passenger>();
  log: Decision[] = [];
  wastedTrips = 0;
  interpLatencies: number[] = [];
  inputTokens = 0;
  pendingInterps = 0;
  interpreted = 0;
  fallbacks = 0;
  refinedBeforePickup = 0;
  changedBeforePickup = 0;
  lateInterpretations = 0;
  lastModel: string | null = null;
  private interpret?: RequestInterpreter;

  constructor(mode: Mode, interpret?: RequestInterpreter) {
    this.mode = mode;
    this.interpret = interpret;
    this.cars = Array.from({ length: CAR_COUNT }, (_, id) => ({
      id,
      pos: [1, 1, 5, 9][id] ?? 1,
      dir: 0,
      doorTimer: 0,
      riders: [],
      assigned: [],
      faulty: false,
      avoided: false,
    }));
  }

  get smart() {
    return this.mode !== "baseline";
  }

  // --- Inputs ---------------------------------------------------------------

  addArrival(a: Arrival) {
    const p: Passenger = {
      ...a,
      status: "waiting",
      wastedTrips: 0,
      profile: this.smart ? provisionalProfile(a.note) : BASELINE_PROFILE,
    };
    p.trace = {
      initialProfile: copyProfile(p.profile!),
      modelStatus: this.interpret ? "pending" : "not-requested",
      assignments: [],
      events: [],
    };
    this.passengers.set(p.id, p);
    if (!this.interpret) {
      return;
    }
    this.pendingInterps++;
    // Start interpreting without blocking assignment. Promise.resolve also
    // contains synchronous adapter failures, leaving provisional service intact.
    Promise.resolve().then(() => this.interpret!(a))
      .then((interp) => {
        p.interp = interp;
        this.interpreted++;
        this.lastModel = interp.model;
        this.interpLatencies.push(interp.latencyMs);
        this.inputTokens += interp.inputTokens;
        const profile = profileFrom(interp, p.note);
        if (p.trace) {
          p.trace.modelStatus = "success";
          p.trace.modelCompletedAt = this.now;
          p.trace.modelAppliedBeforePickup = p.status === "waiting";
          p.trace.profileBeforeModel = copyProfile(p.profile!);
          p.trace.modelProfile = copyProfile(profile);
        }
        if (p.status === "waiting") {
          this.refinedBeforePickup++;
          if (p.profile!.priority !== profile.priority || p.profile!.units !== profile.units || p.profile!.exclusive !== profile.exclusive) {
            this.changedBeforePickup++;
          }
          this.refineProfile(p, profile);
        } else {
          // Never retrofit a reservation or reassign someone already on board.
          this.lateInterpretations++;
        }
        if (p.trace) p.trace.profileAfterModel = copyProfile(p.profile!);
        this.push({
          kind: "interpret",
          text: `"${p.note}" → ${p.status === "waiting" ? "refined before pickup" : "read after pickup; no route change"}`,
          tags: profile.tags,
          latencyMs: interp.latencyMs,
        });
      })
      .catch(() => {
        // Timeouts do not erase explicit bed/emergency facts or stop the cars.
        this.fallbacks++;
        if (p.trace) {
          p.trace.modelStatus = "fallback";
          p.trace.modelCompletedAt = this.now;
          p.trace.modelAppliedBeforePickup = false;
          p.trace.profileBeforeModel = copyProfile(p.profile!);
        }
        if (p.status === "waiting") p.profile = { ...p.profile!, tags: [...p.profile!.tags, "model unavailable"] };
        if (p.trace) p.trace.profileAfterModel = copyProfile(p.profile!);
      })
      .finally(() => {
        this.pendingInterps--;
      });
  }

  private refineProfile(p: Passenger, profile: Profile) {
    p.profile = profile;
    if (p.car === undefined) return;
    const car = this.cars[p.car];
    const others = car.assigned.filter((id) => id !== p.id);
    const cannotServe = (car.avoided && (profile.priority === "stat" || profile.priority === "urgent" || profile.exclusive)) ||
      (profile.exclusive ? others.length > 0 : this.loadUnits(car) > CAR_CAPACITY);
    if (car.exclusiveFor === p.id) car.exclusiveFor = undefined;
    if (cannotServe) {
      car.assigned = others;
      p.car = undefined;
      this.traceEvent(p, { kind: "reroute", car: car.id, message: "模型更新后的容量或优先级约束与原分配不兼容，等待重新派梯" });
      return;
    }
    if (profile.exclusive) car.exclusiveFor = p.id;
  }

  // Physical consequences happen in every column, understood or not.
  applyPhysicalEvent(e: EventInterpretation) {
    if (e.type === "car_fault" && e.car !== null) this.cars[e.car].faulty = true;
  }

  // Policy response: only dispatchers that can read the event react to it.
  applyPolicy(e: EventInterpretation, text: string) {
    if (!this.smart) return;
    if (e.type === "car_fault" && e.car !== null) {
      const car = this.cars[e.car];
      car.avoided = true;
      car.reservedFloor = undefined;
      car.reservedUntil = undefined;
      for (const id of [...car.assigned]) {
        const p = this.passengers.get(id)!;
        const prof = p.profile!;
        if (prof.priority !== "stat" && prof.priority !== "urgent" && !prof.exclusive) continue;
        car.assigned = car.assigned.filter((assigned) => assigned !== id);
        if (car.exclusiveFor === id) car.exclusiveFor = undefined;
        p.car = undefined;
        this.traceEvent(p, { kind: "reroute", car: car.id, message: "收到故障报告，尚未上梯的紧急或专梯请求重新分配" });
        this.push({ kind: "bump", text: `Re-routed "${p.note}" off ${carName(car.id)} after a fault report` });
      }
      this.push({ kind: "event", text: `"${text}" → ${carName(e.car)} limited to routine traffic` });
    } else if (e.type === "priority_transport") {
      const floor = e.floor ?? 1;
      const car = this.nearestFreeCar(floor);
      if (car) {
        car.reservedFloor = floor;
        car.reservedUntil = this.now + 90;
        this.push({ kind: "event", text: `"${text}" → hold ${carName(car.id)} empty at floor ${floor}` });
      }
    } else if (e.type === "surge") {
      const floor = e.floor ?? 1;
      const idle = this.cars
        .filter((c) => c.reservedFloor === undefined && this.occupants(c).length === 0)
        .sort((a, b) => Math.abs(a.pos - floor) - Math.abs(b.pos - floor))
        .slice(0, 2);
      for (const c of idle) c.parkAt = floor;
      if (idle.length) {
        this.push({
          kind: "event",
          text: `"${text}" → pre-position ${idle.map((c) => carName(c.id)).join(", ")} at floor ${floor}`,
        });
      }
    }
  }

  // --- Simulation -------------------------------------------------------------

  step(dt: number) {
    this.now += dt;
    for (const car of this.cars) {
      if (car.reservedUntil !== undefined && this.now >= car.reservedUntil) {
        car.reservedFloor = undefined;
        car.reservedUntil = undefined;
      }
    }
    this.dispatchWaiting();
    for (const car of this.cars) this.moveCar(car, dt);
  }

  private dispatchWaiting() {
    const waiting = [...this.passengers.values()].filter(
      (p) => p.status === "waiting" && p.car === undefined,
    );
    if (this.smart) {
      waiting.sort(
        (a, b) =>
          this.queuePriority(b) - this.queuePriority(a) || a.at - b.at,
      );
    } else {
      waiting.sort((a, b) => a.at - b.at);
    }
    for (const p of waiting) this.dispatch(p);
  }

  private queuePriority(p: Passenger) {
    // Aging lets long-waiting routine trips compete with fresh urgent trips.
    // Immediate emergencies still lead until another request has waited minutes.
    return PRIORITY_WEIGHT[p.profile!.priority] + Math.min(9, (this.now - p.at) / 30);
  }

  private dispatch(p: Passenger) {
    const prof = p.profile!;
    let best: { car: Car; cost: number; bump: number[] } | undefined;
    const candidates: DispatchCandidateTrace[] = [];
    for (const car of this.cars) {
      const candidate: DispatchCandidateTrace = {
        car: car.id, position: car.pos, eligible: false, selected: false, displacedPassengerIds: [],
      };
      candidates.push(candidate);
      if (car.id === p.blockedCar && this.now < (p.blockedUntil ?? 0)) {
        candidate.rejection = "recent_capacity_failure";
        continue;
      }
      const plan = this.smart
        ? this.smartFeasible(car, p, prof)
        : { ok: this.loadUnits(car) + prof.units <= CAR_CAPACITY, bump: [] as number[], rejection: "insufficient_capacity" as const };
      if (!plan.ok) {
        candidate.rejection = plan.rejection;
        continue;
      }
      const score = this.cost(car, p, prof, plan.bump);
      candidate.eligible = true;
      candidate.score = score;
      candidate.displacedPassengerIds = [...plan.bump];
      if (!best || score.total < best.cost) best = { car, cost: score.total, bump: plan.bump };
    }
    if (best) candidates[best.car.id].selected = true;
    this.traceAssignment(p, {
      at: this.now,
      car: best?.car.id ?? null,
      basis: p.trace?.modelStatus === "success" ? "model" : p.trace?.modelStatus === "fallback" ? "fallback" : this.interpret ? "provisional" : "rules",
      profile: copyProfile(prof),
      candidates,
    });
    if (!best) return; // nothing suitable right now; retry next tick

    const { car, bump } = best;
    for (const id of bump) {
      const other = this.passengers.get(id)!;
      car.assigned = car.assigned.filter((x) => x !== id);
      other.car = undefined;
      this.traceEvent(other, { kind: "reroute", car: car.id, message: "急救请求需要空梯，尚未上梯的原请求重新分配" });
      this.push({ kind: "bump", text: `Re-routed "${other.note}" off ${carName(car.id)} to clear it for STAT` });
    }
    car.assigned.push(p.id);
    p.car = car.id;
    if (car.reservedFloor !== undefined && prof.priority === "stat") {
      car.reservedFloor = undefined;
      car.reservedUntil = undefined;
    }
    if (this.smart && prof.exclusive) car.exclusiveFor = p.id;
    car.parkAt = undefined;
    this.push({
      kind: "assign",
      text: `${carName(car.id)} → floor ${p.from} for "${p.note}"`,
      tags: this.smart ? prof.tags : undefined,
      latencyMs: p.interp?.latencyMs,
    });
  }

  private smartFeasible(car: Car, p: Passenger, prof: Profile): { ok: boolean; bump: number[]; rejection?: DispatchRejection } {
    const no = (rejection: DispatchRejection) => ({ ok: false, bump: [], rejection });
    if (car.exclusiveFor !== undefined) return no("exclusive_car");
    // A faulty car still carries routine traffic, but never critical patients.
    if (car.avoided && (prof.priority === "stat" || prof.priority === "urgent" || prof.exclusive)) return no("faulty_for_priority");
    if (car.reservedFloor !== undefined && prof.priority !== "stat") return no("reserved_for_emergency");

    const occupants = this.occupants(car);
    if (prof.exclusive) {
      if (occupants.length === 0) return { ok: true, bump: [] };
      // STAT may take a car whose passengers haven't boarded yet; they get re-routed.
      if (prof.priority === "stat" && car.riders.length === 0) return { ok: true, bump: [...car.assigned] };
      // Reserve the next empty trip now instead of waiting to notice an empty
      // car. Its current riders are delivered before this exclusive pickup.
      if (car.assigned.length === 0) return { ok: true, bump: [] };
      return no("exclusive_trip_conflict");
    }

    if (this.loadUnits(car) + prof.units > CAR_CAPACITY) return no("insufficient_capacity");
    return { ok: true, bump: [] };
  }

  // Estimated time for the car to reach the pickup, plus the delay the new stop
  // imposes on everyone already on the car. The smart dispatcher weighs that
  // delay by priority; the baseline counts every passenger the same.
  private cost(car: Car, p: Passenger, prof: Profile, bump: number[]): DispatchScore {
    const bumped = new Set(bump);
    const eta = this.smart && prof.exclusive && car.riders.length > 0
      ? this.emptyCarEta(car, p.from)
      : this.eta(car, p.from, this.stops(car, bumped));
    let disruption = 0;
    for (const o of this.occupants(car)) {
      if (bumped.has(o.id)) continue;
      disruption += (this.smart ? PRIORITY_WEIGHT[o.profile!.priority] : 1) * DOOR_DWELL;
    }
    // A car held for an incoming emergency is the right one for that emergency.
    const reservedBonus = car.reservedFloor === p.from && prof.priority === "stat" ? 30 : 0;
    const faultPenalty = car.avoided ? FAULT_DWELL : 0;
    const reassignmentPenalty = bump.length * 5;
    return {
      eta, disruption, faultPenalty, reassignmentPenalty, reservationBonus: reservedBonus,
      total: eta + disruption + faultPenalty + reassignmentPenalty - reservedBonus,
    };
  }

  private emptyCarEta(car: Car, floor: number) {
    const remaining = [...new Set(car.riders.map((id) => this.passengers.get(id)!.to))];
    let pos = car.pos;
    let dir = car.dir;
    let time = car.doorTimer;
    while (remaining.length) {
      const ahead = remaining.filter((f) => dir > 0 ? f >= pos : dir < 0 ? f <= pos : true);
      const candidates = ahead.length ? ahead : remaining;
      const next = candidates.reduce((a, b) => Math.abs(b - pos) < Math.abs(a - pos) ? b : a);
      time += Math.abs(next - pos) / CAR_SPEED + DOOR_DWELL;
      dir = next > pos ? 1 : next < pos ? -1 : dir;
      pos = next;
      remaining.splice(remaining.indexOf(next), 1);
    }
    return time + Math.abs(floor - pos) / CAR_SPEED;
  }

  // Planning assumes normal door times: no dispatcher is told a car is slow,
  // the smart one just stops using a car it has read is faulty.
  private eta(car: Car, floor: number, stops: number[]) {
    const time = (dist: number, n: number) => dist / CAR_SPEED + n * DOOR_DWELL + car.doorTimer;
    const dir = car.dir;
    if (dir === 0 || stops.length === 0) return time(Math.abs(car.pos - floor), 0);
    const ahead = (f: number) => (dir > 0 ? f >= car.pos - EPS : f <= car.pos + EPS);
    if (ahead(floor)) {
      const between = stops.filter((f) => ahead(f) && Math.abs(f - car.pos) < Math.abs(floor - car.pos));
      return time(Math.abs(floor - car.pos), between.length);
    }
    const inDir = stops.filter(ahead);
    const far = inDir.length ? (dir > 0 ? Math.max(...inDir) : Math.min(...inDir)) : car.pos;
    const back = stops.filter((f) => !ahead(f) && Math.abs(f - far) < Math.abs(floor - far));
    return time(Math.abs(far - car.pos) + Math.abs(far - floor), inDir.length + back.length);
  }

  private moveCar(car: Car, dt: number) {
    if (car.doorTimer > 0) {
      car.doorTimer = Math.max(0, car.doorTimer - dt);
      return;
    }
    const target = this.nextTarget(car);
    if (target === undefined) {
      car.dir = 0;
      return;
    }
    if (Math.abs(target - car.pos) < EPS) {
      car.pos = target;
      this.arrive(car, target);
      return;
    }
    car.dir = target > car.pos ? 1 : -1;
    const next = car.pos + car.dir * CAR_SPEED * dt;
    if ((car.dir > 0 && next >= target) || (car.dir < 0 && next <= target)) {
      car.pos = target;
      this.arrive(car, target);
    } else {
      car.pos = next;
    }
  }

  private nextTarget(car: Car): number | undefined {
    const stops = this.smart && car.exclusiveFor !== undefined && car.riders.length > 0 && !car.riders.includes(car.exclusiveFor)
      ? [...new Set(car.riders.map((id) => this.passengers.get(id)!.to))]
      : this.stops(car);
    if (stops.length === 0) {
      const home = car.reservedFloor ?? car.parkAt;
      if (home === undefined || Math.abs(home - car.pos) < EPS) return undefined;
      return home;
    }
    const nearest = (fs: number[]) =>
      fs.reduce((a, b) => (Math.abs(b - car.pos) < Math.abs(a - car.pos) ? b : a));
    if (car.dir !== 0) {
      const ahead = stops.filter((f) => (car.dir > 0 ? f >= car.pos - EPS : f <= car.pos + EPS));
      if (ahead.length) return nearest(ahead);
    }
    return nearest(stops);
  }

  private arrive(car: Car, floor: number) {
    const atStop = this.stops(car).includes(floor);
    if (!atStop) {
      car.dir = 0;
      return;
    }
    // Drop off.
    for (const id of car.riders.filter((id) => this.passengers.get(id)!.to === floor)) {
      const p = this.passengers.get(id)!;
      p.status = "done";
      p.droppedAt = this.now;
      this.traceEvent(p, { kind: "dropoff", car: car.id, message: "已到达目的楼层" });
      if (car.exclusiveFor === id) car.exclusiveFor = undefined;
    }
    car.riders = car.riders.filter((id) => this.passengers.get(id)!.status !== "done");

    // Pick up in the order the dispatcher believes matters most. Physics uses
    // the truth: a bed doesn't fit in a half-full car whatever was believed.
    const boarding = car.assigned
      .map((id) => this.passengers.get(id)!)
      .filter((p) => p.from === floor && (!this.smart || !p.profile!.exclusive || car.riders.length === 0))
      .sort((a, b) => PRIORITY_WEIGHT[b.profile!.priority] - PRIORITY_WEIGHT[a.profile!.priority]);
    for (const p of boarding) {
      car.assigned = car.assigned.filter((id) => id !== p.id);
      const used = car.riders.reduce((s, id) => s + this.passengers.get(id)!.truth.units, 0);
      if (used + p.truth.units > CAR_CAPACITY) {
        p.car = undefined;
        p.blockedCar = car.id;
        p.blockedUntil = this.now + 30;
        p.wastedTrips++;
        this.wastedTrips++;
        if (car.exclusiveFor === p.id) car.exclusiveFor = undefined;
        this.traceEvent(p, { kind: "capacity-failure", car: car.id, message: "电梯到达后实际空间不足，保留请求并重新派梯" });
        this.push({ kind: "wasted", text: `${carName(car.id)} arrived too full: "${p.note}" left behind` });
        continue;
      }
      car.riders.push(p.id);
      p.status = "riding";
      p.pickedAt = this.now;
      this.traceEvent(p, { kind: "pickup", car: car.id, message: "已上梯，后续模型结果仅作记录" });
    }
    car.doorTimer = DOOR_DWELL + (car.faulty ? FAULT_DWELL : 0);
  }

  private stops(car: Car, exclude?: Set<number>): number[] {
    const s = new Set<number>();
    for (const id of car.assigned) if (!exclude?.has(id)) s.add(this.passengers.get(id)!.from);
    for (const id of car.riders) s.add(this.passengers.get(id)!.to);
    return [...s];
  }

  // Riders are measured by the car's load-weighing sensor (every real elevator
  // has one); passengers not yet aboard are counted as the dispatcher believes.
  private loadUnits(car: Car) {
    let units = 0;
    for (const id of car.riders) units += this.passengers.get(id)!.truth.units;
    for (const id of car.assigned) units += this.passengers.get(id)!.profile!.units;
    return units;
  }

  private occupants(car: Car): Passenger[] {
    return [...car.riders, ...car.assigned].map((id) => this.passengers.get(id)!);
  }

  private nearestFreeCar(floor: number): Car | undefined {
    return this.cars
      .filter((c) => !c.avoided && c.reservedFloor === undefined && c.exclusiveFor === undefined && this.occupants(c).length === 0)
      .sort((a, b) => Math.abs(a.pos - floor) - Math.abs(b.pos - floor))[0];
  }

  private push(d: Omit<Decision, "at">) {
    this.log.unshift({ at: this.now, ...d });
    if (this.log.length > MAX_LOG) this.log.length = MAX_LOG;
  }

  private traceAssignment(p: Passenger, entry: AssignmentTrace) {
    if (!p.trace) return;
    const history = p.trace.assignments;
    // A queue can have no suitable car for many simulation ticks. Keep the most
    // recent pending evaluation without filling the history with identical waits.
    if (entry.car === null && history[history.length - 1]?.car === null) history[history.length - 1] = entry;
    else history.push(entry);
    if (history.length > MAX_ASSIGNMENT_TRACE) history.shift();
  }

  private traceEvent(p: Passenger, entry: Omit<TraceEvent, "at">) {
    if (!p.trace) return;
    p.trace.events.push({ at: this.now, ...entry });
    if (p.trace.events.length > MAX_EVENT_TRACE) p.trace.events.shift();
  }

  // --- Metrics ------------------------------------------------------------------

  metrics() {
    const ps = [...this.passengers.values()];
    const wait = (p: Passenger) => (p.pickedAt ?? this.now) - p.at;
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    let wSum = 0;
    let wWait = 0;
    for (const p of ps) {
      const w = PRIORITY_WEIGHT[p.truth.priority];
      wSum += w;
      wWait += w * wait(p);
    }
    const lat = [...this.interpLatencies].sort((a, b) => a - b);
    const pct = (q: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : 0);
    return {
      requests: ps.length,
      delivered: ps.filter((p) => p.status === "done").length,
      priorityWeightedWait: wSum ? wWait / wSum : 0,
      avgWait: avg(ps.map(wait)),
      maxWait: ps.length ? Math.max(...ps.map(wait)) : 0,
      statWait: avg(ps.filter((p) => p.truth.priority === "stat").map(wait)),
      bedWait: avg(ps.filter((p) => p.truth.load === "bed").map(wait)),
      wastedTrips: this.wastedTrips,
      interpreting: this.pendingInterps,
      interpreted: this.interpreted,
      fallbacks: this.fallbacks,
      refinedBeforePickup: this.refinedBeforePickup,
      changedBeforePickup: this.changedBeforePickup,
      lateInterpretations: this.lateInterpretations,
      waiting: ps.filter((p) => p.status === "waiting").length,
      latencyP50: pct(0.5),
      latencyP95: pct(0.95),
      inputTokens: this.inputTokens,
    };
  }
}

export type Metrics = ReturnType<Column["metrics"]>;
