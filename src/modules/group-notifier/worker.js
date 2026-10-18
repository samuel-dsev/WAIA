import { randomUUID } from "node:crypto";
import { createWhatsAppWebGroupSession } from "../../integrations/whatsapp-web/group-session.js";
import { notificationText } from "./qualification.js";

export function createGroupNotifierWorker({ repository, sessionFactory = createWhatsAppWebGroupSession, owner = randomUUID(), clock = () => Date.now() }) {
  let session = null, epoch = null, busy = false, closed = false, owned = false, nextGroupsAt = 0;
  let activeTick = null, closing = null;
  const pulses = new Set();
  async function pulse() {
    if (closed) return;
    const pending = repository.lease(owner);
    pulses.add(pending);
    try {
      const control = await pending;
      if (closed) return null;
      owned = Boolean(control);
      if (!owned) { session?.close(); session = null; epoch = null; }
      return control;
    } finally { pulses.delete(pending); }
  }
  async function execute() {
      try {
        const control = await pulse(); if (!control) return;
        if (epoch !== Number(control.epoch)) {
          if (session) {
            try { await session.disconnect(); } catch { session.close(); }
          }
          session = null; epoch = Number(control.epoch); nextGroupsAt = 0;
          await repository.recover(owner, epoch);
        }
        if (!control.desired) {
          await repository.publish(owner, epoch, { phase: "disconnected" }); return;
        }
        if (closed) return;
        if (!session) {
          session = sessionFactory({ authStore: repository.authStore(owner, epoch) });
          await session.connect(control.phone);
        }
        const state = session.snapshot();
        await repository.publish(owner, epoch, state);
        if (closed || state.phase !== "connected" || !owned) return;
        if (clock() >= nextGroupsAt) {
          const groups = await session.listGroups();
          await repository.cacheGroups(owner, epoch, groups);
          nextGroupsAt = clock() + 30_000;
        }
        const candidate = await repository.candidate(owner, epoch); if (!candidate) return;
        try { await session.groupMetadata(candidate.group_id); }
        catch { await repository.deferCandidate(owner, epoch, candidate.id); return; }
        if (closed || !owned || session.snapshot().phase !== "connected") return;
        const delivery = await repository.beginSend(owner, epoch, candidate.id); if (!delivery) return;
        let result = {};
        try {
          if (!closed && owned && session.snapshot().phase === "connected") result = await session.sendText(delivery.group_id, notificationText({
            companyName: delivery.company_name, name: delivery.name, summary: delivery.summary, qualification: delivery.qualification, phone: delivery.phone,
          }));
        } catch { /* accepted by WhatsApp with lost response is possible: do not retry */ }
        await repository.complete(owner, candidate.id, result);
      } finally { busy = false; }
  }
  return {
    pulse,
    tick() {
      if (closed || busy) return Promise.resolve();
      busy = true;
      activeTick = execute();
      return activeTick;
    },
    close() {
      if (closing) return closing;
      closed = true; owned = false; session?.close();
      closing = (async () => {
        await Promise.allSettled([activeTick, ...pulses]);
        session?.close();
        await session?.flushAuth?.().catch(() => {});
        // Drain in-flight work before releasing ownership or closing the database pool.
        // Stopping preserves encrypted auth; explicit admin disconnect revokes it.
        await repository.release(owner);
      })();
      return closing;
    },
  };
}
