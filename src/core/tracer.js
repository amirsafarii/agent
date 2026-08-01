/**
 * core/tracer.js - Lightweight OpenTelemetry-compatible Hierarchical Tracer
 * -------------------------------------------------------------------------
 * Provides Span and Tracer classes supporting traceId, hierarchical parent-child spans,
 * custom attributes, events, and duration tracking.
 */

import { randomUUID } from 'node:crypto';

export class Span {
  constructor(name, parent = null, traceId = null) {
    this.name = name;
    this.id = randomUUID();
    this.parentId = parent ? parent.id : null;
    this.traceId = traceId || (parent ? parent.traceId : randomUUID());
    this.startTime = Date.now();
    this.endTime = null;
    this.status = 'unset'; // 'unset', 'ok', 'error'
    this.attributes = {};
    this.events = [];
    this.children = [];
    if (parent) {
      parent.children.push(this);
    }
  }

  setAttribute(key, value) {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs) {
    Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name, attributes = {}) {
    this.events.push({ name, attributes, timestamp: Date.now() });
    return this;
  }

  setStatus(status, message) {
    this.status = status;
    if (message) {
      this.setAttribute('status.message', message);
    }
    return this;
  }

  end() {
    this.endTime = Date.now();
    return this;
  }

  get durationMs() {
    return (this.endTime || Date.now()) - this.startTime;
  }

  toJSON() {
    return {
      name: this.name,
      id: this.id,
      parentId: this.parentId,
      traceId: this.traceId,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.durationMs,
      status: this.status,
      attributes: this.attributes,
      events: this.events,
      children: this.children.map((c) => c.toJSON()),
    };
  }
}

export class Tracer {
  constructor() {
    this.activeSpans = [];
    this.traces = new Map(); // traceId -> rootSpan
  }

  startSpan(name, parentSpan = null) {
    const parent = parentSpan || this.activeSpans[this.activeSpans.length - 1] || null;
    const span = new Span(name, parent);
    this.activeSpans.push(span);

    if (!span.parentId) {
      this.traces.set(span.traceId, span);
    }

    return span;
  }

  endSpan(span) {
    span.end();
    const idx = this.activeSpans.indexOf(span);
    if (idx !== -1) {
      this.activeSpans.splice(idx, 1);
    }
    return span;
  }

  getActiveSpan() {
    return this.activeSpans[this.activeSpans.length - 1] || null;
  }

  getTrace(traceId) {
    return this.traces.get(traceId);
  }

  clear() {
    this.activeSpans = [];
    this.traces.clear();
  }
}

export const globalTracer = new Tracer();
export default globalTracer;
