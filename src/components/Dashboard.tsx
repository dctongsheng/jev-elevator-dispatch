"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { EventInterpretation } from "@/lib/jev/interpretEvent";
import type { RequestInterpretation } from "@/lib/jev/interpretRequest";
import { Column, type Metrics } from "@/lib/sim/engine";
import type { Arrival } from "@/lib/sim/types";
import { World } from "@/lib/sim/world";
import { Building, PRIORITY_COLOR } from "./Building";
import { DecisionInspector } from "./DecisionInspector";
import { LanguageSwitcher, useLanguage } from "./LanguageProvider";
import { eventAction } from "@/lib/i18n/domain";

const STEP = 0.25; // sim seconds per engine step
const MIN_REQUESTS = 60; // below this, the comparison is noise
const CLIENT_TIMEOUT_MS = 4000; // past this, dispatch without Jev's reading
const PRESETS = [
  { en: "Emergency incoming", zh: "急救即将到达", text: "Trauma incoming to the ED in 5 minutes" },
  { en: "Car C door fault", zh: "C 梯门故障", text: "Car C door keeps sticking" },
  { en: "Visiting hours", zh: "探视高峰", text: "Visiting hours just started" },
];

async function interpretViaApi(a: Arrival): Promise<RequestInterpretation> {
  const res = await fetch("/api/interpret", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: a.from, to: a.to, note: a.note }),
    signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`interpret ${res.status}`);
  return res.json();
}

function makeWorld() {
  return new World([new Column("baseline"), new Column("jev", interpretViaApi)], { seed: 4 });
}

const clock = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;

type EventLogEntry = { text: string; at: number; interp?: EventInterpretation; actions?: string[]; error?: boolean };

export function Dashboard() {
  const { t } = useLanguage();
  // The world is mutable and mutated by the loop; `frame` re-renders to show it.
  const [world, setWorld] = useState(makeWorld);
  const worldRef = useRef(world);
  const [, setFrame] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(10);
  const [lastEvent, setLastEvent] = useState<EventLogEntry | null>(null);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    worldRef.current = world;
  }, [world]);

  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    let lastPaint = 0;
    const loop = (t: number) => {
      // Cap catch-up after the tab stalls, so we never run minutes of sim in one frame.
      carry += (Math.min(t - last, 250) / 1000) * speed;
      last = t;
      while (carry >= STEP) {
        world.step(STEP);
        carry -= STEP;
      }
      if (t - lastPaint > 90) {
        lastPaint = t;
        setFrame((f) => f + 1);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, speed, world]);

  // Pausing the simulation should not hide a model response already in flight.
  useEffect(() => {
    if (running) return;
    const signature = () => world.columns.map((c) => `${c.pendingInterps}:${c.interpreted}:${c.fallbacks}`).join("|");
    let previous = signature();
    const timer = setInterval(() => {
      const next = signature();
      if (next !== previous) {
        previous = next;
        setFrame((f) => f + 1);
      }
    }, 150);
    return () => clearInterval(timer);
  }, [running, world]);

  const reset = () => {
    setWorld(makeWorld());
    setRunId((id) => id + 1);
    setLastEvent(null);
    setRunning(false);
  };

  const sendEvent = useCallback(async (text: string) => {
    const w = worldRef.current;
    const entry: EventLogEntry = { text, at: w.now };
    setLastEvent(entry);
    try {
      const res = await fetch("/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`event ${res.status}`);
      const interp: EventInterpretation = await res.json();
      if (worldRef.current !== w) return; // reset while in flight
      w.applyEvent(interp);
      const previousLog = new Set(w.columns[1].log);
      for (const c of w.columns) c.applyPolicy(interp, text);
      const actions = w.columns[1].log.filter((d) => !previousLog.has(d)).map((d) => d.text);
      setLastEvent((e) => (e === entry ? { ...entry, interp, actions } : e));
    } catch {
      setLastEvent((e) => (e === entry ? { ...entry, error: true } : e));
    }
  }, []);

  const [baseline, jev] = world.columns;
  const mb = baseline.metrics();
  const mj = jev.metrics();

  return (
    <div className="dashboard-shell">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{t("Elevator Sense", "智能电梯调度")}</h1>
            <span className="rounded-full border border-emerald-800/70 bg-emerald-950/40 px-2 py-0.5 text-[10px] font-medium tracking-wider text-emerald-400">{t("LIVE SIMULATION", "实时仿真")}</span>
          </div>
          <p className="mt-0.5 text-xs text-zinc-400">{t("Same hospital. Same requests. See StartLux guide dispatch.", "同一座医院，同一批请求。实时观察 StartLux 如何影响调度。")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`mr-1 h-1.5 w-1.5 rounded-full ${running ? "bg-emerald-400" : "bg-zinc-600"}`} />
          <span className="mr-2 font-mono text-lg tabular-nums text-zinc-300" title={t("Simulation time", "仿真时间")}>{clock(world.now)}</span>
          <button onClick={() => setRunning((r) => !r)} className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium hover:bg-emerald-500">
            {running ? t("Pause", "暂停") : world.now > 0 ? t("Resume", "继续") : t("Start", "开始仿真")}
          </button>
          <button onClick={reset} className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">{t("Reset", "重置")}</button>
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded-md bg-zinc-800 px-2 py-1.5 text-sm" aria-label={t("Simulation speed", "仿真速度")}>
            {[1, 5, 10, 20].map((s) => <option key={s} value={s}>{s}× {t("speed", "速度")}</option>)}
          </select>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="dashboard-main">
        <div className="simulation-workspace">
          <Scoreboard baseline={mb} jev={mj} />
          <div className="elevator-comparison">
            <BankPanel column={baseline} enhanced={false} />
            <BankPanel column={jev} enhanced />
          </div>
          <Legend />
          <EventBox onSend={sendEvent} last={lastEvent} />
          <RunDetails baseline={mb} jev={mj} column={jev} speed={speed} />
        </div>
        <aside className="decision-sidebar" aria-label={t("StartLux live decision sidebar", "StartLux 实时决策侧栏")}>
          <DecisionInspector key={runId} column={jev} />
        </aside>
      </main>
    </div>
  );
}

function BankPanel({ column, enhanced }: { column: Column; enhanced: boolean }) {
  const { t } = useLanguage();
  const passengers = [...column.passengers.values()];
  const waiting = passengers.filter((p) => p.status === "waiting" || p.status === "interpreting").length;
  const riding = passengers.filter((p) => p.status === "riding").length;
  const delivered = column.metrics().delivered;
  return (
    <section className={`bank-panel ${enhanced ? "border-emerald-800/70 bg-emerald-950/15" : "border-zinc-800 bg-zinc-900/40"}`} aria-label={enhanced ? t("Elevators with StartLux", "接入 StartLux 的电梯") : t("Baseline elevators", "基础调度电梯")}>
      <div className="flex shrink-0 items-start justify-between gap-2">
        <div>
          <h2 className={`text-sm font-semibold ${enhanced ? "text-emerald-300" : "text-zinc-200"}`}>{enhanced ? t("With StartLux", "接入 StartLux") : t("Baseline", "基础调度")}</h2>
          <p className="mt-1 text-[11px] text-zinc-500">{enhanced ? t("Dispatch now · refine with meaning", "即时派梯 · 语义识别后优化") : t("Floor and capacity rules only", "仅按楼层与空间调度")}</p>
        </div>
        <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${enhanced ? "bg-emerald-500/10 text-emerald-400" : "bg-zinc-800 text-zinc-500"}`}>{enhanced ? "STARTLUX" : t("BASELINE", "基础规则")}</span>
      </div>
      <div className="bank-visual"><Building column={column} compact /></div>
      <div className="flex shrink-0 items-center justify-between border-t border-zinc-800/70 pt-2 text-[11px] text-zinc-500">
        <span>{t("Waiting", "候梯")} <b className="ml-1 font-mono text-zinc-300">{waiting}</b></span>
        <span>{t("Onboard", "在途")} <b className="ml-1 font-mono text-zinc-300">{riding}</b></span>
        <span>{t("Delivered", "已送达")} <b className={`ml-1 font-mono ${enhanced ? "text-emerald-300" : "text-zinc-300"}`}>{delivered}</b></span>
      </div>
    </section>
  );
}

const CARDS: { key: keyof Metrics; en: string; zh: string }[] = [
  { key: "statWait", en: "Emergency wait", zh: "急救候梯" },
  { key: "bedWait", en: "Patient bed wait", zh: "病床候梯" },
  { key: "avgWait", en: "Overall wait", zh: "整体候梯" },
  { key: "wastedTrips", en: "Capacity failures", zh: "容量不足接载" },
];

function Scoreboard({ baseline, jev }: { baseline: Metrics; jev: Metrics }) {
  const { t } = useLanguage();
  const settled = jev.requests >= MIN_REQUESTS;
  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t("Live performance comparison", "实时效果对比")}>
      {CARDS.map((c) => {
        const unit = c.key === "wastedTrips" ? t("", "次") : "s";
        const b = baseline[c.key];
        const j = jev[c.key];
        const change = b > 0 ? Math.round(((b - j) / b) * 100) : null;
        const better = change !== null && change >= 0;
        return (
          <div key={c.key} className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2.5">
            <div className="text-xs text-zinc-400">{t(c.en, c.zh)}</div>
            <div className={`mt-1 font-mono text-2xl font-semibold tracking-tight ${!settled || change === null ? "text-zinc-600" : better ? "text-emerald-400" : "text-red-400"}`}>
              {!settled || change === null ? "—" : `${better ? "↓" : "↑"} ${Math.abs(change)}%`}
            </div>
            <div className="mt-1 text-[10px] tabular-nums text-zinc-500">
              {settled ? <>{t("Baseline", "基础")} {Math.round(b)}{unit} → <span className="text-zinc-300">{Math.round(j)}{unit}</span></> : t(`Gathering data ${jev.requests}/${MIN_REQUESTS}`, `积累样本 ${jev.requests}/${MIN_REQUESTS}`)}
            </div>
          </div>
        );
      })}
    </section>
  );
}

function InfoDialog({ title, trigger, children }: { title: string; trigger: string; children: React.ReactNode }) {
  const { t } = useLanguage();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  return (
    <>
      <button onClick={() => ref.current?.showModal()} className="shrink-0 text-xs text-zinc-400 underline decoration-zinc-700 underline-offset-4 hover:text-emerald-300">{trigger}</button>
      <dialog ref={ref} aria-labelledby={titleId} className="m-auto max-h-[85dvh] w-[min(640px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-950 p-5 text-zinc-300 shadow-2xl backdrop:bg-black/70">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-zinc-100">{title}</h2>
          <button onClick={() => ref.current?.close()} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700" autoFocus>{t("Close", "关闭")}</button>
        </div>
        {children}
      </dialog>
    </>
  );
}

function RunDetails({ baseline, jev, column, speed }: { baseline: Metrics; jev: Metrics; column: Column; speed: number }) {
  const { t } = useLanguage();
  const readings = [...column.passengers.values()].flatMap((p) => p.interp ? [p.interp] : []);
  const latest = readings[readings.length - 1];
  const cached = readings.filter((i) => i.cache === "hit" || i.cache === "shared").length;
  const guarded = readings.filter((i) => i.adjustments?.length).length;
  const modelTimes = readings.filter((i) => i.cache === "miss").map((i) => i.modelLatencyMs ?? i.latencyMs).sort((a, b) => a - b);
  return (
    <footer className="flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-zinc-500">
      <span>{t(`${jev.requests} requests · delivered ${baseline.delivered} / ${jev.delivered} (baseline / StartLux)`, `${jev.requests} 个请求 · 已送达 ${baseline.delivered} / ${jev.delivered}（基础 / StartLux）`)}</span>
      <InfoDialog title={t("Run data and measurement", "运行数据与统计口径")} trigger={t("Run details ↗", "运行详情 ↗")}>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <div className="col-span-2"><dt className="text-zinc-500">{t("Model", "模型")}</dt><dd className="mt-1 break-all">{latest?.model ?? t("Awaiting first response", "等待首次响应")}</dd></div>
          <div><dt className="text-zinc-500">{t("Readings / cached or shared", "已识别 / 缓存或共享")}</dt><dd className="mt-1">{readings.length} / {cached}</dd></div>
          <div><dt className="text-zinc-500">{t("Guardrail corrections", "规则修正")}</dt><dd className="mt-1">{guarded}</dd></div>
          <div><dt className="text-zinc-500">{t("Changed before pickup / late results", "接载前调整 / 接载后到达")}</dt><dd className="mt-1">{jev.changedBeforePickup} / {jev.lateInterpretations}</dd></div>
          <div><dt className="text-zinc-500">{t("Pending / fallback", "等待响应 / 回退")}</dt><dd className="mt-1">{jev.interpreting} / {jev.fallbacks}</dd></div>
          <div><dt className="text-zinc-500">{t("Response p95 (including cache)", "响应 p95（含缓存）")}</dt><dd className="mt-1">{Math.round(jev.latencyP95)} ms</dd></div>
          <div><dt className="text-zinc-500">{t("Uncached model p50", "未命中缓存的模型 p50")}</dt><dd className="mt-1">{modelTimes.length ? `${Math.round(modelTimes[Math.floor(modelTimes.length / 2)])} ms` : t("Awaiting response", "等待响应")}</dd></div>
        </dl>
        <p className="mt-4 border-t border-zinc-800 pt-4 text-xs leading-relaxed text-zinc-400">{t(`Wait runs from request to pickup and includes people still waiting. Capacity failures count pickup attempts. At ${speed}× speed, one real second equals ${speed} simulation seconds. Dispatch continues during inference; results arriving after pickup are advisory. Percentages compare this run after ${MIN_REQUESTS} requests and may change as it progresses.`, `候梯时间从发出请求到接载，包含仍在候梯的人；容量不足按接载尝试次数统计。当前 ${speed}× 速度下，真实 1 秒对应仿真 ${speed} 秒。模型响应期间继续调度，接载后的结果仅作建议。百分比为本次运行对比，样本达到 ${MIN_REQUESTS} 个后展示，结果可能随运行波动。`)}</p>
      </InfoDialog>
    </footer>
  );
}

function EventBox({ onSend, last }: { onSend: (text: string) => void; last: EventLogEntry | null }) {
  const { locale, t } = useLanguage();
  const eventLabels: Record<EventInterpretation["type"], string> = {
    surge: t("Crowd surge", "人流增加"),
    car_fault: t("Elevator fault", "电梯故障"),
    priority_transport: t("Priority transport", "紧急转运"),
    ignore: t("Unrelated to dispatch", "与电梯调度无关"),
  };
  const [text, setText] = useState("");
  const submit = () => {
    const value = text.trim();
    if (!value) return;
    onSend(value);
    setText("");
  };
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 p-3" aria-label={t("Hospital events", "医院事件")}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium text-zinc-300">{t("Add a hospital event", "注入医院事件")}</h2>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => <button key={p.text} onClick={() => onSend(p.text)} className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200">{t(p.en, p.zh)}</button>)}
        </div>
      </div>
      <div className="flex gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) submit(); }} aria-label={t("Hospital event description", "医院事件描述")} placeholder={t("Describe an event, e.g. Car C door keeps sticking", "描述事件，例如：Car C door keeps sticking")} className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-xs outline-none focus:border-emerald-500" />
        <button onClick={submit} disabled={!text.trim()} className="rounded-md bg-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40">{t("Send", "发送")}</button>
      </div>
      <div className="flex min-h-4 items-center justify-between gap-3 text-[10px] text-zinc-500" aria-live="polite">
        <p className="min-w-0 truncate" title={last?.text}>
          {last ? <><span>“{last.text}” → </span>{last.error ? <span className="text-red-400">{t("StartLux unavailable", "StartLux 暂不可用")}</span> : last.interp ? <span className="text-emerald-300">{eventLabels[last.interp.type]}{last.interp.car !== null ? t(` · Car ${"ABCD"[last.interp.car]}`, ` · ${"ABCD"[last.interp.car]} 梯`) : last.interp.floor !== null ? t(` · Floor ${last.interp.floor}`, ` · ${last.interp.floor} 层`) : ""} · {Math.round(last.interp.latencyMs)} ms</span> : t("StartLux is reading…", "StartLux 识别中…")}</> : t("StartLux classifies the event; the dispatcher applies the policy.", "StartLux 识别事件，调度器执行对应策略。")}
        </p>
        {last?.interp && <InfoDialog title={t("Event interpretation and actions", "事件判断与实际动作")} trigger={t("Event details ↗", "事件详情 ↗")}>
          <p className="mb-4 text-sm">“{last.text}”</p>
          <dl className="grid gap-3 text-xs sm:grid-cols-2">
            <div><dt className="text-zinc-500">{t("Event type", "事件分类")}</dt><dd className="mt-1">{eventLabels[last.interp.type]} · {t("Confidence", "置信信号")} {(last.interp.typeConfidence * 100).toFixed(1)}%</dd></div>
            <div><dt className="text-zinc-500">{t("Event location", "事件位置")}</dt><dd className="mt-1">{last.interp.floor === null ? t("Floor unspecified", "未指定楼层") : t(`Floor ${last.interp.floor}`, `楼层 ${last.interp.floor}`)} · {last.interp.car === null ? t("Car unspecified", "未指定电梯") : t(`Car ${"ABCD"[last.interp.car]}`, `${"ABCD"[last.interp.car]} 梯`)}</dd></div>
            <div className="sm:col-span-2"><dt className="text-zinc-500">{t("Model and response", "模型与响应")}</dt><dd className="mt-1 break-all">{last.interp.model} · {Math.round(last.interp.latencyMs)} ms</dd></div>
          </dl>
          <div className="mt-4 border-t border-zinc-800 pt-3 text-xs leading-relaxed"><p className="mb-2 text-zinc-500">{t("Dispatcher actions", "调度器执行记录")}</p>{last.actions?.length ? <ul className="space-y-2">{last.actions.map((action, index) => <li key={index}>{eventAction(action, locale)}</li>)}</ul> : <p>{t("No new dispatch action for this event.", "本次没有新增调度动作。")}</p>}</div>
        </InfoDialog>}
      </div>
    </section>
  );
}

function Legend() {
  const { t } = useLanguage();
  const labels: Record<keyof typeof PRIORITY_COLOR, string> = { stat: t("Emergency", "急救"), urgent: t("Urgent", "紧急"), routine: t("Routine", "常规"), visitor: t("Visitor", "访客") };
  return (
    <section className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[10px] text-zinc-500" aria-label={t("Simulation legend", "仿真图例")}>
      <span title={t("Dots show actual passenger types; the baseline cannot read this meaning.", "圆点显示真实乘客类别；基础调度无法读取这些语义")}>{t("Passengers", "乘客")}</span>
      {(Object.keys(PRIORITY_COLOR) as (keyof typeof PRIORITY_COLOR)[]).map((k) => <span key={k} className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: PRIORITY_COLOR[k] }} />{labels[k]}</span>)}
      <span className="h-3 border-l border-zinc-700" />
      <span className="flex items-center gap-1"><span className="h-2.5 w-3.5 rounded-sm border border-zinc-200" />{t("Dedicated", "专梯")}</span>
      <span className="flex items-center gap-1"><span className="h-2.5 w-3.5 rounded-sm border border-dashed border-yellow-400" />{t("Door fault", "门故障")}</span>
    </section>
  );
}
