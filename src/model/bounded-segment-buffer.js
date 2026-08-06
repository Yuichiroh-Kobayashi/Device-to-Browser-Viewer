/** A fixed-capacity FIFO ring. It never grows after construction. */
export class BoundedSegmentBuffer {
  constructor(capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4096) {
      throw new RangeError("ring capacity must be an integer from 1 through 4096");
    }
    this.capacity = capacity;
    this._items = new Array(capacity);
    this._head = 0;
    this.size = 0;
  }

  append(value) {
    let evicted;
    if (this.size === this.capacity) {
      evicted = this._items[this._head];
      this._items[this._head] = value;
      this._head = (this._head + 1) % this.capacity;
    } else {
      this._items[(this._head + this.size) % this.capacity] = value;
      this.size += 1;
    }
    return evicted;
  }

  peek() {
    return this.size === 0 ? undefined : this._items[this._head];
  }

  shift() {
    if (this.size === 0) return undefined;
    const value = this._items[this._head];
    this._items[this._head] = undefined;
    this._head = (this._head + 1) % this.capacity;
    this.size -= 1;
    return value;
  }

  clear() {
    this._items.fill(undefined);
    this._head = 0;
    this.size = 0;
  }

  /** Returns a new array bounded by this ring's fixed capacity. */
  toArray() {
    const values = new Array(this.size);
    for (let index = 0; index < this.size; index += 1) {
      values[index] = this._items[(this._head + index) % this.capacity];
    }
    return values;
  }

  forEach(callback) {
    for (let index = 0; index < this.size; index += 1) {
      callback(this._items[(this._head + index) % this.capacity], index);
    }
  }
}
