import { choice, noul, systemOne } from "./client";
import { requestEvidence } from "./requestEvidence";

export type Priority = "stat" | "urgent" | "routine" | "visitor";
export type Load = "bed" | "wheelchair" | "cart" | "walking";

export interface ElevatorRequest {
  from: number;
  to: number;
  note: string;
}

export interface RequestInterpretation {
  priority: Priority;
  priorityConfidence: number;
  priorityProbabilities: Record<Priority, number>;
  load: Load;
  loadConfidence: number;
  loadProbabilities: Record<Load, number>;
  exclusiveCar: number; // probability 0–1
  latencyMs: number;
  inputTokens: number;
  model: string;
  source?: "model" | "model+guardrails";
  cache?: "miss" | "hit" | "shared";
  modelLatencyMs?: number;
  raw?: { priority: Priority; load: Load; exclusiveCar: number };
  adjustments?: string[];
}

// All questions go in one call: they're evaluated in parallel, so the extra
// (sometimes irrelevant) questions cost tokens but barely any latency.
const QUESTIONS = {
  priority: choice(
    "Classify the trip in note. Use only what is written. Hospital destinations alone do not imply a patient or emergency.",
    {
      stat: "Immediate life-threatening patient emergency or responding code/rapid-response team: code blue, stroke alert, trauma, cardiac arrest. Not laboratory samples or ordinary staff trips.",
      urgent:
        "Patient transfer, scheduled procedure, or time-sensitive specimens/medicine. No immediate threat to life.",
      routine:
        "Ordinary staff travel, supplies, equipment, linen, meals, waste, deceased transport. Default when no urgency is stated.",
      visitor:
        "Visitors, family or public travel.",
    },
  ),
  load: choice("What is actually carried in note? Do not invent equipment based on a destination or job title.", {
    bed: "Explicit bed, stretcher, gurney, or transport of a deceased person.",
    wheelchair: "A patient in a wheelchair.",
    cart: "A cart or large equipment: supply, linen, meal, waste, or medical equipment cart.",
    walking: "People on foot or small hand-carried items. Default for staff or visitors without stated equipment.",
  }),
  exclusive_car: noul(
    "Does note explicitly require an empty/dedicated car: bed or stretcher, life-threatening emergency response, or isolation? Ordinary carts, wheelchairs, staff and visitors may share a car. Do not infer exclusivity from being in a hospital.",
  ),
};

const CACHE_LIMIT = 256;
const CACHE_TTL_MS = 5 * 60_000;
type Cached = { value: RequestInterpretation; expires: number };
type Pending = { promise: Promise<RequestInterpretation>; controller: AbortController; subscribers: number };
const cache = new Map<string, Cached>();
const pending = new Map<string, Pending>();

async function interpretUncached(
  req: ElevatorRequest,
  options?: { signal?: AbortSignal },
): Promise<RequestInterpretation> {
  const started = performance.now();
  const res = await systemOne(
    {
      state: { note: req.note.replace(/\bw\/c\b/gi, "wheelchair") },
      questions: QUESTIONS,
    },
    { signal: options?.signal },
  );
  const latencyMs = performance.now() - started;
  const a = res.answers;
  const evidence = requestEvidence(req.note);
  const raw = { priority: a.priority.choice, load: a.load.choice, exclusiveCar: a.exclusive_car.noul };
  const adjustments: string[] = [];
  // Prefer a clear model interpretation over shallow keyword evidence. The
  // model understands negation, roles and destination equipment that generic
  // lexical rules cannot reliably resolve. Evidence helps ambiguous answers.
  let priority = a.priority.probabilities[raw.priority] >= 0.8 ? raw.priority : (evidence.priority ?? raw.priority);
  let load = a.load.probabilities[raw.load] >= 0.8 ? raw.load : (evidence.load ?? raw.load);
  // Scores are confidence signals, not calibrated probabilities of correctness.
  // Only an unambiguous signal may impose a costly hard constraint without
  // explicit evidence in the note. Ambiguity falls back to an ordinary trip.
  if (!evidence.priority && raw.priority === "stat" && a.priority.probabilities.stat < 0.8) priority = "routine";
  if (!evidence.priority && raw.priority === "urgent" && a.priority.probabilities.urgent < 0.65) priority = "routine";
  if (!evidence.load && raw.load === "bed" && a.load.probabilities.bed < 0.7) load = "walking";
  let exclusiveCar = evidence.exclusiveReason === "explicit" ? 1 : (raw.exclusiveCar >= 0.9 ? raw.exclusiveCar : 0);
  if (load === "bed" || priority === "stat") exclusiveCar = 1;
  if (priority !== raw.priority) adjustments.push(`priority: ${raw.priority} → ${priority}`);
  if (load !== raw.load) adjustments.push(`load: ${raw.load} → ${load}`);
  if ((exclusiveCar > 0.5) !== (raw.exclusiveCar > 0.5)) adjustments.push("dedicated car requires explicit evidence or a strong model signal");
  return {
    priority,
    priorityConfidence: a.priority.confidence,
    priorityProbabilities: { ...a.priority.probabilities },
    load,
    loadConfidence: a.load.confidence,
    loadProbabilities: { ...a.load.probabilities },
    exclusiveCar,
    latencyMs,
    inputTokens: res.usage.input_tokens,
    model: res.model,
    modelLatencyMs: latencyMs,
    raw,
    adjustments,
    source: adjustments.length ? "model+guardrails" : "model",
  };
}

// Repeated notes need one interpretation, regardless of their floors. Floor
// labels were intentionally removed from the model input above. Cache entries
// contain model answers only, never hidden simulation truth or a request list.
export async function interpretRequest(req: ElevatorRequest, options?: { signal?: AbortSignal }): Promise<RequestInterpretation> {
  const started = performance.now();
  options?.signal?.throwIfAborted();
  const key = req.note.trim().replace(/\s+/g, " ").toLowerCase();
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now()) {
    cache.delete(key);
    cache.set(key, existing);
    return { ...structuredClone(existing.value), cache: "hit", inputTokens: 0, latencyMs: performance.now() - started };
  }
  if (existing) cache.delete(key);
  let task = pending.get(key);
  const shared = task !== undefined && !task.controller.signal.aborted;
  if (!task || task.controller.signal.aborted) {
    const controller = new AbortController();
    const next: Pending = { controller, subscribers: 0, promise: Promise.resolve(null as unknown as RequestInterpretation) };
    next.promise = interpretUncached(req, { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) {
        cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      return value;
    }).finally(() => { if (pending.get(key) === next) pending.delete(key); });
    task = next;
    pending.set(key, task);
  }
  const activeTask = task;
  activeTask.subscribers++;
  return new Promise<RequestInterpretation>((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      options?.signal?.removeEventListener("abort", cancel);
      activeTask.subscribers--;
      if (activeTask.subscribers === 0 && pending.get(key) === activeTask) activeTask.controller.abort();
      return true;
    };
    const cancel = () => { if (finish()) reject(options?.signal?.reason); };
    options?.signal?.addEventListener("abort", cancel, { once: true });
    activeTask.promise.then((value) => {
      if (finish()) resolve({ ...structuredClone(value), cache: shared ? "shared" : "miss", inputTokens: shared ? 0 : value.inputTokens, latencyMs: performance.now() - started });
    }, (error: unknown) => { if (finish()) reject(error); });
  });
}
