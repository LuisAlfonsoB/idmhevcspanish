'use strict';
// Tiny JSON persistence layer (one file per collection, debounced writes).
const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir, name, defaults) {
    this.file = path.join(dir, name + '.json');
    this.defaults = defaults;
    this.timer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = Array.isArray(defaults) ? raw : Object.assign({}, defaults, raw);
    } catch (_) {
      this.data = JSON.parse(JSON.stringify(defaults));
    }
  }
  get(key) { return key === undefined ? this.data : this.data[key]; }
  set(key, value) {
    if (value === undefined && typeof key === 'object') this.data = key;
    else this.data[key] = value;
    this.save();
  }
  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 400);
  }
  flush() {
    clearTimeout(this.timer);
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) { console.error('store write failed', this.file, e.message); }
  }
}
module.exports = { Store };
