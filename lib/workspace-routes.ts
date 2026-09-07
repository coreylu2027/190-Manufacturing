export const WORKSPACE_ROUTES = {
  operations: "/operations",
  fabrication: "/finishing",
  production: "/production",
  qc: "/qc",
  admin: "/admin",
} as const;

export type WorkspaceView = keyof typeof WORKSPACE_ROUTES;
