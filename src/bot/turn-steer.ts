import type { RunHandle } from './active-runs';

export interface SteerCommand {
  /** Steering body with the `/steer` command prefix removed. */
  text: string;
}

export type MainTurnSteerUnavailableReason =
  | 'side-active'
  | 'no-active-main'
  | 'run-stopping'
  | 'provider-unsupported'
  | 'backend-unavailable';

export type MainTurnSteerAvailability =
  | { available: true; handle: RunHandle }
  | {
      available: false;
      reason: MainTurnSteerUnavailableReason;
      detail?: string;
    };

interface ActiveTurnLookup {
  get(scope: string): RunHandle | undefined;
  getSide(scope: string): RunHandle | undefined;
}

/** Parse the explicit same-turn injection command without treating it as a
 * native slash command. */
export function parseSteerCommand(content: string): SteerCommand | undefined {
  const match = /^\/steer(?:\s+([\s\S]*))?$/iu.exec(content.trim());
  return match ? { text: (match[1] ?? '').trim() } : undefined;
}

/** Resolve whether this scope has a main turn that can safely receive an
 * explicit steering message. Side conversations always fail closed because
 * their composer may own the shared live terminal. */
export function mainTurnSteerAvailability(
  activeRuns: ActiveTurnLookup,
  scope: string,
): MainTurnSteerAvailability {
  if (activeRuns.getSide(scope)) return { available: false, reason: 'side-active' };
  const handle = activeRuns.get(scope);
  if (!handle) return { available: false, reason: 'no-active-main' };
  if (handle.interrupted || handle.stopRequested || handle.detached) {
    return { available: false, reason: 'run-stopping' };
  }
  if (!handle.run.steer) return { available: false, reason: 'provider-unsupported' };
  const capability = handle.run.steerCapability?.();
  if (capability && !capability.available) {
    return {
      available: false,
      reason: capability.kind === 'provider'
        ? 'provider-unsupported'
        : capability.kind === 'run'
          ? 'run-stopping'
          : 'backend-unavailable',
      detail: capability.reason,
    };
  }
  return { available: true, handle };
}
