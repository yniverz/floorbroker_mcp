import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { PRELUDE } from "./prelude.js";
import type { HostApi, Intent, StrategyDeclaration, StrategyLog } from "./types.js";

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function quickjs(): Promise<QuickJSWASMModule> {
  // The package's default-export typing does not match under NodeNext; the value is the variant.
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant as unknown as Parameters<typeof newQuickJSWASMModuleFromVariant>[0]);
  return modulePromise;
}

export interface SandboxLimits {
  memoryBytes: number;
  /** Time allowed for loading the code and for onStart. */
  startMs: number;
  /** Time allowed per event handler call. */
  eventMs: number;
}

export const DEFAULT_LIMITS: SandboxLimits = { memoryBytes: 32 * 1024 * 1024, startMs: 1000, eventMs: 250 };

export class StrategyError extends Error {}

export interface DispatchResult {
  intents: Intent[];
  logs: StrategyLog[];
  state: Record<string, unknown>;
}

/**
 * One strategy instance in its own QuickJS runtime: no network, files, timers or
 * access to floorbroker except the read-only host API and recorded order intents.
 */
export class StrategySandbox {
  private constructor(
    private readonly rt: QuickJSRuntime,
    private readonly vm: QuickJSContext,
    private readonly limits: SandboxLimits,
    readonly declaration: StrategyDeclaration,
  ) {}

  static async create(code: string, host: HostApi, limits: SandboxLimits = DEFAULT_LIMITS): Promise<StrategySandbox> {
    const QuickJS = await quickjs();
    const rt = QuickJS.newRuntime();
    rt.setMemoryLimit(limits.memoryBytes);
    rt.setMaxStackSize(1024 * 1024);
    const vm = rt.newContext();
    try {
      const hostFn = vm.newFunction("__host", (opH, argsH) => {
        const op = vm.getString(opH);
        const args = JSON.parse(vm.getString(argsH)) as unknown[];
        let out: unknown;
        try {
          out = host(op, args ?? []);
        } catch (err) {
          throw vm.newError(err instanceof Error ? err.message : String(err));
        }
        return vm.newString(out === undefined || out === null ? "" : JSON.stringify(out));
      });
      vm.setProp(vm.global, "__host", hostFn);
      hostFn.dispose();

      rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + limits.startMs));
      evalOrThrow(vm, PRELUDE, "prelude");
      evalOrThrow(vm, code, "strategy code");
      const decl = JSON.parse(callString(vm, "__describe", [])) as StrategyDeclaration;
      return new StrategySandbox(rt, vm, limits, decl);
    } catch (err) {
      vm.dispose();
      rt.dispose();
      throw err instanceof StrategyError ? err : new StrategyError(err instanceof Error ? err.message : String(err));
    }
  }

  init(params: Record<string, unknown>, state: Record<string, unknown>): void {
    this.rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + this.limits.startMs));
    callString(this.vm, "__init", [JSON.stringify(params ?? {}), JSON.stringify(state ?? {})]);
  }

  /** Calls a handler. On an exception, its intents are discarded and a StrategyError carries its logs. */
  dispatch(handler: string, now: number, payload: unknown, timeMs = this.limits.eventMs): DispatchResult {
    this.rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeMs));
    try {
      const out = callString(this.vm, "__dispatch", [handler, now, payload === undefined ? "" : JSON.stringify(payload)]);
      return JSON.parse(out) as DispatchResult;
    } catch (err) {
      let logs: StrategyLog[] = [];
      try {
        this.rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 100));
        logs = (JSON.parse(callString(this.vm, "__abort", [])) as { logs: StrategyLog[] }).logs;
      } catch {
        /* sandbox may be unusable after out-of-memory */
      }
      const e = new StrategyError(`${handler} failed: ${err instanceof Error ? err.message : String(err)}`);
      (e as StrategyError & { logs: StrategyLog[] }).logs = logs;
      throw e;
    }
  }

  dispose(): void {
    try {
      this.vm.dispose();
      this.rt.dispose();
    } catch {
      /* already disposed */
    }
  }
}

function evalOrThrow(vm: QuickJSContext, code: string, what: string): void {
  const r = vm.evalCode(code, what === "prelude" ? "prelude.js" : "strategy.js");
  if (r.error) {
    const e = vm.dump(r.error) as { message?: string; stack?: string } | string;
    r.error.dispose();
    const msg = typeof e === "string" ? e : (e?.message ?? JSON.stringify(e));
    throw new StrategyError(`${what}: ${msg}${typeof e === "object" && e?.stack ? `\n${String(e.stack).split("\n").slice(0, 3).join("\n")}` : ""}`);
  }
  r.value.dispose();
}

function callString(vm: QuickJSContext, fnName: string, args: (string | number)[]): string {
  const fn = vm.getProp(vm.global, fnName);
  const handles: QuickJSHandle[] = args.map((a) => (typeof a === "number" ? vm.newNumber(a) : vm.newString(a)));
  try {
    const r = vm.callFunction(fn, vm.undefined, ...handles);
    if (r.error) {
      const e = vm.dump(r.error) as { message?: string } | string;
      r.error.dispose();
      throw new StrategyError(typeof e === "string" ? e : (e?.message ?? JSON.stringify(e)));
    }
    const out = vm.typeof(r.value) === "string" ? vm.getString(r.value) : "";
    r.value.dispose();
    return out;
  } finally {
    fn.dispose();
    for (const h of handles) h.dispose();
  }
}
