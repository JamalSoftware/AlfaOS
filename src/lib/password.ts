import bcrypt from "bcryptjs";
import { DomainError } from "./errors";

const HASH_ROUNDS = 12;

/**
 * Hash of a throwaway string, used only to spend the same bcrypt time when the
 * account does not exist. Not a secret: it protects timing, not data.
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$12$6E7itvA074kKpwi.bNTWr.QLmmXJ.ovetwoIPARAK8UxktD8zBjWi";

/**
 * Admission control for bcrypt work (docs/SECURITY.md §2.2).
 *
 * Why this exists
 * ---------------
 * `bcryptjs` is pure JavaScript. Its *async* API (the one used here) slices the
 * work into <=100ms chunks and yields through `setImmediate` between chunks, so
 * a single comparison does not freeze the process outright — but the CPU cost
 * is real (~350ms at cost 12) and it is paid on the one thread that serves
 * every tenant.
 *
 * With unbounded concurrency, N in-flight comparisons round-robin over the same
 * core: each one takes N x 350ms of wall clock and the event loop spends every
 * 100ms slice hashing. An anonymous flood therefore degrades *everyone* —
 * including requests that have nothing to do with login.
 *
 * The previous defence was a deployment-wide ceiling on recent failed logins
 * (`LOGIN_MAX_FAILED_ATTEMPTS_GLOBAL`). It stopped the CPU burn but was itself
 * an authentication kill switch: ~200 logins with random e-mails (no valid
 * account required) blocked login for every tenant for a whole window, and
 * blocked requests were free for the attacker, so the block was trivial to
 * sustain. It was removed — see docs/SECURITY.md §2.2.
 *
 * What replaces it
 * ----------------
 * A process-local semaphore with a bounded FIFO queue:
 *   - at most `BCRYPT_MAX_CONCURRENCY` (default 2) comparisons run at once, so
 *     the event loop always has room for everything else;
 *   - up to `BCRYPT_MAX_QUEUE` (default 32) callers wait in FIFO order, so a
 *     legitimate login is served, just later, instead of being denied;
 *   - beyond that the request is rejected immediately with 503 — no CPU spent.
 *
 * Crucially this is *instantaneous back-pressure*, not a stateful block: it
 * only rejects while the flood is actually saturating the CPU, and recovers
 * within milliseconds of the flood stopping. Nothing an anonymous caller does
 * leaves behind state that keeps other tenants out. No external service is
 * involved; the app is single-instance by design.
 */

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read per call so deployments — and tests — can change it without a reload. */
function maxConcurrency(): number {
  return positiveInt(process.env.BCRYPT_MAX_CONCURRENCY, 2);
}

function maxQueue(): number {
  return positiveInt(process.env.BCRYPT_MAX_QUEUE, 32);
}

/**
 * Raised when the bcrypt queue is full. 503 (not 429): it says "the server is
 * saturated right now", carries no per-account meaning and, unlike the old
 * global ceiling, cannot be latched by an attacker.
 */
export class PasswordHashingOverloadError extends DomainError {
  constructor() {
    super(
      503,
      "Serviço de autenticação sobrecarregado. Tente novamente em instantes.",
    );
    this.name = "PasswordHashingOverloadError";
  }
}

interface Waiter {
  resolve: () => void;
}

let active = 0;
let peakActive = 0;
let rejected = 0;
const waiters: Waiter[] = [];

function acquire(): Promise<void> {
  if (active < maxConcurrency()) {
    active += 1;
    if (active > peakActive) {
      peakActive = active;
    }
    return Promise.resolve();
  }

  if (waiters.length >= maxQueue()) {
    rejected += 1;
    return Promise.reject(new PasswordHashingOverloadError());
  }

  return new Promise<void>((resolve) => {
    waiters.push({ resolve });
  });
}

function release(): void {
  // Hand the slot straight to the next waiter instead of releasing and
  // re-acquiring: `active` stays constant, so a burst can never overshoot the
  // concurrency limit between the two steps.
  const next = waiters.shift();
  if (next) {
    next.resolve();
    return;
  }
  active -= 1;
}

async function withBcryptSlot<T>(task: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

export interface PasswordGateStats {
  /** Comparisons/hashes executing right now. Never exceeds `maxConcurrency`. */
  active: number;
  /** Callers waiting for a slot. */
  queued: number;
  /** Highest `active` observed since the last reset (observability + tests). */
  peakActive: number;
  /** Requests refused because the queue was full, since the last reset. */
  rejected: number;
  maxConcurrency: number;
  maxQueue: number;
}

/** Read-only introspection of the gate (metrics and adversarial tests). */
export function passwordGateStats(): PasswordGateStats {
  return {
    active,
    queued: waiters.length,
    peakActive,
    rejected,
    maxConcurrency: maxConcurrency(),
    maxQueue: maxQueue(),
  };
}

/** Clears the high-water marks. Never touches in-flight work. */
export function resetPasswordGateStats(): void {
  peakActive = active;
  rejected = 0;
}

export function hashPassword(plain: string): Promise<string> {
  return withBcryptSlot(() => bcrypt.hash(plain, HASH_ROUNDS));
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return withBcryptSlot(() => bcrypt.compare(plain, hash));
}
