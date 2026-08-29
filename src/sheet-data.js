function text(value) {
  return String(value ?? "").trim();
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function validateEvent(row, today) {
  const [id, date, weekday, time, attractions, price, vipRule, notes, status] = row.map(text);
  if (status.toLowerCase() !== "ativo") return null;
  if (!id || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !weekday || !/^\d{2}:\d{2}$/.test(time) || !attractions) return null;
  const numericPrice = Number(String(price).replace(",", "."));
  if (!Number.isFinite(numericPrice) || numericPrice < 0 || date < dateKey(today)) return null;
  return { id, date, weekday, time, attractions, price: numericPrice, vipRule, notes };
}

function parseConfig(rows) {
  const result = {};
  for (const row of rows) {
    const key = text(row[0]);
    if (key) result[key] = text(row[1]);
  }
  return result;
}

export class SheetDataService {
  constructor({ client, intervalMs = 120_000, now = () => new Date(), logger = console }) {
    this.client = client;
    this.intervalMs = intervalMs;
    this.now = now;
    this.logger = logger;
    this.snapshot = null;
    this.timer = null;
    this.lastAttemptAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
  }

  get configured() {
    return Boolean(this.client?.configured);
  }

  async sync() {
    this.lastAttemptAt = this.now().toISOString();
    try {
      const [agendaRows, configRows] = await Promise.all([
        this.client.getValues("Agenda!A2:I"),
        this.client.getValues("Configurações!A2:C"),
      ]);
      const events = agendaRows.map((row) => validateEvent(row, this.now())).filter(Boolean).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
      const settings = parseConfig(configRows);
      const required = ["chave_pix", "favorecida_pix", "endereco"];
      if (!events.length) throw new Error("A planilha não contém eventos ativos, futuros e válidos.");
      if (required.some((key) => !settings[key])) throw new Error("A aba Configurações está incompleta.");
      this.snapshot = { events, settings };
      this.lastSuccessAt = this.now().toISOString();
      this.lastError = null;
      return this.snapshot;
    } catch (error) {
      this.lastError = error.message;
      this.logger.error("Falha ao sincronizar Google Sheets; mantendo último cache válido:", error.message);
      throw error;
    }
  }

  start() {
    if (!this.configured || this.timer) return;
    void this.sync().catch(() => {});
    this.timer = setInterval(() => void this.sync().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getSnapshot() {
    return this.snapshot;
  }

  diagnostics() {
    return {
      configured: this.configured,
      hasValidData: Boolean(this.snapshot),
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
    };
  }

  async recordOrder({ phone, eventId, name, receiptId }) {
    if (!this.configured) throw new Error("Google Sheets não configurado para registrar pedidos.");
    await this.client.appendValues("Pedidos!A:G", [
      this.now().toISOString(), phone, eventId, name, receiptId || "", "Aguardando conferência", "",
    ]);
  }
}
