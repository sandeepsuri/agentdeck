// Settings → Folder access. Local admin only: absent from both remote
// allowlists in app.ts, so a collaborator or tailnet device can never widen
// what AgentDeck may touch on this Mac.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { AgentDeckConfig } from '../config.js';
import { folderAccess, normalizeAllowedRoots } from '../folder-access.js';
import { GrantPathError } from '../personal-tasks/folder-grant.js';
import { FolderPickerUnavailableError, type FolderPicker } from '../personal-tasks/folder-picker.js';

export interface FolderAccessRoutesDeps {
  config: AgentDeckConfig;
  saveConfig: (patch: Partial<AgentDeckConfig>) => void;
  pickFolder?: FolderPicker;
  /** Called after the chosen folders change, e.g. to rescan repos. */
  onChange?: () => void;
  homeDir?: string;
}

const MAX_ROOTS = 50;

export function registerFolderAccessRoutes(app: FastifyInstance, deps: FolderAccessRoutesDeps): void {
  const access = folderAccess(deps.config);
  const view = () => ({
    roots: access.roots().map((root) => ({ path: root, exists: fs.existsSync(root) })),
    chosen: Boolean(deps.config.allowedRoots?.length),
    enforced: access.enforced(),
    launchedByApp: deps.config.launchedByApp === true,
    canPick: Boolean(deps.pickFolder),
  });
  const save = (selected: readonly string[]) => {
    const roots = normalizeAllowedRoots(selected, {
      ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
      protectedRoots: [deps.config.dataDir],
    });
    deps.saveConfig({ allowedRoots: roots.length > 0 ? roots : undefined });
    deps.config.allowedRoots = roots.length > 0 ? roots : undefined;
    deps.onChange?.();
  };

  app.get('/api/settings/access', async () => view());

  app.put('/api/settings/access', async (req, reply) => {
    const roots = (req.body as { roots?: unknown } | null)?.roots;
    if (!Array.isArray(roots) || roots.length > MAX_ROOTS || !roots.every((root) => typeof root === 'string')) {
      return reply.code(400).send({ error: 'roots must be an array of folder paths' });
    }
    try {
      save(roots as string[]);
    } catch (error) {
      if (error instanceof GrantPathError) return reply.code(400).send({ error: error.message, code: error.code });
      throw error;
    }
    return view();
  });

  let pickerOpen = false;
  app.post('/api/settings/access/pick', async (_req, reply) => {
    if (!deps.pickFolder) return reply.code(503).send({ error: 'Choosing a folder needs macOS.', code: 'picker-unavailable' });
    if (pickerOpen) return reply.code(409).send({ error: 'The folder picker is already open on this Mac.', code: 'picker-open' });
    pickerOpen = true;
    try {
      const selected = await deps.pickFolder();
      if (!selected) return { ...view(), cancelled: true };
      save([...(deps.config.allowedRoots ?? []), selected]);
      return view();
    } catch (error) {
      if (error instanceof GrantPathError) return reply.code(400).send({ error: error.message, code: error.code });
      if (error instanceof FolderPickerUnavailableError) return reply.code(503).send({ error: error.message, code: 'picker-unavailable' });
      throw error;
    } finally {
      pickerOpen = false;
    }
  });
}
