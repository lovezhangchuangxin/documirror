import { buildSite } from "@documirror/site-builder";
import type { Logger } from "@documirror/shared";
import {
  attachCommandProfile,
  defaultLogger,
  extractCommandProfile,
} from "@documirror/shared";

import { getRepoPaths } from "./repo-paths";
import {
  loadAssemblyMaps,
  loadConfig,
  loadManifest,
  loadSegments,
  loadTranslations,
} from "./storage";
import type { BuildMirrorOptions, BuildSummary } from "./types";

export async function buildMirror(
  repoDir: string,
  logger: Logger = defaultLogger,
  options: BuildMirrorOptions = {},
): Promise<BuildSummary> {
  const startedAt = Date.now();
  const paths = getRepoPaths(repoDir);
  const loadStateStartedAt = Date.now();
  let loadStateDurationMs = 0;

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig(paths);
    const [manifest, segments, assemblyMaps, translations] = await Promise.all([
      loadManifest(paths),
      loadSegments(paths),
      loadAssemblyMaps(paths),
      loadTranslations(paths),
    ]);
    loadStateDurationMs = Date.now() - loadStateStartedAt;

    try {
      const buildResult = await buildSite({
        repoDir,
        config,
        manifest,
        segments,
        assemblyMaps,
        translations,
        logger,
        profile: options.profile,
      });

      if (!options.profile) {
        return buildResult;
      }

      return {
        ...buildResult,
        profile: {
          totalDurationMs: Date.now() - startedAt,
          steps: [
            {
              label: "load repository state",
              durationMs: loadStateDurationMs,
            },
            ...(buildResult.profile?.steps ?? []),
          ],
        },
      };
    } catch (error) {
      if (!options.profile) {
        throw error;
      }

      const nestedProfile = extractCommandProfile(error);
      throw attachCommandProfile(error, {
        totalDurationMs: Date.now() - startedAt,
        steps: [
          {
            label: "load repository state",
            durationMs: loadStateDurationMs,
          },
          ...(nestedProfile?.steps ?? []),
        ],
      });
    }
  } catch (error) {
    if (!options.profile) {
      throw error;
    }

    const existingProfile = extractCommandProfile(error);
    if (existingProfile) {
      throw attachCommandProfile(error, {
        totalDurationMs: Date.now() - startedAt,
        steps: existingProfile.steps,
      });
    }

    throw attachCommandProfile(error, {
      totalDurationMs: Date.now() - startedAt,
      steps: [
        {
          label: "load repository state",
          durationMs:
            loadStateDurationMs > 0
              ? loadStateDurationMs
              : Date.now() - loadStateStartedAt,
        },
      ],
    });
  }
}
