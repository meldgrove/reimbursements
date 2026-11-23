import { describe, expect, it } from "vitest";
import { overrideConfigForTests } from "./config";
import { productionChecks } from "./checks";

describe("the checks before a process starts", () => {
  it("refuse a deployment without the sandbox or the bounded workspace, as the Django version did", async () => {
    overrideConfigForTests({ isDevelopment: false, DOCUMENT_SANDBOX_ENABLED: false });
    // Tests run without the private tmpfs of compose.yaml.
    expect(await productionChecks()).toEqual([
      "Document sandbox requires Linux Landlock ABI 3+ and libseccomp2.",
      "Mount private/work as a private, bounded tmpfs of at most 750 MB.",
    ]);
  });

  it("leave development alone", async () => {
    overrideConfigForTests({ isDevelopment: true, DOCUMENT_SANDBOX_ENABLED: false });
    expect(await productionChecks()).toEqual([]);
  });
});
