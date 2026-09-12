import { inspect } from "node:util";
import { randomInt } from "node:crypto";

export type VeniceErrorCategory =
  | "auth_missing"
  | "auth_expired"
  | "auth_rejected"
  | "permission_denied"
  | "companion_unavailable"
  | "timeout"
  | "cancelled"
  | "rate_limit"
  | "billing"
  | "invalid_response"
  | "transport_failure"
  | "unsupported_content";
export class VeniceTransportError extends Error {
  constructor(
    public readonly category: VeniceErrorCategory,
    public readonly status: number
  ) {
    super(`Venice Classic: ${category}`);
    this.name = "VeniceTransportError";
  }
}
export class SecretString {
  #value: string;
  constructor(value: string) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toJSON() {
    return "[REDACTED]";
  }
  toString() {
    return "[REDACTED]";
  }
  [inspect.custom]() {
    return "[REDACTED]";
  }
}
export interface VeniceWebAuthState {
  bearerToken: SecretString;
  clientAttestation: SecretString;
  userId: string;
  obtainedAt: number;
  expiresAt: number;
  revision: number;
}
export type AuthSubmission = {
  bearerToken: string;
  clientAttestation: string;
  userId: string;
  attestationExpiresAt?: number;
  bearerExpiresAt?: number;
};

export function abortError(signal: AbortSignal): VeniceTransportError {
  return new VeniceTransportError(
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError"
      ? "timeout"
      : "cancelled",
    signal.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? 504 : 499
  );
}
export function withAbort<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (v) => {
        cleanup();
        resolve(v);
      },
      (e) => {
        cleanup();
        reject(e);
      }
    );
  });
}

/** Process-local store. No API can read the raw state. Inspection is always redacted. */
export class VeniceAuthBroker {
  #state?: VeniceWebAuthState;
  #revision = 0;
  #accountUserId?: string;
  #refresh?: {
    promise: Promise<VeniceWebAuthState>;
    resolve: (s: VeniceWebAuthState) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    id: number;
  };
  #lastCompanionAt = 0;
  // The companion survives server restarts and deduplicates commands by this ID.
  // Start with a fresh 47-bit nonce so a new process cannot repeat command 1.
  #refreshId = randomInt(0, 2 ** 47);
  #validated = new Map<string, number>();
  #access = new Map<string, "available" | "denied">();
  #imageLimits = new Map<string, number>();
  constructor(
    private readonly now = Date.now,
    private readonly refreshTimeoutMs = 65_000
  ) {}
  toJSON() {
    return this.status();
  }
  [inspect.custom]() {
    return this.status();
  }
  status() {
    return {
      connected: this.valid(),
      companionAvailable: this.now() - this.#lastCompanionAt < 20_000,
      refreshPending: !!this.#refresh,
      expiresAt: this.#state?.expiresAt ?? null,
      validatedModels: [...this.#validated.keys()],
    };
  }
  valid() {
    return !!this.#state && this.#state.expiresAt > this.now() + 3000;
  }
  submit(input: AuthSubmission): void {
    if (
      !input ||
      !input.bearerToken ||
      !input.clientAttestation ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(input.userId ?? "") ||
      input.bearerToken.length > 16384 ||
      input.clientAttestation.length > 16384 ||
      /[\r\n]/.test(input.bearerToken + input.clientAttestation)
    )
      throw new VeniceTransportError("auth_missing", 401);
    const expiresAt = Math.min(
      this.now() + 60_000,
      input.attestationExpiresAt ?? this.now() + 30_000,
      input.bearerExpiresAt ?? this.now() + 60_000
    );
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() + 3000)
      throw new VeniceTransportError("auth_expired", 401);
    if (this.#accountUserId && this.#accountUserId !== input.userId) {
      this.#validated.clear();
      this.#access.clear();
      this.#imageLimits.clear();
    }
    this.#accountUserId = input.userId;
    this.#state = {
      bearerToken: new SecretString(input.bearerToken),
      clientAttestation: new SecretString(input.clientAttestation),
      userId: input.userId,
      obtainedAt: this.now(),
      expiresAt,
      revision: ++this.#revision,
    };
    this.#lastCompanionAt = this.now();
    const pending = this.#refresh;
    if (pending) {
      clearTimeout(pending.timer);
      this.#refresh = undefined;
      pending.resolve(this.#state);
    }
  }
  /** Returns commands, never credentials. Polled only by the paired extension. */
  poll() {
    this.#lastCompanionAt = this.now();
    return this.#refresh ? { refreshId: this.#refresh.id } : { refreshId: null };
  }
  failRefresh(id: number) {
    if (this.#refresh?.id !== id) return;
    const pending = this.#refresh;
    clearTimeout(pending.timer);
    this.#refresh = undefined;
    pending.reject(new VeniceTransportError("companion_unavailable", 503));
  }
  invalidate(revision?: number) {
    if (revision === undefined || this.#state?.revision === revision) this.#state = undefined;
  }
  async acquire(
    signal?: AbortSignal | null,
    rejectedRevision?: number
  ): Promise<VeniceWebAuthState> {
    if (signal?.aborted) throw abortError(signal);
    if (rejectedRevision !== undefined) this.invalidate(rejectedRevision);
    if (this.valid()) return this.#state!;
    if (!this.#refresh) {
      let resolve!: (s: VeniceWebAuthState) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<VeniceWebAuthState>((a, b) => {
        resolve = a;
        reject = b;
      });
      // An aborted caller must not leave an unhandled single-flight rejection.
      void promise.catch(() => {});
      const id = ++this.#refreshId;
      const timer = setTimeout(() => this.failRefresh(id), this.refreshTimeoutMs);
      timer.unref?.();
      this.#refresh = { promise, resolve, reject, timer, id };
    }
    return withAbort(this.#refresh.promise, signal);
  }
  recordNativeSuccess(model: string, imageCount: number, userId?: string) {
    if (userId && userId !== this.#accountUserId) return;
    if (imageCount > 0)
      this.#validated.set(model, Math.max(imageCount, this.#validated.get(model) ?? 0));
  }
  validatedImages(model: string) {
    return this.#validated.get(model) ?? 0;
  }
  recordAccess(model: string, allowed: boolean, userId?: string) {
    if (userId && userId !== this.#accountUserId) return;
    this.#access.set(model, allowed ? "available" : "denied");
  }
  access(model: string) {
    return this.#access.get(model) ?? "unknown";
  }
  setImageLimit(model: string, count: number) {
    this.#imageLimits.set(model, count);
  }
  imageLimit(model: string) {
    return Math.min(10, this.#imageLimits.get(model) ?? 10);
  }
  close() {
    if (this.#refresh) this.failRefresh(this.#refresh.id);
    this.#state = undefined;
    this.#accountUserId = undefined;
    this.#validated.clear();
    this.#access.clear();
    this.#imageLimits.clear();
  }
}
