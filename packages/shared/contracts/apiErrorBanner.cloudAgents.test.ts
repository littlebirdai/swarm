import { describe, expect, test } from "bun:test";
import {
  AGENT_MODEL_CONFIG,
  findModelOption,
  listedModels,
  modelOptionKey,
} from "@codecast/agent-clients/agentClients";
import {
  CLOUD_AGENT_PROVIDERS,
  cloudAgentCardText,
  cloudAgentLaunch,
  cloudAgentLaunchKey,
  cloudAgentProviderForLaunch,
  cloudAgentProvidersFor,
  cloudAgentSetupSentence,
  cloudAgentCardOf,
  CLOUD_AGENT_RETRIED_SUFFIX,
  cloudAgentChangedProblem,
  cloudAgentLimitProblem,
  cloudAgentProblemInfo,
} from "@codecast/agent-clients/cloudAgents";
import {
  CLIENT_ERROR_BANNER_PREFIX,
  classifyApiErrorBanner,
} from "./apiErrorBanner";

describe("cloud agent providers", () => {
  test("the Agents API lane: its own launch keys and models beside Codex Cloud's, and its own cards", () => {
    const api = CLOUD_AGENT_PROVIDERS.codex_api;
    expect(cloudAgentProviderForLaunch("codex", "api")?.id).toBe("codex_api");
    expect(cloudAgentProviderForLaunch("codex", "cloud")?.id).toBe("codex");
    expect(cloudAgentLaunch("codex", "api:gpt-5.6-luna")).toEqual({
      model: "gpt-5.6-luna",
      ask: false,
      attempts: 1,
    });
    expect(cloudAgentLaunch("codex", "api:ask+x3")).toEqual({
      model: "",
      ask: false,
      attempts: 1,
    });
    expect(
      cloudAgentLaunchKey(api, {
        model: "gpt-6-astra",
        ask: true,
        attempts: 2,
      }),
    ).toBe("api:gpt-6-astra");
    const listed = listedModels(AGENT_MODEL_CONFIG.codex)
      .filter(
        (m) => cloudAgentProviderForLaunch("codex", m.key)?.id === "codex_api",
      )
      .map((m) => m.key);
    expect(listed[0]).toBe("api");
    expect(listed).toContain(`api:${api.defaultModel}`);
    expect(listed).not.toContain("api:gpt-5.3-codex-spark");
    for (const key of listed) expect(modelOptionKey(key, "codex")).toBe(key);
    expect(findModelOption("codex", "api:gpt-5.6-luna")?.label).toBe(
      "GPT-5.6 Luna",
    );
    for (const spec of cloudAgentProvidersFor("codex"))
      expect(spec.lane?.cost).toBeTruthy();
    const missing = cloudAgentCardText(api.credentialCards.missing, "Mac");
    expect(cloudAgentCardOf(api, undefined, missing)?.kind).toBe("credential");
    expect(
      cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, missing),
    ).toBeNull();
    expect(
      classifyApiErrorBanner(
        `${CLIENT_ERROR_BANNER_PREFIX} ${cloudAgentCardText(api.credentialCards.rejected, "Mac")} (Incorrect API key provided).`,
      ),
    ).toBe("auth");
  });

  test("the daemon's credential cards are recognized by their copy, and are auth banners", () => {
    const cards = CLOUD_AGENT_PROVIDERS.cursor.credentialCards;
    for (const message of [
      cards.missing,
      `${cards.rejected} (Invalid User API Key).`,
    ]) {
      expect(
        cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.cursor, undefined, message)
          ?.kind,
      ).toBe("credential");
      expect(
        classifyApiErrorBanner(`${CLIENT_ERROR_BANNER_PREFIX} ${message}`),
      ).toBe("auth");
    }
    expect(
      cloudAgentCardOf(
        CLOUD_AGENT_PROVIDERS.cursor,
        undefined,
        "Cursor Cloud needs a Cursor API key on this machine.",
      )?.kind,
    ).toBe("credential");
    expect(
      cloudAgentCardOf(
        CLOUD_AGENT_PROVIDERS.cursor,
        undefined,
        "Not logged in: run cursor-agent login",
      ),
    ).toBeNull();
    expect(
      cloudAgentCardOf(CLOUD_AGENT_PROVIDERS.codex, undefined, cards.missing),
    ).toBeNull();
  });
});

describe("cloud agent lane problems: a provider that changed, a limit", () => {
  const codex = CLOUD_AGENT_PROVIDERS.codex;
  test("each opens with the provider; on a card neither is a sign-in card or a usage park", () => {
    const changed = cloudAgentChangedProblem(codex, "Ashot's MacBook");
    expect(changed).toBe(
      "Codex Cloud changed in a way codecast can't read yet. Syncing on Ashot's MacBook is paused and checks again every 5 minutes",
    );
    const limit = cloudAgentLimitProblem(
      codex,
      "the Week (7d) window of your ChatGPT Pro plan is used up",
    );
    expect(limit).toBe(
      "Codex Cloud limit reached: the Week (7d) window of your ChatGPT Pro plan is used up",
    );
    expect(
      `${codex.label} ${cloudAgentProblemInfo("limit")!.heading}`,
    ).not.toBe(limit.split(":")[0]);
    expect(
      classifyApiErrorBanner(
        `${CLIENT_ERROR_BANNER_PREFIX} ${changed}${CLOUD_AGENT_RETRIED_SUFFIX}`,
      ),
    ).toBe("error");
    expect(
      classifyApiErrorBanner(
        `${CLIENT_ERROR_BANNER_PREFIX} ${limit}${CLOUD_AGENT_RETRIED_SUFFIX}`,
      ),
    ).toBe("error");
    expect(
      cloudAgentSetupSentence(
        codex,
        { kind: "changed", reason: changed },
        "Mac",
      ),
    ).toBe(`${changed}.`);
  });
});
