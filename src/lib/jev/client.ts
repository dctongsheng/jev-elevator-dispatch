// Server-side only: calls the decision API, which mirrors the TypeSafe Jev
// schema: one call carries `state` plus all `questions` (evaluated in
// parallel), and answers come back per question — { choice, confidence,
// probabilities } for choices, { noul } (0–1) for yes/no. Auth is optional:
// hosted gateways want a key, the LAN server doesn't.
//
// One deadline covers queueing, inference and retries. Cancelled callers never
// leave queued work or retries behind. The dispatcher can act provisionally
// while the model is working rather than stopping its control loop.

const BASE_URL = process.env.DECISION_BASE_URL ?? "http://10.6.108.25:8090";
const MODEL = process.env.DECISION_MODEL ?? "startlux-decision-v1.1-4b-autothink-q4km";
const API_KEY = process.env.DECISION_API_KEY ?? "";
const TIMEOUT_MS = Number(process.env.DECISION_TIMEOUT_MS) || 2500;
const THINK_MODE = process.env.DECISION_THINK_MODE ?? "never";
const MAX_RETRIES = 1;
const MAX_IN_FLIGHT = Number(process.env.DECISION_MAX_CONCURRENCY) || 2;
const MAX_QUEUED = 64;

let inFlight = 0;
type Waiter = { grant: () => void; signal: AbortSignal; cancel: () => void };
const waiters: Waiter[] = [];

async function acquire(signal: AbortSignal) {
  signal.throwIfAborted();
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  if (waiters.length >= MAX_QUEUED) throw new Error("decision queue full");
  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      signal,
      grant: resolve,
      cancel: () => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(signal.reason);
      },
    };
    waiters.push(waiter);
    signal.addEventListener("abort", waiter.cancel, { once: true });
  });
}

function release() {
  const next = waiters.shift();
  if (next) {
    next.signal.removeEventListener("abort", next.cancel);
    next.grant(); // transfer the occupied slot; no opportunity to jump the queue
  } else {
    inFlight--;
  }
}

async function withSlot<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  await acquire(signal);
  try {
    signal.throwIfAborted();
    return await fn();
  } finally {
    release();
  }
}

export function choice<K extends string>(instructions: string, criteria: Record<K, string>) {
  return { type: "choice" as const, instructions, criteria };
}

export function noul(instructions: string) {
  return { type: "noul" as const, instructions };
}

export type Question = ReturnType<typeof choice> | ReturnType<typeof noul>;

type ChoiceAnswer<K extends string> = {
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
};
type NoulAnswer = { noul: number };

type AnswerOf<Q extends Question> = Q extends {
  type: "choice";
  criteria: Record<infer K extends string, string>;
}
  ? ChoiceAnswer<K>
  : NoulAnswer;

interface SystemOneResponse<A> {
  model: string;
  answers: A;
  usage?: { input_tokens?: number };
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return err instanceof TypeError || status === 429 || (status !== undefined && status >= 500);
}

async function callOnce(
  body: string,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const res = await fetch(`${BASE_URL}/v1/systemone`, {
    method: "POST",
    headers,
    body,
    signal,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`decision API ${res.status}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export async function systemOne<Q extends Record<string, Question>>(
  req: { state: unknown; questions: Q },
  options?: { signal?: AbortSignal },
): Promise<{
  model: string;
  answers: { [K in keyof Q]: AnswerOf<Q[K]> };
  usage: { input_tokens: number };
}> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const payload = JSON.stringify({
    model: MODEL,
    state: req.state,
    questions: req.questions,
    think_mode: THINK_MODE,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      const parsed = await withSlot(signal, () => callOnce(payload, signal));
      if (typeof parsed.answers !== "object" || parsed.answers === null) {
        throw new Error("unexpected decision response shape");
      }
      const r = parsed as unknown as SystemOneResponse<Record<string, unknown>>;
      for (const [name, question] of Object.entries(req.questions)) {
        const answer = r.answers[name] as Record<string, unknown> | undefined;
        if (!answer || typeof answer !== "object") throw new Error(`missing answer: ${name}`);
        const validProbability = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 1;
        if (question.type === "choice") {
          const criteria = question.criteria;
          if (typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice) || !validProbability(answer.confidence)) {
            throw new Error(`invalid choice answer: ${name}`);
          }
          const probabilities = answer.probabilities as Record<string, unknown> | undefined;
          if (!probabilities || Object.keys(criteria).some((key) => !validProbability(probabilities[key]))) {
            throw new Error(`invalid choice probabilities: ${name}`);
          }
        } else if (!validProbability(answer.noul)) {
          throw new Error(`invalid yes/no answer: ${name}`);
        }
      }
      return {
        model: (r.model as string) ?? MODEL,
        answers: r.answers as { [K in keyof Q]: AnswerOf<Q[K]> },
        usage: { input_tokens: r.usage?.input_tokens ?? 0 },
      };
    } catch (err) {
      if (signal.aborted || attempt >= MAX_RETRIES || !isRetryable(err)) throw err;
      await new Promise<void>((resolve, reject) => {
        const cancel = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", cancel);
          resolve();
        }, 75);
        signal.addEventListener("abort", cancel, { once: true });
      });
    }
  }
}
