export type ExecutionNodeKind =
  | "deterministic"
  | "external_io"
  | "judgment"
  | "persistence"
  | "human_gate"
  | "consequential_side_effect";

export type ExecutionNodeOutcome = "success" | "partial" | "failed" | "skipped" | "blocked";

export type ExecutionRunKind = "campaign_run";

/** Operational trace only. Do not put profile content, answers, tokens, or page data here. */
export interface ExecutionNodeTrace {
  nodeId: string;
  nodeKind: ExecutionNodeKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: ExecutionNodeOutcome;
  attempt: number;
  inputCount?: number;
  outputCount?: number;
  cacheHit?: boolean;
  retryReason?: string;
  humanAttentionRequired?: boolean;
  metadata?: Readonly<Record<string, string>>;
}

export interface ExecutionRunTrace {
  runId: string;
  runKind: ExecutionRunKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  retryCount: number;
  humanAttentionEvents: number;
  nodes: readonly ExecutionNodeTrace[];
}

export interface ExecutionNodeTraceInput {
  nodeId: string;
  nodeKind: ExecutionNodeKind;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  outcome: ExecutionNodeOutcome;
  attempt?: number;
  inputCount?: number;
  outputCount?: number;
  cacheHit?: boolean;
  retryReason?: string;
  humanAttentionRequired?: boolean;
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
  };
}

export interface ExecutionMeasureOptions<T> {
  attempt?: number;
  inputCount?: number;
  outputCount?: (value: T) => number | undefined;
  outcome?: (value: T) => ExecutionNodeOutcome;
  cacheHit?: (value: T) => boolean | undefined;
  humanAttentionRequired?: (value: T) => boolean | undefined;
  retryReason?: string;
  metadata?: Readonly<Record<string, string>>;
}

/**
 * A small recorder for an actual run. It records observations; it does not
 * define or execute a graph topology.
 */
export class ExecutionTraceBuilder {
  private readonly nodes: ExecutionNodeTrace[] = [];
  private humanAttentionEventCount = 0;
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

  setHumanAttentionEvents(count: number): void {
    this.humanAttentionEventCount = Math.max(0, Math.floor(count));
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
      const completedAt = this.now();
      this.add(createExecutionNodeTrace({
        nodeId,
        nodeKind,
        startedAt,
        completedAt,
        durationMs: monotonicNow() - monotonicStartedAt,
        outcome: options.outcome?.(result) ?? "success",
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
        ...(options.inputCount !== undefined ? { inputCount: options.inputCount } : {}),
        ...(options.outputCount ? { outputCount: options.outputCount(result) } : {}),
        ...(options.cacheHit ? { cacheHit: options.cacheHit(result) } : {}),
        ...(options.humanAttentionRequired ? { humanAttentionRequired: options.humanAttentionRequired(result) } : {}),
        ...(options.retryReason ? { retryReason: options.retryReason } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }));
      return result;
    } catch (error) {
      const completedAt = this.now();
      this.add(createExecutionNodeTrace({
        nodeId,
        nodeKind,
        startedAt,
        completedAt,
        durationMs: monotonicNow() - monotonicStartedAt,
        outcome: "failed",
        ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
        ...(options.inputCount !== undefined ? { inputCount: options.inputCount } : {}),
        ...(options.retryReason ? { retryReason: options.retryReason } : {}),
        ...(options.metadata ? { metadata: options.metadata } : {}),
      }));
      throw error;
    }
  }

  finish(completedAt = this.now()): ExecutionRunTrace {
    return {
      runId: this.runId,
      runKind: this.runKind,
      startedAt: this.startedAt,
      completedAt,
      durationMs: Math.max(0, Math.round(monotonicNow() - this.monotonicStartedAt)),
      retryCount: this.nodes.reduce((total, node) => total + Math.max(0, node.attempt - 1), 0),
      humanAttentionEvents: this.humanAttentionEventCount,
      nodes: [...this.nodes],
    };
  }
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

function isNodeKind(value: unknown): value is ExecutionNodeKind {
  return value === "deterministic" || value === "external_io" || value === "judgment" ||
    value === "persistence" || value === "human_gate" || value === "consequential_side_effect";
}

function isNodeOutcome(value: unknown): value is ExecutionNodeOutcome {
  return value === "success" || value === "partial" || value === "failed" || value === "skipped" || value === "blocked";
}

function isSafeMetadata(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

export function isExecutionNodeTrace(value: unknown): value is ExecutionNodeTrace {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.nodeId) &&
    isNodeKind(value.nodeKind) &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.completedAt) &&
    typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 &&
    isNodeOutcome(value.outcome) &&
    typeof value.attempt === "number" && Number.isInteger(value.attempt) && value.attempt > 0 &&
    (value.inputCount === undefined || isNonNegativeInteger(value.inputCount)) &&
    (value.outputCount === undefined || isNonNegativeInteger(value.outputCount)) &&
    (value.cacheHit === undefined || typeof value.cacheHit === "boolean") &&
    (value.retryReason === undefined || typeof value.retryReason === "string") &&
    (value.humanAttentionRequired === undefined || typeof value.humanAttentionRequired === "boolean") &&
    (value.metadata === undefined || isSafeMetadata(value.metadata));
}

export function isExecutionRunTrace(value: unknown): value is ExecutionRunTrace {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.runId) &&
    value.runKind === "campaign_run" &&
    isTimestamp(value.startedAt) &&
    isTimestamp(value.completedAt) &&
    typeof value.durationMs === "number" && Number.isFinite(value.durationMs) && value.durationMs >= 0 &&
    isNonNegativeInteger(value.retryCount) &&
    isNonNegativeInteger(value.humanAttentionEvents) &&
    Array.isArray(value.nodes) && value.nodes.every(isExecutionNodeTrace);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
