import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { chooseLoadBalancedEnvironment } from "../load-balancing.ts";
import {
  applyProjectGroupingOverrideToMembers,
  buildProjectGroups,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "./projectGrouping.ts";

const environmentId = EnvironmentId.make("environment");

describe("load balancing shared project machines", () => {
  const now = 100_000;
  const resources = {
    sampledAt: now,
    cpuUtilization: 0.2,
    cpuCount: 8,
    availableMemoryBytes: 8_000,
    totalMemoryBytes: 16_000,
  };

  it("compares three machines using free capacity and preference", () => {
    const candidates = [
      { environmentId: "busy", resources: { ...resources, cpuUtilization: 0.9 }, weight: 1 },
      { environmentId: "idle", resources, weight: 1 },
      { environmentId: "preferred", resources: { ...resources, cpuCount: 4 }, weight: 3 },
    ];
    expect(chooseLoadBalancedEnvironment(candidates, now)).toBe("preferred");
    expect(chooseLoadBalancedEnvironment(candidates.slice(0, 2), now)).toBe("idle");
  });

  it("rejects stale, unknown, excluded and saturated machines", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [
          {
            environmentId: "stale",
            resources: { ...resources, sampledAt: now - 15_001 },
            weight: 1,
          },
          { environmentId: "unknown", resources: null, weight: 1 },
          {
            environmentId: "no-cpu-sample",
            resources: { ...resources, cpuUtilization: null },
            weight: 1,
          },
          { environmentId: "excluded", resources, weight: 0 },
          {
            environmentId: "cpu-full",
            resources: { ...resources, cpuUtilization: 0.95 },
            weight: 1,
          },
          {
            environmentId: "memory-full",
            resources: { ...resources, availableMemoryBytes: 100 },
            weight: 1,
          },
        ],
        now,
      ),
    ).toBeNull();
  });

  it("uses client receipt time when host clocks differ", () => {
    const candidate = {
      environmentId: "different-clock",
      resources: { ...resources, sampledAt: now + 60_000 },
      receivedAt: now,
      weight: 1,
    };
    expect(chooseLoadBalancedEnvironment([candidate], now)).toBe("different-clock");
    expect(chooseLoadBalancedEnvironment([candidate], now + 15_001)).toBeNull();
  });
});
const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId,
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function settings(
  mode: ProjectGroupingSettings["sidebarProjectGroupingMode"],
  overrides: ProjectGroupingSettings["sidebarProjectGroupingOverrides"] = {},
): ProjectGroupingSettings {
  return {
    sidebarProjectGroupingMode: mode,
    sidebarProjectGroupingOverrides: overrides,
  };
}

describe("applyProjectGroupingOverrideToMembers", () => {
  it("writes the same override for every checkout in the group", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2", {
      environmentId: EnvironmentId.make("remote"),
    });

    expect(
      applyProjectGroupingOverrideToMembers({
        overrides: {
          [derivePhysicalProjectKey(first)]: "separate",
        },
        members: [first, second],
        selection: "repository_path",
      }),
    ).toEqual({
      [derivePhysicalProjectKey(first)]: "repository_path",
      [derivePhysicalProjectKey(second)]: "repository_path",
    });
  });

  it("clears overrides for every checkout when inheriting the global default", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2", {
      environmentId: EnvironmentId.make("remote"),
    });

    expect(
      applyProjectGroupingOverrideToMembers({
        overrides: {
          [derivePhysicalProjectKey(first)]: "repository_path",
          [derivePhysicalProjectKey(second)]: "separate",
          "unrelated:checkout": "repository",
        },
        members: [first, second],
        selection: "inherit",
      }),
    ).toEqual({
      "unrelated:checkout": "repository",
    });
  });
});

describe("buildProjectGroups", () => {
  it("preserves every physical project as a selectable member when grouping by repository", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository") });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual([
      "t3code",
      "t3code-2",
      "t3code-3",
    ]);
    expect(groups[0]?.memberProjectRefs).toHaveLength(3);
  });

  it("keeps differently named checkouts separate in repository_path mode", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository_path") });
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.members.map((member) => member.project.id))).toEqual([
      ["t3code"],
      ["t3code-2"],
      ["t3code-3"],
    ]);
  });

  it("groups same-named checkouts across environments in repository_path mode", () => {
    const localEnvironmentId = EnvironmentId.make("local");
    const remoteEnvironmentId = EnvironmentId.make("remote");
    const projects = [
      makeProject("local-current", "/Users/dev/Current/app-current", {
        environmentId: localEnvironmentId,
        repositoryIdentity: {
          ...repositoryIdentity,
          rootPath: "/Users/dev/Current/app-current",
        },
      }),
      makeProject("local-experimental", "/Users/dev/Experimental/app-experimental", {
        environmentId: localEnvironmentId,
        repositoryIdentity: {
          ...repositoryIdentity,
          rootPath: "/Users/dev/Experimental/app-experimental",
        },
      }),
      makeProject("remote-current", "/home/dev/workspace/current/app-current", {
        environmentId: remoteEnvironmentId,
        repositoryIdentity: {
          ...repositoryIdentity,
          rootPath: "/home/dev/workspace/current/app-current",
        },
      }),
      makeProject("remote-experimental", "/home/dev/workspace/experimental/app-experimental", {
        environmentId: remoteEnvironmentId,
        repositoryIdentity: {
          ...repositoryIdentity,
          rootPath: "/home/dev/workspace/experimental/app-experimental",
        },
      }),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository_path") });
    expect(groups).toHaveLength(2);
    expect(
      groups
        .map((group) => group.members.map((member) => member.project.id).toSorted())
        .toSorted((left, right) => left[0]!.localeCompare(right[0]!)),
    ).toEqual([
      ["local-current", "remote-current"],
      ["local-experimental", "remote-experimental"],
    ]);
  });

  it("keeps monorepo package paths distinct in repository_path mode", () => {
    const projects = [
      makeProject("web", "/work/monorepo/apps/web", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/monorepo" },
      }),
      makeProject("mobile", "/work/monorepo/apps/mobile", {
        repositoryIdentity: { ...repositoryIdentity, rootPath: "/work/monorepo" },
      }),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("repository_path") });
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key).toSorted()).toEqual([
      "github.com/t3tools/t3code::apps/mobile",
      "github.com/t3tools/t3code::apps/web",
    ]);
  });

  it("uses a shared custom title as the repository group's label", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "Custom project" }),
      makeProject("second", "/work/t3code-2", { title: "Custom project" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "Custom project",
    );
  });

  it("keeps the repository label when shared titles match its repository name", () => {
    const projects = [
      makeProject("first", "/work/t3code", { title: "t3code" }),
      makeProject("second", "/work/t3code-2", { title: "t3code" }),
    ];

    expect(buildProjectGroups({ projects, settings: settings("repository") })[0]?.label).toBe(
      "T3 Code",
    );
  });

  it("keeps physical projects in separate groups when requested", () => {
    const projects = [
      makeProject("t3code", "/work/t3code"),
      makeProject("t3code-2", "/work/t3code-2"),
      makeProject("t3code-3", "/work/t3code-3"),
    ];

    const groups = buildProjectGroups({ projects, settings: settings("separate") });
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.members)).toHaveLength(3);
    expect(groups.map((group) => group.label)).toEqual(["t3code", "t3code-2", "t3code-3"]);
  });

  it("applies a physical-project override without dropping its siblings", () => {
    const first = makeProject("t3code", "/work/t3code");
    const second = makeProject("t3code-2", "/work/t3code-2");
    const third = makeProject("t3code-3", "/work/t3code-3");
    const groups = buildProjectGroups({
      projects: [first, second, third],
      settings: settings("repository", {
        [derivePhysicalProjectKey(second)]: "separate",
      }),
    });

    expect(groups).toHaveLength(2);
    expect(groups.flatMap((group) => group.members.map((member) => member.project.id))).toEqual([
      "t3code",
      "t3code-3",
      "t3code-2",
    ]);
  });

  it("dedupes stale registrations at one physical path using the freshest project", () => {
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });

    const groups = buildProjectGroups({
      projects: [stale, fresh],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(1);
    expect(groups[0]?.representative.id).toBe("fresh");
    expect(groups[0]?.memberProjectRefs).toHaveLength(2);
  });

  it("uses repository identity from a duplicate registration when the winner lacks it", () => {
    const identified = makeProject("identified", "/work/t3code", {
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshUnidentified = makeProject("fresh", "/work/t3code/", {
      repositoryIdentity: null,
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [identified, freshUnidentified, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest winner's repository identity when stale duplicates disagree", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const stale = makeProject("stale", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const fresh = makeProject("fresh", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [stale, fresh, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["fresh", "sibling"]);
  });

  it("uses the freshest identity-bearing duplicate when the winner lacks identity", () => {
    const staleIdentity = {
      ...repositoryIdentity,
      canonicalKey: "github.com/t3tools/old-repository",
      name: "old-repository",
      displayName: "Old Repository",
    };
    const staleIdentified = makeProject("stale-identified", "/work/t3code", {
      repositoryIdentity: staleIdentity,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const freshIdentified = makeProject("fresh-identified", "/work/t3code/", {
      updatedAt: "2026-07-02T00:00:00.000Z",
    });
    const winner = makeProject("winner", "/work/t3code", {
      repositoryIdentity: null,
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    const sibling = makeProject("sibling", "/work/t3code-2");

    const groups = buildProjectGroups({
      projects: [staleIdentified, freshIdentified, winner, sibling],
      settings: settings("repository"),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((member) => member.project.id)).toEqual(["winner", "sibling"]);
  });
});
