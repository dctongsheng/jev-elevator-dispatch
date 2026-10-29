"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Load, Priority, RequestInterpretation } from "@/lib/jev/interpretRequest";
import { floorLabel, requestNote, traceMessage } from "@/lib/i18n/domain";
import { useLanguage } from "./LanguageProvider";
import type { Column } from "@/lib/sim/engine";
import type { AssignmentTrace, Passenger, Profile } from "@/lib/sim/types";

type Translate = (english: string, chinese: string) => string;

function labels(t: Translate) {
  const priority: Record<Priority, string> = { stat: t("Emergency", "急救"), urgent: t("Urgent", "紧急"), routine: t("Routine", "常规"), visitor: t("Visitor", "访客") };
  const load: Record<Load, string> = { bed: t("Bed", "病床"), wheelchair: t("Wheelchair", "轮椅"), cart: t("Cart", "推车"), walking: t("Walking", "步行") };
  const status = { interpreting: t("Awaiting model", "等待模型"), waiting: t("Waiting", "等待上梯"), riding: t("On board", "已上梯"), done: t("Delivered", "已送达") };
  const basis = { provisional: t("Immediate dispatch", "即时预调度"), model: t("Model-refined constraints", "模型返回后的约束"), fallback: t("Rules after model failure", "模型失败后的规则调度"), rules: t("Direct rules", "直接规则") };
  const rejection: Record<string, string> = {
    recent_capacity_failure: t("Recently failed to fit; temporarily avoided", "刚发生容量不足，暂避此梯"),
    exclusive_car: t("Dedicated to another request", "已为另一请求保留专梯"),
    faulty_for_priority: t("Faulty car excluded for urgent or dedicated trips", "故障梯不接紧急或专梯请求"),
    reserved_for_emergency: t("Reserved for an emergency", "已预约用于急救"),
    exclusive_trip_conflict: t("Existing assignments conflict with a dedicated trip", "现有派梯与独占要求冲突"),
    insufficient_capacity: t("Insufficient estimated capacity", "预计剩余容量不足"),
  };
  return { priority, load, status, basis, rejection };
}
const clock = (seconds: number) => `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
const ms = (value: number) => value < 1 ? "<1 ms" : `${Math.round(value)} ms`;
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const carName = (id: number, t: Translate) => t(`Car ${"ABCD"[id]}`, `${"ABCD"[id]} 梯`);

// Animate inserted cards, not the scrollbar. Stable request IDs keep model
// responses and language changes from replaying the entrance animation.
function useDecisionEntrance(
  feedRef: RefObject<HTMLDivElement | null>,
  listRef: RefObject<HTMLOListElement | null>,
  live: boolean,
) {
  const previous = useRef(new Map<string, number>());
  const wasLive = useRef(false);
  const mounted = useRef(false);
  const animations = useRef(new Map<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const feed = feedRef.current;
    const list = listRef.current;
    if (!feed || !list) return;
    const cards = Array.from(list.children) as HTMLElement[];
    const positions = new Map(cards.map((card) => [card.dataset.requestId!, card.offsetTop]));
    const inserted = cards.some((card) => !previous.current.has(card.dataset.requestId!));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const shouldAnimate = mounted.current && wasLive.current && live && inserted && !reducedMotion;

    if (live && feed.scrollTop !== 0) feed.scrollTop = 0;
    if (!live || reducedMotion || !wasLive.current) {
      animations.current.forEach((animation) => animation.cancel());
      animations.current.clear();
    }

    if (shouldAnimate) {
      for (const card of cards) {
        const top = card.offsetTop;
        if (top > feed.clientHeight + card.offsetHeight) continue;
        const before = previous.current.get(card.dataset.requestId!);
        // Account for a still-running entrance when requests arrive in a burst.
        const transform = getComputedStyle(card).transform;
        const offset = transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m42;
        animations.current.get(card)?.cancel();
        const delta = before === undefined ? 0 : before + offset - top;
        if (before !== undefined && Math.abs(delta) < 1) continue;
        const animation = card.animate(before === undefined ? [
          { transform: "translateY(calc(-100% - 8px)) scale(0.98)", opacity: 0, boxShadow: "inset 0 0 0 1px rgba(52,211,153,0.55)" },
          { transform: "translateY(0) scale(1)", opacity: 1, boxShadow: "inset 0 0 0 1px rgba(52,211,153,0)" },
        ] : [
          { transform: `translateY(${delta}px)` },
          { transform: "translateY(0)" },
        ], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
        animations.current.set(card, animation);
        animation.onfinish = () => {
          if (animations.current.get(card) === animation) animations.current.delete(card);
        };
      }
    }
    previous.current = positions;
    wasLive.current = live;
    mounted.current = true;
  });

  useEffect(() => {
    const active = animations.current;
    return () => { active.forEach((animation) => animation.cancel()); active.clear(); };
  }, []);
}

export function DecisionInspector({ column }: { column: Column }) {
  const { t } = useLanguage();
  const [selected, setSelected] = useState<Passenger | null>(null);
  const [paused, setPaused] = useState<{ requests: Passenger[]; total: number } | null>(null);
  const following = paused === null;
  const feedRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const followButtonRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const followingRef = useRef(true);
  const touchY = useRef<number | null>(null);
  const recent = [...column.passengers.values()].slice(-40).reverse();
  const displayed = paused?.requests ?? recent;
  const unseen = paused ? Math.max(0, column.passengers.size - paused.total) : 0;

  useDecisionEntrance(feedRef, listRef, following && selected === null);

  const pauseFollow = () => {
    if (!followingRef.current) return;
    followingRef.current = false;
    setPaused({ requests: recent, total: column.passengers.size });
  };
  const resumeFollow = () => {
    followingRef.current = true;
    setPaused(null);
    if (feedRef.current) feedRef.current.scrollTop = 0;
  };

  return (
    <section aria-labelledby="decision-inspector-title" className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-emerald-800/80 bg-zinc-900/50">
      <div className="shrink-0 border-b border-zinc-800 px-3.5 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 id="decision-inspector-title" className="text-sm font-semibold text-emerald-200">{t("StartLux live decisions", "StartLux 实时决策")}</h2>
          <button ref={followButtonRef} type="button" onClick={() => following ? pauseFollow() : resumeFollow()}
            aria-label={following ? t("Pause live updates", "暂停实时更新") : t("Show latest and resume live updates", "显示最新并恢复实时更新")}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] transition-colors ${following ? "border-emerald-800 bg-emerald-950/60 text-emerald-300" : "border-amber-800/70 bg-amber-950/40 text-amber-300"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${following ? "bg-emerald-400" : "bg-amber-400"}`} />
            {following ? t("Live", "实时") : t("Resume ↑", "继续 ↑")}
          </button>
        </div>
        <p className="mt-1.5 text-[11px] text-zinc-500">{t("Interpret → Validate → Dispatch", "语义判断 → 规则校验 → 调度器派梯")}</p>
        <div className="mt-2 flex gap-3 text-[10px] text-zinc-400">
          <span>{t("Returned", "已返回")} <strong className="font-mono font-normal text-zinc-200">{column.interpreted}</strong></span>
          <span>{t("Pending", "处理中")} <strong className="font-mono font-normal text-emerald-300">{column.pendingInterps}</strong></span>
          <span>{t("Fallbacks", "回退")} <strong className="font-mono font-normal text-amber-300">{column.fallbacks}</strong></span>
        </div>
      </div>
      <div ref={feedRef} tabIndex={0} aria-label={t("StartLux decisions, newest first", "StartLux 决策记录，最新在上")}
        style={{ overflowAnchor: following ? "none" : "auto" }}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2.5 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-emerald-600"
        onWheel={(event) => { if (event.deltaY > 0) pauseFollow(); }}
        onTouchStart={(event) => { touchY.current = event.touches[0]?.clientY ?? null; }}
        onTouchMove={(event) => {
          const y = event.touches[0]?.clientY;
          if (y !== undefined && touchY.current !== null && y < touchY.current - 3) pauseFollow();
          if (y !== undefined) touchY.current = Math.max(touchY.current ?? y, y);
        }}
        onKeyDown={(event) => { if (["Tab", "ArrowDown", "PageDown", "End"].includes(event.key) || (event.key === " " && !event.shiftKey && event.target === event.currentTarget)) pauseFollow(); }}
        onPointerDown={(event) => { if (event.target === event.currentTarget || event.button === 1) pauseFollow(); }}>
        <ol ref={listRef} className="relative flex flex-col gap-2">
          {displayed.map((p, index) => <li key={p.id} data-request-id={p.id} className="origin-top rounded-lg"><DecisionCard passenger={p} latest={following && index === 0} onOpen={(button) => {
            openerRef.current = button;
            setSelected(p);
          }} /></li>)}
        </ol>
        {!displayed.length && <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
          <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-emerald-900 bg-emerald-950/50 font-mono text-lg text-emerald-500">↳</span>
          <p className="text-sm text-zinc-300">{t("Waiting for the first decision", "等待第一条决策")}</p>
          <p className="mt-2 text-xs leading-5 text-zinc-500">{t("Click Start. New decisions pop in here and move earlier ones down.", "点击「开始仿真」，新决策会从顶部弹入，旧记录依次下移。")}</p>
        </div>}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-800 px-3.5 py-2 text-[10px] text-zinc-500">
        <span>{t(`Newest first · ${displayed.length} records`, `最新在上 · ${displayed.length} 条记录`)}</span>
        {!following && <button type="button" onClick={resumeFollow} className="text-emerald-300 hover:text-emerald-100">{unseen > 0 ? t(`${unseen} new · Show latest ↑`, `${unseen} 条新决策 · 回到最新 ↑`) : t("Show latest ↑", "回到最新 ↑")}</button>}
      </div>
      {selected && <DecisionDetail passenger={selected} onClose={() => {
        setSelected(null);
        const opener = openerRef.current;
        // A live stream may have pushed the opener out of view while the
        // dialog was open. Keep keyboard focus on a visible control.
        (followingRef.current ? followButtonRef.current : opener?.isConnected ? opener : followButtonRef.current)?.focus({ preventScroll: true });
      }} />}
    </section>
  );
}

function DecisionCard({ passenger: p, latest, onOpen }: { passenger: Passenger; latest: boolean; onOpen: (button: HTMLButtonElement) => void }) {
  const { locale, t } = useLanguage();
  const { priority: priorities, load, status } = labels(t);
  const i = p.interp;
  const profile = p.profile ?? p.trace?.initialProfile;
  const priority = i?.priority ?? profile?.priority;
  const corrected = !!i?.adjustments?.length;
  const late = p.trace?.modelStatus === "success" && p.trace.modelAppliedBeforePickup === false;
  const failed = p.trace?.modelStatus === "fallback";
  const label = failed ? t("Model failed · Rules active", "模型失败 · 规则继续") : i ? i.cache === "hit" ? t("Cache hit", "缓存命中") : i.cache === "shared" ? t("Shared response", "共享响应") : t("Model returned", "模型已返回") : p.trace?.modelStatus === "not-requested" ? t("Direct rules", "直接规则") : t("Model reading…", "模型读取中…");
  return <button type="button" aria-label={t(`View request #${p.id}: ${p.note}`, `查看请求 #${p.id}：${requestNote(p.note, locale)}`)} onClick={(event) => onOpen(event.currentTarget)} className={`block w-full min-w-0 rounded-lg border p-3 text-left transition-colors hover:bg-zinc-800/70 focus-visible:outline-2 focus-visible:outline-emerald-500 ${corrected || failed || late ? "border-amber-900/60 bg-amber-950/10" : "border-zinc-800 bg-zinc-950/45"}`}>
    <span className="flex items-center justify-between gap-2 text-[10px] text-zinc-500"><span className="flex items-center gap-2"><span className="font-mono">#{p.id} · {clock(p.at)}</span>{latest && <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-emerald-300">{t("LATEST", "最新")}</span>}</span><span>{status[p.status]}</span></span>
    <span className="mt-1.5 block line-clamp-2 text-xs leading-[1.55] text-zinc-200">{requestNote(p.note, locale)}</span>
    <span className="mt-2 flex items-center justify-between gap-2 text-[10px]"><span className="truncate text-zinc-500">{floorLabel(p.from, locale)} → {floorLabel(p.to, locale)}</span><span className="shrink-0 text-zinc-300">{t("Assigned: ", "调度器：")}<strong className="font-medium text-emerald-300">{p.car === undefined ? t("Pending", "待派梯") : carName(p.car, t)}</strong></span></span>
    <span className="mt-2 flex flex-wrap items-center gap-1 text-[10px]">
      <span className="mr-0.5 text-zinc-500">{i ? t("Validated", "校验建议") : t("Initial rules", "即时规则")}</span>
      <span className={`rounded px-1.5 py-0.5 ${priority === "stat" || priority === "urgent" ? "bg-rose-950/70 text-rose-300" : "bg-zinc-800 text-zinc-300"}`}>{priority ? priorities[priority] : t("Unclassified", "等待分类")}</span>
      {i && <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{load[i.load]}</span>}
      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{i ? i.exclusiveCar > 0.5 ? t("Dedicated", "专梯") : t("Shared", "可合乘") : profile ? profile.exclusive ? t("Dedicated", "专梯") : t("Shared", "可合乘") : t("Unconfirmed", "待确认")}</span>
      {!i && profile && <span className="text-zinc-500">{t(`Load ${profile.units}/10`, `占 ${profile.units}/10`)}</span>}
      {corrected && <span className="text-amber-300">{t(`${i!.adjustments!.length} corrected`, `已修正 ${i!.adjustments!.length} 项`)}</span>}
    </span>
    {late && <span className="mt-1.5 block text-[10px] text-amber-300">{t("Returned after pickup · Advisory only", "上梯后返回 · 建议未改变执行安排")}</span>}
    <span className="mt-2 flex items-center justify-between gap-2 border-t border-zinc-800/70 pt-2 text-[10px]"><span className={failed ? "text-amber-300" : i ? "text-emerald-400" : "text-zinc-500"}>{label}{i && <span className="ml-2 font-mono text-zinc-500">{ms(i.latencyMs)}</span>}</span><span className="shrink-0 text-zinc-500">{t("Details ↗", "详情 ↗")}</span></span>
  </button>;
}

function DecisionDetail({ passenger, onClose }: { passenger: Passenger; onClose: () => void }) {
  const { t } = useLanguage();
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    // Removing the dialog removes it from the top layer. Avoid closing it in
    // effect cleanup: Strict Mode replays effects and would emit a false close.
  }, []);
  return <dialog ref={dialogRef} aria-labelledby="decision-detail-title" onClose={onClose} className="m-auto max-h-[90dvh] w-[min(960px,calc(100vw-32px))] max-w-none overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 p-0 text-zinc-200 shadow-2xl backdrop:bg-black/70">
    <div className="flex max-h-[90dvh] min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div><h2 id="decision-detail-title" className="text-sm font-semibold text-emerald-200">{t(`Request #${passenger.id} · Full decision record`, `请求 #${passenger.id} · 完整决策记录`)}</h2><p className="mt-1 text-[11px] text-zinc-500">{t("Actual input, model output, validation, and dispatch snapshots", "真实输入、模型输出、校验结果和调度快照")}</p></div>
        <button type="button" autoFocus onClick={() => dialogRef.current?.close()} className="shrink-0 rounded border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">{t("Close", "关闭")} <span className="ml-1 text-zinc-500">Esc</span></button>
      </div>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain p-3 sm:p-4">
        <InputStep passenger={passenger} />
        <ModelStep passenger={passenger} />
        <HarnessStep passenger={passenger} />
        <DispatchStep key={passenger.id} passenger={passenger} />
      </div>
    </div>
  </dialog>;
}

function Step({ number, title, aside, children }: { number: string; title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/45 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium"><span className="font-mono text-emerald-500">{number}</span>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function InputStep({ passenger: p }: { passenger: Passenger }) {
  const { locale, t } = useLanguage();
  const { status } = labels(t);
  const translated = requestNote(p.note, locale);
  return (
    <Step number="01" title={t("Request input", "请求输入")} aside={<span className="text-xs text-zinc-500">#{p.id} · {clock(p.at)} · {status[p.status]}</span>}>
      <p className="mb-1 text-[11px] text-zinc-500">{t("Original request", "原始请求")}</p>
      <blockquote className="border-l-2 border-emerald-700 pl-3 text-sm leading-6 text-zinc-100 break-words">{p.note}</blockquote>
      {translated !== p.note && <p className="mt-2 text-xs text-zinc-400">{t("Display translation: ", "界面译文：")}{translated}</p>}
      <p className="mt-2 text-xs text-zinc-400">{floorLabel(p.from, locale)} → {floorLabel(p.to, locale)}</p>
      <p className="mt-2 text-[11px] text-zinc-500">{t("Floors are used for dispatch. Classification reads only the request text, so the destination does not bias the judgment.", "楼层用于派梯；模型分类只读取请求正文，避免目的楼层干扰判断。")}</p>
      {p.interp?.modelInput && (
        <details className="mt-2 text-xs text-zinc-400">
          <summary className="cursor-pointer hover:text-zinc-200">{t("Actual model input and three questions", "模型实际输入与三个问题")}{p.interp.cache === "hit" || p.interp.cache === "shared" ? t(" (original call)", "（原始调用）") : ""}</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-950 p-3 whitespace-pre-wrap break-words text-[11px] leading-5">{JSON.stringify(p.interp.modelInput, null, 2)}</pre>
        </details>
      )}
    </Step>
  );
}

function ModelStep({ passenger: p }: { passenger: Passenger }) {
  const { t } = useLanguage();
  const { priority, load } = labels(t);
  const i = p.interp;
  const failed = p.trace?.modelStatus === "fallback";
  const raw = i?.raw;
  return (
    <Step number="02" title={t("StartLux model output", "StartLux 模型输出")} aside={i && <span className="rounded bg-emerald-950 px-2 py-0.5 text-[11px] text-emerald-300">{i.cache === "hit" ? t("Cache hit", "缓存命中") : i.cache === "shared" ? t("Shared call", "并发共享") : t("Model call", "实际模型调用")}</span>}>
      {!i ? <p className={`text-sm ${failed ? "text-amber-300" : "text-zinc-400"}`}>{failed ? t("The model call failed or timed out. Rules keep dispatching this request; no model result is available.", "调用失败或超时；当前请求继续按规则调度。没有模型结果可展示。") : p.trace?.modelStatus === "not-requested" ? t("This request uses direct rules; no model was called.", "当前请求只使用直接规则，未调用模型。") : t("Waiting for the model. Elevators continue using the initial rules.", "正在等待模型返回，电梯已按即时规则继续调度。")}</p> : (
        <>
          <p className="text-[11px] text-zinc-500 break-all">{i.model} · {t("Response", "本次响应")} {ms(i.latencyMs)}{i.modelLatencyMs !== undefined && t(` · Original model call ${ms(i.modelLatencyMs)}`, ` · 原始模型调用 ${ms(i.modelLatencyMs)}`)}</p>
          {raw ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <ProbabilityGroup title={t("Priority", "紧急程度")} selected={raw.priority} scores={i.priorityProbabilities} labels={priority} confidence={i.priorityConfidence} />
              <ProbabilityGroup title={t("Load", "乘梯载荷")} selected={raw.load} scores={i.loadProbabilities} labels={load} confidence={i.loadConfidence} />
              <div className="sm:col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-zinc-800 pt-2 text-xs">
                <span className="text-zinc-400">{t("Dedicated car · yes score", "需要专梯 · yes 分数")}</span><strong className="font-mono text-zinc-200">{percent(raw.exclusiveCar)}</strong>
                <span className="text-zinc-500">{t("Raw output before dispatch rules. Confidence signals are not success rates.", "原始返回尚未套用派梯规则；置信信号不代表成功率。")}</span>
              </div>
            </div>
          ) : <p className="mt-3 text-xs text-amber-300">{t("The original classifications were not saved for this response and cannot be reconstructed.", "这条历史响应未保存原始分类，无法还原模型原始选择。")}</p>}
          <details className="mt-2 text-xs text-zinc-500">
            <summary className="cursor-pointer hover:text-zinc-300">{t("View full response JSON", "查看完整响应 JSON")}</summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-zinc-950 p-3 whitespace-pre-wrap break-words text-[11px]">{JSON.stringify(i, null, 2)}</pre>
          </details>
        </>
      )}
    </Step>
  );
}

function ProbabilityGroup<K extends string>({ title, selected, scores, labels, confidence }: { title: string; selected: K; scores: Record<K, number>; labels: Record<K, string>; confidence: number }) {
  const { t } = useLanguage();
  return (
    <div className="min-w-0">
      <p className="mb-2 flex flex-wrap justify-between gap-2 text-xs"><span className="text-zinc-300">{title} → <strong className="text-emerald-300">{labels[selected]}</strong></span><span className="text-zinc-500">{t("Confidence", "置信信号")} {percent(confidence)}</span></p>
      <div className="space-y-1.5">
        {(Object.keys(labels) as K[]).map((key) => (
          <div key={key} className="grid grid-cols-[68px_minmax(0,1fr)_46px] items-center gap-2 text-[11px]">
            <span className={key === selected ? "text-emerald-300" : "text-zinc-500"}>{labels[key]}</span>
            <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800"><div className={`h-full rounded-full ${key === selected ? "bg-emerald-500" : "bg-zinc-600"}`} style={{ width: `${Math.max(0, Math.min(1, scores[key])) * 100}%` }} /></div>
            <span className="font-mono text-right text-zinc-400">{percent(scores[key])}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileLine({ label, profile }: { label: string; profile?: Profile }) {
  const { t } = useLanguage();
  const { priority } = labels(t);
  return <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs"><span className="w-36 shrink-0 text-zinc-500">{label}</span><span className="text-zinc-200">{profile ? `${priority[profile.priority]} · ${t(`Load ${profile.units}/10`, `占用 ${profile.units}/10`)} · ${profile.exclusive ? t("Dedicated car", "需要专梯") : t("Sharing allowed", "允许合乘")}` : t("No snapshot saved", "未保存快照")}</span></p>;
}

function adjustmentLabel(change: string, interpretation: RequestInterpretation, t: Translate) {
  const i = interpretation;
  const { priority, load } = labels(t);
  if (change.startsWith("priority:") && i.raw) return t(`Dispatch rule: priority changed from ${priority[i.raw.priority]} to ${priority[i.priority]}.`, `调度规则：紧急程度由「${priority[i.raw.priority]}」调整为「${priority[i.priority]}」。`);
  if (change.startsWith("load:") && i.raw) return t(`Dispatch rule: load changed from ${load[i.raw.load]} to ${load[i.load]}.`, `调度规则：乘梯载荷由「${load[i.raw.load]}」调整为「${load[i.load]}」。`);
  if (change.startsWith("dedicated car")) {
    if (i.exclusiveCar > 0.5 && i.priority === "stat") return t("Dispatch rule: emergency priority requires a dedicated car, overriding the raw model score.", "调度规则：最终分类为急救，按规则安排专梯，覆盖模型的原始专梯分数。");
    if (i.exclusiveCar > 0.5 && i.load === "bed") return t("Dispatch rule: a bed fills the car and requires a dedicated trip, overriding the raw model score.", "调度规则：病床占满轿厢，必须安排专梯，覆盖模型的原始专梯分数。");
    return i.exclusiveCar > 0.5
      ? t("Dispatch rule: a dedicated car was approved based on an explicit requirement or a strong model signal.", "调度规则：专梯需满足明确独占要求或模型强信号门槛，校验后安排专梯。")
      : t("Dispatch rule: no explicit requirement or strong model signal; the dedicated-car restriction was removed.", "调度规则：未满足明确独占要求或模型强信号门槛，取消专梯限制，允许合乘。");
  }
  return change;
}

function HarnessStep({ passenger: p }: { passenger: Passenger }) {
  const { t } = useLanguage();
  const trace = p.trace;
  const changes = p.interp?.adjustments ?? [];
  return (
    <Step number="03" title={t("Harness validation and constraints", "Harness 校验与执行约束")}>
      <div className="space-y-2">
        <ProfileLine label={t("Initial rules", "即时规则预估")} profile={trace?.initialProfile} />
        {trace?.modelProfile && <ProfileLine label={t("Validated model advice", "模型＋校验建议")} profile={trace.modelProfile} />}
        <ProfileLine label={t("Applied constraints", "实际执行约束")} profile={trace?.profileAfterModel ?? p.profile} />
      </div>
      {changes.length > 0 ? <ul className="mt-3 space-y-1 border-l-2 border-amber-600/60 pl-3 text-xs text-amber-200/90">{changes.map((change, index) => <li key={index}>{p.interp ? adjustmentLabel(change, p.interp, t) : change}</li>)}</ul> : p.interp && <p className="mt-3 text-xs text-zinc-500">{t("The model classifications passed validation without correction.", "模型分类通过校验，无需修正原始判断。")}</p>}
      {trace?.modelStatus === "success" && <p className={`mt-2 text-xs ${trace.modelAppliedBeforePickup ? "text-emerald-400" : "text-amber-300"}`}>{clock(trace.modelCompletedAt ?? p.at)} · {trace.modelAppliedBeforePickup ? t("Applied before pickup. If the original car no longer meets the constraints, dispatch assigns a new car.", "在上梯前应用；如原派梯不再满足约束，会解除分配后重新选梯。") : t("Returned after pickup. Advice is recorded without changing the executed trip.", "模型在上梯后返回，仅记录建议，不改变已执行的安排。")}</p>}
      {trace?.modelStatus === "fallback" && <p className="mt-2 text-xs text-amber-300">{t("Model fallback: preserve known request facts and continue dispatching.", "模型失败回退：保留已知请求事实，继续派梯。")}</p>}
    </Step>
  );
}

function DispatchStep({ passenger: p }: { passenger: Passenger }) {
  const { locale, t } = useLanguage();
  const { basis } = labels(t);
  const assignments = p.trace?.assignments ?? [];
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);
  const pinnedSnapshot = snapshotAt !== null ? assignments.find((a) => a.at === snapshotAt) : undefined;
  const assignment = pinnedSnapshot ?? assignments[assignments.length - 1];
  return (
    <Step number="04" title={t("Dispatcher car selection", "调度器选梯")} aside={assignment && <span className="font-mono text-xs text-zinc-500">{t("Snapshot", "快照")} {clock(assignment.at)}</span>}>
      {!assignment ? <p className="text-xs text-zinc-400">{p.trace ? t("Waiting for the next dispatch evaluation.", "等待下一次派梯评估。") : t("This request predates trace capture. Reset the simulation to capture complete dispatch snapshots.", "这条请求产生于记录功能加载前；重置仿真后可查看完整选梯快照。")}</p> : (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-zinc-200">{assignment.car === null ? t("No eligible car yet; waiting", "暂无满足约束的电梯，继续等待") : <><strong className="text-emerald-300">{t("Selected", "选择")} {carName(assignment.car, t)}</strong><span className="ml-2 text-xs text-zinc-500">{t("Lowest score among eligible cars", "可用电梯中调度评分最低")}</span></>}</p>
            {assignments.length > 1 && <select aria-label={t(`Dispatch snapshots for request #${p.id}`, `请求 #${p.id} 的派梯快照`)} value={pinnedSnapshot?.at ?? "latest"} onChange={(event) => setSnapshotAt(event.target.value === "latest" ? null : Number(event.target.value))} className="max-w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300">
              <option value="latest">{t("Latest dispatch snapshot", "最新选梯记录")}</option>{assignments.map((a, index) => <option key={`${a.at}-${index}`} value={a.at}>{clock(a.at)} · {a.car === null ? t("Waiting", "等待") : carName(a.car, t)} · {basis[a.basis]}</option>)}
            </select>}
          </div>
          <p className="mb-2 text-[11px] text-zinc-500">{t(`Dispatch basis: ${basis[assignment.basis]}. StartLux supplies semantic judgments; dispatch code calculates the scores below. If the original assignment still meets the constraints after the model returns, it is retained without rescoring.`, `派梯时依据：${basis[assignment.basis]}。StartLux 提供语义判断，下面的评分由调度代码计算。模型返回后若原分配仍满足约束，会保留原选梯，不重新评分。`)}</p>
          <CandidateTable assignment={assignment} />
          <p className="mt-2 text-[11px] leading-5 text-zinc-500">{t("Dispatch score = arrival ETA + passenger delay cost + fault penalty + reassignment penalty − emergency reservation bonus. This score is not elapsed time. Lower is better; ineligible cars are excluded.", "调度评分 = 预计到达时间 + 乘客延误代价 + 故障惩罚 + 重派惩罚 − 急救预约加分。评分不是实际耗时；数值越低越优先。不满足约束的电梯不参与比较。")}</p>
        </>
      )}
      {!!p.trace?.events.length && <details className="mt-3 text-xs text-zinc-400"><summary className="cursor-pointer">{t(`Execution timeline (latest ${p.trace.events.length})`, `执行时间线（最近 ${p.trace.events.length} 条）`)}</summary><ol className="mt-2 space-y-1.5">{p.trace.events.map((event, index) => <li key={index} className="flex gap-3"><span className="shrink-0 font-mono text-zinc-500">{clock(event.at)}</span><span>{traceMessage(event.message, locale)}</span></li>)}</ol></details>}
    </Step>
  );
}

function CandidateTable({ assignment }: { assignment: AssignmentTrace }) {
  const { t } = useLanguage();
  const { rejection } = labels(t);
  return (
    <div className="overflow-x-auto rounded border border-zinc-800">
      <table className="w-full text-left text-xs">
        <thead className="bg-zinc-900 text-zinc-500"><tr>{[t("Car", "电梯"), t("Position", "位置"), t("ETA", "预计到达"), t("Delay cost", "延误代价"), t("Fault + Reassign − Reserve", "故障 + 重派 − 预约"), t("Score / Exclusion", "评分 / 排除原因")].map((label) => <th key={label} scope="col" className="whitespace-nowrap px-2.5 py-2 font-normal">{label}</th>)}</tr></thead>
        <tbody>{assignment.candidates.map((candidate) => <tr key={candidate.car} className={`border-t border-zinc-800 ${candidate.selected ? "bg-emerald-950/50 text-emerald-200" : "text-zinc-400"}`}>
          <th scope="row" className="whitespace-nowrap px-2.5 py-2 font-medium">{candidate.selected ? "✓ " : ""}{carName(candidate.car, t)}</th>
          <td className="px-2.5 py-2 font-mono">{candidate.position.toFixed(1)}F</td>
          {candidate.score ? <><td className="px-2.5 py-2 font-mono">{candidate.score.eta.toFixed(1)}s</td><td className="px-2.5 py-2 font-mono">{candidate.score.disruption.toFixed(1)}</td><td className="whitespace-nowrap px-2.5 py-2 font-mono">{candidate.score.faultPenalty.toFixed(1)} + {candidate.score.reassignmentPenalty.toFixed(1)} − {candidate.score.reservationBonus.toFixed(1)}</td><td className="px-2.5 py-2 font-mono font-medium">{candidate.score.total.toFixed(1)}{candidate.displacedPassengerIds.length > 0 && <span className="ml-2 font-sans text-[10px]">{t(`${candidate.displacedPassengerIds.length} reassigned`, `重派 ${candidate.displacedPassengerIds.length} 条`)}</span>}</td></> : <td colSpan={4} className="px-2.5 py-2 text-[11px] text-zinc-500">{rejection[candidate.rejection ?? ""] ?? t("Does not meet dispatch constraints", "不满足当前派梯约束")}</td>}
        </tr>)}</tbody>
      </table>
    </div>
  );
}
