// Android's back button closes the topmost sheet. MapView owns the one Capacitor
// `backButton` listener (registering any listener replaces Capacitor's default, so there
// can only sensibly be one), and asks here first whether a sheet wants the press.

const handlers: Array<() => void> = [];

/**
 * While a sheet is open, `close` is what back does. The newest registration runs first,
 * so a sheet opened over another one is closed before the one beneath it.
 * Returns the function that unregisters it.
 */
export function pushBackHandler(close: () => void): () => void {
  handlers.push(close);
  return () => {
    const at = handlers.lastIndexOf(close);
    if (at !== -1) handlers.splice(at, 1);
  };
}

/** Runs the newest handler; false when no sheet registered one (back should then leave the app). */
export function runBackHandler(): boolean {
  const close = handlers[handlers.length - 1];
  if (!close) return false;
  close();
  return true;
}
