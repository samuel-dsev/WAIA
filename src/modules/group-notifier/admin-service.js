import { requirePlatformAdmin, requireTenantAccess } from "../admin/authorization.js";
import { AdminValidationError } from "../admin/errors.js";

export class GroupNotifierAdminService {
  constructor(repository, renderQr) { this.repository = repository; this.renderQr = renderQr; }
  async status(auth) {
    const { actorId } = requirePlatformAdmin(auth);
    const data = await this.repository.status(actorId);
    const { qr, ...safe } = data;
    return { ...safe, qrImage: qr ? await this.renderQr(qr) : null };
  }
  async connect(auth, body) {
    const { actorId } = requirePlatformAdmin(auth);
    if (body?.dedicated !== true) throw new AdminValidationError("Confirme o uso do número dedicado da WAIA.");
    return this.repository.configure(body.phone, actorId);
  }
  disconnect(auth) { const { actorId } = requirePlatformAdmin(auth); return this.repository.revoke(actorId); }
  groups(auth) { requirePlatformAdmin(auth); return this.repository.groups().then((groups) => ({ groups })); }
  route(auth, empresaId) {
    requireTenantAccess(auth, empresaId, { permission: "conversations.read" });
    return this.repository.route(empresaId).then((route) => ({ route }));
  }
  saveRoute(auth, empresaId, body) {
    const { actorId } = requirePlatformAdmin(auth);
    return this.repository.saveRoute(empresaId, body, actorId);
  }
  leads(auth, empresaId) {
    requireTenantAccess(auth, empresaId, { permission: "conversations.read" });
    return this.repository.leads(empresaId).then((leads) => ({ leads }));
  }
}
