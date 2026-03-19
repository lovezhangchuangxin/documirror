import { z } from "zod";

export const assemblyMapsSchema = z.array(
  z.object({
    pageUrl: z.string(),
    bindings: z.array(
      z.object({
        segmentId: z.string(),
        domPath: z.string(),
        kind: z.enum(["text", "attr", "meta"]),
        attributeName: z.string().optional(),
      }),
    ),
  }),
);
