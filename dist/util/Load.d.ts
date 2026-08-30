import type { Account } from '../interface/Account';
import type { Config } from '../interface/Config';
export declare function getProjectRoot(): string;
export declare function loadAccounts(): Account[];
export declare function loadConfig(): Config;
export declare function applyRuntimeConfigOverrides(config: Config, sourceEnv?: NodeJS.ProcessEnv): Config;
//# sourceMappingURL=Load.d.ts.map