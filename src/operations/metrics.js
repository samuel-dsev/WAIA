const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u;

function metricName(value) {
  const name = String(value || "");
  if (!NAME.test(name)) throw new TypeError("Nome de métrica inválido.");
  return name;
}

export class MetricsRegistry {
  #counters = new Map();
  #gauges = new Map();
  #summaries = new Map();

  increment(name, value = 1) {
    name = metricName(name);
    this.#counters.set(name, (this.#counters.get(name) || 0) + Number(value));
  }
  set(name, value) { this.#gauges.set(metricName(name), Number(value)); }
  observe(name, value) {
    name = metricName(name);
    const current = this.#summaries.get(name) || { count: 0, sum: 0, max: 0 };
    current.count += 1;
    current.sum += Number(value);
    current.max = Math.max(current.max, Number(value));
    this.#summaries.set(name, current);
  }
  snapshot() {
    return Object.freeze({
      counters: Object.fromEntries(this.#counters),
      gauges: Object.fromEntries(this.#gauges),
      summaries: Object.fromEntries([...this.#summaries].map(([name, value]) => [name, { ...value }])),
    });
  }
  prometheus() {
    const lines = [];
    for (const [name, value] of this.#counters) lines.push(`# TYPE ${name} counter`, `${name} ${value}`);
    for (const [name, value] of this.#gauges) lines.push(`# TYPE ${name} gauge`, `${name} ${value}`);
    for (const [name, value] of this.#summaries) {
      lines.push(`# TYPE ${name} summary`, `${name}_count ${value.count}`, `${name}_sum ${value.sum}`, `${name}_max ${value.max}`);
    }
    return `${lines.join("\n")}\n`;
  }
}
