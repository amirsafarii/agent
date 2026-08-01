/**
 * tools/system.js — optional semantic name for the public ToolSystem.
 *
 * ToolRegistry remains the concrete registration API. This thin subclass is
 * provided for hosts that want to name the aggregate `ToolSystem` while
 * keeping one implementation and one execution pipeline.
 */
import { ToolRegistry } from './registry.js';

export class ToolSystem extends ToolRegistry {}

export default ToolSystem;
