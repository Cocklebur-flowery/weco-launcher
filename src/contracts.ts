export type Settings = {
  workspace: string; javaPath: string; memoryMiB: number; playerName: string;
  versionId: string; serverAddress: string; serverPort: number; autoConnect: boolean; localFixtures: boolean;
  authAddress: string; channel: 'dev' | 'stable'; manifestAddress:string;
};
export type Snapshot = { settings: Settings; phase: string; message: string; gamePid: number | null;
  releaseId: string | null; logs: string[]; progress: { path: string; bytes: number; total: number } | null; trustedKeys: number;
  auth: import('./auth.ts').AuthView };
export type AuthRequest = { action: 'login' | 'register' | 'qq-challenge' | 'qq-status' | 'qq-confirm' | 'premium-start' | 'premium-poll' | 'premium-cancel' | 'logout'; name?: string; password?: string; code?: string };
export type Result = { ok: boolean; error?: string; state: Snapshot };
export interface LauncherBridge {
  state(): Promise<Snapshot>;
  configure(value: Partial<Settings>): Promise<Result>;
  action(name: 'workspace' | 'java' | 'install-java' | 'import' | 'bootstrap' | 'launch' | 'key' | 'prepare' | 'install' | 'cancel' | 'logs' | 'premium-web' | 'remote-update'): Promise<Result>;
  auth(request: AuthRequest): Promise<Result>;
  subscribe(handler: (state: Snapshot) => void): () => void;
}
