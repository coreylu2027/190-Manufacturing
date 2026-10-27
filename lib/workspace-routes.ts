export const WORKSPACE_ROUTES = {
  preferences: "/preferences",
  operations: "/operations",
  fabrication: "/finishing",
  production: "/production",
  qc: "/qc",
  admin: "/admin",
  sync: "/admin/sync",
} as const;

export type WorkspaceView = keyof typeof WORKSPACE_ROUTES;
