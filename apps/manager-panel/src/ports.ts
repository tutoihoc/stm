import type { PortSettings } from '../../../packages/contracts/src/index.js';

/**
 * Ports below this need privileges the manager does not ask for. Kept in step
 * with the server's own bound so that a number the server would refuse is
 * refused here first, while the reader is still looking at the field.
 */
export const LOWEST_PORT = 1024;
export const HIGHEST_PORT = 65535;

/** What SillyTavern runs on until the server has said otherwise. */
export const DEFAULT_SILLYTAVERN_PORT = 8002;

/**
 * Why a typed port cannot be used, as a message to look up, or null.
 *
 * A key and its parameters rather than a sentence, because the panel says this
 * in whichever language it was opened in. The server checks the same rule
 * again: this one exists to answer without a round trip, not to be the
 * guarantee that two services never land on one port.
 */
export type PortRefusal =
  | { readonly key: 'console.portInvalid'; readonly params: { readonly lowest: number; readonly highest: number } }
  | { readonly key: 'console.portTakenByManager' | 'console.portTakenByAccess'; readonly params: { readonly port: number } };

export function portRefusal(typed: string, reserved: PortSettings['reserved']): PortRefusal | null {
  const trimmed = typed.trim();
  const range = { key: 'console.portInvalid', params: { lowest: LOWEST_PORT, highest: HIGHEST_PORT } } as const;
  // Tested as digits rather than with Number, which reads ' 12e3 ', '0x1f' and
  // '8000.0' as numbers that a port field was never offering.
  if (!/^\d+$/u.test(trimmed)) return range;
  const port = Number(trimmed);
  if (port < LOWEST_PORT || port > HIGHEST_PORT) return range;
  if (port === reserved.manager) return { key: 'console.portTakenByManager', params: { port } };
  if (port === reserved.access) return { key: 'console.portTakenByAccess', params: { port } };
  return null;
}
