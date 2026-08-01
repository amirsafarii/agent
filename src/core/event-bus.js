/**
 * core/event-bus.js - Independent Event Bus
 * -----------------------------------------
 * Facilitates pub/sub messaging across the agent's lifecycle.
 */

export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  /**
   * Subscribe to a specific event or all events (using '*')
   * @param {string} eventName
   * @param {Function} callback
   * @returns {Function} unsubscribe function
   */
  subscribe(eventName, callback) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(callback);

    return () => {
      this.unsubscribe(eventName, callback);
    };
  }

  /**
   * Unsubscribe a callback from an event
   * @param {string} eventName
   * @param {Function} callback
   */
  unsubscribe(eventName, callback) {
    const set = this.listeners.get(eventName);
    if (set) {
      set.delete(callback);
      if (set.size === 0) {
        this.listeners.delete(eventName);
      }
    }
  }

  /**
   * Publish an event to all subscribers of the event and subscribers of '*'
   * @param {string} eventName
   * @param {any} data
   */
  publish(eventName, data = {}) {
    const timestamp = Date.now();
    const payload = { ...data, event: eventName, timestamp };

    // Call subscribers of the specific event
    const specificSet = this.listeners.get(eventName);
    if (specificSet) {
      for (const cb of specificSet) {
        try {
          cb(payload);
        } catch (err) {
          console.error(`EventBus callback failed for event "${eventName}":`, err);
        }
      }
    }

    // Call wildcard subscribers
    const wildcardSet = this.listeners.get('*');
    if (wildcardSet) {
      for (const cb of wildcardSet) {
        try {
          cb(payload);
        } catch (err) {
          console.error(`EventBus wildcard callback failed for event "${eventName}":`, err);
        }
      }
    }
  }
}

export default EventBus;
