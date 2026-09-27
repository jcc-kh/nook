import type { Awaiting, ClassifyContext, ClassifyInput, SafetyIntentKind } from "../shared/types.ts";

export interface IntentCase {
  input: string;
  expectedKind: SafetyIntentKind;
  expectedClear?: boolean;
  awaiting?: Awaiting;
  recent?: ClassifyContext["recent"];
}

export interface IntentResult {
  c: IntentCase;
  kind: SafetyIntentKind;
  clear?: boolean;
  classifier: string;
  ok: boolean;
}

export function contextFor(c: IntentCase): ClassifyContext {
  return { safetyState: "safe", awaiting: c.awaiting ?? null, recent: c.recent ?? [] };
}

/**
 * Runs every case through `classify`; a case matches when kind (and `clear`, if given) agree.
 * `delayMs` spaces out calls for rate-limited APIs.
 */
export async function runIntentEval(
  cases: IntentCase[],
  classify: ClassifyInput,
  opts: { delayMs?: number } = {},
): Promise<IntentResult[]> {
  const out: IntentResult[] = [];
  for (const [i, c] of cases.entries()) {
    if (opts.delayMs && i > 0) await Bun.sleep(opts.delayMs);
    const { intent, classifier } = await classify(c.input, contextFor(c));
    const clear = intent.kind === "danger" ? intent.clear : undefined;
    const ok = intent.kind === c.expectedKind && (c.expectedClear === undefined || clear === c.expectedClear);
    out.push({ c, kind: intent.kind, ...(clear !== undefined && { clear }), classifier, ok });
  }
  return out;
}

export function describeResult(r: IntentResult): string {
  const got = `${r.kind}${r.clear === undefined ? "" : ` clear=${r.clear}`}`;
  const want = `${r.c.expectedKind}${r.c.expectedClear === undefined ? "" : ` clear=${r.c.expectedClear}`}`;
  const where = r.c.awaiting ? ` [awaiting ${r.c.awaiting}]` : "";
  return `${JSON.stringify(r.c.input)}${where}: expected ${want}, got ${got} (${r.classifier})`;
}
