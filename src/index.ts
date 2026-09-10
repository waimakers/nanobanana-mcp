#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { InputSafetyError, prepareOutputPath, writeOutputImage } from "./io-safety.js";
import { Ajv, type ValidateFunction } from "ajv/dist/ajv.js";
import {
  DEFAULT_ASPECT_RATIO,
  GEMINI_31_FLASH_ASPECT_RATIOS,
  GeminiClient,
  IMAGE_MODELS,
  MODEL_ALIASES,
  MODEL_CAPABILITIES,
  getRuntimeDefaults,
  extractImage,
  type EditImageRequest,
  type GenerateImageRequest,
  type ReferenceImage,
} from "./gemini-client.js";

const imageOptions = {
  prompt: {
    type: "string",
    description: "Image instruction (maximum 20,000 characters).",
  },
  model: {
    type: "string",
    enum: IMAGE_MODELS,
    description:
      "Stable Gemini 3 IDs are recommended. nano-banana-pro-preview retains its historical mapping to gemini-3-pro-image-preview.",
  },
  aspectRatio: {
    type: "string",
    enum: GEMINI_31_FLASH_ASPECT_RATIOS,
    description: `Default: ${DEFAULT_ASPECT_RATIO}; unsupported model/ratio combinations are rejected.`,
  },
  imageSize: {
    type: "string",
    enum: ["0.5K", "1K", "2K", "4K"],
    description: "Defaults are configured by the server; call get_model_capabilities for active defaults and supported model/size combinations.",
  },
  mimeType: {
    type: "string",
    enum: ["image/png", "image/jpeg"],
    description:
      "Legacy compatibility option. Gemini controls the returned image encoding; this value is not forwarded.",
  },
  seed: {
    type: "number",
    description:
      "Optional non-negative 32-bit seed forwarded to Gemini generationConfig.",
  },
  outputPath: {
    type: "string",
    minLength: 1,
    maxLength: 2048,
    description:
      "Optional result path. If omitted, the response contains base64 image data.",
  },
};
const referenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      enum: ["url", "file_uri", "file_path", "inline"],
    },
    url: { type: "string" },
    fileUri: { type: "string" },
    filePath: { type: "string" },
    mimeType: {
      type: "string",
      enum: ["image/jpeg", "image/png", "image/webp", "image/gif"],
    },
    base64: { type: "string" },
  },
  required: ["source"],
};
const TOOLS: Tool[] = [
  {
    name: "generate_image",
    description:
      "Generate an image from text with optional reference images. References guide generation; referenceMode/referenceStrength are accepted only for compatibility and are not provider controls.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...imageOptions,
        referenceImages: { type: "array", maxItems: 5, items: referenceSchema },
        referenceMode: {
          type: "string",
          enum: ["style", "identity", "composition", "auto"],
          description:
            "Deprecated compatibility field; not forwarded to Gemini.",
        },
        referenceStrength: {
          type: "number",
          description:
            "Deprecated compatibility field; not forwarded to Gemini.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "edit_image",
    description:
      "Edit an image from an instruction and image inputs. An optional maskImage is passed as reference guidance only; Gemini does not provide pixel-exact masking.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...imageOptions,
        inputImage: referenceSchema,
        maskImage: referenceSchema,
      },
      required: ["prompt", "inputImage"],
    },
  },
  {
    name: "get_model_capabilities",
    description:
      "List model IDs, capability limits, defaults, and legacy alias behavior.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "upload_image",
    description:
      "Upload a bounded reference image to Google Files API for reuse.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "string", enum: ["url", "file_path"] },
        url: { type: "string" },
        filePath: { type: "string" },
        displayName: { type: "string", maxLength: 256 },
      },
      required: ["source"],
    },
  },
  {
    name: "list_uploaded_files",
    description:
      "List metadata for Google Files API uploads visible to this API key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_uploaded_file",
    description:
      "Delete an upload visible to this API key using its files/... name.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { fileName: { type: "string" } },
      required: ["fileName"],
    },
  },
];

const validator = new Ajv({ allErrors: true, strict: false });
const toolArgumentValidators = new Map<string, ValidateFunction>(
  TOOLS.map((tool) => [
    tool.name,
    validator.compile(tool.inputSchema as Record<string, unknown>),
  ]),
);

function validateToolArguments(name: string, args: Record<string, unknown>) {
  const validate = toolArgumentValidators.get(name);
  if (!validate || validate(args)) return;
  const details = (validate.errors ?? [])
    .map((error) => `${error.instancePath || "arguments"} ${error.message}`)
    .join("; ");
  throw new McpError(
    ErrorCode.InvalidParams,
    `Invalid tool arguments: ${details}`,
  );
}

function safeToolError(error: unknown): string {
  if (error instanceof InputSafetyError) return error.message;
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Tool execution failed";
  if (
    /^(Invalid|Unsupported|Use at most|seed must|Reference URLs|Provider returned|Image generation|File upload|Reference (download|upload)|Listing files|Deleting file|Unknown tool|NANOBANANA_|GEMINI_)/.test(
      message,
    )
  ) {
    return message;
  }
  if (message.includes("Invalid")) return "Invalid tool arguments";
  return "Tool execution failed";
}

export class NanobananaServer {
  private readonly client: GeminiClient;
  private readonly server: Server;
  constructor(
    apiKey = process.env.GEMINI_IMAGE_API_KEY ?? process.env.GEMINI_API_KEY,
  ) {
    if (!apiKey?.trim())
      throw new Error(
        "GEMINI_IMAGE_API_KEY or GEMINI_API_KEY environment variable is required",
      );
    this.client = new GeminiClient(apiKey.trim(), getRuntimeDefaults());
    this.server = new Server(
      { name: "nanobanana-mcp-server", version: "0.2.0" },
      { capabilities: { tools: {} } },
    );
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
    }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request) =>
      this.handleToolCall(request.params.name, request.params.arguments ?? {}),
    );
    this.server.onerror = () => process.stderr.write("MCP protocol error\n");
  }
  private async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      validateToolArguments(name, args);
      switch (name) {
        case "generate_image":
          validateOutputPath(args.outputPath);
          if (args.outputPath !== undefined) args.outputPath = prepareOutputPath(args.outputPath);
          return this.imageResult(
            await this.client.generateImage(
              args as unknown as GenerateImageRequest,
            ),
            args.outputPath as string | undefined,
          );
        case "edit_image":
          validateOutputPath(args.outputPath);
          if (args.outputPath !== undefined) args.outputPath = prepareOutputPath(args.outputPath);
          return this.imageResult(
            await this.client.editImage(args as unknown as EditImageRequest),
            args.outputPath as string | undefined,
          );
        case "get_model_capabilities":
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    defaults: getRuntimeDefaults(),
                    legacyAlias: {
                      name: "nano-banana-pro-preview",
                      resolvesTo: MODEL_ALIASES["nano-banana-pro-preview"],
                    },
                    models: Object.entries(MODEL_CAPABILITIES).map(
                      ([name, capability]) => ({ name, ...capability }),
                    ),
                    noSilentFallback: true,
                    notes: [
                      "Reference images, including maskImage, are guidance only; no exact mask or style-strength control is claimed.",
                      "mimeType, referenceMode, and referenceStrength are accepted for legacy callers but not forwarded.",
                    ],
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        case "upload_image":
          return await this.upload(args);
        case "list_uploaded_files":
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(await this.client.listFiles(), null, 2),
              },
            ],
          };
        case "delete_uploaded_file":
          await this.client.deleteFile(args.fileName as string);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ success: true }, null, 2),
              },
            ],
          };
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${safeToolError(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
  private async upload(args: Record<string, unknown>): Promise<CallToolResult> {
    if (args.source === "file_path") {
      const file = await this.client.uploadFile(
        args.filePath as string,
        args.displayName as string | undefined,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ success: true, file: file.file }, null, 2),
          },
        ],
      };
    }
    if (args.source === "url") {
      const reference: ReferenceImage = {
        source: "url",
        url: args.url as string,
      };
      const file = await this.client.resolveReferenceImage(reference);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { success: true, fileUri: file.fileUri, mimeType: file.mimeType },
              null,
              2,
            ),
          },
        ],
      };
    }
    throw new McpError(
      ErrorCode.InvalidParams,
      "source must be url or file_path",
    );
  }
  private imageResult(
    result: Awaited<ReturnType<GeminiClient["generateImage"]>>,
    outputPath: string | undefined,
  ): CallToolResult {
    const image = extractImage(result);
    if (!image)
      throw new Error(
        "Provider returned no image; it may have blocked or declined the request",
      );
    const output: Record<string, unknown> = {
      success: true,
      model: result.model,
      mimeType: image.mimeType,
      usedFileUris: result.usedFileUris,
      cost_estimate_usd: result.cost_estimate_usd,
      usageMetadata: result.usageMetadata,
    };
    if (outputPath) {
      const bytes = Buffer.from(image.data, "base64");
      output.outputPath = writeOutputImage(outputPath, bytes);
      output.sizeBytes = bytes.length;
    } else output.base64 = image.data;
    return {
      content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
    };
  }
  async start() {
    await this.server.connect(new StdioServerTransport());
  }
}

function validateOutputPath(
  outputPath: unknown,
): asserts outputPath is string | undefined {
  if (
    outputPath !== undefined &&
    (typeof outputPath !== "string" || !outputPath || outputPath.length > 2048)
  ) {
    throw new McpError(ErrorCode.InvalidParams, "Invalid outputPath");
  }
}

async function main() {
  await new NanobananaServer().start();
}
main().catch((error) => {
  const message =
    error instanceof Error && /^(GEMINI_|NANOBANANA_)/.test(error.message)
      ? error.message
      : "Server failed to start";
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

process.on("SIGINT", () => process.exit(0));
