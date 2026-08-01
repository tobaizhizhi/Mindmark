"use client";

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Database,
  FileWarning,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type {
  LearningQualityOperationsReport,
  WorkflowOperationsSnapshot,
} from "@mindmark/shared";

type ApiError = { error?: { message?: string; requestId?: string } };

type Metric = {
  label: string;
  value: number;
  tone: "neutral" | "working" | "warning" | "danger" | "success";
};

async function parseApi<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) {
    const reference = body.error?.requestId ? ` (${body.error.requestId})` : "";
    throw new Error(`${body.error?.message ?? "无法读取运营状态"}${reference}`);
  }
  return body;
}

function percentage(numerator: number, denominator: number) {
  if (denominator === 0) return "-";
  return `${Math.round(numerator * 100 / denominator)}%`;
}

function statusTone(status: string) {
  if (status === "FAILED" || status === "CANCELLED") return "danger";
  if (status === "RETRYABLE") return "warning";
  if (status === "RUNNING") return "working";
  return "neutral";
}

function formatTime(value: string | null) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function targetLabel(job: WorkflowOperationsSnapshot["jobs"][number]) {
  const parts = [];
  if (job.chapterId !== null) parts.push(`章节 ${job.chapterId + 1}`);
  if (job.workUnitId !== null) parts.push(`单元 ${job.workUnitId + 1}`);
  return parts.length ? parts.join(" / ") : "项目级";
}

function eventDetail(event: WorkflowOperationsSnapshot["events"][number]) {
  const entries = Object.entries(event.payload).map(([key, value]) => `${key}: ${String(value)}`);
  return entries.length ? entries.join(" · ").slice(0, 180) : "-";
}

export function OperationsWorkspace() {
  const [snapshot, setSnapshot] = useState<WorkflowOperationsSnapshot | null>(null);
  const [qualityReport, setQualityReport] = useState<LearningQualityOperationsReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qualityError, setQualityError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const next = await parseApi<WorkflowOperationsSnapshot>(await fetch("/api/operations", { cache: "no-store" }));
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取运营状态");
    } finally {
      if (manual) setRefreshing(false);
    }
    try {
      const nextQuality = await parseApi<LearningQualityOperationsReport>(await fetch("/api/operations/quality", { cache: "no-store" }));
      setQualityReport(nextQuality);
      setQualityError(null);
    } catch (caught) {
      setQualityError(caught instanceof Error ? caught.message : "无法读取质量汇总");
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const metrics: Metric[] = snapshot ? [
    { label: "等待领取", value: snapshot.metrics.queuedJobs, tone: "neutral" },
    { label: "运行中", value: snapshot.metrics.runningJobs, tone: "working" },
    { label: "可重试", value: snapshot.metrics.retryableJobs, tone: "warning" },
    { label: "已失败", value: snapshot.metrics.failedJobs, tone: "danger" },
    { label: "超时租约", value: snapshot.metrics.staleJobs, tone: snapshot.metrics.staleJobs ? "danger" : "success" },
    { label: "已完成", value: snapshot.metrics.succeededJobs, tone: "success" },
    { label: "待结算奖励", value: snapshot.metrics.pendingRewards, tone: "working" },
    { label: "受阻奖励", value: snapshot.metrics.blockedRewards, tone: snapshot.metrics.blockedRewards ? "danger" : "success" },
  ] : [];
  const qualityMetrics: Metric[] = qualityReport ? [
    { label: "学习者反馈", value: qualityReport.feedback.totalCount, tone: "neutral" },
    { label: "认为有帮助", value: qualityReport.feedback.upCount, tone: "success" },
    { label: "需要关注", value: qualityReport.feedback.incorrectCount + qualityReport.feedback.unclearCount, tone: qualityReport.feedback.incorrectCount + qualityReport.feedback.unclearCount ? "warning" : "success" },
    { label: "待修复槽位", value: qualityReport.slots.filter((slot) => slot.status === "REPAIR_REQUESTED").length, tone: qualityReport.slots.some((slot) => slot.status === "REPAIR_REQUESTED") ? "warning" : "success" },
  ] : [];

  return (
    <main className="operations-shell">
      <header className="operations-header">
        <div className="operations-brand">
          <span className="operations-brand-mark"><Activity /></span>
          <div>
            <p>Mindmark / Operations</p>
            <h1>运行诊断</h1>
          </div>
        </div>
        <div className="operations-header-actions">
          {snapshot ? <span className="operations-updated"><Clock3 />更新于 {formatTime(snapshot.generatedAt)}</span> : null}
          <button
            type="button"
            className="icon-button"
            onClick={() => void refresh(true)}
            disabled={refreshing}
            aria-label="刷新运营状态"
            title="刷新运营状态"
          >
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </button>
        </div>
      </header>

      {error ? (
        <section className="operations-access" aria-live="polite">
          <span><ShieldAlert /></span>
          <div>
            <h2>无法读取运营数据</h2>
            <p>{error}</p>
          </div>
          <Link href="/learn" className="command-button command-button-quiet">返回资料库</Link>
        </section>
      ) : null}

      {!snapshot && !error ? (
        <section className="operations-loading" aria-label="正在读取运营状态">
          <Database className="animate-pulse" />
          <p>正在读取工作流队列</p>
        </section>
      ) : null}

      {snapshot ? (
        <div className="operations-content">
          <section className="operations-metrics" aria-label="工作流指标">
            {metrics.map((metric) => (
              <div key={metric.label} className="operations-metric" data-tone={metric.tone}>
                <span>{metric.label}</span>
                <strong>{metric.value}</strong>
              </div>
            ))}
          </section>

          {snapshot.alerts.length ? (
            <section className="operations-alerts" aria-label="需要处理的告警">
              {snapshot.alerts.map((alert) => (
                <div key={alert.code} data-severity={alert.severity}>
                  {alert.severity === "critical" ? <XCircle /> : <AlertTriangle />}
                  <p><strong>{alert.count}</strong>{alert.message}</p>
                  <code>{alert.code}</code>
                </div>
              ))}
            </section>
          ) : null}

          <section className="operations-section" aria-labelledby="quality-heading">
            <div className="operations-section-heading">
              <div>
                <p>Learning quality</p>
                <h2 id="quality-heading">生成质量与学习者反馈</h2>
              </div>
              {qualityReport ? <span>更新于 {formatTime(qualityReport.generatedAt)}</span> : null}
            </div>
            {qualityError ? (
              <div className="quality-unavailable">
                <FileWarning />
                <p>{qualityError}</p>
              </div>
            ) : qualityReport ? (
              <>
                <div className="quality-metrics" aria-label="质量汇总指标">
                  {qualityMetrics.map((metric) => (
                    <div key={metric.label} className="operations-metric" data-tone={metric.tone}>
                      <span>{metric.label}</span>
                      <strong>{metric.value}</strong>
                    </div>
                  ))}
                  <div className="quality-rate">
                    <span>有帮助占比</span>
                    <strong>{percentage(qualityReport.feedback.upCount, qualityReport.feedback.totalCount)}</strong>
                  </div>
                </div>
                <div className="quality-breakdown">
                  <div>
                    <span>反馈分类</span>
                    <p>无帮助 {qualityReport.feedback.downCount} · 事实有误 {qualityReport.feedback.incorrectCount} · 表述不清 {qualityReport.feedback.unclearCount}</p>
                  </div>
                  <div>
                    <span>主要修复原因</span>
                    <p>{qualityReport.failureCategories.length ? qualityReport.failureCategories.slice(0, 3).map((failure) => `${failure.code} (${failure.count})`).join(" · ") : "尚无质量失败记录"}</p>
                  </div>
                </div>
                {qualityReport.chapters.length ? (
                  <div className="operations-table-scroll">
                    <table className="operations-table quality-table">
                      <thead>
                        <tr><th>项目 / 章节</th><th>槽位通过</th><th>质量评估</th><th>学习者反馈</th></tr>
                      </thead>
                      <tbody>
                        {qualityReport.chapters.map((chapter) => (
                          <tr key={`${chapter.projectId}:${chapter.chapterId}`}>
                            <td><strong>{chapter.projectId.slice(0, 10)}...{chapter.projectId.slice(-6)}</strong><small>章节 {chapter.chapterId + 1}</small></td>
                            <td>{chapter.acceptedSlotCount} / {chapter.requiredSlotCount} 必需槽位</td>
                            <td>{chapter.approvedEvaluationCount} 通过 · {chapter.repairRequestedEvaluationCount} 修复 · {chapter.failedEvaluationCount} 失败</td>
                            <td>{chapter.feedback.totalCount} 条 · 有帮助 {percentage(chapter.feedback.upCount, chapter.feedback.totalCount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <div className="operations-empty"><Activity /><span>尚无 V3 质量数据</span></div>}
                {qualityReport.slots.length ? (
                  <>
                    <div className="quality-subheading"><span>Blueprint slots</span><strong>槽位质量明细</strong><small>{qualityReport.slots.length} 条</small></div>
                    <div className="operations-table-scroll">
                      <table className="operations-table quality-slot-table">
                        <thead>
                          <tr><th>项目 / 章节</th><th>槽位</th><th>类型</th><th>状态</th><th>评估</th><th>学习者反馈</th></tr>
                        </thead>
                        <tbody>
                          {qualityReport.slots.map((slot) => (
                            <tr key={`${slot.projectId}:${slot.chapterId}:${slot.slotId}`}>
                              <td><strong>{slot.projectId.slice(0, 10)}...{slot.projectId.slice(-6)}</strong><small>章节 {slot.chapterId + 1}</small></td>
                              <td><code>{slot.slotId.slice(0, 10)}...{slot.slotId.slice(-6)}</code></td>
                              <td>{slot.cardType}{slot.required ? " · 必需" : ""}</td>
                              <td><span className="operations-status" data-tone={slot.status === "ACCEPTED" ? "success" : slot.status === "REPAIR_REQUESTED" || slot.status === "REJECTED" ? "warning" : "neutral"}>{slot.status}</span></td>
                              <td>{slot.approvedEvaluationCount} 通过 · {slot.repairRequestedEvaluationCount} 修复 · {slot.failedEvaluationCount} 失败</td>
                              <td>{slot.feedback.totalCount} 条 · 关注 {slot.feedback.incorrectCount + slot.feedback.unclearCount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
              </>
            ) : <div className="operations-empty"><Database className="animate-pulse" /><span>正在读取质量汇总</span></div>}
          </section>

          <section className="operations-section" aria-labelledby="active-jobs-heading">
            <div className="operations-section-heading">
              <div>
                <p>Workflow jobs</p>
                <h2 id="active-jobs-heading">待处理与失败任务</h2>
              </div>
              <span>{snapshot.jobs.length} 条</span>
            </div>
            {snapshot.jobs.length ? (
              <div className="operations-table-scroll">
                <table className="operations-table">
                  <thead>
                    <tr><th>项目</th><th>阶段</th><th>资源</th><th>状态</th><th>尝试</th><th>可用时间</th><th>错误摘要</th></tr>
                  </thead>
                  <tbody>
                    {snapshot.jobs.map((job) => (
                      <tr key={job.jobId}>
                        <td><strong>{job.projectTitle}</strong><small>{job.projectId.slice(0, 10)}...{job.projectId.slice(-6)}</small></td>
                        <td><code>{job.kind}</code></td>
                        <td>{targetLabel(job)}</td>
                        <td><span className="operations-status" data-tone={statusTone(job.status)}>{job.status}</span></td>
                        <td>{job.attempt}</td>
                        <td><time dateTime={job.availableAt}>{formatTime(job.availableAt)}</time></td>
                        <td className="operations-error-cell">{job.lastError ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="operations-empty"><CheckCircle2 /><span>没有待处理或失败任务</span></div>
            )}
          </section>

          <section className="operations-section" aria-labelledby="events-heading">
            <div className="operations-section-heading">
              <div>
                <p>Workflow events</p>
                <h2 id="events-heading">最近运行事件</h2>
              </div>
              <span>{snapshot.events.length} 条</span>
            </div>
            {snapshot.events.length ? (
              <ol className="operations-events">
                {snapshot.events.map((event) => (
                  <li key={event.eventId}>
                    <span className="operations-event-icon" data-tone={event.eventType.includes("FAILED") ? "danger" : "neutral"}>
                      {event.eventType.includes("FAILED") ? <XCircle /> : event.eventType.includes("RETRY") ? <AlertTriangle /> : <Activity />}
                    </span>
                    <div>
                      <strong>{event.eventType}</strong>
                      <p>{eventDetail(event)}</p>
                    </div>
                    <time dateTime={event.createdAt}>{formatTime(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : <div className="operations-empty"><Activity /><span>尚无运行事件</span></div>}
          </section>
        </div>
      ) : null}
    </main>
  );
}
