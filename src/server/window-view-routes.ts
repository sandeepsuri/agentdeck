// Issue #91: view one Mac window from a paired owner phone. Choosing the
// window, asking for Screen Recording permission, and stopping or clearing
// the share happen only at the Mac. Starting, following, and stopping a view
// are for a paired owner phone only (directly or through the relay), and are
// on no collaborator or shared-token allowlist. Each handler repeats its own
// check, so the routes stay owner-only even if an allowlist later widens.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { OwnerDeviceAudit } from '../store/owner-devices.js';
import { PERMISSION_HELP, WindowViewError, type ScreenPermission, type Viewer, type WindowViewService } from '../window-view/service.js';

export interface WindowViewRouteDeps {
  service: WindowViewService;
  /** Opens System Settings › Privacy & Security › Screen Recording on this Mac. */
  openSettings: () => Promise<void>;
  isLocalOwner: (request: FastifyRequest) => boolean;
  /** The paired owner phone making this request, if it is one. */
  ownerPhone: (request: FastifyRequest) => Viewer | undefined;
  audit?: (deviceId: string, action: OwnerDeviceAudit['action'], targetId: string) => void;
}

/** The window-view routes an owner phone may use, directly or through the relay. */
export function isOwnerWindowViewRoute(method: string, pathname: string): boolean {
  if (method === 'GET') return pathname === '/api/window-view/phone' || pathname === '/api/window-view/frame';
  if (method === 'POST') return pathname === '/api/window-view/start' || pathname === '/api/window-view/stop';
  return false;
}

/** Long enough to save empty round trips, short enough for the phone's direct-path timeout. */
const MAX_WAIT_MS = 2_000;

const STATUS: Record<WindowViewError['code'], number> = {
  'no-window': 409,
  'permission-denied': 409,
  unsupported: 503,
  'capture-failed': 503,
  'not-found': 404,
  'not-viewing': 409,
};

function sendError(error: unknown, reply: FastifyReply): FastifyReply {
  if (error instanceof WindowViewError) return reply.code(STATUS[error.code]).send({ error: error.message, code: error.code });
  throw error;
}

/** A permission, with the way to fix it when it is off. */
const withHelp = (permission: ScreenPermission) => ({ permission, ...(permission === 'denied' ? { permissionHelp: PERMISSION_HELP } : {}) });

const windowName = (window: { app: string; title: string } | null) => (window ? [window.app, window.title].filter(Boolean).join(' — ').slice(0, 160) : '');

export function registerWindowViewRoutes(app: FastifyInstance, deps: WindowViewRouteDeps): void {
  const { service } = deps;

  const atMac = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (deps.isLocalOwner(req)) return true;
    void reply.code(403).send({ error: 'Choose and manage the shared window on the Mac.' });
    return false;
  };

  const phone = (req: FastifyRequest, reply: FastifyReply): Viewer | undefined => {
    const viewer = deps.ownerPhone(req);
    if (!viewer) void reply.code(403).send({ error: 'Viewing a Mac window is only available on a paired owner phone.' });
    else if (!deps.audit) { void reply.code(503).send({ error: 'Owner phone audit is unavailable.' }); return undefined; }
    return viewer;
  };

  const macStatus = async () => {
    return { ...service.status(), ...withHelp(await service.permission()) };
  };

  app.get('/api/window-view', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    return macStatus();
  });

  app.get('/api/window-view/windows', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    try { return await service.windows(); }
    catch (error) { return sendError(error, reply); }
  });

  app.post('/api/window-view/permission', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    return withHelp(await service.requestPermission());
  });

  app.post('/api/window-view/permission/settings', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    await deps.openSettings();
    return { ok: true };
  });

  app.post('/api/window-view/select', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    const windowId = (req.body as { windowId?: unknown } | undefined)?.windowId;
    if (typeof windowId !== 'number' || !Number.isInteger(windowId)) return reply.code(400).send({ error: 'windowId must be a window id.' });
    try { await service.select(windowId); return await macStatus(); }
    catch (error) { return sendError(error, reply); }
  });

  app.post('/api/window-view/clear', async (req, reply) => {
    if (!atMac(req, reply)) return reply;
    service.clear();
    return macStatus();
  });

  app.get('/api/window-view/phone', async (req, reply) => {
    const viewer = phone(req, reply);
    if (!viewer) return reply;
    return service.phoneStatus(viewer);
  });

  app.post('/api/window-view/start', async (req, reply) => {
    const viewer = phone(req, reply);
    if (!viewer) return reply;
    try {
      const view = await service.start(viewer);
      deps.audit?.(viewer.id, 'window-view-start', windowName(service.status().window));
      return view;
    } catch (error) { return sendError(error, reply); }
  });

  app.get<{ Querystring: { view?: string; after?: string; wait?: string } }>('/api/window-view/frame', async (req, reply) => {
    const viewer = phone(req, reply);
    if (!viewer) return reply;
    const after = Number(req.query.after ?? 0);
    const wait = Math.min(Math.max(Number(req.query.wait ?? MAX_WAIT_MS) || 0, 0), MAX_WAIT_MS);
    try {
      const frame = await service.frame(viewer, String(req.query.view ?? ''), Number.isFinite(after) ? after : 0, wait);
      return {
        frame: frame
          ? { seq: frame.seq, width: frame.width, height: frame.height, capturedAt: frame.capturedAt, jpeg: frame.jpeg.toString('base64') }
          : null,
      };
    } catch (error) { return sendError(error, reply); }
  });

  // At the Mac this stops whoever is viewing; from a phone, only its own view.
  app.post('/api/window-view/stop', async (req, reply) => {
    if (deps.isLocalOwner(req)) {
      service.stopAtMac();
      return macStatus();
    }
    const viewer = phone(req, reply);
    if (!viewer) return reply;
    const viewId = (req.body as { viewId?: unknown } | undefined)?.viewId;
    if (!service.stopForPhone(viewer, typeof viewId === 'string' ? viewId : '')) {
      return reply.code(409).send({ error: 'This phone is not viewing a Mac window.', code: 'not-viewing' });
    }
    deps.audit?.(viewer.id, 'window-view-stop', windowName(service.status().window));
    return service.phoneStatus(viewer);
  });
}
