import axios, { AxiosInstance } from 'axios';
import FormData from 'form-data';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface UploadFileResponse {
  file: {
    name: string;
    displayName?: string;
    mimeType: string;
    sizeBytes: string;
    createTime: string;
    updateTime: string;
    expirationTime: string;
    sha256Hash: string;
    uri: string;
    state: string;
  };
}

export interface ReferenceImage {
  source: 'url' | 'file_uri' | 'inline' | 'file_path';
  url?: string;
  fileUri?: string;
  filePath?: string;
  mimeType?: string;
  base64?: string;
}

export interface GenerateImageRequest {
  prompt: string;
  model?: 'gemini-2.5-flash-image' | 'gemini-3-pro-image-preview' | 'nano-banana-pro-preview';
  aspectRatio?: '1:1' | '16:9' | '9:16' | '3:4' | '4:3';
  imageSize?: '256x256' | '512x512' | '1K' | '2K' | '4K';
  mimeType?: 'image/png' | 'image/jpeg';
  seed?: number;
  negativeSeed?: number;
  referenceImages?: ReferenceImage[];
  referenceMode?: 'style' | 'identity' | 'composition' | 'auto';
  referenceStrength?: number;
}

export interface EditImageRequest {
  prompt: string;
  inputImage: ReferenceImage;
  maskImage?: ReferenceImage;
  model?: 'gemini-2.5-flash-image' | 'gemini-3-pro-image-preview' | 'nano-banana-pro-preview';
  aspectRatio?: '1:1' | '16:9' | '9:16' | '3:4' | '4:3';
  imageSize?: '256x256' | '512x512' | '1K' | '2K' | '4K';
  mimeType?: 'image/png' | 'image/jpeg';
  seed?: number;
}

export interface GenerateImageResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        inlineData?: {
          mimeType: string;
          data: string; // base64
        };
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
    promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
    candidatesTokensDetails?: Array<{ modality: string; tokenCount: number }>;
  };
}

// Pricing snapshot, USD per 1M tokens.
// Verified 2026-04-29 against:
//   - https://ai.google.dev/gemini-api/docs/pricing
//   - https://cloud.google.com/vertex-ai/generative-ai/pricing
//   - https://openrouter.ai/google/gemini-3.1-flash-image-preview
//   - https://openrouter.ai/google/gemini-3-pro-image-preview
// Gemini bills image generation per token; per-image numbers are Google's
// convenience reference (token_count × $/1M token rate).
export const PRICING_SOURCE_DATE = "2026-04-29";

interface GeminiTokenRates {
  text_in_per_1m: number;
  image_in_per_1m?: number;
  text_out_per_1m?: number;
  image_out_per_1m: number;
  // Convenience reference: typical USD per generated image at common resolutions.
  per_image_reference_usd?: Record<string, number>;
  notes?: string;
}

const PRICING_PER_1M_TOKENS: Record<string, GeminiTokenRates> = {
  "gemini-2.5-flash-image": {
    text_in_per_1m: 0.30,
    image_out_per_1m: 30.00,
    per_image_reference_usd: { "1024": 0.039 },
    notes: "Original Nano Banana. Flat ~1290 output tokens per 1024 image. Batch API = 50% off.",
  },
  "gemini-3-pro-image-preview": {
    text_in_per_1m: 2.00,
    image_in_per_1m: 2.00,
    text_out_per_1m: 12.00,
    image_out_per_1m: 120.00,
    per_image_reference_usd: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
    notes: "Nano Banana Pro. Resolution-tiered output tokens. Batch = 50% off.",
  },
  "gemini-3.1-flash-image-preview": {
    text_in_per_1m: 0.50,
    image_in_per_1m: 0.50,
    text_out_per_1m: 3.00,
    image_out_per_1m: 60.00,
    per_image_reference_usd: { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 },
    notes: "Nano Banana 2 (current default). 1680 tokens = 2K = $0.101.",
  },
  // Alias to Pro
  "nano-banana-pro-preview": {
    text_in_per_1m: 2.00,
    image_in_per_1m: 2.00,
    text_out_per_1m: 12.00,
    image_out_per_1m: 120.00,
    per_image_reference_usd: { "1K": 0.134, "2K": 0.134, "4K": 0.24 },
    notes: "Alias for gemini-3-pro-image-preview.",
  },
};

/**
 * Model aliases that must be rewritten before the name reaches Google's API.
 *
 * `nano-banana-pro-preview` LOOKS like the Pro flagship and is documented
 * everywhere as "Nano Banana Pro", but Google's API resolves it to
 * gemini-3.1-flash-image-preview (Flash 2) — a weaker model — and returns NO
 * error. Callers silently get downgraded art.
 *
 * Verified by output-token count at 2K: Pro = 1120 tokens, Flash 2 = 1680.
 * (2026-04-29, re-confirmed 2026-07-14.)
 *
 * The default was previously pointed at Pro, but that only helped callers who
 * passed no model at all. Anything naming the alias explicitly — which is what
 * most of our skills do — still went to Flash 2. Hence this map: it is applied
 * to the EXPLICIT model too, which is the whole point.
 */
const MODEL_ALIASES: Record<string, string> = {
  'nano-banana-pro-preview': 'gemini-3-pro-image-preview',
};

export const DEFAULT_MODEL = 'gemini-3-pro-image-preview';

/** Resolve a requested model name to the one we actually want to hit. */
export function resolveModel(requested?: string): string {
  const name = requested || DEFAULT_MODEL;
  return MODEL_ALIASES[name] ?? name;
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}

export interface GeminiCostEstimate {
  total: number;
  breakdown: {
    text_input_tokens: number;
    image_input_tokens: number;
    text_output_tokens: number;
    image_output_tokens: number;
    text_input_usd: number;
    image_input_usd: number;
    text_output_usd: number;
    image_output_usd: number;
    rates_per_1m_tokens: GeminiTokenRates;
  };
  pricing_source_date: string;
  note: string;
}

/**
 * Estimate USD cost from Gemini's usageMetadata.
 * Gemini's API does NOT return a USD figure — this is a client-side
 * calculation using verified per-token rates.
 */
export function estimateGeminiCost(
  model: string,
  usageMetadata: GenerateImageResponse["usageMetadata"]
): GeminiCostEstimate | null {
  if (!usageMetadata) return null;
  const rates = PRICING_PER_1M_TOKENS[model];
  if (!rates) return null;

  // Pull per-modality token counts when available; fall back to totals.
  const promptDetails = usageMetadata.promptTokensDetails ?? [];
  const candidateDetails = usageMetadata.candidatesTokensDetails ?? [];

  const sumByModality = (arr: any[], modality: string): number =>
    arr
      .filter((d) => d?.modality === modality)
      .reduce((s, d) => s + (d.tokenCount ?? 0), 0);

  let textIn = sumByModality(promptDetails, "TEXT");
  let imageIn = sumByModality(promptDetails, "IMAGE");
  if (textIn === 0 && imageIn === 0) {
    textIn = usageMetadata.promptTokenCount ?? 0;
  }

  let imageOut = sumByModality(candidateDetails, "IMAGE");
  let textOut = sumByModality(candidateDetails, "TEXT");
  if (imageOut === 0 && textOut === 0) {
    imageOut = usageMetadata.candidatesTokenCount ?? 0;
  }

  const textInUsd = (textIn / 1_000_000) * rates.text_in_per_1m;
  const imageInUsd = (imageIn / 1_000_000) * (rates.image_in_per_1m ?? 0);
  const textOutUsd = (textOut / 1_000_000) * (rates.text_out_per_1m ?? 0);
  const imageOutUsd = (imageOut / 1_000_000) * rates.image_out_per_1m;

  const total = textInUsd + imageInUsd + textOutUsd + imageOutUsd;

  return {
    total: round4(total),
    breakdown: {
      text_input_tokens: textIn,
      image_input_tokens: imageIn,
      text_output_tokens: textOut,
      image_output_tokens: imageOut,
      text_input_usd: round4(textInUsd),
      image_input_usd: round4(imageInUsd),
      text_output_usd: round4(textOutUsd),
      image_output_usd: round4(imageOutUsd),
      rates_per_1m_tokens: rates,
    },
    pricing_source_date: PRICING_SOURCE_DATE,
    note:
      "Estimate computed from Gemini usageMetadata × verified per-token rates. The Gemini API does not return USD; this is a client-side calculation.",
  };
}

export class GeminiClient {
  private apiKey: string;
  private baseUrl: string;
  private filesBaseUrl: string;
  private axios: AxiosInstance;
  private fileCache: Map<string, string>; // hash -> fileUri cache

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta';
    this.filesBaseUrl = 'https://generativelanguage.googleapis.com/upload/v1beta';
    this.fileCache = new Map();
    
    this.axios = axios.create({
      headers: {
        'x-goog-api-key': this.apiKey,
      },
    });
  }

  /**
   * Upload a file to Google's Files API
   * Returns a fileUri that can be used in generate requests
   */
  async uploadFile(filePath: string, displayName?: string): Promise<UploadFileResponse> {
    try {
      process.stderr.write(`Uploading file: ${filePath}\n`);

      // Read file
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);
      const mimeType = this.getMimeType(filePath);

      // Create form data
      const formData = new FormData();
      
      // Add metadata
      const metadata = {
        file: {
          displayName: displayName || fileName,
        }
      };
      formData.append('metadata', JSON.stringify(metadata), {
        contentType: 'application/json',
      });

      // Add file data
      formData.append('file', fileBuffer, {
        filename: fileName,
        contentType: mimeType,
      });

      // Upload
      const response = await axios.post<UploadFileResponse>(
        `${this.filesBaseUrl}/files`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'x-goog-api-key': this.apiKey,
          },
        }
      );

      process.stderr.write(`File uploaded successfully: ${response.data.file.uri}\n`);
      process.stderr.write(`File will expire at: ${response.data.file.expirationTime}\n`);

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        process.stderr.write(`Upload failed: ${errorMsg}\n`);
        throw new Error(`File upload failed: ${errorMsg}`);
      }
      throw error;
    }
  }

  /**
   * List uploaded files
   */
  async listFiles(): Promise<any> {
    try {
      const response = await this.axios.get(`${this.baseUrl}/files`);
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to list files: ${error.response?.data?.error?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Delete an uploaded file
   */
  async deleteFile(fileName: string): Promise<void> {
    try {
      await this.axios.delete(`${this.baseUrl}/${fileName}`);
      process.stderr.write(`File deleted: ${fileName}\n`);
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Failed to delete file: ${error.response?.data?.error?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Resolve a reference image to a fileUri (token-efficient)
   * Downloads URLs, uploads files, caches by hash
   */
  private async resolveReferenceImage(ref: ReferenceImage): Promise<{ mimeType: string; fileUri: string }> {
    // Already a fileUri - just use it
    if (ref.source === 'file_uri' && ref.fileUri) {
      return {
        mimeType: ref.mimeType || 'image/png',
        fileUri: ref.fileUri,
      };
    }

    let bytes: Buffer | null = null;
    let mimeType = ref.mimeType || 'image/png';

    // Download from URL
    if (ref.source === 'url' && ref.url) {
      process.stderr.write(`Downloading reference from URL: ${ref.url}\n`);
      const response = await axios.get(ref.url, { responseType: 'arraybuffer' });
      mimeType = response.headers['content-type'] || mimeType;
      bytes = Buffer.from(response.data);
    }
    // Read from file path
    else if (ref.source === 'file_path' && ref.filePath) {
      process.stderr.write(`Reading reference from file: ${ref.filePath}\n`);
      bytes = fs.readFileSync(ref.filePath);
      mimeType = this.getMimeType(ref.filePath);
    }
    // Inline base64
    else if (ref.source === 'inline' && ref.base64) {
      process.stderr.write(`Using inline reference (base64)\n`);
      bytes = Buffer.from(ref.base64, 'base64');
    }

    if (!bytes) {
      throw new Error('Invalid reference image: no valid source provided');
    }

    // Check cache by content hash (avoid re-uploading same image)
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    if (this.fileCache.has(hash)) {
      const cachedUri = this.fileCache.get(hash)!;
      process.stderr.write(`Using cached fileUri for hash ${hash.substring(0, 8)}...: ${cachedUri}\n`);
      return { mimeType, fileUri: cachedUri };
    }

    // Upload to Files API
    process.stderr.write(`Uploading ${(bytes.length / 1024).toFixed(2)} KB to Files API...\n`);
    const fileUri = await this.uploadBytes(bytes, mimeType);
    
    // Cache for future use
    this.fileCache.set(hash, fileUri);
    process.stderr.write(`Cached fileUri for future use: ${fileUri}\n`);

    return { mimeType, fileUri };
  }

  /**
   * Upload raw bytes to Files API and return fileUri
   */
  private async uploadBytes(bytes: Buffer, mimeType: string): Promise<string> {
    try {
      const response = await axios.post(
        `${this.filesBaseUrl}/files`,
        bytes,
        {
          headers: {
            'x-goog-api-key': this.apiKey,
            'Content-Type': mimeType,
          },
        }
      );

      const uri = response.data.file?.uri;
      if (!uri) {
        throw new Error('Files API upload failed: no URI returned');
      }

      return uri;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`Upload failed: ${error.response?.data?.error?.message || error.message}`);
      }
      throw error;
    }
  }

  /**
   * Generate an image using Nano Banana (token-efficient with reference images)
   */
  async generateImage(request: GenerateImageRequest): Promise<GenerateImageResponse & { usedFileUris?: string[]; cost_estimate_usd?: GeminiCostEstimate | null }> {
    try {
      process.stderr.write(`\n🎨 Generating image with prompt: ${request.prompt}\n`);

      const parts: any[] = [{ text: request.prompt }];
      const usedFileUris: string[] = [];

      // Process reference images (token-efficient: upload and use fileUri)
      if (request.referenceImages && request.referenceImages.length > 0) {
        process.stderr.write(`Processing ${request.referenceImages.length} reference image(s)...\n`);
        
        for (const ref of request.referenceImages) {
          const resolved = await this.resolveReferenceImage(ref);
          parts.push({
            fileData: {
              mimeType: resolved.mimeType,
              fileUri: resolved.fileUri,
            },
          });
          usedFileUris.push(resolved.fileUri);
        }
      }

      // Select model. Fixing only the DEFAULT was not enough: a caller that
      // explicitly names the legacy alias still got the weak model, because we
      // passed the name through verbatim. resolveModel() maps it. See MODEL_ALIASES.
      const model = resolveModel(request.model);
      process.stderr.write(`Using model: ${model}\n`);

      // Build generation config
      const imageConfig: any = {
        aspectRatio: request.aspectRatio || '16:9',
        imageSize: request.imageSize || '2K',
      };

      // Do NOT send outputMimeType. Google rejects it inside image_config
      // ("Unknown name \"outputMimeType\" at 'generation_config.image_config'")
      // and the entire call fails. `mimeType` is still accepted on the request for
      // backwards compatibility, but is deliberately not forwarded to the API.

      const generationConfig: any = {
        responseModalities: ['IMAGE'],
        imageConfig,
      };

      if (request.seed !== undefined) {
        generationConfig.seed = request.seed;
      }
      if (request.negativeSeed !== undefined) {
        imageConfig.negativeSeed = request.negativeSeed;
      }
      // Note: referenceMode and referenceStrength are not currently supported by the API
      // These parameters are accepted for future compatibility but not sent to the API

      // Build the request
      const generateRequest = {
        contents: [{ parts }],
        generationConfig,
      };

      process.stderr.write(`Calling ${model}...\n`);

      // Call Gemini API
      const response = await this.axios.post<GenerateImageResponse>(
        `${this.baseUrl}/models/${model}:generateContent`,
        generateRequest
      );

      process.stderr.write(`✅ Image generated successfully!\n`);

      return {
        ...response.data,
        usedFileUris,
        cost_estimate_usd: estimateGeminiCost(model, response.data.usageMetadata),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        process.stderr.write(`❌ Generation failed: ${errorMsg}\n`);
        if (error.response?.data) {
          process.stderr.write(`Full error: ${JSON.stringify(error.response.data, null, 2)}\n`);
        }
        throw new Error(`Image generation failed: ${errorMsg}`);
      }
      throw error;
    }
  }

  /**
   * Edit an image (inpainting/outpainting with optional mask)
   */
  async editImage(request: EditImageRequest): Promise<GenerateImageResponse & { usedFileUris?: string[]; cost_estimate_usd?: GeminiCostEstimate | null }> {
    try {
      process.stderr.write(`\n✏️  Editing image with prompt: ${request.prompt}\n`);

      const parts: any[] = [{ text: request.prompt }];
      const usedFileUris: string[] = [];

      // Resolve input image
      const inputResolved = await this.resolveReferenceImage(request.inputImage);
      parts.push({
        fileData: {
          mimeType: inputResolved.mimeType,
          fileUri: inputResolved.fileUri,
        },
      });
      usedFileUris.push(inputResolved.fileUri);

      // Resolve mask if provided
      if (request.maskImage) {
        const maskResolved = await this.resolveReferenceImage(request.maskImage);
        parts.push({
          fileData: {
            mimeType: maskResolved.mimeType,
            fileUri: maskResolved.fileUri,
          },
        });
        usedFileUris.push(maskResolved.fileUri);
      }

      // Select model. Fixing only the DEFAULT was not enough: a caller that
      // explicitly names the legacy alias still got the weak model, because we
      // passed the name through verbatim. resolveModel() maps it. See MODEL_ALIASES.
      const model = resolveModel(request.model);
      process.stderr.write(`Using model: ${model}\n`);

      // Build generation config
      const imageConfig: any = {
        aspectRatio: request.aspectRatio || '16:9',
        imageSize: request.imageSize || '2K',
      };

      // Do NOT send outputMimeType. Google rejects it inside image_config
      // ("Unknown name \"outputMimeType\" at 'generation_config.image_config'")
      // and the entire call fails. `mimeType` is still accepted on the request for
      // backwards compatibility, but is deliberately not forwarded to the API.

      const generationConfig: any = {
        responseModalities: ['IMAGE'],
        imageConfig,
      };

      if (request.seed !== undefined) {
        generationConfig.seed = request.seed;
      }

      // Build the request
      const generateRequest = {
        contents: [{ parts }],
        generationConfig,
      };

      process.stderr.write(`Calling ${model} for editing...\n`);

      // Call Gemini API
      const response = await this.axios.post<GenerateImageResponse>(
        `${this.baseUrl}/models/${model}:generateContent`,
        generateRequest
      );

      process.stderr.write(`✅ Image edited successfully!\n`);

      return {
        ...response.data,
        usedFileUris,
        cost_estimate_usd: estimateGeminiCost(model, response.data.usageMetadata),
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        process.stderr.write(`❌ Edit failed: ${errorMsg}\n`);
        if (error.response?.data) {
          process.stderr.write(`Full error: ${JSON.stringify(error.response.data, null, 2)}\n`);
        }
        throw new Error(`Image edit failed: ${errorMsg}`);
      }
      throw error;
    }
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }
}

