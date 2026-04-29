#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  Tool,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { GeminiClient, GenerateImageRequest, EditImageRequest, ReferenceImage } from './gemini-client.js';
import * as fs from 'fs';
import * as path from 'path';

// Define available tools
const TOOLS: Tool[] = [
  {
    name: "generate_image",
    description: "Generate an image using Nano Banana (Gemini image generation). Supports text-to-image with optional reference images for style transfer. Reference images are uploaded automatically to Files API for token efficiency - you can provide URLs, file paths, or fileUris.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The text prompt describing the image to generate"
        },
        model: {
          type: "string",
          enum: ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "nano-banana-pro-preview"],
          description: "Model to use for generation (default: nano-banana-pro-preview)"
        },
        aspectRatio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "3:4", "4:3"],
          description: "Aspect ratio of the generated image (default: 16:9)"
        },
        imageSize: {
          type: "string",
          enum: ["256x256", "512x512", "1K", "2K", "4K"],
          description: "Size of the generated image (default: 2K)"
        },
        mimeType: {
          type: "string",
          enum: ["image/png", "image/jpeg"],
          description: "Output image format (default: image/png)"
        },
        seed: {
          type: "number",
          description: "Optional seed for reproducible generation"
        },
        referenceImages: {
          type: "array",
          description: "Optional reference images for style transfer. Each can be a URL, file path, or existing fileUri. Server automatically uploads and caches them.",
          items: {
            type: "object",
            properties: {
              source: {
                type: "string",
                enum: ["url", "file_uri", "file_path", "inline"],
                description: "Source type: 'url' (download from web), 'file_uri' (already uploaded), 'file_path' (local file), 'inline' (base64)"
              },
              url: {
                type: "string",
                description: "URL to download (if source='url')"
              },
              fileUri: {
                type: "string",
                description: "Existing Files API URI like 'files/abc123' (if source='file_uri')"
              },
              filePath: {
                type: "string",
                description: "Local file path (if source='file_path')"
              },
              mimeType: {
                type: "string",
                description: "MIME type (optional, auto-detected for URLs/files)"
              },
              base64: {
                type: "string",
                description: "Base64-encoded image data (if source='inline', use sparingly for token efficiency)"
              }
            },
            required: ["source"]
          }
        },
        referenceMode: {
          type: "string",
          enum: ["style", "identity", "composition", "auto"],
          description: "How to use reference images (default: auto)"
        },
        referenceStrength: {
          type: "number",
          description: "Strength of reference influence, 0.0-1.0 (default: 0.7)"
        },
        outputPath: {
          type: "string",
          description: "Optional: Path where to save the generated image. If not provided, returns base64 data."
        }
      },
      required: ["prompt"]
    }
  },
  {
    name: "edit_image",
    description: "Edit an existing image using AI. Supports inpainting (with mask) and general image-to-image transformation. Input image is uploaded automatically for token efficiency.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The edit instructions"
        },
        inputImage: {
          type: "object",
          description: "The image to edit",
          properties: {
            source: {
              type: "string",
              enum: ["url", "file_uri", "file_path", "inline"],
              description: "Source type"
            },
            url: { type: "string" },
            fileUri: { type: "string" },
            filePath: { type: "string" },
            mimeType: { type: "string" },
            base64: { type: "string" }
          },
          required: ["source"]
        },
        maskImage: {
          type: "object",
          description: "Optional mask image (white = edit area, black = preserve)",
          properties: {
            source: { type: "string", enum: ["url", "file_uri", "file_path", "inline"] },
            url: { type: "string" },
            fileUri: { type: "string" },
            filePath: { type: "string" },
            mimeType: { type: "string" },
            base64: { type: "string" }
          },
          required: ["source"]
        },
        model: {
          type: "string",
          enum: ["gemini-2.5-flash-image", "gemini-3-pro-image-preview", "nano-banana-pro-preview"],
          description: "Model to use (default: nano-banana-pro-preview)"
        },
        aspectRatio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "3:4", "4:3"],
          description: "Aspect ratio (default: 16:9)"
        },
        imageSize: {
          type: "string",
          enum: ["256x256", "512x512", "1K", "2K", "4K"],
          description: "Image size (default: 2K)"
        },
        mimeType: {
          type: "string",
          enum: ["image/png", "image/jpeg"]
        },
        seed: {
          type: "number"
        },
        outputPath: {
          type: "string",
          description: "Optional: Path where to save the edited image"
        }
      },
      required: ["prompt", "inputImage"]
    }
  },
  {
    name: "get_model_capabilities",
    description: "Get information about available models and their supported features, aspect ratios, and sizes.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "upload_image",
    description: "Manually upload an image to Google Files API and get a fileUri for reuse. The fileUri can be used in subsequent generate_image or edit_image calls.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["url", "file_path"],
          description: "Source type: 'url' to download from web, 'file_path' for local file"
        },
        url: {
          type: "string",
          description: "URL to download (if source='url')"
        },
        filePath: {
          type: "string",
          description: "Local file path (if source='file_path')"
        },
        displayName: {
          type: "string",
          description: "Optional display name for the uploaded file"
        }
      },
      required: ["source"]
    }
  },
  {
    name: "list_uploaded_files",
    description: "List all files currently uploaded to Google Files API",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "delete_uploaded_file",
    description: "Delete a previously uploaded file from Google Files API",
    inputSchema: {
      type: "object",
      properties: {
        fileName: {
          type: "string",
          description: "The file name to delete (e.g., 'files/abc123')"
        }
      },
      required: ["fileName"]
    }
  }
];

class NanobananaServer {
  private geminiClient: GeminiClient;
  private server: Server;

  constructor() {
    // Get API key from environment
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error('Error: GEMINI_API_KEY environment variable is required');
      console.error('Get your API key at: https://aistudio.google.com/app/apikey');
      process.exit(1);
    }

    this.geminiClient = new GeminiClient(apiKey);
    this.server = new Server(
      {
        name: "nanobanana-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => 
      this.handleToolCall(request.params.name, request.params.arguments ?? {})
    );
  }

  private async handleToolCall(name: string, args: any): Promise<CallToolResult> {
    try {
      switch (name) {
        case "generate_image": {
          const { 
            prompt, 
            model,
            aspectRatio, 
            imageSize, 
            mimeType,
            seed,
            referenceImages,
            referenceMode,
            referenceStrength,
            outputPath 
          } = args;

          const request: GenerateImageRequest = {
            prompt,
            model,
            aspectRatio,
            imageSize,
            mimeType,
            seed,
            referenceImages,
            referenceMode,
            referenceStrength,
          };

          const result = await this.geminiClient.generateImage(request);

          // Extract the image data
          const imageData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          
          if (!imageData) {
            throw new Error('No image data in response');
          }

          // Save to file if outputPath provided
          if (outputPath) {
            const imageBuffer = Buffer.from(imageData.data, 'base64');
            const outputDir = path.dirname(outputPath);
            
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }

            fs.writeFileSync(outputPath, imageBuffer);

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "Image generated and saved successfully!",
                  outputPath: path.resolve(outputPath),
                  mimeType: imageData.mimeType,
                  sizeBytes: imageBuffer.length,
                  usedFileUris: result.usedFileUris || [],
                  cost_estimate_usd: result.cost_estimate_usd,
                  usageMetadata: result.usageMetadata
                }, null, 2),
              }],
            };
          } else {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "Image generated successfully!",
                  mimeType: imageData.mimeType,
                  base64: imageData.data,
                  usedFileUris: result.usedFileUris || [],
                  cost_estimate_usd: result.cost_estimate_usd,
                  usageMetadata: result.usageMetadata,
                  note: "Image returned as base64. Provide 'outputPath' to save to disk."
                }, null, 2),
              }],
            };
          }
        }

        case "edit_image": {
          const {
            prompt,
            inputImage,
            maskImage,
            model,
            aspectRatio,
            imageSize,
            mimeType,
            seed,
            outputPath
          } = args;

          const request: EditImageRequest = {
            prompt,
            inputImage,
            maskImage,
            model,
            aspectRatio,
            imageSize,
            mimeType,
            seed,
          };

          const result = await this.geminiClient.editImage(request);

          const imageData = result.candidates?.[0]?.content?.parts?.[0]?.inlineData;
          
          if (!imageData) {
            throw new Error('No image data in response');
          }

          if (outputPath) {
            const imageBuffer = Buffer.from(imageData.data, 'base64');
            const outputDir = path.dirname(outputPath);
            
            if (!fs.existsSync(outputDir)) {
              fs.mkdirSync(outputDir, { recursive: true });
            }

            fs.writeFileSync(outputPath, imageBuffer);

            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "Image edited and saved successfully!",
                  outputPath: path.resolve(outputPath),
                  mimeType: imageData.mimeType,
                  sizeBytes: imageBuffer.length,
                  usedFileUris: result.usedFileUris || [],
                  cost_estimate_usd: result.cost_estimate_usd,
                  usageMetadata: result.usageMetadata
                }, null, 2),
              }],
            };
          } else {
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "Image edited successfully!",
                  mimeType: imageData.mimeType,
                  base64: imageData.data,
                  usedFileUris: result.usedFileUris || [],
                  cost_estimate_usd: result.cost_estimate_usd,
                  usageMetadata: result.usageMetadata
                }, null, 2),
              }],
            };
          }
        }

        case "get_model_capabilities": {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                models: [
                  {
                    name: "nano-banana-pro-preview",
                    displayName: "Nano Banana Pro (Preview)",
                    description: "Most capable image generation model",
                    supportedFeatures: ["text-to-image", "image-to-image", "style-transfer", "editing"],
                    defaultModel: true
                  },
                  {
                    name: "gemini-3-pro-image-preview",
                    displayName: "Gemini 3 Pro Image (Preview)",
                    description: "High-quality image generation",
                    supportedFeatures: ["text-to-image", "image-to-image", "style-transfer"]
                  },
                  {
                    name: "gemini-2.5-flash-image",
                    displayName: "Gemini 2.5 Flash Image",
                    description: "Fast image generation",
                    supportedFeatures: ["text-to-image", "style-transfer"]
                  }
                ],
                aspectRatios: ["1:1", "16:9", "9:16", "3:4", "4:3"],
                imageSizes: ["256x256", "512x512", "1K", "2K", "4K"],
                outputFormats: ["image/png", "image/jpeg"],
                referenceModes: ["style", "identity", "composition", "auto"],
                maxReferenceImages: 5,
                fileExpiration: "48 hours"
              }, null, 2),
            }],
          };
        }

        case "upload_image": {
          const { source, url, filePath, displayName } = args;

          let uploadResult;

          if (source === 'file_path' && filePath) {
            if (!fs.existsSync(filePath)) {
              throw new McpError(ErrorCode.InvalidParams, `File not found: ${filePath}`);
            }
            uploadResult = await this.geminiClient.uploadFile(filePath, displayName);
          } else if (source === 'url' && url) {
            // Download and upload
            const axios = (await import('axios')).default;
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const bytes = Buffer.from(response.data);
            const mimeType = response.headers['content-type'] || 'image/png';
            
            // Use the private method through a workaround
            const ref: ReferenceImage = { source: 'url', url };
            const resolved = await (this.geminiClient as any).resolveReferenceImage(ref);
            
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  success: true,
                  message: "File uploaded from URL successfully!",
                  fileUri: resolved.fileUri,
                  mimeType: resolved.mimeType,
                  note: "File will expire in 48 hours"
                }, null, 2),
              }],
            };
          } else {
            throw new McpError(ErrorCode.InvalidParams, "Invalid source or missing url/filePath");
          }

          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: "File uploaded successfully!",
                file: {
                  uri: uploadResult.file.uri,
                  name: uploadResult.file.name,
                  displayName: uploadResult.file.displayName,
                  mimeType: uploadResult.file.mimeType,
                  sizeBytes: uploadResult.file.sizeBytes,
                  expirationTime: uploadResult.file.expirationTime,
                  state: uploadResult.file.state
                }
              }, null, 2),
            }],
          };
        }

        case "list_uploaded_files": {
          const result = await this.geminiClient.listFiles();
          return {
            content: [{
              type: "text",
              text: JSON.stringify(result, null, 2),
            }],
          };
        }

        case "delete_uploaded_file": {
          const { fileName } = args;
          await this.geminiClient.deleteFile(fileName);
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success: true,
                message: `File ${fileName} deleted successfully`
              }, null, 2),
            }],
          };
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Tool execution error: ${errorMessage}\n`);
      
      return {
        content: [{
          type: "text",
          text: `Error: ${errorMessage}`,
        }],
        isError: true,
      };
    }
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      process.stderr.write(`[MCP Error] ${error}\n`);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });

    process.on('uncaughtException', (error) => {
      process.stderr.write(`[Uncaught Exception] ${error.message}\n`);
      process.exit(1);
    });

    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[Unhandled Rejection] ${reason}\n`);
    });
  }

  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    process.stderr.write('🍌 Nanobanana MCP server is running\n');
  }
}

// Main execution
async function main() {
  const server = new NanobananaServer();
  await server.start();
}

main().catch((error) => {
  process.stderr.write(`Fatal server error: ${error.message}\n`);
  process.exit(1);
});

