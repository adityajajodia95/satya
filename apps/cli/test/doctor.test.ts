import { describe, expect, it } from "vitest";
import {
  REQUIRED_OLLAMA_ENV,
  checkFullyOnGpu,
  checkModelsPresent,
  checkNode,
  checkOllamaEnv,
  checkVram,
  parseNvidiaSmi,
} from "../src/doctor/checks";

describe("doctor checks", () => {
  it("requires Node >= 22", () => {
    expect(checkNode("24.13.0").status).toBe("pass");
    expect(checkNode("v22.0.0").status).toBe("pass");
    expect(checkNode("20.11.1").status).toBe("fail");
  });

  it("treats untagged model names as :latest", () => {
    expect(checkModelsPresent(["qwen3:4b", "bge-m3:latest"], ["qwen3:4b", "bge-m3"]).status).toBe("pass");
    const missing = checkModelsPresent(["qwen3:4b"], ["qwen3:4b", "bge-m3"]);
    expect(missing.status).toBe("fail");
    expect(missing.detail).toContain("bge-m3");
  });

  it("checks every Ollama env var against §2A", () => {
    expect(checkOllamaEnv({ ...REQUIRED_OLLAMA_ENV }).status).toBe("pass");
    const wrong = checkOllamaEnv({
      ...REQUIRED_OLLAMA_ENV,
      OLLAMA_KV_CACHE_TYPE: "f16",
      OLLAMA_NUM_PARALLEL: undefined,
    });
    expect(wrong.status).toBe("fail");
    expect(wrong.detail).toContain("OLLAMA_KV_CACHE_TYPE=f16");
    expect(wrong.detail).toContain("OLLAMA_NUM_PARALLEL=<unset>");
  });

  it("parses nvidia-smi CSV output", () => {
    const csv = "memory.used [MiB], memory.total [MiB]\r\n412 MiB, 8151 MiB\r\n";
    expect(parseNvidiaSmi(csv)).toEqual({ usedMiB: 412, totalMiB: 8151 });
    expect(() => parseNvidiaSmi("NVIDIA-SMI has failed")).toThrow();
  });

  it("fails when peak − baseline exceeds 6 GB", () => {
    expect(checkVram(400, [400, 3000, 5400]).status).toBe("pass"); // 4.88 GB
    expect(checkVram(400, [400, 6600]).status).toBe("fail"); // 6.05 GB
    expect(checkVram(400, []).status).toBe("fail");
  });

  it("requires 100% GPU residency for both models", () => {
    const gpu = [
      { name: "qwen3:4b", size: 3_600, size_vram: 3_600 },
      { name: "bge-m3:latest", size: 1_300, size_vram: 1_300 },
    ];
    expect(checkFullyOnGpu(gpu, ["qwen3:4b", "bge-m3"]).status).toBe("pass");
    const split = checkFullyOnGpu([{ ...gpu[0]!, size_vram: 1_800 }, gpu[1]!], ["qwen3:4b", "bge-m3"]);
    expect(split.status).toBe("fail");
    expect(split.detail).toBe("qwen3:4b 50% GPU");
    expect(checkFullyOnGpu([gpu[0]!], ["qwen3:4b", "bge-m3"]).detail).toBe("bge-m3 not loaded");
  });
});
