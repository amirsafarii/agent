/**
 * kernel/ids.js — id generation shim
 * -----------------------------------------------
 * The memory layers were lifted from a runtime that shared one kernel id
 * generator. Node's built-in randomUUID is exactly that, no dependency
 * needed.
 */
import { randomUUID } from 'node:crypto';

export function generateId() {
  return randomUUID();
}

export default generateId;
