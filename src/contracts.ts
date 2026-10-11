export type Settings = {
  workspace: string; javaPath: string; memoryMiB: number; playerName: string;
  versionId: string; serverAddress: string; serverPort: number; autoConnect: boolean; localFixtures: boolean;
};
export type Snapshot = { settings: Settings; phase: string; message: string; gamePid: number | null;
  releaseId: string | null; logs: string[]; progress: { path: string; bytes: number; total: number } | null; trustedKeys: number };
export type Result = { ok: boolean; error?: string; state: Snapshot };
export interface LauncherBridge {
  state(): Promise<Snapshot>;
  configure(value: Partial<Settings>): Promise<Result>;
  action(name: 'workspace' | 'java' | 'install-java' | 'import' | 'bootstrap' | 'launch' | 'key' | 'prepare' | 'install' | 'cancel' | 'logs'): Promise<Result>;
  subscribe(handler: (state: Snapshot) => void): () => void;
}
