export type KiroCliCommandSource = "configured" | "path" | "common";

export interface KiroCliCommandResolution {
  command: string;
  source: KiroCliCommandSource;
}

export interface KiroCliCommandProbe {
  homeDir(): Promise<string>;
  findOnPath(command: string): Promise<string | null>;
  isExecutable(path: string): Promise<boolean>;
}

export function commonKiroCliPaths(home: string): string[] {
  const normalizedHome = home.replace(/\/$/, "");
  return [
    `${normalizedHome}/.local/bin/kiro-cli`,
    `${normalizedHome}/.kiro/bin/kiro-cli`,
    `${normalizedHome}/.local/share/kiro-cli/bin/kiro-cli`,
    "/opt/homebrew/bin/kiro-cli",
    "/usr/local/bin/kiro-cli",
  ];
}

export function buildKiroCliExecArgs(command: string, args: string[]): string[] {
  return ["-c", 'exec "$@"', "--", command, ...args];
}

/**
 * 解析 Kiro CLI 可执行文件：显式配置优先；留空时自动扫描 PATH 与常见安装目录。
 * 返回真实可执行路径，后续通过已授权的 sh + exec 启动，避免 Tauri capability 写死用户目录。
 */
export async function resolveKiroCliCommand(
  configuredCommand: string | undefined,
  probe: KiroCliCommandProbe,
): Promise<KiroCliCommandResolution> {
  const configured = configuredCommand?.trim();
  if (configured) {
    if (configured.includes("/")) {
      if (await probe.isExecutable(configured)) {
        return { command: configured, source: "configured" };
      }
      throw new Error(`指定的 Kiro CLI 不可执行或不存在: ${configured}`);
    }

    const resolved = await probe.findOnPath(configured);
    if (resolved) return { command: resolved, source: "configured" };
    throw new Error(`PATH 中找不到指定命令: ${configured}`);
  }

  const fromPath = await probe.findOnPath("kiro-cli");
  if (fromPath) return { command: fromPath, source: "path" };

  const candidates = commonKiroCliPaths(await probe.homeDir());
  for (const candidate of candidates) {
    if (await probe.isExecutable(candidate)) {
      return { command: candidate, source: "common" };
    }
  }

  throw new Error(`未检测到 kiro-cli；请在连接器设置中填写可执行文件路径。已检查: ${candidates.join(", ")}`);
}
