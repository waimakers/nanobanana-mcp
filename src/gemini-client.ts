import axios, { AxiosInstance } from "axios";
import * as crypto from "node:crypto";
import * as path from "node:path";
import { createPublicImageAgent, imageMimeType, readLocalImage, validatePublicImageUrl } from "./io-safety.js";

export const MAX_PROMPT_CHARS = 20_000;
export const MAX_REFERENCE_IMAGES = 5;
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 60_000;
// Generated 4K images are returned as base64 JSON, larger than reference inputs.
export const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024 * 1024;

export const IMAGE_MODELS = [
  "gemini-2.5-flash-image",
  "gemini-3-pro-image-preview",
  "nano-banana-pro-preview",
  "gemini-3.1-flash-image-preview",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image",
  "gemini-3.1-flash-lite-image",
] as const;
export type ImageModel = (typeof IMAGE_MODELS)[number];
export type AspectRatio =
  | "1:1"
  | "1:4"
  | "1:8"
  | "2:3"
  | "3:2"
  | "3:4"
  | "4:1"
  | "4:3"
  | "4:5"
  | "5:4"
  | "8:1"
  | "9:16"
  | "16:9"
  | "21:9";
export type ImageSize = "0.5K" | "1K" | "2K" | "4K";
export const COMMON_ASPECT_RATIOS: readonly AspectRatio[] = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
];
export const GEMINI_31_FLASH_ASPECT_RATIOS: readonly AspectRatio[] = [
  ...COMMON_ASPECT_RATIOS,
  "1:4",
  "1:8",
  "4:1",
  "8:1",
];

export interface ReferenceImage {
  source: "url" | "file_uri" | "inline" | "file_path";
  url?: string;
  fileUri?: string;
  filePath?: string;
  mimeType?: string;
  base64?: string;
}
export interface GenerateImageRequest {
  prompt: string;
  model?: ImageModel;
  aspectRatio?: AspectRatio;
  imageSize?: ImageSize;
  mimeType?: "image/png" | "image/jpeg";
  seed?: number;
  negativeSeed?: number;
  referenceImages?: ReferenceImage[];
  referenceMode?: "style" | "identity" | "composition" | "auto";
  referenceStrength?: number;
}
export interface EditImageRequest {
  prompt: string;
  inputImage: ReferenceImage;
  maskImage?: ReferenceImage;
  model?: ImageModel;
  aspectRatio?: AspectRatio;
  imageSize?: ImageSize;
  mimeType?: "image/png" | "image/jpeg";
  seed?: number;
}
export interface UploadFileResponse {
  file: {
    name: string;
    displayName?: string;
    mimeType: string;
    sizeBytes: string;
    expirationTime?: string;
    uri: string;
    state?: string;
  };
}
export interface GenerateImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ inlineData?: { mimeType: string; data: string } }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
    promptTokensDetails?: Array<{ modality: string; tokenCount: number }>;
    candidatesTokensDetails?: Array<{ modality: string; tokenCount: number }>;
  };
}

interface ModelCapabilities {
  displayName: string;
  sizes: readonly ImageSize[];
  aspectRatios: readonly AspectRatio[];
  preview?: boolean;
}
export const MODEL_CAPABILITIES: Record<
  Exclude<ImageModel, "nano-banana-pro-preview">,
  ModelCapabilities
> = {
  "gemini-2.5-flash-image": {
    displayName: "Gemini 2.5 Flash Image",
    sizes: ["1K"],
    aspectRatios: COMMON_ASPECT_RATIOS,
  },
  "gemini-3-pro-image-preview": {
    displayName: "Gemini 3 Pro Image (Preview)",
    sizes: ["1K", "2K", "4K"],
    aspectRatios: COMMON_ASPECT_RATIOS,
    preview: true,
  },
  "gemini-3.1-flash-image-preview": {
    displayName: "Gemini 3.1 Flash Image (Preview)",
    sizes: ["0.5K", "1K", "2K", "4K"],
    aspectRatios: GEMINI_31_FLASH_ASPECT_RATIOS,
    preview: true,
  },
  "gemini-3.1-flash-image": {
    displayName: "Gemini 3.1 Flash Image (Nano Banana 2)",
    sizes: ["0.5K", "1K", "2K", "4K"],
    aspectRatios: GEMINI_31_FLASH_ASPECT_RATIOS,
  },
  "gemini-3-pro-image": {
    displayName: "Gemini 3 Pro Image (Nano Banana Pro)",
    sizes: ["1K", "2K", "4K"],
    aspectRatios: COMMON_ASPECT_RATIOS,
  },
  "gemini-3.1-flash-lite-image": {
    displayName: "Gemini 3.1 Flash Lite Image (Nano Banana 2 Lite)",
    sizes: ["1K"],
    aspectRatios: COMMON_ASPECT_RATIOS,
  },
};
/** Legacy meaning is preserved: this public alias maps to Google's Pro preview endpoint. */
export const MODEL_ALIASES: Readonly<
  Record<string, Exclude<ImageModel, "nano-banana-pro-preview">>
> = { "nano-banana-pro-preview": "gemini-3-pro-image-preview" };
export const DEFAULT_MODEL: Exclude<ImageModel, "nano-banana-pro-preview"> =
  "gemini-3-pro-image-preview";
export const DEFAULT_IMAGE_SIZE: ImageSize = "2K";
export const DEFAULT_ASPECT_RATIO: AspectRatio = "16:9";
export interface RuntimeDefaults {
  model: Exclude<ImageModel, "nano-banana-pro-preview">;
  imageSize: ImageSize;
}

export function resolveModel(
  model?: string,
): Exclude<ImageModel, "nano-banana-pro-preview"> {
  const requested = model ?? DEFAULT_MODEL;
  const resolved = Object.hasOwn(MODEL_ALIASES, requested)
    ? MODEL_ALIASES[requested]
    : requested;
  if (!Object.hasOwn(MODEL_CAPABILITIES, resolved))
    throw new Error(
      `Unsupported model. Use one of: ${IMAGE_MODELS.join(", ")}`,
    );
  return resolved as Exclude<ImageModel, "nano-banana-pro-preview">;
}
export function getRuntimeDefaults(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeDefaults {
  const model = resolveModel(env.NANOBANANA_DEFAULT_MODEL);
  const imageSize = (env.NANOBANANA_DEFAULT_IMAGE_SIZE ??
    DEFAULT_IMAGE_SIZE) as ImageSize;
  if (!MODEL_CAPABILITIES[model].sizes.includes(imageSize))
    throw new Error(
      `NANOBANANA_DEFAULT_IMAGE_SIZE is not supported by NANOBANANA_DEFAULT_MODEL`,
    );
  return { model, imageSize };
}

const RATES: Record<
  string,
  {
    text_in_per_1m: number;
    image_in_per_1m?: number;
    text_out_per_1m?: number;
    image_out_per_1m: number;
  }
> = {
  "gemini-2.5-flash-image": {
    text_in_per_1m: 0.3,
    image_in_per_1m: 0.3,
    image_out_per_1m: 30,
  },
  "gemini-3-pro-image-preview": {
    text_in_per_1m: 2,
    image_in_per_1m: 2,
    text_out_per_1m: 12,
    image_out_per_1m: 120,
  },
  "gemini-3-pro-image": {
    text_in_per_1m: 2,
    image_in_per_1m: 2,
    text_out_per_1m: 12,
    image_out_per_1m: 120,
  },
  "gemini-3.1-flash-image-preview": {
    text_in_per_1m: 0.5,
    image_in_per_1m: 0.5,
    text_out_per_1m: 3,
    image_out_per_1m: 60,
  },
  "gemini-3.1-flash-image": {
    text_in_per_1m: 0.5,
    image_in_per_1m: 0.5,
    text_out_per_1m: 3,
    image_out_per_1m: 60,
  },
  "gemini-3.1-flash-lite-image": {
    text_in_per_1m: 0.25,
    image_in_per_1m: 0.25,
    text_out_per_1m: 1.5,
    image_out_per_1m: 30,
  },
};
export const PRICING_SOURCE_DATE = "2026-09-10";
export function estimateGeminiCost(
  model: string,
  usage?: GenerateImageResponse["usageMetadata"],
) {
  const rates = RATES[model];
  if (!rates || !usage) return null;
  const sum = (
    rows: Array<{ modality: string; tokenCount: number }> | undefined,
    modality: string,
  ) =>
    (rows ?? [])
      .filter((row) => row.modality === modality)
      .reduce((n, row) => n + row.tokenCount, 0);
  let textIn = sum(usage.promptTokensDetails, "TEXT");
  let imageIn = sum(usage.promptTokensDetails, "IMAGE");
  if (!textIn && !imageIn) textIn = usage.promptTokenCount ?? 0;
  const candidateText = sum(usage.candidatesTokensDetails, "TEXT");
  const textOut = candidateText + (usage.thoughtsTokenCount ?? 0);
  let imageOut = sum(usage.candidatesTokensDetails, "IMAGE");
  if (!candidateText && !imageOut) imageOut = usage.candidatesTokenCount ?? 0;
  const round = (n: number) => Number(n.toFixed(4));
  const breakdown = {
    text_input_tokens: textIn,
    image_input_tokens: imageIn,
    text_output_tokens: textOut,
    image_output_tokens: imageOut,
    text_input_usd: round((textIn * rates.text_in_per_1m) / 1e6),
    image_input_usd: round((imageIn * (rates.image_in_per_1m ?? 0)) / 1e6),
    text_output_usd: round((textOut * (rates.text_out_per_1m ?? 0)) / 1e6),
    image_output_usd: round((imageOut * rates.image_out_per_1m) / 1e6),
    rates_per_1m_tokens: rates,
  };
  return {
    total: round(
      breakdown.text_input_usd +
        breakdown.image_input_usd +
        breakdown.text_output_usd +
        breakdown.image_output_usd,
    ),
    breakdown,
    pricing_source_date: PRICING_SOURCE_DATE,
    note: "Estimate uses Gemini usageMetadata and Google published token prices; Google does not return a USD charge.",
  };
}

function assertText(
  value: unknown,
  field: string,
  maximum = MAX_PROMPT_CHARS,
): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum)
    throw new Error(`Invalid ${field}`);
}
export function normalizeFileUri(value: unknown): string {
  assertText(value, "file URI", 2048);
  const name = value.startsWith("https://generativelanguage.googleapis.com/v1beta/")
    ? value.slice("https://generativelanguage.googleapis.com/v1beta/".length)
    : value;
  if (!/^files\/[A-Za-z0-9_-]+$/.test(name)) throw new Error("Invalid Google Files URI");
  return `https://generativelanguage.googleapis.com/v1beta/${name}`;
}
export function validateReferenceImage(
  ref: unknown,
): asserts ref is ReferenceImage {
  if (!ref || typeof ref !== "object")
    throw new Error("Invalid reference image");
  const value = ref as ReferenceImage;
  if (!["url", "file_uri", "file_path", "inline"].includes(value.source))
    throw new Error("Invalid reference image source");
  if (
    value.mimeType &&
    !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(
      value.mimeType,
    )
  )
    throw new Error("Unsupported reference image MIME type");
  if (value.source === "url") {
    assertText(value.url, "reference URL", 2048);
    let parsed: URL;
    try {
      parsed = new URL(value.url!);
    } catch {
      throw new Error("Invalid reference URL");
    }
    if (parsed.protocol !== "https:")
      throw new Error("Reference URLs must use HTTPS");
  }
  if (value.source === "file_uri") normalizeFileUri(value.fileUri);
  if (value.source === "file_path")
    assertText(value.filePath, "file path", 2048);
  if (value.source === "inline") {
    assertText(
      value.base64,
      "inline reference",
      Math.ceil((MAX_REFERENCE_BYTES * 4) / 3) + 4,
    );
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64!))
      throw new Error("Inline reference is not valid base64");
  }
}
export function validateImageRequest(
  request: GenerateImageRequest | EditImageRequest,
  defaults: RuntimeDefaults,
) {
  assertText(request.prompt, "prompt");
  const model = resolveModel(request.model ?? defaults.model);
  const imageSize = request.imageSize ?? defaults.imageSize;
  const aspectRatio = request.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const capabilities = MODEL_CAPABILITIES[model];
  if (!capabilities.sizes.includes(imageSize))
    throw new Error(`${imageSize} is not supported by ${model}`);
  if (!capabilities.aspectRatios.includes(aspectRatio))
    throw new Error(`${aspectRatio} is not supported by ${model}`);
  if ("referenceImages" in request && request.referenceImages !== undefined) {
    if (
      !Array.isArray(request.referenceImages) ||
      request.referenceImages.length > MAX_REFERENCE_IMAGES
    )
      throw new Error(`Use at most ${MAX_REFERENCE_IMAGES} reference images`);
    request.referenceImages.forEach(validateReferenceImage);
  }
  if ("inputImage" in request) validateReferenceImage(request.inputImage);
  if ("maskImage" in request && request.maskImage !== undefined) {
    validateReferenceImage(request.maskImage);
  }
  if (
    request.seed !== undefined &&
    (!Number.isInteger(request.seed) ||
      request.seed < 0 ||
      request.seed > 0x7fffffff)
  )
    throw new Error("seed must be a non-negative 32-bit integer");
  return { model, imageSize, aspectRatio };
}
function providerError(error: unknown, operation: string): Error {
  if (axios.isAxiosError(error)) {
    if (error.code === "ECONNABORTED")
      return new Error(`${operation} timed out`);
    return new Error(
      error.response?.status
        ? `${operation} failed (HTTP ${error.response.status})`
        : `${operation} failed`,
    );
  }
  return error instanceof Error ? error : new Error(`${operation} failed`);
}

interface CacheEntry {
  fileUri: string;
  expiresAt: number;
}
export class GeminiClient {
  private readonly api: AxiosInstance;
  private readonly download: AxiosInstance;
  private readonly fileCache = new Map<string, CacheEntry>();
  private readonly baseUrl = "https://generativelanguage.googleapis.com/v1beta";
  private readonly filesUrl =
    "https://generativelanguage.googleapis.com/upload/v1beta/files";
  constructor(
    apiKey: string,
    private readonly defaults: RuntimeDefaults = getRuntimeDefaults(),
  ) {
    this.api = axios.create({
      headers: { "x-goog-api-key": apiKey },
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_PROVIDER_RESPONSE_BYTES,
      maxBodyLength: MAX_REFERENCE_BYTES,
      maxRedirects: 0,
    });
    this.download = axios.create({
      httpsAgent: createPublicImageAgent(),
      proxy: false,
      timeout: REQUEST_TIMEOUT_MS,
      maxContentLength: MAX_REFERENCE_BYTES,
      maxRedirects: 0,
    });
  }
  async uploadFile(
    filePath: string,
    displayName?: string,
  ): Promise<UploadFileResponse> {
    assertText(filePath, "file path", 2048);
    const { bytes, mimeType } = readLocalImage(filePath);
    return this.uploadBytes(bytes, mimeType, displayName ?? path.basename(filePath));
  }

  async listFiles() {
    try {
      const response = await this.api.get<{
        files?: UploadFileResponse["file"][];
        nextPageToken?: string;
      }>(`${this.baseUrl}/files`);
      return {
        files: (response.data.files ?? []).map(
          ({
            name,
            displayName,
            mimeType,
            sizeBytes,
            expirationTime,
            state,
            uri,
          }) => ({
            name,
            displayName,
            mimeType,
            sizeBytes,
            expirationTime,
            state,
            uri,
          }),
        ),
        nextPageToken: response.data.nextPageToken,
      };
    } catch (error) {
      throw providerError(error, "Listing files");
    }
  }
  async deleteFile(name: string) {
    assertText(name, "file name", 1024);
    if (!/^files\/[A-Za-z0-9_-]+$/.test(name))
      throw new Error("Invalid file name");
    try {
      await this.api.delete(`${this.baseUrl}/${name}`);
      for (const [hash, cached] of this.fileCache) {
        if (cached.fileUri === `${this.baseUrl}/${name}`) this.fileCache.delete(hash);
      }
    } catch (error) {
      throw providerError(error, "Deleting file");
    }
  }
  async resolveReferenceImage(
    ref: ReferenceImage,
  ): Promise<{ mimeType: string; fileUri: string }> {
    validateReferenceImage(ref);
    if (ref.source === "file_uri")
      return { mimeType: ref.mimeType ?? "image/png", fileUri: normalizeFileUri(ref.fileUri) };
    let bytes: Buffer;
    let mimeType = ref.mimeType ?? "image/png";
    if (ref.source === "url") {
      try {
        validatePublicImageUrl(ref.url!);
        const response = await this.download.get<ArrayBuffer>(ref.url!, {
          responseType: "arraybuffer",
        });
        bytes = Buffer.from(response.data);
        const contentType = response.headers["content-type"];
        mimeType =
          (typeof contentType === "string"
            ? contentType.split(";")[0]
            : undefined) ?? mimeType;
      } catch (error) {
        throw providerError(error, "Reference download");
      }
    } else if (ref.source === "file_path") {
      ({ bytes, mimeType } = readLocalImage(ref.filePath!));
    } else bytes = Buffer.from(ref.base64!, "base64");
    if (!bytes.length || bytes.length > MAX_REFERENCE_BYTES)
      throw new Error(
        `Reference images must be no larger than ${MAX_REFERENCE_BYTES} bytes`,
      );
    if (
      !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mimeType)
    )
      throw new Error("Unsupported reference image MIME type");
    mimeType = imageMimeType(bytes);
    const hash = crypto.createHash("sha256").update(bytes).digest("hex");
    const cached = this.fileCache.get(hash);
    if (cached && cached.expiresAt > Date.now())
      return { mimeType, fileUri: cached.fileUri };
    this.fileCache.delete(hash);
    const uploaded = await this.uploadBytes(bytes, mimeType);
    this.fileCache.set(hash, {
      fileUri: uploaded.file.uri,
      expiresAt: Date.now() + 45 * 60 * 60 * 1000,
    });
    return { mimeType, fileUri: uploaded.file.uri };
  }
  private async uploadBytes(
    bytes: Buffer,
    mimeType: string,
    displayName = "reference-image",
  ): Promise<UploadFileResponse> {
    try {
      const start = await this.api.post(
        this.filesUrl,
        { file: { display_name: displayName.slice(0, 256) } },
        {
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
            "X-Goog-Upload-Header-Content-Length": String(bytes.length),
            "X-Goog-Upload-Header-Content-Type": mimeType,
          },
        },
      );
      const uploadUrl = start.headers["x-goog-upload-url"];
      if (typeof uploadUrl !== "string")
        throw new Error("Upload did not provide a resumable URL");
      const parsedUploadUrl = new URL(uploadUrl);
      if (
        parsedUploadUrl.protocol !== "https:" ||
        parsedUploadUrl.origin !== "https://generativelanguage.googleapis.com" ||
        parsedUploadUrl.username !== "" || parsedUploadUrl.password !== "" ||
        !parsedUploadUrl.pathname.startsWith("/upload/")
      )
        throw new Error("Upload returned an invalid resumable URL");
      const complete = await this.api.post<UploadFileResponse>(
        uploadUrl,
        bytes,
        {
          headers: {
            "Content-Type": mimeType,
            "Content-Length": String(bytes.length),
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
          },
        },
      );
      if (!complete.data.file?.uri)
        throw new Error("Upload returned no file URI");
      return complete.data;
    } catch (error) {
      throw providerError(error, "File upload");
    }
  }
  async generateImage(request: GenerateImageRequest) {
    const configuration = validateImageRequest(request, this.defaults);
    const parts: Array<Record<string, unknown>> = [{ text: request.prompt }];
    const usedFileUris: string[] = [];
    for (const reference of request.referenceImages ?? []) {
      const resolved = await this.resolveReferenceImage(reference);
      parts.push({
        fileData: { mimeType: resolved.mimeType, fileUri: resolved.fileUri },
      });
      usedFileUris.push(resolved.fileUri);
    }
    return this.call(configuration, parts, usedFileUris, request.seed);
  }
  async editImage(request: EditImageRequest) {
    const configuration = validateImageRequest(request, this.defaults);
    const input = await this.resolveReferenceImage(request.inputImage);
    const parts: Array<Record<string, unknown>> = [
      { text: request.prompt },
      { fileData: { mimeType: input.mimeType, fileUri: input.fileUri } },
    ];
    const usedFileUris = [input.fileUri];
    if (request.maskImage) {
      const mask = await this.resolveReferenceImage(request.maskImage);
      parts.push({
        fileData: { mimeType: mask.mimeType, fileUri: mask.fileUri },
      });
      usedFileUris.push(mask.fileUri);
    }
    return this.call(configuration, parts, usedFileUris, request.seed);
  }
  private async call(
    config: ReturnType<typeof validateImageRequest>,
    parts: Array<Record<string, unknown>>,
    usedFileUris: string[],
    seed?: number,
  ) {
    try {
      const imageConfig: Record<string, unknown> = {
        aspectRatio: config.aspectRatio,
      };
      // Gemini 2.5 Flash Image has a fixed approximately 1K output and rejects imageSize.
      if (config.model !== "gemini-2.5-flash-image") {
        imageConfig.imageSize = config.imageSize;
      }
      const generationConfig: Record<string, unknown> = {
        responseModalities: ["IMAGE"],
        imageConfig,
      };
      if (seed !== undefined) generationConfig.seed = seed;
      const response = await this.api.post<GenerateImageResponse>(
        `${this.baseUrl}/models/${config.model}:generateContent`,
        { contents: [{ parts }], generationConfig },
      );
      if (!extractImage(response.data))
        throw new Error(
          "Provider returned no image; it may have blocked or declined the request",
        );
      return {
        ...response.data,
        usedFileUris,
        model: config.model,
        cost_estimate_usd: estimateGeminiCost(
          config.model,
          response.data.usageMetadata,
        ),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Provider returned no image")
      )
        throw error;
      throw providerError(error, "Image generation");
    }
  }

}
export function extractImage(response: GenerateImageResponse) {
  for (const candidate of response.candidates ?? [])
    for (const part of candidate.content?.parts ?? [])
      if (!(part as { thought?: boolean }).thought && part.inlineData?.data)
        return part.inlineData;
  return undefined;
}
