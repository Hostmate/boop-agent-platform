import { z } from "zod";
import { zodShapeToJsonSchema } from "./json-schema.js";
import type { RuntimeTool, RuntimeToolResult } from "./types.js";

export function defineRuntimeTool<T extends z.ZodRawShape>(
  namespace: string,
  name: string,
  description: string,
  inputSchema: T,
  handle: (args: z.infer<z.ZodObject<T>>) => Promise<RuntimeToolResult>,
  jsonSchema: Record<string, unknown> = zodShapeToJsonSchema(inputSchema),
): RuntimeTool {
  // Product tools are an authority boundary. Unknown keys must fail instead of
  // being silently stripped (for example tenantId or an injected EntityRef).
  const parser = z.object(inputSchema).strict();
  return {
    namespace,
    name,
    description,
    inputSchema,
    jsonSchema,
    handle: async (args) => handle(parser.parse(args)),
  };
}
