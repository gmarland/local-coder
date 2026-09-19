export type WorkflowState = "created" | "implementing" | "verifying" | "reviewing" | "repairing" | "complete" | "failed";
export type ImplementationStatus = "success" | "no_change" | "failure";

export interface WorkflowSnapshot {
  state: WorkflowState;
  repairAttempts: number;
  reviewRemediations: number;
  finalVerificationPassed: boolean;
  failure?: string;
}

/** Owns completion and retry policy independently of model prose. */
export class WorkflowController {
  private state: WorkflowState = "created";
  private repairAttempts = 0;
  private reviewRemediations = 0;
  private finalVerificationPassed = false;
  private failure?: string;

  constructor(private readonly maxRepairAttempts = 2, private readonly reviewRequired = false) {
    if (!Number.isInteger(maxRepairAttempts) || maxRepairAttempts < 0)
      throw new Error("maxRepairAttempts must be a non-negative integer");
  }

  startImplementation(): void {
    this.requireState("created", "repairing");
    this.state = "implementing";
    this.finalVerificationPassed = false;
  }

  implementationFinished(status: ImplementationStatus): void {
    this.requireState("implementing");
    if (status === "failure") return this.stop("implementation failed");
    this.state = "verifying";
  }

  verificationFinished(passed: boolean): void {
    this.requireState("verifying");
    if (!passed) {
      if (this.repairAttempts >= this.maxRepairAttempts) return this.stop("verification failed after repair budget was exhausted");
      this.repairAttempts++;
      this.state = "repairing";
      return;
    }
    this.finalVerificationPassed = true;
    this.state = this.reviewRequired ? "reviewing" : "complete";
  }

  reviewFinished(actionableFindings: boolean): void {
    this.requireState("reviewing");
    if (!actionableFindings) {
      if (!this.finalVerificationPassed) return this.stop("completion attempted without final verification");
      this.state = "complete";
      return;
    }
    if (this.reviewRemediations >= 1) return this.stop("review remediation budget was exhausted");
    this.reviewRemediations++;
    this.state = "repairing";
    this.finalVerificationPassed = false;
  }

  stop(reason: string): void {
    this.state = "failed";
    this.failure = reason;
    this.finalVerificationPassed = false;
  }

  snapshot(): WorkflowSnapshot {
    return { state: this.state, repairAttempts: this.repairAttempts, reviewRemediations: this.reviewRemediations,
      finalVerificationPassed: this.finalVerificationPassed, ...(this.failure ? { failure: this.failure } : {}) };
  }

  private requireState(...allowed: WorkflowState[]): void {
    if (!allowed.includes(this.state)) throw new Error(`Illegal workflow transition from ${this.state}; expected ${allowed.join(" or ")}`);
  }
}

interface ToolPart {
  id?: string;
  callID?: string;
  type?: string;
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
}

export interface TraceAnalysis {
  ok: boolean;
  roles: string[];
  verifierPassed: boolean;
  reason?: string;
}

function eventPart(value: unknown): ToolPart | undefined {
  if (!value || typeof value !== "object") return undefined;
  const event = value as { part?: unknown; properties?: { part?: unknown } };
  const part = event.properties?.part ?? event.part ?? value;
  return part && typeof part === "object" ? part as ToolPart : undefined;
}

/** Validates completed task calls in OpenCode's newline-delimited JSON event stream. */
export function analyzeOpenCodeTrace(output: string, requireReviewer = false): TraceAnalysis {
  const roles: string[] = [];
  const outputs: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const part = eventPart(value);
    if (!part) continue;
    if (part.type !== "tool" || part.tool !== "task" || part.state?.status !== "completed") continue;
    const role = part.state.input?.subagent_type;
    if (typeof role !== "string") continue;
    const key = part.callID || part.id || `task:${roles.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push(role);
    outputs.push(part.state.output || "");
  }

  const flow = new WorkflowController(2, requireReviewer);
  let sawCoder = false;
  let sawVerifier = false;
  let verifierPassed = false;
  try {
    for (let index = 0; index < roles.length; index++) {
      const role = roles[index];
      const result = outputs[index];
      if (role === "coder") {
        sawCoder = true;
        flow.startImplementation();
        flow.implementationFinished(/STATUS:\s*FAILURE\b/i.test(result) ? "failure"
          : /STATUS:\s*NO_CHANGE\b/i.test(result) ? "no_change" : "success");
      } else if (role === "verifier") {
        if (!sawCoder) return { ok: false, roles, verifierPassed: false, reason: "OpenCode did not complete a verifier task after the coder" };
        sawVerifier = true;
        verifierPassed = /STATUS:\s*PASS\b/i.test(result);
        flow.verificationFinished(verifierPassed);
      } else if (role === "reviewer" && requireReviewer) {
        flow.reviewFinished(!/STATUS:\s*CLEAR\b/i.test(result));
      }
    }
  } catch (error) {
    return { ok: false, roles, verifierPassed, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!sawCoder) return { ok: false, roles, verifierPassed, reason: "OpenCode did not complete a coder task" };
  if (!sawVerifier) return { ok: false, roles, verifierPassed, reason: "OpenCode did not complete a verifier task after the coder" };
  const snapshot = flow.snapshot();
  if (snapshot.state === "complete") return { ok: true, roles, verifierPassed: true };
  if (snapshot.state === "repairing" && !verifierPassed)
    return { ok: false, roles, verifierPassed, reason: "The verifier did not return STATUS: PASS" };
  if (snapshot.state === "reviewing" || (snapshot.state === "repairing" && requireReviewer))
    return { ok: false, roles, verifierPassed, reason: "OpenCode did not complete a final reviewer task with STATUS: CLEAR" };
  return { ok: false, roles, verifierPassed, reason: snapshot.failure || `OpenCode workflow ended in ${snapshot.state}` };
}
