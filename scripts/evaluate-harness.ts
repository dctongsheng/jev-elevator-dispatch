/**
 * Record real model answers once, then replay them with a virtual wall clock.
 * Unlike tune.ts, the simulation keeps moving while decisions are pending.
 * Usage: node --import tsx --env-file=.env.local scripts/evaluate-harness.ts record|replay|all
 * Capture and replay are separate so an artifact never silently becomes an oracle.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { interpretRequest, type ElevatorRequest, type RequestInterpretation } from "../src/lib/jev/interpretRequest";
import { interpretEvent, type EventInterpretation } from "../src/lib/jev/interpretEvent";
import { Column } from "../src/lib/sim/engine";
import { World } from "../src/lib/sim/world";
import { profileFrom } from "../src/lib/sim/policy";
import type { Arrival } from "../src/lib/sim/types";
import { HARNESS_CASES } from "./fixtures/harness-cases";
import { HOLDOUT_CASES } from "./fixtures/harness-holdout";
const ALL_CASES = [...HARNESS_CASES, ...HOLDOUT_CASES];

const RECORD_PATH = process.env.RECORD_PATH ?? "docs/validation-2026-10-29-recordings.json";
const REPORT_PATH = process.env.REPORT_PATH ?? "docs/validation-2026-10-29-results.json";
const SEED_START = Number(process.env.SEED_START ?? 101);
const SEEDS = Number(process.env.SEEDS ?? 16);
const SIM_SECONDS = Number(process.env.SIM_SECONDS ?? 1200);
const STEP = 0.25;
const MAX_DRAIN = 600;
const DEADLINE_MS = Number(process.env.REPLAY_DEADLINE_MS ?? process.env.DECISION_TIMEOUT_MS ?? 2500);
const CONCURRENCY = Number(process.env.DECISION_MAX_CONCURRENCY ?? 2);
const keys = ["statWait", "bedWait", "avgWait", "wastedTrips", "priorityWeightedWait", "p95Wait", "maxWait", "delivered"] as const;
const normalize = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const truthEvent = (type: EventInterpretation["type"], floor: number | null, car: number | null): EventInterpretation => ({ type, floor, car, typeConfidence: 1, floorConfidence: 1, carConfidence: 1, latencyMs: 0, inputTokens: 0, model: "physical-scenario-fixture" });
const EVENTS = [
  { at: 100, text: "Trauma incoming to the ED in 5 minutes", physical: truthEvent("priority_transport", 1, null) },
  { at: 250, text: "Car C door keeps sticking", physical: truthEvent("car_fault", null, 2) },
  { at: 400, text: "Visiting hours just started", physical: truthEvent("surge", 1, null) },
];

interface Recording<T> { input: ElevatorRequest | string; response?: T; elapsedMs: number; error?: string }
interface Recordings {
  version: 1;
  createdAt: string;
  requestScope: "normalized-note-only";
  seeds: number[];
  simSeconds: number;
  requests: Record<string, Recording<RequestInterpretation>>;
  cases: Record<string, Recording<RequestInterpretation>>;
  events: Record<string, Recording<EventInterpretation>>;
  sourceHashes: Record<string, string>;
}
const interpreterFiles = ["src/lib/jev/client.ts", "src/lib/jev/interpretRequest.ts", "src/lib/jev/interpretEvent.ts", "src/lib/jev/requestEvidence.ts"];
async function hashes(paths: string[]) {
  const pairs = await Promise.all(paths.map(async (p) => {
    try { return [p, createHash("sha256").update(await readFile(p)).digest("hex")] as const; }
    catch { return [p, "absent"] as const; }
  }));
  return Object.fromEntries(pairs);
}
const seedList = Array.from({ length: SEEDS }, (_, i) => SEED_START + i);

function gatherRequests() {
  const requests = new Map<string, ElevatorRequest>();
  for (const seed of seedList) {
    const observer = new Column("baseline");
    const world = new World([observer], { seed });
    const pending = [...EVENTS];
    while (world.now < SIM_SECONDS) {
      if (pending.length && world.now >= pending[0].at) world.applyEvent(pending.shift()!.physical);
      world.step(STEP);
    }
    for (const p of observer.passengers.values()) {
      const key = normalize(p.note);
      if (!requests.has(key)) requests.set(key, { note: p.note, from: p.from, to: p.to });
    }
  }
  return requests;
}

async function capture<T>(input: ElevatorRequest | string, fn: () => Promise<T>): Promise<Recording<T>> {
  const start = performance.now();
  try { return { input, response: await fn(), elapsedMs: performance.now() - start }; }
  catch (error) { return { input, elapsedMs: performance.now() - start, error: error instanceof Error ? error.message : String(error) }; }
}
async function record() {
  const out: Recordings = { version: 1, createdAt: new Date().toISOString(), requestScope: "normalized-note-only", seeds: seedList, simSeconds: SIM_SECONDS, requests: {}, cases: {}, events: {}, sourceHashes: await hashes(interpreterFiles) };
  const requests = gatherRequests();
  for (const [key, req] of requests) {
    const result = await capture(req, () => interpretRequest(req));
    out.requests[key] = result;
    console.log(`record ${Object.keys(out.requests).length}/${requests.size} ${Math.round(result.elapsedMs)}ms ${result.response?.priority ?? "ERROR"}/${result.response?.load ?? "?"} ${req.note}`);
    await writeFile(RECORD_PATH, JSON.stringify(out, null, 2) + "\n");
  }
  for (const sample of ALL_CASES) {
    const req = { note: sample.note, from: sample.from, to: sample.to };
    out.cases[sample.id] = await capture(req, () => interpretRequest(req));
    console.log(`case ${sample.id}: ${out.cases[sample.id].response?.priority ?? "ERROR"}/${out.cases[sample.id].response?.load ?? "?"}`);
    await writeFile(RECORD_PATH, JSON.stringify(out, null, 2) + "\n");
  }
  for (const e of EVENTS) out.events[e.text] = await capture(e.text, () => interpretEvent(e.text));
  await writeFile(RECORD_PATH, JSON.stringify(out, null, 2) + "\n");
  return out;
}

type Scenario = { name: string; speed: number; cache: boolean; failure?: "outage"; latencyFloorMs?: number; evidenceOnly?: boolean };
interface Task { due: number; complete: () => void }
class Replay {
  now = 0;
  tasks: Task[] = [];
  slots = Array.from({ length: CONCURRENCY }, () => 0);
  cached = new Map<string, { value: RequestInterpretation; expiresWall: number }>();
  inFlight = new Map<string, Promise<RequestInterpretation>>();
  stats = { modelCalls: 0, eventCalls: 0, cacheHits: 0, shared: 0, timeouts: 0, recordedFailures: 0, outages: 0 };
  constructor(readonly records: Recordings, readonly scenario: Scenario) {}
  schedule<T>(record: Recording<T> | undefined, category: "request" | "event"): Promise<T> {
    if (!record) throw new Error(`Missing recording for ${category}; refuse synthetic answer substitution`);
    if (category === "event") this.stats.eventCalls++;
    const nowWall = this.now / this.scenario.speed;
    const slot = this.slots.indexOf(Math.min(...this.slots));
    const startWall = Math.max(nowWall, this.slots[slot]);
    const durationMs = Math.max(record.elapsedMs, this.scenario.latencyFloorMs ?? 0);
    const endWall = startWall + durationMs / 1000;
    const deadlineWall = nowWall + DEADLINE_MS / 1000;
    const outage = this.scenario.failure === "outage";
    const timeout = endWall >= deadlineWall || outage;
    const dueWall = timeout ? deadlineWall : endWall;
    // Propagated cancellation releases a slot; jobs that expire in queue do not extend it.
    if (startWall < deadlineWall) this.slots[slot] = dueWall;
    return new Promise<T>((resolve, reject) => {
      this.tasks.push({ due: dueWall * this.scenario.speed, complete: () => {
        if (outage) { this.stats.outages++; reject(new Error("injected model outage")); }
        else if (timeout) { this.stats.timeouts++; reject(new Error("replayed deadline exceeded")); }
        else if (!record.response) { this.stats.recordedFailures++; reject(new Error(record.error ?? "recorded model failure")); }
        else resolve({ ...record.response, latencyMs: (dueWall - nowWall) * 1000 });
      } });
    });
  }
  interpret = (a: Arrival): Promise<RequestInterpretation> => {
    const key = normalize(a.note);
    const cached = this.scenario.cache && this.cached.get(key);
    if (cached && cached.expiresWall > this.now / this.scenario.speed) {
      this.stats.cacheHits++; this.cached.delete(key); this.cached.set(key, cached);
      return Promise.resolve({ ...cached.value, cache: "hit", inputTokens: 0, latencyMs: 0 });
    }
    if (cached) this.cached.delete(key);
    const shared = this.scenario.cache && this.inFlight.get(key);
    if (shared) { this.stats.shared++; return shared; }
    this.stats.modelCalls++;
    const promise = this.schedule(this.records.requests[key], "request");
    if (this.scenario.cache) {
      this.inFlight.set(key, promise);
      promise.then((value) => {
        this.cached.set(key, { value, expiresWall: this.now / this.scenario.speed + 300 });
        while (this.cached.size > 256) this.cached.delete(this.cached.keys().next().value!);
      }, () => {}).finally(() => this.inFlight.delete(key));
    }
    return promise;
  };
  async advance(now: number) {
    this.now = now;
    const ready = this.tasks.filter((t) => t.due <= now);
    this.tasks = this.tasks.filter((t) => t.due > now);
    for (const task of ready) task.complete();
    // Flush both interpreter and Column .then/.catch/.finally before next physics step.
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
}

function metrics(column: Column) {
  const waits = [...column.passengers.values()].map((p) => (p.pickedAt ?? column.now) - p.at).sort((a, b) => a - b);
  const m = column.metrics();
  return { ...m, p95Wait: waits.length ? waits[Math.min(waits.length - 1, Math.floor(waits.length * .95))] : 0,
    unfinished: [...column.passengers.values()].filter((p) => p.status !== "done").length };
}
async function run(records: Recordings, scenario: Scenario, seed: number) {
  const replay = new Replay(records, scenario);
  const baseline = new Column("baseline");
  const smart = new Column("jev", scenario.evidenceOnly ? undefined : replay.interpret);
  const world = new World([baseline, smart], { seed });
  const events = [...EVENTS];
  const eventResults: { text: string; appliedAt?: number; error?: boolean }[] = [];
  while (world.now < SIM_SECONDS) {
    if (events.length && world.now >= events[0].at) {
      const event = events.shift()!;
      world.applyEvent(event.physical); // physical scenario is independent of the model's interpretation
      const log: { text: string; appliedAt?: number; error?: boolean } = { text: event.text };
      eventResults.push(log);
      if (!scenario.evidenceOnly) replay.schedule(records.events[event.text], "event").then((interp) => { smart.applyPolicy(interp, event.text); log.appliedAt = replay.now; }, () => { log.error = true; });
    }
    world.step(STEP);
    await replay.advance(world.now);
  }
  const horizon = { baseline: metrics(baseline), jev: metrics(smart) };
  let drainSeconds = 0;
  while (drainSeconds < MAX_DRAIN && (metrics(baseline).unfinished || metrics(smart).unfinished || replay.tasks.length)) {
    baseline.step(STEP); smart.step(STEP); drainSeconds += STEP;
    await replay.advance(SIM_SECONDS + drainSeconds);
  }
  return { seed, horizon, afterDrain: { baseline: metrics(baseline), jev: metrics(smart) }, drainSeconds, replay: replay.stats, eventResults };
}

async function evaluate(records: Recordings, loadedSourceHashes: Record<string, string>) {
  const scenarios: Scenario[] = [
    { name: "evidence-only-no-model", speed: 10, cache: false, evidenceOnly: true },
    { name: "live-1x-cache", speed: 1, cache: true },
    { name: "live-10x-cache", speed: 10, cache: true },
    { name: "cold-10x-no-cache", speed: 10, cache: false },
    { name: "slow-10x-2500ms", speed: 10, cache: true, latencyFloorMs: 2500 },
    { name: "outage-10x", speed: 10, cache: true, failure: "outage" },
  ];
  const beforeHashes = await hashes(interpreterFiles);
  for (const [path, hash] of Object.entries(records.sourceHashes)) {
    if (beforeHashes[path] !== hash && !process.env.ALLOW_RECORDING_DRIFT) throw new Error(`Interpreter changed since capture: ${path}. Re-record, or explicitly ALLOW_RECORDING_DRIFT=1 for a labeled exploratory replay.`);
  }
  const reports = [];
  for (const scenario of scenarios) {
    const runs: Awaited<ReturnType<typeof run>>[] = [];
    for (const seed of seedList) runs.push(await run(records, scenario, seed));
    const summary = (phase: "horizon" | "afterDrain") => Object.fromEntries(keys.map((key) => {
      const b = runs.reduce((s, r) => s + r[phase].baseline[key], 0) / runs.length;
      const j = runs.reduce((s, r) => s + r[phase].jev[key], 0) / runs.length;
      const lowerIsBetter = key !== "delivered";
      const regressedSeeds = runs.filter((r) => lowerIsBetter ? r[phase].jev[key] > r[phase].baseline[key] + 1e-6 : r[phase].jev[key] < r[phase].baseline[key] - 1e-6).map((r) => r.seed);
      return [key, { baseline: b, jev: j, changePercent: b ? (j - b) / b * 100 : null, regressedSeeds }];
    }));
    const item = { scenario, horizon: summary("horizon"), afterDrain: summary("afterDrain"), runs };
    reports.push(item);
    console.log(`${scenario.name}: ${keys.slice(0,4).map((k) => `${k} ${item.horizon[k].baseline.toFixed(1)}→${item.horizon[k].jev.toFixed(1)} (${item.horizon[k].regressedSeeds.length}/${runs.length} regressions)`).join("; ")}`);
  }
  for (const report of reports) {
    for (let i = 0; i < report.runs.length; i++) {
      const run = report.runs[i];
      if (JSON.stringify(run.horizon.baseline) !== JSON.stringify(reports[0].runs[i].horizon.baseline)) throw new Error(`Baseline changed across scenarios for seed ${run.seed}`);
      if (run.horizon.baseline.requests !== run.horizon.jev.requests) throw new Error(`Unequal request cohort for seed ${run.seed}`);
    }
  }
  const classification = ALL_CASES.map((sample) => {
    const recording = records.cases[sample.id];
    const r = recording?.response;
    const exclusive = r ? profileFrom(r, sample.note).exclusive : undefined;
    return { ...sample, actual: r ? { priority: r.priority, load: r.load, exclusive, model: r.model, source: r.source, adjustments: r.adjustments, raw: r.raw } : null,
      priorityCorrect: !!r && sample.priority.includes(r.priority), loadCorrect: r?.load === sample.load,
      rawPriorityCorrect: !!r?.raw && sample.priority.includes(r.raw.priority), rawLoadCorrect: r?.raw?.load === sample.load,
      rawExclusiveAnswerCorrect: !!r?.raw && (sample.exclusive === undefined || (r.raw.exclusiveCar > .5) === sample.exclusive),
      exclusiveCorrect: sample.exclusive === undefined || exclusive === sample.exclusive, error: recording?.error };
  });
  const currentSourceHashes = await hashes(Object.keys(loadedSourceHashes));
  const changedDuringRun = Object.keys(loadedSourceHashes).filter((p) => loadedSourceHashes[p] !== currentSourceHashes[p]);
  if (changedDuringRun.length) throw new Error(`Source changed while this process was running: ${changedDuringRun.join(", ")}. Replay in a fresh process.`);
  const classifySummary = (items: typeof classification) => ({ total: items.length, priorityCorrect: items.filter((c) => c.priorityCorrect).length, loadCorrect: items.filter((c) => c.loadCorrect).length, exclusiveCorrect: items.filter((c) => c.exclusiveCorrect).length, rawPriorityCorrect: items.filter((c) => c.rawPriorityCorrect).length, rawLoadCorrect: items.filter((c) => c.rawLoadCorrect).length, rawExclusiveAnswerCorrect: items.filter((c) => c.rawExclusiveAnswerCorrect).length, cases: items });
  const out = {
    version: 1, createdAt: new Date().toISOString(), recordingCreatedAt: records.createdAt, recordingPath: RECORD_PATH, recordingTrafficSeeds: records.seeds,
    provenance: "Recorded real model answers, deterministic virtual-clock replay; not a fresh live browser run, not an oracle.",
    modelNames: [...new Set([...Object.values(records.requests), ...Object.values(records.cases)].flatMap((r) => r.response ? [r.response.model] : []))],
    methodology: { seeds: seedList, simSeconds: SIM_SECONDS, stepSeconds: STEP, maxDrainSeconds: MAX_DRAIN, deadlineMs: DEADLINE_MS, concurrency: CONCURRENCY,
      cacheKey: "normalized note (interpreter ignores floors)", cacheScope: "empty at each seed, then exact-note memory/inflight reuse", cacheHitLatencyMs: 0, cacheTtlSeconds: 300, cacheMaxEntries: 256, resolutionQuantumSeconds: STEP,
      latencies: "recorded cold wall time plus replayed two-slot queue; failures/outage advance the clock and retain provisional dispatch",
      events: "fixed known physical scenario shared by both banks; only JEV policy response uses recorded event interpretation after its measured delay",
      score: "truth labels used only for scoring and physical capacity; ongoing waits counted at horizon; afterDrain phase stops arrivals and drains up to 600s; unfinished counts remain explicit if the cap is reached",
      caveats: ["16 held-out random traffic seeds reuse the existing authored request corpus; they are not independent natural-language generalization tests.", "The initial 16-wording development fixture exposed bugs and was used to revise guards; only the separate final 14-wording holdout remains a generalization check. Neither is clinical validation.", "Service concurrency and measured cold latency are replayed approximations; load-dependent model latency and browser transport need a separate live run.", "No guarantee of per-scenario or per-passenger improvement is implied; every regressed seed is retained."] },
    sourceHashes: loadedSourceHashes,
    recordingSourceDrift: Object.entries(records.sourceHashes).filter(([p,h]) => beforeHashes[p] !== h).map(([p]) => p),
    classification: { development: classifySummary(classification.filter((c) => !c.id.startsWith("holdout-"))), holdout: classifySummary(classification.filter((c) => c.id.startsWith("holdout-"))) },
    attribution: { evidenceOnlyScenario: "evidence-only-no-model", note: "The evidence-only arm never invokes an interpreter or applies semantic event policies. Its gains come from direct text evidence and dispatcher rules, not model inference. Compare other scenarios with this arm to identify incremental model benefit or harm. The outage arm separately checks failure behavior." },
    scenarios: reports,
  };
  await writeFile(REPORT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`classification development ${out.classification.development.priorityCorrect}/${HARNESS_CASES.length} priority; holdout ${out.classification.holdout.priorityCorrect}/${HOLDOUT_CASES.length} priority, ${out.classification.holdout.loadCorrect}/${HOLDOUT_CASES.length} load; saved ${REPORT_PATH}`);
}
async function main() {
  const loadedSourceHashes = await hashes([...interpreterFiles, "src/lib/sim/engine.ts", "src/lib/sim/policy.ts", "src/lib/sim/types.ts", "src/lib/sim/world.ts", "src/lib/sim/corpus.ts", "scripts/evaluate-harness.ts", "scripts/fixtures/harness-cases.ts", "scripts/fixtures/harness-holdout.ts"]);
  const mode = process.argv[2] ?? "replay";
  const records = mode === "record" || mode === "all" ? await record() : JSON.parse(await readFile(RECORD_PATH, "utf8")) as Recordings;
  if (mode !== "record") await evaluate(records, loadedSourceHashes);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
