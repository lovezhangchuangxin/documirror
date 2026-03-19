import { URL } from "node:url";

import axios from "axios";
import robotsParserModule from "robots-parser";

import type { MirrorConfig } from "@documirror/shared";

import { DEFAULT_USER_AGENT } from "./constants";
import type { RobotsLike } from "./types";

const robotsParser = robotsParserModule as unknown as (
  url: string,
  contents: string,
) => RobotsLike;

export async function loadRobots(config: MirrorConfig): Promise<RobotsLike> {
  try {
    const source = new URL(config.sourceUrl);
    const robotsUrl = `${source.origin}/robots.txt`;
    const response = await axios.get<string>(robotsUrl, {
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        ...config.requestHeaders,
      },
      responseType: "text",
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      return allowAllRobots();
    }

    return robotsParser(robotsUrl, response.data);
  } catch {
    return allowAllRobots();
  }
}

function allowAllRobots(): RobotsLike {
  return {
    isAllowed: () => true,
  };
}
