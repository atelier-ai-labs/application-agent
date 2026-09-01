export type ExecutionNodeKind =
  | "deterministic"
  | "external_io"
  | "judgment"
  | "persistence"
  | "human_gate"
  | "consequential_side_effect";

export type ExecutionNodeOutcome = "success" | "partial" | "failed" | "skipped" | "blocked";

export type ExecutionRunKind = "campaign_run";

/** Conservative local bound for persisted campaign-run telemetry. */
export const EXECUTION_RUN_HISTORY_LIMIT = 5;

/** Stable, non-sensitive categories used for operational failure reporting. */
export type ExecutionFailureReason =
  | "timeout"
  | "provider_error"
  | "provider_configuration"
  | "validation_error"
  | "policy_rejected"
  | "blocker"
  | "authentication_required"
  | "human_gate"
  | "browser_interrupted"
  | "tracker_failure"
  | "cancelled"
  | "unknown";

/** Stable categories for existing user-attention events. */
export type HumanAttentionCategory =
  | "candidate_fact_missing"
  | "subjective_answer"
  | "policy_decision"
  | "login"
  | "mfa"
  | "captcha"
  | "unsupported_field"
  | "resume_artifact_missing"
  | "manual_submission"
  | "tracker_auth"
  | "tracker_failure"
  | "provider_configuration"
  | "operational_failure";

export interface ExecutionExternalMetrics {
  requestCount?: number;
  successCount?: number;
  failureCount?: number;
  timeoutCount?: number;
  cancellationCount?: number;
  lateCompletionCount?: number;
}

export interface ExecutionStageSummary {
  stage: string;
  nodeCount: number;
  /** Sum of node durations. This can overlap for parent/child or parallel nodes. */
  inclusiveDurationMs: number;
  /** Duration attributed to the node after direct child coverage is removed. */
  exclusiveDurationMs: number;
  /** Union of observed stage intervals; the safest stage wall-clock measure. */
  wallClockDurationMs: number;
  retryCount: number;
  failureCount: number;
  externalRequestCount: number;
  externalSuccessCount: number;
  externalFailureCount: number;
  timeoutCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  humanAttentionEvents: number;
}

export interface ExecutionRunSummary {
  totalDurationMs: number;
  humanWaitDurationMs: number;
  retryCount: number;
  failureCount: number;
  externalRequestCount: number;
  externalSuccessCount: number;
  externalFailureCount: number;
  timeoutCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  humanAttentionEvents: number;
  attentionByCategory: Partial<Record<HumanAttentionCategory, number>>;
  stageSummaries: readonly ExecutionStageSummary[];
  slowestStages: readonly Pick<ExecutionStageSummary, "stage" | "wallClockDurationMs">[];
}

/** Operational trace only. Do not put profile content, answers, tokens, or page data here. */
export interface ExecutionNodeTrace {
  nodeId: string;
  nodeKind: ExecutionNodeKind;
  startedAt: string;
  completedAt: string;
  /** Inclusive elapsed time for this node boundary. */
  durationMs: number;
  /** Derived self time; excludes the wall-clock union of direct child nodes. */
  exclusiveDurationMs?: number;
  parentNodeId?: string;
  outcome: ExecutionNodeOutcome;
  attempt: number;
  inputCount?: number;
  outputCount?: number;
  cacheHit?: boolean;
  retryReason?: string;
  retryReasonCode?: ExecutionFailureReason;
  previousOutcome?: ExecutionNodeOutcome;
  failureReason?: ExecutionFailureReason;
  externalRequestCount?: number;
  externalSuccessCount?: number;
  externalFailureCount?: number;
  timeoutCount?: number;
  cancellationCount?: number;
  lateCompletionCount?: number;
  humanAttentionRequired?: boolean;
  humanAttentionCategory?: HumanAttentionCategory;
  /** Reserved for future external-model instrumentation; absent for local code. */
  modelProvider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface ExecutionRunTrace {
  runId: string;
  runKind: ExecutionRunKind;
  startedAt: string;
  completedAt: string;
  /** Agent wall-clock duration. Human waiting is recorded separately. */
  durationMs: number;
  retryCount: number;
  humanAttentionEvents: number;
  humanWaitDurationMs?: number;
  attentionByCategory?: Partial<Record<HumanAttentionCategory, number>>;
  nodes: readonly ExecutionNodeTrace[];
  summary?: ExecutionRunSummary;
}

export interface ExecutionNodeTraceInput {
  nodeId: string;
  nodeKind: ExecutionNodeKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exclusiveDurationMs?: number;
  parentNodeId?: string;
  outcome: ExecutionNodeOutcome;
  attempt?: number;
  inputCount?: number;
  outputCount?: number;
  cacheHit?: boolean;
  retryReason?: string;
  retryReasonCode?: ExecutionFailureReason;
  previousOutcome?: ExecutionNodeOutcome;
  failureReason?: ExecutionFailureReason;
  externalRequestCount?: number;
  externalSuccessCount?: number;
  externalFailureCount?: number;
  timeoutCount?: number;
  cancellationCount?: number;
  lateCompletionCount?: number;
  humanAttentionRequired?: boolean;
  humanAttentionCategory?: HumanAttentionCategory;
  modelProvider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  metadata?: Readonly<Record<string, string>>;
}

export function monotonicNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function createExecutionNodeTrace(input: ExecutionNodeTraceInput): ExecutionNodeTrace {
  return {
    ...input,
    attempt: input.attempt ?? 1,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    ...(input.exclusiveDurationMs !== undefined
      ? { exclusiveDurationMs: Math.max(0, Math.round(input.exclusiveDurationMs)) }
      : {}),
  };
}

export interface ExecutionMeasureOptions<T> {
  attempt?: number;
  inputCount?: number;
  outputCount?: (value: T) => number | undefined;
  outcome?: (value: T) => ExecutionNodeOutcome;
  cacheHit?: (value: T) => boolean | undefined;
  humanAttentionRequired?: (value: T) => boolean | undefined;
  humanAttentionCategory?: (value: T) => HumanAttentionCategory | undefined;
  failureReason?: ExecutionFailureReason | ((value: T) => ExecutionFailureReason | undefined);
  failureReasonOnError?: ExecutionFailureReason;
  retryReason?: string;
  retryReasonCode?: ExecutionFailureReason;
  previousOutcome?: ExecutionNodeOutcome;
  parentNodeId?: string;
  externalMetrics?: (value: T) => ExecutionExternalMetrics | undefined;
  externalMetricsOnError?: ExecutionExternalMetrics;
  modelProvider?: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCost?: number;
  metadata?: Readonly<Record<string, string>>;
}

/**
 * Classifies an error without retaining its message. The raw error remains
 * available to normal developer logging, while persisted telemetry gets only
 * this stable category.
 */
export function executionFailureReason(error: unknown): ExecutionFailureReason {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message.toLowerCase() : typeof error === "string" ? error.toLowerCase() : "";
  const text = `${name} ${message}`;
  if (text.includes("cancel") || name === "aborterror") return "cancelled";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("captcha") || text.includes("human") || text.includes("login") || text.includes("mfa")) return "human_gate";
  if (text.includes("auth") || text.includes("credential") || text.includes("oauth")) return "authentication_required";
  if (text.includes("tracker")) return "tracker_failure";
  if (text.includes("browser") || text.includes("execution host") || text.includes("session")) return "browser_interrupted";
  if (text.includes("not configured") || text.includes("configuration")) return "provider_configuration";
  if (text.includes("provider") || text.includes("http") || text.includes("fetch")) return "provider_error";
  if (text.includes("validation") || text.includes("malformed") || text.includes("required")) return "validation_error";
  if (text.includes("policy") || text.includes("not allowed")) return "policy_rejected";
  if (text.includes("blocker") || text.includes("needs input")) return "blocker";
  return "unknown";
}

/**
 * A small recorder for an actual run. It records observations; it does not
 * define or execute a graph topology.
 */
export class ExecutionTraceBuilder {
  private readonly nodes: ExecutionNodeTrace[] = [];
  private humanAttentionEventCount = 0;
  private humanWaitMs = 0;
  private attentionCategories: Partial<Record<HumanAttentionCategory, number>> = {};
  private readonly monotonicStartedAt = monotonicNow();

  constructor(
    public readonly runId: string,
    public readonly runKind: ExecutionRunKind,
    private readonly now: () => string,
    public readonly startedAt: string,
  ) {}

  add(node: ExecutionNodeTrace): void {
    this.nodes.push(node);
  }

  addMany(nodes: readonly ExecutionNodeTrace[]): void {
    this.nodes.push(...nodes);
  }

  setHumanAttentionEvents(count: number, categories: Partial<Record<HumanAttentionCategory, number>> = {}): void {
    this.humanAttentionEventCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.attentionCategories = Object.fromEntries(
      Object.entries(categories)
        .filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0)
        .map(([category, value]) => [category, Math.floor(value as number)]),
    ) as Partial<Record<HumanAttentionCategory, number>>;
  }

  setHumanWaitDuration(durationMs: number): void {
    this.humanWaitMs = Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0;
  }

  async measure<T>(
    nodeId: string,
    nodeKind: ExecutionNodeKind,
    operation: () => Promise<T>,
    options: ExecutionMeasureOptions<T> = {},
  ): Promise<T> {
    const startedAt = this.now();
    const monotonicStartedAt = monotonicNow();
    try {
      const result = await operation();
      this.add(this.nodeForResult(nodeId, nodeKind, startedAt, this.now(), monotonicNow() - monotonicStartedAt, result, options));
      return result;
    } catch (error) {
      this.add(this.nodeForError(nodeId, nodeKind, startedAt, this.now(), monotonicNow() - monotonicStartedAt, error, options));
      throw error;
    }
  }

  measureSync<T>(
    nodeId: string,
    nodeKind: ExecutionNodeKind,
    operation: () => T,
    options: ExecutionMeasureOptions<T> = {},
  ): T {
    const startedAt = this.now();
    const monotonicStartedAt = monotonicNow();
    try {
      const result = operation();
      this.add(this.nodeForResult(nodeId, nodeKind, startedAt, this.now(), monotonicNow() - monotonicStartedAt, result, options));
      return result;
    } catch (error) {
      this.add(this.nodeForError(nodeId, nodeKind, startedAt, this.now(), monotonicNow() - monotonicStartedAt, error, options));
      throw error;
    }
  }

  finish(completedAt = this.now()): ExecutionRunTrace {
    const durationMs = Math.max(0, Math.round(monotonicNow() - this.monotonicStartedAt));
    const nodes = deriveExclusiveDurations(this.nodes);
    const retryCount = nodes.reduce((total, node) => total + Math.max(0, node.attempt - 1), 0);
    const summary = summarizeExecutionRun(nodes, {
      totalDurationMs: durationMs,
      retryCount,
      humanAttentionEvents: this.humanAttentionEventCount,
      humanWaitDurationMs: this.humanWaitMs,
      attentionByCategory: this.attentionCategories,
    });
    return {
      runId: this.runId,
      runKind: this.runKind,
      startedAt: this.startedAt,
      completedAt,
      durationMs,
      retryCount,
      humanAttentionEvents: this.humanAttentionEventCount,
      ...(this.humanWaitMs > 0 ? { humanWaitDurationMs: this.humanWaitMs } : {}),
      ...(Object.keys(this.attentionCategories).length > 0 ? { attentionByCategory: this.attentionCategories } : {}),
      nodes,
      summary,
    };
  }

  private nodeForResult<T>(
    nodeId: string,
    nodeKind: ExecutionNodeKind,
    startedAt: string,
    completedAt: string,
    durationMs: number,
    result: T,
    options: ExecutionMeasureOptions<T>,
  ): ExecutionNodeTrace {
    const external = options.externalMetrics?.(result);
    const failureReason = typeof options.failureReason === "function" ? options.failureReason(result) : options.failureReason;
    const attentionCategory = options.humanAttentionCategory?.(result);
    return createExecutionNodeTrace({
      nodeId,
      nodeKind,
      startedAt,
      completedAt,
      durationMs,
      outcome: options.outcome?.(result) ?? "success",
      ...this.optionalOptions(options),
      ...(options.outputCount ? { outputCount: options.outputCount(result) } : {}),
      ...(options.cacheHit ? { cacheHit: options.cacheHit(result) } : {}),
      ...(options.humanAttentionRequired ? { humanAttentionRequired: options.humanAttentionRequired(result) } : {}),
      ...(failureReason ? { failureReason } : {}),
      ...(attentionCategory ? { humanAttentionCategory: attentionCategory } : {}),
      ...(external ? externalFields(external) : {}),
    });
  }

  private nodeForError<T>(
    nodeId: string,
    nodeKind: ExecutionNodeKind,
    startedAt: string,
    completedAt: string,
    durationMs: number,
    error: unknown,
    options: ExecutionMeasureOptions<T>,
  ): ExecutionNodeTrace {
    return createExecutionNodeTrace({
      nodeId,
      nodeKind,
      startedAt,
      completedAt,
      durationMs,
      outcome: "failed",
      ...this.optionalOptions(options),
      failureReason: options.failureReasonOnError ?? executionFailureReason(error),
      ...(options.externalMetricsOnError ? externalFields(options.externalMetricsOnError) : {}),
    });
  }

  private optionalOptions<T>(options: ExecutionMeasureOptions<T>): Omit<ExecutionNodeTraceInput, "nodeId" | "nodeKind" | "startedAt" | "completedAt" | "durationMs" | "outcome"> {
    return {
      ...(options.attempt !== undefined ? { attempt: Math.max(1, Math.floor(options.attempt)) } : {}),
      ...(options.inputCount !== undefined ? { inputCount: options.inputCount } : {}),
      ...(options.retryReason ? { retryReason: options.retryReason } : {}),
      ...(options.retryReasonCode ? { retryReasonCode: options.retryReasonCode } : {}),
      ...(options.previousOutcome ? { previousOutcome: options.previousOutcome } : {}),
      ...(options.parentNodeId ? { parentNodeId: options.parentNodeId } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      ...(options.modelId ? { modelId: options.modelId } : {}),
      ...(options.inputTokens !== undefined ? { inputTokens: options.inputTokens } : {}),
      ...(options.outputTokens !== undefined ? { outputTokens: options.outputTokens } : {}),
      ...(options.estimatedCost !== undefined ? { estimatedCost: options.estimatedCost } : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
    } as Omit<ExecutionNodeTraceInput, "nodeId" | "nodeKind" | "startedAt" | "completedAt" | "durationMs" | "outcome">;
  }
}

function externalFields(metrics: ExecutionExternalMetrics): Partial<ExecutionNodeTraceInput> {
  return {
    ...(metrics.requestCount !== undefined ? { externalRequestCount: metrics.requestCount } : {}),
    ...(metrics.successCount !== undefined ? { externalSuccessCount: metrics.successCount } : {}),
    ...(metrics.failureCount !== undefined ? { externalFailureCount: metrics.failureCount } : {}),
    ...(metrics.timeoutCount !== undefined ? { timeoutCount: metrics.timeoutCount } : {}),
    ...(metrics.cancellationCount !== undefined ? { cancellationCount: metrics.cancellationCount } : {}),
    ...(metrics.lateCompletionCount !== undefined ? { lateCompletionCount: metrics.lateCompletionCount } : {}),
  };
}

function deriveExclusiveDurations(nodes: readonly ExecutionNodeTrace[]): readonly ExecutionNodeTrace[] {
  const children = new Map<string, ExecutionNodeTrace[]>();
  for (const node of nodes) {
    if (!node.parentNodeId) continue;
    const current = children.get(node.parentNodeId) ?? [];
    current.push(node);
    children.set(node.parentNodeId, current);
  }
  return nodes.map((node) => {
    const directChildren = children.get(node.nodeId) ?? [];
    if (directChildren.length === 0) {
      return { ...node, exclusiveDurationMs: Math.max(0, Math.round(node.durationMs)) };
    }
    const parentInterval = timestampInterval(node);
    const childIntervals = directChildren.map(timestampInterval).filter((interval): interval is [number, number] => interval !== undefined);
    const wallCovered = parentInterval && childIntervals.length > 0
      ? intervalUnionDuration(childIntervals.map(([start, end]) => [
        Math.max(start, parentInterval[0]),
        Math.min(end, parentInterval[1]),
      ] as [number, number]).filter(([start, end]) => end >= start))
      : Math.max(...directChildren.map((child) => child.durationMs), 0);
    const covered = Math.min(node.durationMs, Math.max(wallCovered, Math.max(...directChildren.map((child) => child.durationMs), 0)));
    return {
      ...node,
      exclusiveDurationMs: Math.max(0, Math.round(node.durationMs - covered)),
    };
  });
}

function timestampInterval(node: Pick<ExecutionNodeTrace, "startedAt" | "completedAt">): [number, number] | undefined {
  const start = Date.parse(node.startedAt);
  const end = Date.parse(node.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return undefined;
  return [start, end];
}

function intervalUnionDuration(intervals: readonly [number, number][]): number {
  if (intervals.length === 0) return 0;
  const ordered = [...intervals].sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  let total = 0;
  let start = ordered[0][0];
  let end = ordered[0][1];
  for (const [nextStart, nextEnd] of ordered.slice(1)) {
    if (nextStart <= end) end = Math.max(end, nextEnd);
    else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }
  return total + end - start;
}

function summarizeExecutionRun(
  nodes: readonly ExecutionNodeTrace[],
  run: {
    totalDurationMs: number;
    retryCount: number;
    humanAttentionEvents: number;
    humanWaitDurationMs: number;
    attentionByCategory: Partial<Record<HumanAttentionCategory, number>>;
  },
): ExecutionRunSummary {
  const groups = new Map<string, ExecutionNodeTrace[]>();
  for (const node of nodes) {
    const stage = node.metadata?.stage ?? node.nodeId;
    const current = groups.get(stage) ?? [];
    current.push(node);
    groups.set(stage, current);
  }
  const stageSummaries = [...groups.entries()].map(([stage, stageNodes]) => ({
    stage,
    nodeCount: stageNodes.length,
    inclusiveDurationMs: sum(stageNodes.map((node) => node.durationMs)),
    exclusiveDurationMs: sum(stageNodes.map((node) => node.exclusiveDurationMs ?? node.durationMs)),
    wallClockDurationMs: stageWallClockDuration(stageNodes),
    retryCount: sum(stageNodes.map((node) => Math.max(0, node.attempt - 1))),
    failureCount: stageNodes.filter((node) => node.outcome === "failed").length,
    externalRequestCount: sum(stageNodes.map((node) => node.externalRequestCount ?? 0)),
    externalSuccessCount: sum(stageNodes.map((node) => node.externalSuccessCount ?? 0)),
    externalFailureCount: sum(stageNodes.map((node) => node.externalFailureCount ?? 0)),
    timeoutCount: sum(stageNodes.map((node) => node.timeoutCount ?? 0)),
    cacheHitCount: stageNodes.filter((node) => node.cacheHit === true).length,
    cacheMissCount: stageNodes.filter((node) => node.cacheHit === false).length,
    humanAttentionEvents: stageNodes.filter((node) => node.humanAttentionRequired === true).length,
  })).sort((left, right) => left.stage.localeCompare(right.stage));
  const slowestStages = [...stageSummaries]
    .sort((left, right) => right.wallClockDurationMs - left.wallClockDurationMs || left.stage.localeCompare(right.stage))
    .slice(0, 5)
    .map(({ stage, wallClockDurationMs }) => ({ stage, wallClockDurationMs }));
  return {
    totalDurationMs: run.totalDurationMs,
    humanWaitDurationMs: run.humanWaitDurationMs,
    retryCount: run.retryCount,
    failureCount: nodes.filter((node) => node.outcome === "failed").length,
    externalRequestCount: sum(nodes.map((node) => node.externalRequestCount ?? 0)),
    externalSuccessCount: sum(nodes.map((node) => node.externalSuccessCount ?? 0)),
    externalFailureCount: sum(nodes.map((node) => node.externalFailureCount ?? 0)),
    timeoutCount: sum(nodes.map((node) => node.timeoutCount ?? 0)),
    cacheHitCount: nodes.filter((node) => node.cacheHit === true).length,
    cacheMissCount: nodes.filter((node) => node.cacheHit === false).length,
    humanAttentionEvents: run.humanAttentionEvents,
    attentionByCategory: { ...run.attentionByCategory },
    stageSummaries,
    slowestStages,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + Math.max(0, Math.round(value)), 0);
}

function stageWallClockDuration(nodes: readonly ExecutionNodeTrace[]): number {
  const observed = intervalUnionDuration(nodes.map(timestampInterval).filter((interval): interval is [number, number] => interval !== undefined));
  return observed > 0 ? observed : Math.max(...nodes.map((node) => node.durationMs), 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNodeKind(value: unknown): value is ExecutionNodeKind {
  return value === "deterministic" || value === "external_io" || value === "judgment" ||
    value === "persistence" || value === "human_gate" || value === "consequential_side_effect";
}

function isNodeOutcome(value: unknown): value is ExecutionNodeOutcome {
  return value === "success" || value === "partial" || value === "failed" || value === "skipped" || value === "blocked";
}

export function isExecutionFailureReason(value: unknown): value is ExecutionFailureReason {
  return value === "timeout" || value === "provider_error" || value === "provider_configuration" || value === "validation_error" ||
    value === "policy_rejected" || value === "blocker" || value === "authentication_required" ||
    value === "human_gate" || value === "browser_interrupted" || value === "tracker_failure" ||
    value === "cancelled" || value === "unknown";
}

export function isHumanAttentionCategory(value: unknown): value is HumanAttentionCategory {
  return value === "candidate_fact_missing" || value === "subjective_answer" || value === "policy_decision" ||
    value === "login" || value === "mfa" || value === "captcha" || value === "unsupported_field" ||
    value === "resume_artifact_missing" || value === "manual_submission" || value === "tracker_auth" ||
    value === "tracker_failure" || value === "provider_configuration" || value === "operational_failure";
}

function isSafeMetadata(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isOptionalCounter(value: unknown): boolean {
  return value === undefined || isNonNegativeInteger(value);
}

function isOptionalDuration(value: unknown): boolean {
  return value === undefined || isNonNegativeNumber(value);
}

function isAttentionCounts(value: unknown): value is Partial<Record<HumanAttentionCategory, number>> {
  return isRecord(value) && Object.entries(value).every(([category, count]) => isHumanAttentionCategory(category) && isNonNegativeInteger(count));
}

function isExecutionStageSummary(value: unknown): value is ExecutionStageSummary {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.stage) &&
    isNonNegativeInteger(value.nodeCount) &&
    isNonNegativeNumber(value.inclusiveDurationMs) &&
    isNonNegativeNumber(value.exclusiveDurationMs) &&
    isNonNegativeNumber(value.wallClockDurationMs) &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.failureCount) &&
    isNonNegativeInteger(value.externalRequestCount) &&
    isNonNegativeInteger(value.externalSuccessCount) &&
    isNonNegativeInteger(value.externalFailureCount) &&
    isNonNegativeInteger(value.timeoutCount) &&
    isNonNegativeInteger(value.cacheHitCount) &&
    isNonNegativeInteger(value.cacheMissCount) &&
    isNonNegativeInteger(value.humanAttentionEvents);
}

function isExecutionRunSummary(value: unknown): value is ExecutionRunSummary {
  if (!isRecord(value)) return false;
  return isNonNegativeNumber(value.totalDurationMs) &&
    isNonNegativeNumber(value.humanWaitDurationMs) &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.failureCount) &&
    isNonNegativeInteger(value.externalRequestCount) &&
    isNonNegativeInteger(value.externalSuccessCount) &&
    isNonNegativeInteger(value.externalFailureCount) &&
    isNonNegativeInteger(value.timeoutCount) &&
    isNonNegativeInteger(value.cacheHitCount) &&
    isNonNegativeInteger(value.cacheMissCount) &&
    isNonNegativeInteger(value.humanAttentionEvents) &&
    isAttentionCounts(value.attentionByCategory) &&
    Array.isArray(value.stageSummaries) && value.stageSummaries.every(isExecutionStageSummary) &&
    Array.isArray(value.slowestStages) && value.slowestStages.every((stage) => isRecord(stage) && isNonEmptyString(stage.stage) && isNonNegativeNumber(stage.wallClockDurationMs));
}

export function isExecutionNodeTrace(value: unknown): value is ExecutionNodeTrace {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.nodeId) &&
    isNodeKind(value.nodeKind) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.completedAt) &&
    isNonNegativeNumber(value.durationMs) &&
    isOptionalDuration(value.exclusiveDurationMs) &&
    (value.parentNodeId === undefined || isNonEmptyString(value.parentNodeId)) &&
    isNodeOutcome(value.outcome) &&
    typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt > 0 &&
    (value.inputCount === undefined || isNonNegativeInteger(value.inputCount)) &&
    (value.outputCount === undefined || isNonNegativeInteger(value.outputCount)) &&
    (value.cacheHit === undefined || typeof value.cacheHit === "boolean") &&
    (value.retryReason === undefined || typeof value.retryReason === "string") &&
    (value.retryReasonCode === undefined || isExecutionFailureReason(value.retryReasonCode)) &&
    (value.previousOutcome === undefined || isNodeOutcome(value.previousOutcome)) &&
    (value.failureReason === undefined || isExecutionFailureReason(value.failureReason)) &&
    isOptionalCounter(value.externalRequestCount) &&
    isOptionalCounter(value.externalSuccessCount) &&
    isOptionalCounter(value.externalFailureCount) &&
    isOptionalCounter(value.timeoutCount) &&
    isOptionalCounter(value.cancellationCount) &&
    isOptionalCounter(value.lateCompletionCount) &&
    (value.humanAttentionRequired === undefined || typeof value.humanAttentionRequired === "boolean") &&
    (value.humanAttentionCategory === undefined || isHumanAttentionCategory(value.humanAttentionCategory)) &&
    (value.modelProvider === undefined || isNonEmptyString(value.modelProvider)) &&
    (value.modelId === undefined || isNonEmptyString(value.modelId)) &&
    isOptionalCounter(value.inputTokens) &&
    isOptionalCounter(value.outputTokens) &&
    isOptionalDuration(value.estimatedCost) &&
    (value.metadata === undefined || isSafeMetadata(value.metadata));
}

export function isExecutionRunTrace(value: unknown): value is ExecutionRunTrace {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.runId) &&
    value.runKind === "campaign_run" &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.completedAt) &&
    isNonNegativeNumber(value.durationMs) &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.humanAttentionEvents) &&
    isOptionalDuration(value.humanWaitDurationMs) &&
    (value.attentionByCategory === undefined || isAttentionCounts(value.attentionByCategory)) &&
    Array.isArray(value.nodes) && value.nodes.every(isExecutionNodeTrace) &&
    (value.summary === undefined || isExecutionRunSummary(value.summary));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
