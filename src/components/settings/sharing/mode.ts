export interface SharingModeState {
  hostBlocked: boolean;
  clientBlocked: boolean;
  conflict: boolean;
}

/**
 * A host and a client role are mutually exclusive. A legacy state can still
 * contain both, which is surfaced separately so the user can resolve it.
 */
export function sharingModeState(sharing: boolean, connected: boolean): SharingModeState {
  return {
    hostBlocked: connected && !sharing,
    clientBlocked: sharing && !connected,
    conflict: sharing && connected,
  };
}
