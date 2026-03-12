import { describe, expect, it } from "vitest";
import type { CommandResult } from "../types";
import { mapInstallCatchFailure, mapInstallFailure } from "./installFailure";

function makeResult(partial: Partial<CommandResult>): CommandResult {
  return {
    success: false,
    code: "UNKNOWN",
    message: "安装失败",
    hint: null,
    command: "install.ps1",
    exit_code: null,
    log_path: null,
    retriable: true,
    stdout: null,
    stderr: null,
    ...partial,
  };
}

describe("mapInstallFailure", () => {
  it("maps known error codes to user-friendly text", () => {
    expect(mapInstallFailure(makeResult({ code: "NODE_RUNTIME_NOT_READY" }))).toBe("Node.js 运行时未就绪");
    expect(mapInstallFailure(makeResult({ code: "OPENCLAW_NOT_FOUND" }))).toBe("安装后未找到 openclaw 命令");
    expect(mapInstallFailure(makeResult({ code: "NPM_NETWORK_ERROR" }))).toBe("OpenClaw CLI 安装失败（网络异常）");
  });

  it("falls back to backend message for unknown code", () => {
    expect(mapInstallFailure(makeResult({ code: "OTHER", message: "原始报错" }))).toBe("原始报错");
  });
});

describe("mapInstallCatchFailure", () => {
  it("maps npm/node/msi/version keywords", () => {
    expect(mapInstallCatchFailure(new Error("npm ERR! denied"))).toBe("OpenClaw CLI 安装失败（npm 阶段）");
    expect(mapInstallCatchFailure(new Error("node command missing"))).toBe("Node.js 安装失败");
    expect(mapInstallCatchFailure(new Error("MSI installer failed"))).toBe("Node.js MSI 安装失败");
    expect(mapInstallCatchFailure(new Error("version output empty"))).toBe("OpenClaw 安装验证失败");
  });
});
